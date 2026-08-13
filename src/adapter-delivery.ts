import { DurableObject } from "cloudflare:workers";

import { ADAPTER, WORST_CASE_PARTITIONS, fullCycleBoundS } from "./adapter-constants.ts";
import {
  mintChannelToken,
  pushMessage,
  serializeMessageV1,
  type MessageFragment,
} from "./line-adapter.ts";
import type { AdapterOutboxEvent } from "./reservation-day.ts";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NONCE = /^[0-9a-f]{64}$/;
const LINE_SUBJECT = /^U[0-9a-f]{32}$/;
const NONCE_FREE_ID = /^[0-9A-Za-z-]{1,64}$/;

export type AdapterState = "never" | "active" | "deactivating" | "disabled";

export type AdapterSnapshot = { messagingChannelId: string };

export type AdapterDeliveryMeta = {
  state: AdapterState;
  generation: number;
  // Authoritative high-water of every generation ever activated. Survives
  // disable and a compatible forward backout (storage persists —
  // specs/003-line-adapter/research.md R5); re-enable stays above it.
  highWater: number;
  // Day event sequence recorded at activation: events at or below it predate
  // the installation's links and are never delivered retroactively.
  watermark: number;
  updatedAt: string;
  // Non-secret channel snapshot captured at activation so alarms can send
  // without any config read. Null outside `active`/`deactivating`.
  snapshot: AdapterSnapshot | null;
  beginDisableAt: number | null;
  purgeCompletedAt: number | null;
  sweepCursor: string | null;
};

export type PokeDayInput = { date: string };
export type PokeDayResult = { ok: true; drained: number };

export type AdapterDiagnostics = {
  state: AdapterState;
  generation: number;
  pending: number;
  oldestPendingAt: string | null;
  // Installation-level aggregates only — never a subject or reservation ID.
  links: { final: number; provisional: number };
  subjects: { followed: number; unfollowed: number };
  sweepCursor: string | null;
  purgeCompletedAt: number | null;
  counters: Record<string, number>;
  // Redacted terminal ledger tail: reason + event type + provider HTTP
  // status (where one exists) + time only.
  ledger: Array<{ reason: string; eventType: string; httpStatus: number | null; occurredAt: string }>;
};

type DeliveryRow = {
  purge_at: number | null;
  delivery_id: string;
  event_id: string;
  reservation_id: string;
  type: string;
  payload_json: string;
  link_version: number;
  retry_key: string;
  attempt: number;
  next_attempt_at: number;
  first_attempt_at: number | null;
  claimed_at: number | null;
  status: string;
  park_reason: string | null;
  date: string;
  created_at: string;
};

const dateOffset = (date: string, days: number): string => {
  const [y, m, d] = date.split("-").map(Number);
  const shifted = new Date(Date.UTC(y as number, (m as number) - 1, (d as number) + days));
  return shifted.toISOString().slice(0, 10);
};

/** Lowercase hex SHA-256 — the storage form of every link nonce. */
const digestHex = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

const withDeadline = async <T>(work: PromiseLike<T>, ms: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("rpc deadline")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Installation-singleton delivery and lifecycle authority for the LINE
 * adapter. Owns links, deliveries, webhook dedup, the redacted terminal
 * ledger, and the authoritative generation high-water. Isolated from the
 * reservation core: nothing here is on any booking path, and every timed
 * behavior runs on this object's own alarm (reservation-day alarms are
 * untouched by the whole feature).
 *
 * Invariant (tested): once `state` is `disabled` and the TTL stores are empty,
 * no alarm remains scheduled. Until those stores drain, a compatible forward
 * backout retains this class so their alarms can still run (research R5).
 */
