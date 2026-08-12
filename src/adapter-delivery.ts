import { DurableObject } from "cloudflare:workers";

import { ADAPTER } from "./adapter-constants.ts";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

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

  #ensureSchema(): void {
    if (this.#hasSchema()) return;
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
      sql.exec(
        `INSERT INTO meta (singleton, state, generation, high_water, watermark, updated_at)
         VALUES (1, 'never', 0, 0, 0, ?)`,
        new Date().toISOString(),
      );
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
