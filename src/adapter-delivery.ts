import { DurableObject } from "cloudflare:workers";

import { ADAPTER } from "./adapter-constants.ts";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NONCE = /^[0-9a-f]{32}$/;
const LINE_SUBJECT = /^U[0-9a-f]{32}$/;
const NONCE_FREE_ID = /^[0-9A-Za-z-]{1,64}$/;

// Delivery states a row in `deliveries` can hold. Terminal rows move their
// reason into the redacted ledger and keep no payload.
export type AdapterState = "never" | "active" | "deactivating" | "disabled";

export type AdapterDeliveryMeta = {
  state: AdapterState;
  generation: number;
  // Authoritative high-water of every generation ever activated. Survives
  // disable and rollback (storage persists — specs/003-line-adapter/research.md
  // R5); re-enable always mints strictly above it.
  highWater: number;
  // Day event sequence recorded at activation: events at or below it predate
  // the installation's links and are never delivered retroactively.
  watermark: number;
  updatedAt: string;
};

export type PokeDayInput = { date: string };
export type PokeDayResult = { ok: true; drained: number };

/**
 * Installation-singleton delivery and lifecycle authority for the LINE
 * adapter. Owns links, deliveries, webhook dedup, the redacted terminal
 * ledger, and the authoritative generation high-water. Isolated from the
 * reservation core: nothing here is on any booking path, and every timed
 * behavior runs on this object's own alarm (reservation-day alarms are
 * untouched by the whole feature).
 *
 * Invariant (tested): once `state` is `disabled` and the TTL stores are empty,
 * no alarm remains scheduled — a rollback that removes this class from the
 * Worker then leaves no pending alarm behind (research R5).
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

  // Idempotent on every call: CREATE IF NOT EXISTS per table, so a later
  // release adding a table needs no migration machinery.
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
          updated_at TEXT NOT NULL
        )
      `);
      sql.exec(`
        CREATE TABLE IF NOT EXISTS accepted_events (
          event_id TEXT PRIMARY KEY,
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
          expires_at INTEGER
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
          status TEXT NOT NULL CHECK (status IN ('queued', 'awaiting-configuration')),
          created_at TEXT NOT NULL
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
      }>(
        "SELECT state, generation, high_water, watermark, updated_at FROM meta WHERE singleton = 1",
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
    return {
      state: row.state as AdapterState,
      generation: row.generation,
      highWater: row.high_water,
      watermark: row.watermark,
      updatedAt: row.updated_at,
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
        this.ctx.storage.transactionSync(() => {
          for (const event of batch.events) {
            const seen = this.ctx.storage.sql
              .exec<{ event_id: string }>(
                "SELECT event_id FROM accepted_events WHERE event_id = ?",
                event.eventId,
              )
              .toArray();
            if (seen.length > 0) continue;
            // Disposition skeleton: the full priority order lands with the
            // delivery pipeline; the foundation only distinguishes stale
            // generations from acceptable events and records the outcome.
            const disposition =
              event.generation !== meta.generation ? "canceled" : "accepted";
            this.ctx.storage.sql.exec(
              `INSERT INTO accepted_events (event_id, date, generation, seq, disposition, accepted_at)
               VALUES (?, ?, ?, ?, ?, ?)`,
              event.eventId,
              event.date,
              event.generation,
              event.seq,
              disposition,
              new Date().toISOString(),
            );
            this.#bumpCounter(`disposition:${disposition}`, 1);
          }
        });
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
  }): Promise<{ ok: true; nonce: string; expiresAt: number } | { ok: false; code: "INACTIVE" }> {
    if (
      typeof input !== "object" ||
      input === null ||
      !UUID.test(input.reservationId) ||
      !DATE.test(input.date) ||
      !Number.isSafeInteger(input.generation) ||
      input.generation < 1
    ) {
      throw new Error("bad intent input");
    }
    if (!this.#hasSchema()) return { ok: false, code: "INACTIVE" };
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    const nonce = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    const expiresAt = Date.now() + ADAPTER.INTENT_NONCE_TTL_S * 1000;
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
        nonce, input.reservationId, input.date, input.generation, expiresAt,
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
             (reservation_id, date, subject, status, generation, watermark_seq, link_version, created_at, finalized_at, expires_at)
           VALUES (?, ?, '', 'provisional', ?, 0, 0, ?, NULL, ?)
           ON CONFLICT(reservation_id) DO UPDATE SET
             generation = excluded.generation,
             created_at = excluded.created_at,
             expires_at = excluded.expires_at`,
          input.reservationId, input.date, input.generation,
          new Date().toISOString(),
          Date.now() + ADAPTER.PROVISIONAL_LINK_TTL_S * 1000,
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
    const meta = this.#readMeta();
    if (meta.state !== "active") return { ok: false };
    const row = this.ctx.storage.sql
      .exec<{ generation: number; expires_at: number }>(
        "SELECT generation, expires_at FROM intents WHERE nonce = ?",
        input.nonce,
      )
      .toArray()[0];
    return {
      ok:
        row !== undefined &&
        row.expires_at >= Date.now() &&
        row.generation === meta.generation,
    };
  }

  /**
   * Complete a link after server-side token verification. Re-checks the
   * intent inside the transaction; the watermark (the day's event sequence at
   * this moment) separates never-delivered prelink events from deliverable
   * ones. Same-subject repeat → no-op; different subject over a final link →
   * surfaced conflict, never an overwrite.
   */
  async finalizeLink(input: {
    nonce: string;
    subject: string;
  }): Promise<
    | { ok: true; reservationId: string; replayed: boolean }
    | { ok: false; code: "INVALID_INTENT" | "LINK_CONFLICT" }
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
    const pre = this.ctx.storage.sql
      .exec<{ reservation_id: string; date: string }>(
        "SELECT reservation_id, date FROM intents WHERE nonce = ?",
        input.nonce,
      )
      .toArray()[0];
    if (pre === undefined) return { ok: false, code: "INVALID_INTENT" };
    // Watermark read is a day RPC, so it happens before the local transaction.
    let watermark = 0;
    try {
      const sequence = await this.env.RESERVATION_DAYS.getByName(
        `single-location:${pre.date}`,
      ).readEventSequence();
      watermark = sequence.eventSeq;
    } catch {
      // A day that cannot answer has no adapter rows to fence; zero is safe.
    }
    return this.ctx.storage.transactionSync(() => {
      const meta = this.#readMeta();
      const sql = this.ctx.storage.sql;
      const intent = sql
        .exec<{ reservation_id: string; date: string; generation: number; expires_at: number }>(
          "SELECT reservation_id, date, generation, expires_at FROM intents WHERE nonce = ?",
          input.nonce,
        )
        .toArray()[0];
      if (
        intent === undefined ||
        intent.expires_at < Date.now() ||
        meta.state !== "active" ||
        intent.generation !== meta.generation
      ) {
        return { ok: false as const, code: "INVALID_INTENT" as const };
      }
      sql.exec("DELETE FROM intents WHERE nonce = ?", input.nonce);
      const existing = sql
        .exec<{ subject: string; status: string; link_version: number }>(
          "SELECT subject, status, link_version FROM links WHERE reservation_id = ?",
          intent.reservation_id,
        )
        .toArray()[0];
      if (existing !== undefined && existing.status === "final") {
        if (existing.subject === input.subject) {
          return {
            ok: true as const,
            reservationId: intent.reservation_id,
            replayed: true,
          };
        }
        return { ok: false as const, code: "LINK_CONFLICT" as const };
      }
      const now = new Date().toISOString();
      sql.exec(
        `INSERT INTO links
           (reservation_id, date, subject, status, generation, watermark_seq, link_version, created_at, finalized_at, expires_at)
         VALUES (?, ?, ?, 'final', ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(reservation_id) DO UPDATE SET
           subject = excluded.subject,
           status = 'final',
           generation = excluded.generation,
           watermark_seq = excluded.watermark_seq,
           link_version = excluded.link_version,
           finalized_at = excluded.finalized_at,
           expires_at = NULL`,
        intent.reservation_id, intent.date, input.subject, intent.generation,
        watermark, (existing?.link_version ?? 0) + 1, now, now,
      );
      sql.exec(
        `INSERT INTO subjects (subject, followed, updated_at) VALUES (?, 1, ?)
         ON CONFLICT(subject) DO NOTHING`,
        input.subject, Date.now(),
      );
      this.#bumpCounter("links_finalized", 1);
      return { ok: true as const, reservationId: intent.reservation_id, replayed: false };
    });
  }

  /** Management-proof unlink: works in every degraded state, needs nothing
   * from LINE. Queued deliveries resolve their subject at send time, so
   * removing the link is sufficient. */
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
      sql.exec("DELETE FROM links WHERE reservation_id = ?", input.reservationId);
      sql.exec("DELETE FROM intents WHERE reservation_id = ?", input.reservationId);
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
   * follow/unfollow ordered by timestamp. Anything while not active is
   * acknowledged with zero persistence (disposition priority 0).
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
    return this.ctx.storage.transactionSync(() => {
      const meta = this.#readMeta();
      if (meta.state !== "active") return { ok: true as const, applied: 0, duplicates: 0 };
      const sql = this.ctx.storage.sql;
      const now = Date.now();
      let applied = 0;
      let duplicates = 0;
      const ordered = [...input.events].sort((a, b) => a.timestamp - b.timestamp);
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
        sql.exec(
          `INSERT INTO subjects (subject, followed, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(subject) DO UPDATE SET
             followed = excluded.followed,
             updated_at = excluded.updated_at`,
          event.userId,
          event.type === "follow" ? 1 : 0,
          event.timestamp,
        );
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
    this.#ensureSchema();
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
   * a generation — the property the persistent high-water exists for.
   */
  async activate(input: {
    generation: number;
    watermark: number;
  }): Promise<{ ok: true; meta: AdapterDeliveryMeta } | { ok: false; code: "STALE_GENERATION" }> {
    if (
      typeof input !== "object" ||
      input === null ||
      !Number.isSafeInteger(input.generation) ||
      input.generation < 1 ||
      !Number.isSafeInteger(input.watermark) ||
      input.watermark < 0
    ) {
      throw new Error("bad activate input");
    }
    this.#ensureSchema();
    return this.ctx.storage.transactionSync(() => {
      const meta = this.#readMeta();
      if (input.generation <= meta.highWater) return { ok: false as const, code: "STALE_GENERATION" as const };
      this.ctx.storage.sql.exec(
        `UPDATE meta SET state = 'active', generation = ?, high_water = ?, watermark = ?, updated_at = ?
         WHERE singleton = 1`,
        input.generation,
        input.generation,
        input.watermark,
        new Date().toISOString(),
      );
      return { ok: true as const, meta: this.#readMeta() };
    });
  }

  /** Disable saga entry: stop accepting the current generation's new work. */
  async beginDisable(): Promise<{ ok: true; meta: AdapterDeliveryMeta }> {
    this.#ensureSchema();
    this.ctx.storage.transactionSync(() => {
      const meta = this.#readMeta();
      if (meta.state === "active") {
        this.ctx.storage.sql.exec(
          "UPDATE meta SET state = 'deactivating', updated_at = ? WHERE singleton = 1",
          new Date().toISOString(),
        );
      }
    });
    return { ok: true, meta: this.#readMeta() };
  }

  /**
   * Disable saga completion — called only after the purge passes finish.
   * Clears every personal/event row; the meta row (with its high-water) and
   * the TTL-bounded non-identifying stores are what remains.
   */
  async completeDisable(): Promise<{ ok: true; meta: AdapterDeliveryMeta }> {
    this.#ensureSchema();
    this.ctx.storage.transactionSync(() => {
      const meta = this.#readMeta();
      if (meta.state !== "deactivating") return;
      this.ctx.storage.sql.exec("DELETE FROM links");
      this.ctx.storage.sql.exec("DELETE FROM deliveries");
      this.ctx.storage.sql.exec("DELETE FROM accepted_events");
      this.ctx.storage.sql.exec(
        "UPDATE meta SET state = 'disabled', updated_at = ? WHERE singleton = 1",
        new Date().toISOString(),
      );
    });
    return { ok: true, meta: this.#readMeta() };
  }

  override async alarm(): Promise<void> {
    // Timed work (retry schedule, durable sweep, retention pruning) arrives
    // with the delivery pipeline. The handler already follows the contract:
    // reconstruct all work from storage, re-arm only while work remains — so
    // `disabled` with drained stores keeps no alarm scheduled.
    if (!this.#hasSchema()) return;
  }
}