export class AdapterDelivery extends DurableObject<Env> {
  #hasSchema(): boolean {
    return (
      this.ctx.storage.sql
        .exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'",
        )
        .toArray().length > 0
    );
  }

  // This class is new and has never been deployed, so its first public release
  // creates the complete schema below. A later released column change will
  // require an additive migration; CREATE IF NOT EXISTS covers new tables only.
  // Status/disposition vocabularies are validated in code, not CHECK
  // constraints — SQLite CHECKs cannot be widened after release.
  #ensureSchema(): void {
    const hadMeta = this.#hasSchema();
    const sql = this.ctx.storage.sql;
    this.ctx.storage.transactionSync(() => {
      sql.exec(`
        CREATE TABLE IF NOT EXISTS meta (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          state TEXT NOT NULL CHECK (state IN ('never', 'active', 'deactivating', 'disabled')),
          generation INTEGER NOT NULL CHECK (generation >= 0),
          high_water INTEGER NOT NULL CHECK (high_water >= 0),
          watermark INTEGER NOT NULL CHECK (watermark >= 0),
          updated_at TEXT NOT NULL,
          snapshot_json TEXT,
          begin_disable_at INTEGER,
          purge_completed_at INTEGER,
          sweep_cursor TEXT,
          cycle_started_at INTEGER
        )
      `);
      sql.exec(`
        CREATE TABLE IF NOT EXISTS accepted_events (
          event_key TEXT PRIMARY KEY,
          event_id TEXT NOT NULL,
          date TEXT NOT NULL,
          generation INTEGER NOT NULL,
          seq INTEGER NOT NULL,
          disposition TEXT NOT NULL,
          accepted_at TEXT NOT NULL
        )
      `);
      sql.exec(`
        CREATE TABLE IF NOT EXISTS links (
          reservation_id TEXT PRIMARY KEY,
          date TEXT NOT NULL,
          subject TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('provisional', 'final')),
          generation INTEGER NOT NULL,
          watermark_seq INTEGER NOT NULL,
          link_version INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          finalized_at TEXT,
          expires_at INTEGER,
          purge_at INTEGER
        )
      `);
      sql.exec(`
        CREATE TABLE IF NOT EXISTS deliveries (
          delivery_id TEXT PRIMARY KEY,
          event_id TEXT NOT NULL,
          reservation_id TEXT NOT NULL,
          type TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          link_version INTEGER NOT NULL,
          retry_key TEXT NOT NULL,
          attempt INTEGER NOT NULL CHECK (attempt >= 0),
          next_attempt_at INTEGER NOT NULL,
          first_attempt_at INTEGER,
          claimed_at INTEGER,
          status TEXT NOT NULL,
          park_reason TEXT,
          date TEXT NOT NULL,
          created_at TEXT NOT NULL,
          purge_at INTEGER
        )
      `);
      sql.exec(`
        CREATE TABLE IF NOT EXISTS webhook_dedup (
          webhook_event_id TEXT PRIMARY KEY,
          seen_at INTEGER NOT NULL
        )
      `);
      sql.exec(`
        CREATE TABLE IF NOT EXISTS ledger (
          entry_id INTEGER PRIMARY KEY AUTOINCREMENT,
          reason TEXT NOT NULL,
          event_type TEXT NOT NULL,
          http_status INTEGER,
          occurred_at TEXT NOT NULL
        )
      `);
      sql.exec(`
        CREATE TABLE IF NOT EXISTS counters (
          name TEXT PRIMARY KEY,
          value INTEGER NOT NULL CHECK (value >= 0)
        )
      `);
      sql.exec(`
        CREATE TABLE IF NOT EXISTS intents (
          nonce TEXT PRIMARY KEY,
          reservation_id TEXT NOT NULL,
          date TEXT NOT NULL,
          generation INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        )
      `);
      sql.exec(`
        CREATE TABLE IF NOT EXISTS subjects (
          subject TEXT PRIMARY KEY,
          followed INTEGER NOT NULL CHECK (followed IN (0, 1)),
          updated_at INTEGER NOT NULL
        )
      `);
      if (!hadMeta) {
        sql.exec(
          `INSERT INTO meta (singleton, state, generation, high_water, watermark, updated_at)
           VALUES (1, 'never', 0, 0, 0, ?)`,
          new Date().toISOString(),
        );
      }
    });
  }

  #readMeta(): AdapterDeliveryMeta {
    const row = this.ctx.storage.sql
      .exec<{
        state: string;
        generation: number;
        high_water: number;
        watermark: number;
        updated_at: string;
        snapshot_json: string | null;
        begin_disable_at: number | null;
        purge_completed_at: number | null;
        sweep_cursor: string | null;
      }>(
        `SELECT state, generation, high_water, watermark, updated_at, snapshot_json,
                begin_disable_at, purge_completed_at, sweep_cursor
         FROM meta WHERE singleton = 1`,
      )
      .toArray()[0];
    if (
      row === undefined ||
      !["never", "active", "deactivating", "disabled"].includes(row.state) ||
      !Number.isSafeInteger(row.generation) ||
      !Number.isSafeInteger(row.high_water) ||
      !Number.isSafeInteger(row.watermark)
    ) {
      throw new Error("corrupt adapter meta");
    }
    let snapshot: AdapterSnapshot | null = null;
    if (row.snapshot_json !== null) {
      const parsed: unknown = JSON.parse(row.snapshot_json);
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        typeof (parsed as AdapterSnapshot).messagingChannelId !== "string"
      ) {
        throw new Error("corrupt adapter snapshot");
      }
      snapshot = parsed as AdapterSnapshot;
    }
    return {
      state: row.state as AdapterState,
      generation: row.generation,
      highWater: row.high_water,
      watermark: row.watermark,
      updatedAt: row.updated_at,
      snapshot,
      beginDisableAt: row.begin_disable_at,
      purgeCompletedAt: row.purge_completed_at,
      sweepCursor: row.sweep_cursor,
    };
  }

  #bumpCounter(name: string, by: number): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO counters (name, value) VALUES (?, ?)
       ON CONFLICT(name) DO UPDATE SET value = value + excluded.value`,
      name,
      by,
    );
  }

  /** Redacted terminal record: allowlisted internal reason code, event type,
   * the provider HTTP status where one exists, and the time — never a
   * provider response body, header, or token. */
  #recordTerminal(reason: string, eventType: string, httpStatus: number | null = null): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO ledger (reason, event_type, http_status, occurred_at) VALUES (?, ?, ?, ?)",
      reason,
      eventType,
      httpStatus,
      new Date().toISOString(),
    );
    this.#bumpCounter(`terminal:${reason}`, 1);
  }

  #secretPresent(): boolean {
    const secret = this.env.LINE_MESSAGING_CHANNEL_SECRET;
    return typeof secret === "string" && secret.length >= 16 && secret.length <= 128;
  }

  /**
   * Pre-arm helper: awaited BEFORE the transaction that creates the work, so
   * a crash between the two leaves at worst a spurious wake-up (the handler
   * reconstructs every piece of work from storage alone).
   */
  async #armAlarm(dueAtMs: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > dueAtMs) {
      await this.ctx.storage.setAlarm(dueAtMs);
    }
  }

  // ---- the single disposition function (plan decision 8, priorities 0–6) ----

  /**
   * Dispose one pulled day event inside the caller's transaction. Priority 0
   * (`never`/`disabled` → zero persistence) is enforced by the callers before
   * any write; this function covers priorities 1–6 and records the outcome in
   * `accepted_events`. Every ingress (waitUntil poke, sweep pull, finalize's
   * re-disposition of held rows) routes through here, so one event can never
   * resolve differently by route.
   */
  #disposeEvent(event: AdapterOutboxEvent, meta: AdapterDeliveryMeta, now: number): string {
    const sql = this.ctx.storage.sql;
    let disposition: string;
    const occurredAtMs = Date.parse(event.occurredAt);
    if (event.generation !== meta.generation) {
      disposition = "canceled";
    } else if (event.purgeAt <= now) {
      // The parent reservation data is already gone (or due to go): nothing
      // derived from it may be created, let alone sent.
      disposition = "past-retention";
    } else if (
      now + fullCycleBoundS(WORST_CASE_PARTITIONS) * 1000 >
      occurredAtMs + ADAPTER.HANDOFF_TERMINAL_LEAD_S * 1000
    ) {
      // Next-guaranteed-visit rule: if the lead would expire before the sweep
      // provably returns, this visit is the last safe one — terminalize now.
      disposition = "late-terminal";
    } else {
      const link = sql
        .exec<{ subject: string; status: string; watermark_seq: number; link_version: number; expires_at: number | null }>(
          "SELECT subject, status, watermark_seq, link_version, expires_at FROM links WHERE reservation_id = ?",
          event.reservationId,
        )
        .toArray()[0];
      const liveProvisional =
        link !== undefined &&
        link.status === "provisional" &&
        (link.expires_at === null || link.expires_at >= now);
      if (liveProvisional) {
        disposition = "held";
      } else if (link === undefined || link.status !== "final") {
        disposition = "ignored-no-recipient";
      } else if (event.seq <= link.watermark_seq) {
        disposition = "ignored-prelink";
      } else {
        const pending =
          sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM deliveries").toArray()[0]?.n ??
          0;
        if (pending >= ADAPTER.DELIVERY_QUEUE_CAP) {
          disposition = "overflow";
        } else {
          disposition = this.#secretPresent() ? "queued" : "awaiting-configuration";
        }
      }
      if (disposition === "held" || disposition === "queued" || disposition === "awaiting-configuration") {
        const fragment: MessageFragment = {
          v: 1,
          type: event.type,
          date: event.date,
          startTime: event.startTime,
          serviceLabel: event.serviceLabel,
        };
        const linkVersion = link?.link_version ?? 0;
        sql.exec(
          `INSERT INTO deliveries
             (delivery_id, event_id, reservation_id, type, payload_json, link_version,
              retry_key, attempt, next_attempt_at, first_attempt_at, claimed_at, status,
              park_reason, date, created_at, purge_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, NULL, ?, NULL, ?, ?, ?)
           ON CONFLICT(delivery_id) DO NOTHING`,
          `${event.generation}:${event.eventId}`,
          event.eventId,
          event.reservationId,
          event.type,
          JSON.stringify(fragment),
          linkVersion,
          crypto.randomUUID(),
          now,
          disposition === "held" ? "held" : disposition,
          event.date,
          new Date().toISOString(),
          event.purgeAt,
        );
      }
    }
    if (disposition === "late-terminal") this.#recordTerminal("late-handoff", event.type);
    if (disposition === "overflow") this.#recordTerminal("overflow", event.type);
    if (disposition === "past-retention") this.#recordTerminal("past-retention", event.type);
    sql.exec(
      `INSERT INTO accepted_events (event_key, event_id, date, generation, seq, disposition, accepted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      `${event.generation}:${event.eventId}`,
      event.eventId,
      event.date,
      event.generation,
      event.seq,
      disposition,
      new Date().toISOString(),
    );
    this.#bumpCounter(`disposition:${disposition}`, 1);
    return disposition;
  }

  /** Accept a pulled batch in one local transaction; returns accepted count. */
  #acceptBatch(events: AdapterOutboxEvent[]): number {
    let accepted = 0;
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      const meta = this.#readMeta();
      if (meta.state !== "active" && meta.state !== "deactivating") return;
      for (const event of events) {
        const seen = this.ctx.storage.sql
          .exec<{ event_key: string }>(
            "SELECT event_key FROM accepted_events WHERE event_key = ?",
            `${event.generation}:${event.eventId}`,
          )
          .toArray();
        if (seen.length > 0) continue;
        this.#disposeEvent(event, meta, now);
        accepted += 1;
      }
    });
    return accepted;
  }

  /**
   * Handoff receiver and lazy re-poke target: pull this day's outbox, dispose
   * each event locally, then ack. Idempotent — the accept dedup makes a died
   * ack (or a duplicate poke) converge. While the adapter is `never` or
   * `disabled` this acknowledges without persisting anything at all
   * (disposition priority 0), leaving every table byte-identical.
   */
  async pokeDay(input: PokeDayInput): Promise<PokeDayResult> {
    if (typeof input !== "object" || input === null || !DATE.test(input.date)) {
      throw new Error("bad poke input");
    }
    if (!this.#hasSchema()) return { ok: true, drained: 0 };
    let drained = 0;
    // ponytail: bounded pull loop; anything beyond the budget waits for the
    // next poke or sweep cycle rather than growing one invocation unboundedly.
    for (let round = 0; round < 10; round += 1) {
      const meta = this.#readMeta();
      if (meta.state !== "active" && meta.state !== "deactivating") {
        return { ok: true, drained };
      }
      const stub = this.env.RESERVATION_DAYS.getByName(`single-location:${input.date}`);
      const batch = await stub.drainOutbox({
        consumer: "line",
        limit: ADAPTER.OUTBOX_DRAIN_BATCH,
      });
      if (batch.events.length > 0) {
        await this.#armAlarm(Date.now());
        this.#acceptBatch(batch.events);
        await stub.ackOutbox({
          consumer: "line",
          eventIds: batch.events.map(({ eventId }) => eventId),
        });
        drained += batch.events.length;
      }
      if (!batch.more) break;
    }
    return { ok: true, drained };
  }

  /** Diagnostics and tests: current lifecycle meta. */
  async readMeta(): Promise<AdapterDeliveryMeta | null> {
    if (!this.#hasSchema()) return null;
    return this.#readMeta();
  }

  /** Operator diagnostics: counts and the redacted ledger tail. Secret-free. */
  async diagnostics(): Promise<AdapterDiagnostics | null> {
    if (!this.#hasSchema()) return null;
    const meta = this.#readMeta();
    const sql = this.ctx.storage.sql;
    const pendingRow = sql
      .exec<{ n: number; oldest: string | null }>(
        "SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM deliveries",
      )
      .toArray()[0];
    const linkRows = sql
      .exec<{ status: string; n: number }>(
        "SELECT status, COUNT(*) AS n FROM links GROUP BY status",
      )
      .toArray();
    const links = { final: 0, provisional: 0 };
    for (const row of linkRows) {
      if (row.status === "final") links.final = row.n;
      if (row.status === "provisional") links.provisional = row.n;
    }
    const subjectRows = sql
      .exec<{ followed: number; n: number }>(
        "SELECT followed, COUNT(*) AS n FROM subjects GROUP BY followed",
      )
      .toArray();
    const subjects = { followed: 0, unfollowed: 0 };
    for (const row of subjectRows) {
      if (row.followed === 1) subjects.followed = row.n;
      else subjects.unfollowed = row.n;
    }
    const counters: Record<string, number> = {};
    for (const row of sql
      .exec<{ name: string; value: number }>("SELECT name, value FROM counters")
      .toArray()) {
      counters[row.name] = row.value;
    }
    const ledger = sql
      .exec<{ reason: string; event_type: string; http_status: number | null; occurred_at: string }>(
        "SELECT reason, event_type, http_status, occurred_at FROM ledger ORDER BY entry_id DESC LIMIT 20",
      )
      .toArray()
      .map((row) => ({
        reason: row.reason,
        eventType: row.event_type,
        httpStatus: row.http_status,
        occurredAt: row.occurred_at,
      }));
    return {
      state: meta.state,
      generation: meta.generation,
      pending: pendingRow?.n ?? 0,
      oldestPendingAt: pendingRow?.oldest ?? null,
      links,
      subjects,
      sweepCursor: meta.sweepCursor,
      purgeCompletedAt: meta.purgeCompletedAt,
      counters,
      ledger,
    };
  }

  // ---- Reservation-scoped link surface (specs plan, decision 6) ----

  /**
   * Mint a link intent for a management-proof-verified reservation, creating
   * or refreshing the provisional link that holds events between consent and
   * finalize. The Worker verifies the management proof against the day before
   * calling; this validates lifecycle state and generation.
   */
  async mintIntent(input: {
    reservationId: string;
    date: string;
    generation: number;
    purgeAt: number;
  }): Promise<{ ok: true; nonce: string; expiresAt: number } | { ok: false; code: "INACTIVE" }> {
    if (
      typeof input !== "object" ||
      input === null ||
      !UUID.test(input.reservationId) ||
      !DATE.test(input.date) ||
      !Number.isSafeInteger(input.generation) ||
      input.generation < 1 ||
      !Number.isSafeInteger(input.purgeAt) ||
      input.purgeAt <= 0
    ) {
      throw new Error("bad intent input");
    }
    if (!this.#hasSchema()) return { ok: false, code: "INACTIVE" };
    if (input.purgeAt <= Date.now()) return { ok: false, code: "INACTIVE" };
    // 256 bits, handed to the customer once and never stored in the clear: the
    // table keeps only its digest, so a storage read cannot replay a link.
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const nonce = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    const nonceDigest = await digestHex(nonce);
    const expiresAt = Math.min(
      Date.now() + ADAPTER.INTENT_NONCE_TTL_S * 1000,
      input.purgeAt,
    );
    await this.#armAlarm(Date.now() + ADAPTER.PROVISIONAL_LINK_TTL_S * 1000);
    return this.ctx.storage.transactionSync(() => {
      const meta = this.#readMeta();
      if (meta.state !== "active" || meta.generation !== input.generation) {
        return { ok: false as const, code: "INACTIVE" as const };
      }
      const sql = this.ctx.storage.sql;
      sql.exec("DELETE FROM intents WHERE reservation_id = ? OR expires_at < ?",
        input.reservationId, Date.now());
      sql.exec(
        `INSERT INTO intents (nonce, reservation_id, date, generation, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
        nonceDigest, input.reservationId, input.date, input.generation, expiresAt,
      );
      const existing = sql
        .exec<{ status: string }>(
          "SELECT status FROM links WHERE reservation_id = ?",
          input.reservationId,
        )
        .toArray()[0];
      // A final link stays untouched until finalize decides no-op vs
      // conflict; otherwise (re)create the provisional holder.
      if (existing === undefined || existing.status === "provisional") {
        sql.exec(
          `INSERT INTO links
             (reservation_id, date, subject, status, generation, watermark_seq, link_version, created_at, finalized_at, expires_at, purge_at)
           VALUES (?, ?, '', 'provisional', ?, 0, 0, ?, NULL, ?, ?)
           ON CONFLICT(reservation_id) DO UPDATE SET
             generation = excluded.generation,
             created_at = excluded.created_at,
             expires_at = excluded.expires_at,
             purge_at = excluded.purge_at`,
          input.reservationId, input.date, input.generation,
          new Date().toISOString(),
          Date.now() + ADAPTER.PROVISIONAL_LINK_TTL_S * 1000,
          input.purgeAt,
        );
      }
      return { ok: true as const, nonce, expiresAt };
    });
  }

  /** Cheap pre-check before the Worker spends an outbound LINE call. */
  async checkIntent(input: { nonce: string }): Promise<{ ok: boolean }> {
    if (typeof input !== "object" || input === null || !NONCE.test(input.nonce)) {
      return { ok: false };
    }
    if (!this.#hasSchema()) return { ok: false };
    const nonceDigest = await digestHex(input.nonce);
    const meta = this.#readMeta();
    if (meta.state !== "active") return { ok: false };
    const row = this.ctx.storage.sql
      .exec<{ generation: number; expires_at: number; reservation_id: string }>(
        "SELECT generation, expires_at, reservation_id FROM intents WHERE nonce = ?",
        nonceDigest,
      )
      .toArray()[0];
    if (
      row === undefined ||
      row.expires_at < Date.now() ||
      row.generation !== meta.generation
    ) {
      return { ok: false };
    }
    const holder = this.ctx.storage.sql
      .exec<{ purge_at: number | null }>(
        "SELECT purge_at FROM links WHERE reservation_id = ?",
        row.reservation_id,
      )
      .toArray()[0];
    return {
      ok:
        holder !== undefined &&
        holder.purge_at !== null &&
        holder.purge_at > Date.now(),
    };
  }

  /**
   * Complete a link after server-side token verification. Re-checks the
   * intent inside the transaction; the watermark (the day's event sequence at
   * this moment) separates never-delivered prelink events from deliverable
   * ones. Same-subject repeat → no-op; different subject over a final link →
   * surfaced conflict, never an overwrite. Held events for the reservation
   * are re-disposed here through the same disposition rules: at or below the
   * watermark → `ignored-prelink`; above it → queued for delivery.
   */
  async finalizeLink(input: {
    nonce: string;
    subject: string;
  }): Promise<
    | { ok: true; reservationId: string; replayed: boolean }
    | { ok: false; code: "INVALID_INTENT" | "LINK_CONFLICT" | "TEMPORARILY_UNAVAILABLE" }
  > {
    if (
      typeof input !== "object" ||
      input === null ||
      !NONCE.test(input.nonce) ||
      !LINE_SUBJECT.test(input.subject)
    ) {
      return { ok: false, code: "INVALID_INTENT" };
    }
    if (!this.#hasSchema()) return { ok: false, code: "INVALID_INTENT" };
    const nonceDigest = await digestHex(input.nonce);
    const pre = this.ctx.storage.sql
      .exec<{ reservation_id: string; date: string }>(
        "SELECT reservation_id, date FROM intents WHERE nonce = ?",
        nonceDigest,
      )
      .toArray()[0];
    if (pre === undefined) {
      // Counted only while active: priority 0 (disabled) persists nothing.
      if (this.#readMeta().state === "active") {
        this.#bumpCounter("link_failed:invalid-intent", 1);
      }
      return { ok: false, code: "INVALID_INTENT" };
    }
    // Watermark read is a day RPC, so it happens before the local transaction.
    // It is load-bearing: without the day's current sequence there is no fence
    // between pre-link history and post-link events, and defaulting to zero
    // would send the customer their own past. A day that cannot answer means
    // "try again", never "assume nothing has happened yet".
    let watermark: number;
    try {
      const sequence = await this.env.RESERVATION_DAYS.getByName(
        `single-location:${pre.date}`,
      ).readEventSequence();
      if (!Number.isSafeInteger(sequence.eventSeq) || sequence.eventSeq < 0) {
        throw new Error("bad event sequence");
      }
      watermark = sequence.eventSeq;
    } catch {
      // Kept apart from an invalid nonce: a brief day outage and a replay of
      // dead nonces demand opposite responses from whoever reads diagnostics.
      if (this.#readMeta().state === "active") {
        this.#bumpCounter("link_failed:day-unavailable", 1);
      }
      return { ok: false, code: "TEMPORARILY_UNAVAILABLE" };
    }
    await this.#armAlarm(Date.now());
    return this.ctx.storage.transactionSync(() => {
      const meta = this.#readMeta();
      const sql = this.ctx.storage.sql;
      const intent = sql
        .exec<{ reservation_id: string; date: string; generation: number; expires_at: number }>(
          "SELECT reservation_id, date, generation, expires_at FROM intents WHERE nonce = ?",
          nonceDigest,
        )
        .toArray()[0];
      if (
        intent === undefined ||
        meta.state !== "active" ||
        intent.generation !== meta.generation
      ) {
        if (meta.state === "active") {
          this.#bumpCounter("link_failed:invalid-intent", 1);
        }
        return { ok: false as const, code: "INVALID_INTENT" as const };
      }
      const existing = sql
        .exec<{ subject: string; status: string; link_version: number; purge_at: number | null }>(
          "SELECT subject, status, link_version, purge_at FROM links WHERE reservation_id = ?",
          intent.reservation_id,
        )
        .toArray()[0];
      // Missing or unstamped: prune already took the holder. A stamp that has
      // already passed: prune has not run yet, but the boundary still governs.
      if (
        existing === undefined ||
        existing.purge_at === null ||
        existing.purge_at <= Date.now()
      ) {
        sql.exec("DELETE FROM intents WHERE nonce = ?", nonceDigest);
        this.#bumpCounter("link_failed:past-retention", 1);
        return { ok: false as const, code: "INVALID_INTENT" as const };
      }
      if (intent.expires_at < Date.now()) {
        sql.exec("DELETE FROM intents WHERE nonce = ?", nonceDigest);
        this.#bumpCounter("link_failed:invalid-intent", 1);
        return { ok: false as const, code: "INVALID_INTENT" as const };
      }
      sql.exec("DELETE FROM intents WHERE nonce = ?", nonceDigest);
      if (existing.status === "final") {
        if (existing.subject === input.subject) {
          return {
            ok: true as const,
            reservationId: intent.reservation_id,
            replayed: true,
          };
        }
        this.#bumpCounter("link_failed:conflict", 1);
        return { ok: false as const, code: "LINK_CONFLICT" as const };
      }
      const now = new Date().toISOString();
      const linkVersion = existing.link_version + 1;
      const provisionalPurgeAt = existing.purge_at;
      sql.exec(
        `INSERT INTO links
           (reservation_id, date, subject, status, generation, watermark_seq, link_version, created_at, finalized_at, expires_at, purge_at)
         VALUES (?, ?, ?, 'final', ?, ?, ?, ?, ?, NULL, ?)
         ON CONFLICT(reservation_id) DO UPDATE SET
           subject = excluded.subject,
           status = 'final',
           generation = excluded.generation,
           watermark_seq = excluded.watermark_seq,
           link_version = excluded.link_version,
           finalized_at = excluded.finalized_at,
           expires_at = NULL,
           purge_at = excluded.purge_at`,
        intent.reservation_id, intent.date, input.subject, intent.generation,
        watermark, linkVersion, now, now, provisionalPurgeAt,
      );
      sql.exec(
        `INSERT INTO subjects (subject, followed, updated_at) VALUES (?, 1, ?)
         ON CONFLICT(subject) DO NOTHING`,
        input.subject, Date.now(),
      );
      // Re-dispose held events now that the watermark exists.
      const held = sql
        .exec<{ delivery_id: string; event_id: string; type: string }>(
          "SELECT delivery_id, event_id, type FROM deliveries WHERE reservation_id = ? AND status = 'held'",
          intent.reservation_id,
        )
        .toArray();
      for (const row of held) {
        const acceptedSeq = sql
          .exec<{ seq: number }>(
            "SELECT seq FROM accepted_events WHERE event_key = ?",
            row.delivery_id,
          )
          .toArray()[0];
        if (acceptedSeq === undefined || acceptedSeq.seq <= watermark) {
          sql.exec("DELETE FROM deliveries WHERE delivery_id = ?", row.delivery_id);
          this.#bumpCounter("disposition:ignored-prelink", 1);
          continue;
        }
        sql.exec(
          `UPDATE deliveries SET status = ?, link_version = ?, next_attempt_at = ?
           WHERE delivery_id = ?`,
          this.#secretPresent() ? "queued" : "awaiting-configuration",
          linkVersion,
          Date.now(),
          row.delivery_id,
        );
      }
      this.#bumpCounter("links_finalized", 1);
      return { ok: true as const, reservationId: intent.reservation_id, replayed: false };
    });
  }

  /** Management-proof unlink: works in every degraded state, needs nothing
   * from LINE. Pending deliveries for the reservation are discarded in the
   * same transaction (recorded in the redacted ledger), so no push can start
   * after the unlink commit — an in-flight claim finds its row gone and drops
   * the outcome. */
  async unlink(input: { reservationId: string }): Promise<{ ok: true; existed: boolean }> {
    if (typeof input !== "object" || input === null || !UUID.test(input.reservationId)) {
      throw new Error("bad unlink input");
    }
    if (!this.#hasSchema()) return { ok: true, existed: false };
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      const existed =
        sql
          .exec<{ reservation_id: string }>(
            "SELECT reservation_id FROM links WHERE reservation_id = ?",
            input.reservationId,
          )
          .toArray().length > 0;
      const pending = sql
        .exec<{ type: string }>(
          "SELECT type FROM deliveries WHERE reservation_id = ?",
          input.reservationId,
        )
        .toArray();
      for (const row of pending) this.#recordTerminal("unlinked", row.type);
      sql.exec("DELETE FROM deliveries WHERE reservation_id = ?", input.reservationId);
      sql.exec("DELETE FROM links WHERE reservation_id = ?", input.reservationId);
      sql.exec("DELETE FROM intents WHERE reservation_id = ?", input.reservationId);
      sql.exec(
        `DELETE FROM subjects WHERE subject NOT IN (SELECT subject FROM links WHERE status = 'final')`,
      );
      return { ok: true as const, existed };
    });
  }

  /** Presence only — no subject ever leaves this object via this surface. */
  async linkStatus(input: { reservationId: string }): Promise<{
    linked: "final" | "provisional" | null;
  }> {
    if (typeof input !== "object" || input === null || !UUID.test(input.reservationId)) {
      throw new Error("bad link status input");
    }
    if (!this.#hasSchema()) return { linked: null };
    const row = this.ctx.storage.sql
      .exec<{ status: string; expires_at: number | null }>(
        "SELECT status, expires_at FROM links WHERE reservation_id = ?",
        input.reservationId,
      )
      .toArray()[0];
    if (row === undefined) return { linked: null };
    if (
      row.status === "provisional" &&
      row.expires_at !== null &&
      row.expires_at < Date.now()
    ) {
      return { linked: null };
    }
    return { linked: row.status as "final" | "provisional" };
  }

  /**
   * Signature-verified webhook events: dedup by webhookEventId, apply
   * follow/unfollow ordered by timestamp (equal timestamps: unfollow wins —
   * the safe side). An unfollow parks the subject's pending deliveries; a
   * follow re-queues parked ones. Anything while not active is acknowledged
   * with zero persistence (disposition priority 0).
   */
  async processWebhook(input: {
    events: Array<{
      type: "follow" | "unfollow";
      webhookEventId: string;
      timestamp: number;
      userId: string;
      isRedelivery: boolean;
    }>;
  }): Promise<{ ok: true; applied: number; duplicates: number }> {
    if (
      typeof input !== "object" ||
      input === null ||
      !Array.isArray(input.events) ||
      input.events.length > ADAPTER.WEBHOOK_EVENTS_MAX
    ) {
      throw new Error("bad webhook input");
    }
    if (!this.#hasSchema()) return { ok: true, applied: 0, duplicates: 0 };
    await this.#armAlarm(Date.now());
    return this.ctx.storage.transactionSync(() => {
      const meta = this.#readMeta();
      if (meta.state !== "active") return { ok: true as const, applied: 0, duplicates: 0 };
      const sql = this.ctx.storage.sql;
      const now = Date.now();
      let applied = 0;
      let duplicates = 0;
      const ordered = [...input.events].sort((a, b) =>
        a.timestamp !== b.timestamp
          ? a.timestamp - b.timestamp
          : (a.type === "unfollow" ? 1 : 0) - (b.type === "unfollow" ? 1 : 0),
      );
      for (const event of ordered) {
        if (
          !NONCE_FREE_ID.test(event.webhookEventId) ||
          !LINE_SUBJECT.test(event.userId) ||
          !Number.isSafeInteger(event.timestamp)
        ) {
          throw new Error("bad webhook event");
        }
        const inserted = sql.exec(
          `INSERT INTO webhook_dedup (webhook_event_id, seen_at) VALUES (?, ?)
           ON CONFLICT(webhook_event_id) DO NOTHING`,
          event.webhookEventId,
          now,
        );
        if (inserted.rowsWritten === 0) {
          duplicates += 1;
          continue;
        }
        // Deliverability is only worth persisting for a subject this
        // installation can actually send to: an unlinked follower leaves
        // nothing behind but its webhookEventId in the dedup table.
        const linked =
          sql
            .exec<{ n: number }>(
              "SELECT COUNT(*) AS n FROM links WHERE subject = ? AND status = 'final'",
              event.userId,
            )
            .toArray()[0]?.n ?? 0;
        if (linked === 0) {
          applied += 1;
          continue;
        }
        const current = sql
          .exec<{ followed: number; updated_at: number }>(
            "SELECT followed, updated_at FROM subjects WHERE subject = ?",
            event.userId,
          )
          .toArray()[0];
        // Ordered by event timestamp: an older follow can never resurrect a
        // newer unfollow, and an equal-timestamp stored unfollow wins too.
        if (
          current !== undefined &&
          (current.updated_at > event.timestamp ||
            (current.updated_at === event.timestamp &&
              current.followed === 0 &&
              event.type === "follow"))
        ) {
          applied += 1;
          continue;
        }
        sql.exec(
          `INSERT INTO subjects (subject, followed, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(subject) DO UPDATE SET
             followed = excluded.followed,
             updated_at = excluded.updated_at`,
          event.userId,
          event.type === "follow" ? 1 : 0,
          event.timestamp,
        );
        if (event.type === "unfollow") {
          sql.exec(
            `UPDATE deliveries SET status = 'parked', park_reason = 'unfollow'
             WHERE status IN ('queued', 'awaiting-configuration')
               AND reservation_id IN (
                 SELECT reservation_id FROM links WHERE subject = ? AND status = 'final'
               )`,
            event.userId,
          );
        } else {
          sql.exec(
            `UPDATE deliveries SET status = ?, park_reason = NULL, next_attempt_at = ?
             WHERE status = 'parked' AND park_reason = 'unfollow'
               AND reservation_id IN (
                 SELECT reservation_id FROM links WHERE subject = ? AND status = 'final'
               )`,
            this.#secretPresent() ? "queued" : "awaiting-configuration",
            now,
            event.userId,
          );
        }
        applied += 1;
      }
      // Retention: TTL prune plus cap eviction folded into a counter so
      // visibility degrades to counts, never to silence.
      sql.exec(
        "DELETE FROM webhook_dedup WHERE seen_at < ?",
        now - ADAPTER.WEBHOOK_DEDUP_TTL_S * 1000,
      );
      const total =
        sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM webhook_dedup").toArray()[0]
          ?.n ?? 0;
      if (total > ADAPTER.WEBHOOK_DEDUP_CAP) {
        const excess = total - ADAPTER.WEBHOOK_DEDUP_CAP;
        sql.exec(
          `DELETE FROM webhook_dedup WHERE webhook_event_id IN (
             SELECT webhook_event_id FROM webhook_dedup ORDER BY seen_at ASC LIMIT ?
           )`,
          excess,
        );
        this.#bumpCounter("webhook_dedup_evicted", excess);
      }
      return { ok: true as const, applied, duplicates };
    });
  }

  /** Bounded signature-failure counter: one 24 h window at a time. */
  async noteSignatureFailure(): Promise<{ ok: true }> {
    // Unauthenticated callers reach this. The schema exists whenever the route
    // is reachable (activation creates it), so a bad signature must never be
    // the request that builds it.
    if (!this.#hasSchema()) return { ok: true };
    this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      const windowStart = sql
        .exec<{ value: number }>(
          "SELECT value FROM counters WHERE name = 'sigfail_window_start'",
        )
        .toArray()[0];
      const now = Date.now();
      if (
        windowStart === undefined ||
        windowStart.value < now - ADAPTER.SIGFAIL_WINDOW_S * 1000
      ) {
        sql.exec(
          `INSERT INTO counters (name, value) VALUES ('sigfail_window_start', ?)
           ON CONFLICT(name) DO UPDATE SET value = excluded.value`,
          now,
        );
        sql.exec(
          `INSERT INTO counters (name, value) VALUES ('sigfail', 1)
           ON CONFLICT(name) DO UPDATE SET value = 1`,
        );
      } else {
        this.#bumpCounter("sigfail", 1);
      }
    });
    return { ok: true };
  }

  // ---- Lifecycle authority surface (driven by the InstallationConfig saga) ----

  /**
   * Activate a generation. Strictly-above-high-water is enforced here, at the
   * authority, so no saga replay or delayed RPC can ever re-activate or reuse
   * a generation — the property the persistent high-water exists for. The
   * snapshot (messaging channel, no secret) lets alarms send without any
   * config read.
   */
  async activate(input: {
    generation: number;
    watermark: number;
    snapshot?: AdapterSnapshot;
    // Names the saga operation this activation belongs to. A re-driven
    // operation reports the activation it already performed instead of
    // burning another generation.
    operationId?: string;
  }): Promise<{ ok: true; meta: AdapterDeliveryMeta } | { ok: false; code: "STALE_GENERATION" }> {
    if (
      typeof input !== "object" ||
      input === null ||
      (input.operationId !== undefined && !UUID.test(input.operationId)) ||
      !Number.isSafeInteger(input.generation) ||
      input.generation < 1 ||
      !Number.isSafeInteger(input.watermark) ||
      input.watermark < 0 ||
      (input.snapshot !== undefined &&
        (typeof input.snapshot !== "object" ||
          input.snapshot === null ||
          typeof input.snapshot.messagingChannelId !== "string"))
    ) {
      throw new Error("bad activate input");
    }
    this.#ensureSchema();
    await this.#armAlarm(Date.now() + ADAPTER.SWEEP_REARM_DELAY_S * 1000);
    return this.ctx.storage.transactionSync(() => {
      const meta = this.#readMeta();
      const sql = this.ctx.storage.sql;
      if (input.operationId !== undefined) {
        const previous = sql
          .exec<{ value: number }>(
            "SELECT value FROM counters WHERE name = ?",
            `activation:${input.operationId}`,
          )
          .toArray()[0];
        if (previous !== undefined) {
          // Same operation, already activated: report that activation rather
          // than minting a second generation for one operator command.
          return meta.state === "active" && meta.generation === previous.value
            ? { ok: true as const, meta }
            : { ok: false as const, code: "STALE_GENERATION" as const };
        }
      }
      if (input.generation <= meta.highWater) return { ok: false as const, code: "STALE_GENERATION" as const };
      if (input.operationId !== undefined) {
        sql.exec(
          `INSERT INTO counters (name, value) VALUES (?, ?)
           ON CONFLICT(name) DO UPDATE SET value = excluded.value`,
          `activation:${input.operationId}`,
          input.generation,
        );
      }
      this.ctx.storage.sql.exec(
        `UPDATE meta SET state = 'active', generation = ?, high_water = ?, watermark = ?,
                updated_at = ?, snapshot_json = ?, begin_disable_at = NULL,
                purge_completed_at = NULL, sweep_cursor = NULL, cycle_started_at = NULL
         WHERE singleton = 1`,
        input.generation,
        input.generation,
        input.watermark,
        new Date().toISOString(),
        input.snapshot === undefined ? null : JSON.stringify(input.snapshot),
      );
      return { ok: true as const, meta: this.#readMeta() };
    });
  }

  /**
   * Disable saga entry: stop accepting the current generation's new work and
   * start the purge pass. Idempotent — a re-call reports purge progress; the
   * saga polls it until `purgeComplete`.
   */
  async beginDisable(): Promise<{
    ok: true;
    meta: AdapterDeliveryMeta;
    purgeComplete: boolean;
  }> {
    this.#ensureSchema();
    await this.#armAlarm(Date.now());
    this.ctx.storage.transactionSync(() => {
      const meta = this.#readMeta();
      if (meta.state === "active") {
        this.ctx.storage.sql.exec(
          `UPDATE meta SET state = 'deactivating', updated_at = ?, begin_disable_at = ?,
                  purge_completed_at = NULL, sweep_cursor = NULL, cycle_started_at = NULL
           WHERE singleton = 1`,
          new Date().toISOString(),
          Date.now(),
        );
      }
    });
    const meta = this.#readMeta();
    return { ok: true, meta, purgeComplete: meta.purgeCompletedAt !== null };
  }

  /**
   * Disable saga completion. Refused (state stays `deactivating`) until a full
   * sweep purge pass that started after `beginDisableAt + FINAL_PASS_LEASE_WAIT_S`
   * has finished — every issued descriptor lease has then provably expired and
   * every day partition has been visited and purged. Clears every
   * personal/event row; the meta row (with its high-water) and the
   * TTL-bounded non-identifying stores are what remains.
   */
  async completeDisable(): Promise<{ ok: true; meta: AdapterDeliveryMeta }> {
    this.#ensureSchema();
    this.ctx.storage.transactionSync(() => {
      const meta = this.#readMeta();
      if (meta.state !== "deactivating" || meta.purgeCompletedAt === null) return;
      const sql = this.ctx.storage.sql;
      const pending = sql
        .exec<{ type: string }>("SELECT type FROM deliveries")
        .toArray();
      for (const row of pending) this.#recordTerminal("disabled", row.type);
      sql.exec("DELETE FROM links");
      sql.exec("DELETE FROM deliveries");
      sql.exec("DELETE FROM accepted_events");
      sql.exec("DELETE FROM intents");
      sql.exec("DELETE FROM subjects");
      sql.exec("DELETE FROM counters WHERE name GLOB 'activation:*'");
      sql.exec(
        `UPDATE meta SET state = 'disabled', updated_at = ?, snapshot_json = NULL,
                sweep_cursor = NULL, cycle_started_at = NULL
         WHERE singleton = 1`,
        new Date().toISOString(),
      );
    });
    const meta = this.#readMeta();
    if (meta.state === "disabled") {
      // Re-derive the alarm from the remaining TTL stores so a completed
      // disable with drained stores immediately satisfies the disarm
      // invariant instead of waiting for a leftover wake-up to clear it.
      const due = this.#nextDue(Date.now());
      if (due === null) await this.ctx.storage.deleteAlarm();
      else await this.ctx.storage.setAlarm(due);
    }
    return { ok: true, meta };
  }

  // ---- the alarm engine: sends, recovery, sweep, purge, retention ----

  /** Recover expired send claims; the same retry key makes the repeat safe. */
  #recoverExpiredClaims(now: number): void {
    this.ctx.storage.sql.exec(
      `UPDATE deliveries SET status = 'queued', claimed_at = NULL
       WHERE status = 'sending' AND claimed_at < ?`,
      now - ADAPTER.SEND_CLAIM_LEASE_S * 1000,
    );
  }

  /** Move awaiting-configuration rows toward recovery or their deadline. */
  #reconcileAwaitingConfiguration(now: number): void {
    const sql = this.ctx.storage.sql;
    if (this.#secretPresent()) {
      sql.exec(
        `UPDATE deliveries SET status = 'queued', next_attempt_at = ?
         WHERE status = 'awaiting-configuration'`,
        now,
      );
      return;
    }
    // First-pushed rows terminalize before their retry-key window closes; a
    // never-pushed row waits (bounded by the retention prune).
    const expired = sql
      .exec<{ delivery_id: string; type: string }>(
        `SELECT delivery_id, type FROM deliveries
         WHERE status = 'awaiting-configuration' AND first_attempt_at IS NOT NULL
           AND first_attempt_at < ?`,
        now - (ADAPTER.RETRY_KEY_VALIDITY_S - ADAPTER.RETRY_KEY_SAFETY_MARGIN_S) * 1000,
      )
      .toArray();
    for (const row of expired) {
      this.#recordTerminal("configuration-lost", row.type);
      sql.exec("DELETE FROM deliveries WHERE delivery_id = ?", row.delivery_id);
    }
  }

  /** Expire provisional links; their held events resolve to a defined,
   * non-identifying outcome (`ignored-unfinalized`) before deletion. */
  #expireProvisionalLinks(now: number): void {
    const sql = this.ctx.storage.sql;
    const expired = sql
      .exec<{ reservation_id: string }>(
        "SELECT reservation_id FROM links WHERE status = 'provisional' AND expires_at IS NOT NULL AND expires_at < ?",
        now,
      )
      .toArray();
    for (const link of expired) {
      const held = sql.exec(
        "DELETE FROM deliveries WHERE reservation_id = ? AND status = 'held'",
        link.reservation_id,
      ).rowsWritten;
      if (held > 0) this.#bumpCounter("disposition:ignored-unfinalized", held);
      sql.exec("DELETE FROM links WHERE reservation_id = ?", link.reservation_id);
    }
  }

  /** TTL and cap pruning for the non-identifying stores, plus the ultra-bound
   * retention cascade for anything older than the largest possible window. */
  #pruneRetention(now: number): void {
    const sql = this.ctx.storage.sql;
    sql.exec("DELETE FROM intents WHERE expires_at < ?", now);
    sql.exec(
      "DELETE FROM ledger WHERE occurred_at < ?",
      new Date(now - ADAPTER.LEDGER_TTL_S * 1000).toISOString(),
    );
    const ledgerCount =
      sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM ledger").toArray()[0]?.n ?? 0;
    if (ledgerCount > ADAPTER.LEDGER_CAP) {
      const excess = ledgerCount - ADAPTER.LEDGER_CAP;
      sql.exec(
        `DELETE FROM ledger WHERE entry_id IN (
           SELECT entry_id FROM ledger ORDER BY entry_id ASC LIMIT ?
         )`,
        excess,
      );
      this.#bumpCounter("ledger_evicted", excess);
    }
    sql.exec(
      "DELETE FROM webhook_dedup WHERE seen_at < ?",
      now - ADAPTER.WEBHOOK_DEDUP_TTL_S * 1000,
    );
    // Reservation-scoped rows die with their parent: every one carries the
    // partition's own purgeAt, so a linked LINE user ID can never outlive the
    // reservation that justified holding it. The date floor below stays as a
    // backstop for rows that predate the stamp or somehow lack one.
    const expired = sql
      .exec<{ delivery_id: string; type: string }>(
        "SELECT delivery_id, type FROM deliveries WHERE purge_at IS NOT NULL AND purge_at <= ?",
        now,
      )
      .toArray();
    for (const row of expired) {
      this.#recordTerminal("retention", row.type);
      sql.exec("DELETE FROM deliveries WHERE delivery_id = ?", row.delivery_id);
    }
    sql.exec("DELETE FROM links WHERE purge_at IS NOT NULL AND purge_at <= ?", now);
    const boundary = dateOffset(
      new Date(now).toISOString().slice(0, 10),
      -ADAPTER.SWEEP_PAST_DAYS,
    );
    const stale = sql
      .exec<{ delivery_id: string; type: string }>(
        "SELECT delivery_id, type FROM deliveries WHERE date < ?",
        boundary,
      )
      .toArray();
    for (const row of stale) {
      this.#recordTerminal("retention", row.type);
      sql.exec("DELETE FROM deliveries WHERE delivery_id = ?", row.delivery_id);
    }
    sql.exec("DELETE FROM links WHERE date < ?", boundary);
    sql.exec("DELETE FROM accepted_events WHERE date < ?", boundary);
    // A LINE user ID is held only to reach a linked reservation. Once the last
    // link for a subject is gone, so is the reason to remember the subject.
    sql.exec(
      `DELETE FROM subjects WHERE subject NOT IN (SELECT subject FROM links WHERE status = 'final')`,
    );
  }

  /** One bounded send pass: mint, claim, push, settle. Active state only. */
  async #sendDue(now: number): Promise<void> {
    const meta = this.#readMeta();
    if (meta.state !== "active" || meta.snapshot === null || !this.#secretPresent()) {
      return;
    }
    const snapshot = meta.snapshot;
    const secret = this.env.LINE_MESSAGING_CHANNEL_SECRET as string;
    const due = this.ctx.storage.sql
      .exec<DeliveryRow>(
        `SELECT * FROM deliveries WHERE status = 'queued' AND next_attempt_at <= ?
         ORDER BY next_attempt_at ASC LIMIT ?`,
        now,
        ADAPTER.SEND_BATCH,
      )
      .toArray();
    for (const row of due) {
      const token = await mintChannelToken({
        generation: meta.generation,
        channelId: snapshot.messagingChannelId,
        channelSecret: secret,
      });
      // Claim commits with no await before pushMessage: the input gate stays
      // closed from this validation through the start of the outbound fetch.
      const claim = this.ctx.storage.transactionSync(():
        | { subject: string; fragment: MessageFragment; firstAttemptAt: number }
        | null => {
        const sql = this.ctx.storage.sql;
        const current = this.#readMeta();
        if (
          current.state !== "active" ||
          current.generation !== meta.generation ||
          current.snapshot === null ||
          current.snapshot.messagingChannelId !== snapshot.messagingChannelId
        ) {
          return null;
        }
        const fresh = sql
          .exec<DeliveryRow>(
            "SELECT * FROM deliveries WHERE delivery_id = ? AND status = 'queued'",
            row.delivery_id,
          )
          .toArray()[0];
        if (fresh === undefined) return null;
        const claimNow = Date.now();
        // Last check before the message leaves: the parent reservation's
        // retention deadline is a send boundary, not just a prune boundary.
        if (fresh.purge_at !== null && fresh.purge_at <= claimNow) {
          this.#recordTerminal("past-retention", fresh.type);
          sql.exec("DELETE FROM deliveries WHERE delivery_id = ?", fresh.delivery_id);
          return null;
        }
        const link = sql
          .exec<{ subject: string; status: string; link_version: number }>(
            "SELECT subject, status, link_version FROM links WHERE reservation_id = ?",
            fresh.reservation_id,
          )
          .toArray()[0];
        if (link === undefined || link.status !== "final" || link.link_version !== fresh.link_version) {
          this.#recordTerminal("unlinked", fresh.type);
          sql.exec("DELETE FROM deliveries WHERE delivery_id = ?", fresh.delivery_id);
          return null;
        }
        const subjectRow = sql
          .exec<{ followed: number }>(
            "SELECT followed FROM subjects WHERE subject = ?",
            link.subject,
          )
          .toArray()[0];
        if (subjectRow !== undefined && subjectRow.followed === 0) {
          sql.exec(
            "UPDATE deliveries SET status = 'parked', park_reason = 'unfollow' WHERE delivery_id = ?",
            fresh.delivery_id,
          );
          return null;
        }
        const firstAttemptAt = fresh.first_attempt_at ?? claimNow;
        sql.exec(
          "UPDATE deliveries SET status = 'sending', claimed_at = ?, first_attempt_at = ? WHERE delivery_id = ?",
          claimNow,
          firstAttemptAt,
          fresh.delivery_id,
        );
        const fragment = JSON.parse(fresh.payload_json) as MessageFragment;
        return { subject: link.subject, fragment, firstAttemptAt };
      });
      if (claim === null) continue;

      let outcome:
        | { kind: "sent" }
        | { kind: "retryable"; status: number | null }
        | { kind: "terminal"; reason: string; status: number | null }
        | { kind: "awaiting" };
      if (!token.ok) {
        outcome =
          token.code === "RETRYABLE"
            ? { kind: "retryable", status: null }
            : { kind: "awaiting" };
      } else {
        const push = await pushMessage({
          accessToken: token.accessToken,
          to: claim.subject,
          messages: serializeMessageV1(claim.fragment),
          retryKey: row.retry_key,
        });
        if (push.ok) outcome = { kind: "sent" };
        else if (push.code === "RETRYABLE") {
          outcome = { kind: "retryable", status: push.status };
        } else if (push.code === "CONFIG_REJECTED") {
          // Credentials the operator must fix: park it visibly instead of
          // spending the retry ladder on the same rejection.
          outcome = { kind: "awaiting" };
        } else {
          outcome = { kind: "terminal", reason: "rejected", status: push.status };
        }
      }

      // Outcome transaction: if the row is no longer ours (unlink or disable
      // raced the fetch), drop the outcome — the send was retry-key safe.
      this.ctx.storage.transactionSync(() => {
        const sql = this.ctx.storage.sql;
        const fresh = sql
          .exec<DeliveryRow>(
            "SELECT * FROM deliveries WHERE delivery_id = ? AND status = 'sending'",
            row.delivery_id,
          )
          .toArray()[0];
        if (fresh === undefined) return;
        if (outcome.kind === "sent") {
          sql.exec("DELETE FROM deliveries WHERE delivery_id = ?", fresh.delivery_id);
          this.#bumpCounter("delivered", 1);
          return;
        }
        if (outcome.kind === "terminal") {
          this.#recordTerminal(outcome.reason, fresh.type, outcome.status);
          sql.exec("DELETE FROM deliveries WHERE delivery_id = ?", fresh.delivery_id);
          return;
        }
        if (outcome.kind === "awaiting") {
          // A rejection of the credentials themselves still counts as an
          // attempt: without that, the five-minute configuration recheck would
          // re-push the same doomed message until the retry-key window closed.
          const configAttempts = fresh.attempt + 1;
          if (configAttempts >= ADAPTER.RETRY_OFFSETS_S.length) {
            this.#recordTerminal("configuration-lost", fresh.type);
            sql.exec("DELETE FROM deliveries WHERE delivery_id = ?", fresh.delivery_id);
            return;
          }
          sql.exec(
            `UPDATE deliveries SET status = 'awaiting-configuration', claimed_at = NULL,
                    attempt = ? WHERE delivery_id = ?`,
            configAttempts,
            fresh.delivery_id,
          );
          return;
        }
        const attempts = fresh.attempt + 1;
        if (attempts >= ADAPTER.RETRY_OFFSETS_S.length) {
          // Preserve the final provider status when a retryable outage uses up
          // the ladder.
          this.#recordTerminal("retry-exhausted", fresh.type, outcome.status);
          sql.exec("DELETE FROM deliveries WHERE delivery_id = ?", fresh.delivery_id);
          return;
        }
        // Absolute ladder from the first attempt, not now+delta — the whole
        // schedule stays inside the 24 h retry-key window by construction.
        const nextAt =
          claim.firstAttemptAt + (ADAPTER.RETRY_OFFSETS_S[attempts] as number) * 1000;
        sql.exec(
          `UPDATE deliveries SET status = 'queued', claimed_at = NULL, attempt = ?,
                  next_attempt_at = ? WHERE delivery_id = ?`,
          attempts,
          Math.max(nextAt, now + 1000),
          fresh.delivery_id,
        );
      });
    }
  }

  /**
   * One sweep batch over the fixed worst-case window
   * [today − SWEEP_PAST_DAYS, today + SWEEP_FUTURE_DAYS] — a deliberate
   * superset of every configurable retention/horizon window, so the authority
   * needs no config read; days that never emitted return immediately from
   * `drainOutbox` without creating anything. During `deactivating` each visit
   * also purges the day's LINE consumer rows; a cycle that both started after
   * the lease-expiry wait and finished marks the purge complete.
   */
  async #sweepStep(now: number): Promise<void> {
    const meta = this.#readMeta();
    if (meta.state !== "active" && meta.state !== "deactivating") return;
    const today = new Date(now).toISOString().slice(0, 10);
    const windowStart = dateOffset(today, -ADAPTER.SWEEP_PAST_DAYS);
    const windowEnd = dateOffset(today, ADAPTER.SWEEP_FUTURE_DAYS);
    let cursor = meta.sweepCursor;
    if (cursor === null || cursor < windowStart || cursor > windowEnd) {
      cursor = windowStart;
      this.ctx.storage.sql.exec(
        "UPDATE meta SET sweep_cursor = ?, cycle_started_at = ? WHERE singleton = 1",
        cursor,
        now,
      );
    }
    let faulted = false;
    for (let visited = 0; visited < ADAPTER.SWEEP_DAY_BATCH; visited += 1) {
      if (cursor > windowEnd) break;
      const date = cursor;
      const stub = this.env.RESERVATION_DAYS.getByName(`single-location:${date}`);
      try {
        const batch = await withDeadline(
          stub.drainOutbox({ consumer: "line", limit: ADAPTER.OUTBOX_DRAIN_BATCH }),
          ADAPTER.SWEEP_RPC_DEADLINE_MS,
        );
        if (batch.events.length > 0) {
          await this.#armAlarm(Date.now());
          this.#acceptBatch(batch.events);
          await withDeadline(
            stub.ackOutbox({
              consumer: "line",
              eventIds: batch.events.map(({ eventId }) => eventId),
            }),
            ADAPTER.SWEEP_RPC_DEADLINE_MS,
          );
        }
        if (this.#readMeta().state === "deactivating") {
          await withDeadline(
            stub.purgeConsumer({ consumer: "line" }),
            ADAPTER.SWEEP_RPC_DEADLINE_MS,
          );
        }
      } catch {
        // Deadline or transient failure: leave the cursor on this day (one
        // fault-budget failure); the next run re-drives the batch.
        this.#bumpCounter("sweep_faults", 1);
        faulted = true;
        break;
      }
      cursor = dateOffset(cursor, 1);
    }
    this.ctx.storage.transactionSync(() => {
      const current = this.#readMeta();
      if (current.state !== "active" && current.state !== "deactivating") return;
      const sql = this.ctx.storage.sql;
      if (!faulted && cursor > windowEnd) {
        const cycleStartRow = sql
          .exec<{ cycle_started_at: number | null }>(
            "SELECT cycle_started_at FROM meta WHERE singleton = 1",
          )
          .toArray()[0];
        const cycleStartedAt = cycleStartRow?.cycle_started_at ?? null;
        const leaseWaitOver =
          current.beginDisableAt !== null &&
          cycleStartedAt !== null &&
          cycleStartedAt >= current.beginDisableAt + ADAPTER.FINAL_PASS_LEASE_WAIT_S * 1000;
        sql.exec(
          "UPDATE meta SET sweep_cursor = NULL, cycle_started_at = NULL WHERE singleton = 1",
        );
        if (current.state === "deactivating" && leaseWaitOver) {
          sql.exec("UPDATE meta SET purge_completed_at = ? WHERE singleton = 1", now);
        }
      } else {
        sql.exec("UPDATE meta SET sweep_cursor = ? WHERE singleton = 1", cursor);
      }
    });
  }

  /** Earliest moment any stored work becomes due, or null when none exists. */
  #nextDue(now: number): number | null {
    const sql = this.ctx.storage.sql;
    const meta = this.#readMeta();
    const candidates: number[] = [];
    if (meta.state === "active" || meta.state === "deactivating") {
      candidates.push(now + ADAPTER.SWEEP_REARM_DELAY_S * 1000);
    }
    if (meta.state === "active") {
      const queued = sql
        .exec<{ due: number | null }>(
          "SELECT MIN(next_attempt_at) AS due FROM deliveries WHERE status = 'queued'",
        )
        .toArray()[0];
      if (queued?.due != null) candidates.push(Math.max(queued.due, now + 1000));
      const awaiting = sql
        .exec<{ n: number }>(
          "SELECT COUNT(*) AS n FROM deliveries WHERE status = 'awaiting-configuration'",
        )
        .toArray()[0];
      if ((awaiting?.n ?? 0) > 0) candidates.push(now + ADAPTER.CONFIG_RECHECK_S * 1000);
    }
    const sending = sql
      .exec<{ due: number | null }>(
        "SELECT MIN(claimed_at) AS due FROM deliveries WHERE status = 'sending'",
      )
      .toArray()[0];
    if (sending?.due != null) {
      candidates.push(sending.due + ADAPTER.SEND_CLAIM_LEASE_S * 1000);
    }
    const provisional = sql
      .exec<{ due: number | null }>(
        "SELECT MIN(expires_at) AS due FROM links WHERE status = 'provisional' AND expires_at IS NOT NULL",
      )
      .toArray()[0];
    if (provisional?.due != null) candidates.push(provisional.due);
    // TTL stores: while anything remains, wake at least by its expiry so the
    // disabled-and-drained state truly ends with no alarm scheduled.
    const oldestLedger = sql
      .exec<{ oldest: string | null }>("SELECT MIN(occurred_at) AS oldest FROM ledger")
      .toArray()[0];
    if (oldestLedger?.oldest != null) {
      candidates.push(Date.parse(oldestLedger.oldest) + ADAPTER.LEDGER_TTL_S * 1000);
    }
    const oldestDedup = sql
      .exec<{ oldest: number | null }>("SELECT MIN(seen_at) AS oldest FROM webhook_dedup")
      .toArray()[0];
    if (oldestDedup?.oldest != null) {
      candidates.push(oldestDedup.oldest + ADAPTER.WEBHOOK_DEDUP_TTL_S * 1000);
    }
    if (candidates.length === 0) return null;
    return Math.max(Math.min(...candidates), now + 1000);
  }

  /**
   * All timed behavior, reconstructed from storage alone: claim recovery,
   * configuration reconciliation, provisional expiry, retention pruning, due
   * sends, and one sweep batch — then re-arm at the earliest remaining work.
   * `disabled` with drained TTL stores schedules nothing (the disarm
   * invariant used by a compatible forward backout).
   */
  override async alarm(): Promise<void> {
    if (!this.#hasSchema()) return;
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      this.#recoverExpiredClaims(now);
      this.#reconcileAwaitingConfiguration(now);
      this.#expireProvisionalLinks(now);
      this.#pruneRetention(now);
    });
    await this.#sendDue(now);
    await this.#sweepStep(now);
    const due = this.#nextDue(Date.now());
    if (due !== null) await this.ctx.storage.setAlarm(due);
  }
}
