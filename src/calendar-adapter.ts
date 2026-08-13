import { DurableObject } from "cloudflare:workers";

import { ADAPTER } from "./adapter-constants.ts";
import { readBoundedBytes } from "./line-adapter.ts";
import type {
  AdapterOutboxEvent,
  DayAdapterDescriptor,
  DayCalendarProjectionResult,
  ReservationDay,
} from "./reservation-day.ts";

const FEED_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTROL = /[\u0000-\u001f\u007f]/;
const GOOGLE_KEYS = ["calendarId", "clientId", "clientSecret", "refreshToken"] as const;
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CALENDAR_BASE_URL = "https://www.googleapis.com/calendar/v3/calendars";
const RESPONSE_MAX_BYTES = 16 * 1024;
const JST_OFFSET_MS = 9 * 60 * 60 * 1_000;
const DAY_MS = 24 * 60 * 60 * 1_000;
const CALENDAR_ROW_CAP = 2_000;
const ACCEPTED_EVENT_CAP = ADAPTER.WEBHOOK_DEDUP_CAP;

declare global {
  interface Env {
    CALENDAR_FEED_TOKEN?: string;
    GOOGLE_CALENDAR_CREDENTIALS?: string;
  }
}

export type GoogleCalendarCredentials = {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  calendarId: string;
};

export type CalendarProjection = {
  uid: string;
  externalId: string;
  startAt: string;
  endAt: string;
  serviceLabel: string;
  status: "tentative" | "confirmed";
};

export const parseCalendarFeedToken = (value: unknown): string | null =>
  typeof value === "string" && FEED_TOKEN.test(value) ? value : null;

const boundedSecret = (value: unknown, max: number): value is string =>
  typeof value === "string" &&
  value.length >= 1 &&
  value.length <= max &&
  value.trim() === value &&
  !CONTROL.test(value);

export const parseGoogleCredentials = (value: unknown): GoogleCalendarCredentials | null => {
  if (typeof value !== "string" || value.length > 16 * 1024) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (
      Object.keys(record).sort().join("\0") !== GOOGLE_KEYS.join("\0") ||
      !boundedSecret(record.clientId, 512) ||
      !boundedSecret(record.clientSecret, 4_096) ||
      !boundedSecret(record.refreshToken, 4_096) ||
      !boundedSecret(record.calendarId, 1_024)
    ) {
      return null;
    }
    return {
      clientId: record.clientId,
      clientSecret: record.clientSecret,
      refreshToken: record.refreshToken,
      calendarId: record.calendarId,
    };
  } catch {
    return null;
  }
};

const sha256Hex = async (value: string): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

export const calendarIdentifiers = async (
  reservationId: string,
): Promise<{ uid: string; externalId: string }> => {
  if (!UUID.test(reservationId)) throw new Error("invalid reservation id");
  const [uid, externalId] = await Promise.all([
    sha256Hex(`ics:${reservationId}`),
    sha256Hex(`google:${reservationId}`),
  ]);
  return {
    uid: `${uid}@example.invalid`,
    externalId: `sr${externalId}`,
  };
};

export const escapeCalendarText = (value: string): string =>
  value
    .replaceAll("\\", "\\\\")
    .replace(/\r\n|\r|\n/g, "\\n")
    .replaceAll(",", "\\,")
    .replaceAll(";", "\\;");

export const foldCalendarLine = (value: string): string => {
  const encoder = new TextEncoder();
  const chunks: string[] = [];
  let chunk = "";
  let max = 75;
  for (const character of value) {
    if (encoder.encode(chunk + character).byteLength > max) {
      chunks.push(chunk);
      chunk = character;
      max = 74;
    } else {
      chunk += character;
    }
  }
  chunks.push(chunk);
  return chunks.map((part, index) => (index === 0 ? part : ` ${part}`)).join("\r\n");
};

const icalTimestamp = (value: string | number): string => {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("invalid calendar timestamp");
  return date.toISOString().replace(/[-:]/g, "").replace(".000", "");
};

export const renderCalendar = (events: CalendarProjection[], now: number): string => {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Salon Reservation OSS//Calendar Feed//EN",
    "CALSCALE:GREGORIAN",
  ];
  for (const event of [...events].sort(
    (left, right) =>
      left.startAt.localeCompare(right.startAt) || left.externalId.localeCompare(right.externalId),
  )) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${event.uid}`,
      `DTSTAMP:${icalTimestamp(now)}`,
      `DTSTART:${icalTimestamp(event.startAt)}`,
      `DTEND:${icalTimestamp(event.endAt)}`,
      `STATUS:${event.status === "tentative" ? "TENTATIVE" : "CONFIRMED"}`,
      `SUMMARY:${escapeCalendarText(event.serviceLabel)}`,
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return `${lines.map(foldCalendarLine).join("\r\n")}\r\n`;
};

export const googleEventUrl = (calendarId: string, eventId?: string): string =>
  `${CALENDAR_BASE_URL}/${encodeURIComponent(calendarId)}/events${
    eventId === undefined ? "" : `/${encodeURIComponent(eventId)}`
  }?sendUpdates=none`;

export const googleEventBody = (
  event: CalendarProjection,
  includeId: boolean,
): Record<string, unknown> => ({
  ...(includeId ? { id: event.externalId } : {}),
  summary: event.serviceLabel,
  status: event.status,
  visibility: "private",
  transparency: "opaque",
  start: { dateTime: event.startAt, timeZone: "Asia/Tokyo" },
  end: { dateTime: event.endAt, timeZone: "Asia/Tokyo" },
});

export const classifyGoogleResponse = (
  status: number,
  reasons: string[] = [],
): "success" | "retryable" | "configuration" | "permanent" => {
  if (status >= 200 && status < 300) return "success";
  if (
    status === 429 ||
    status >= 500 ||
    (status === 403 &&
      reasons.some((reason) =>
        ["rateLimitExceeded", "userRateLimitExceeded"].includes(reason),
      ))
  ) {
    return "retryable";
  }
  if (status === 401 || status === 403) return "configuration";
  return "permanent";
};

export type GoogleTokenResult =
  | { ok: true; accessToken: string; expiresAt: number }
  | { ok: false; kind: "retryable" | "configuration" | "protocol"; status: number | null };

export const requestGoogleAccessToken = async (
  credentials: GoogleCalendarCredentials,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<GoogleTokenResult> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ADAPTER.OUTBOUND_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetcher(TOKEN_URL, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        refresh_token: credentials.refreshToken,
        grant_type: "refresh_token",
      }).toString(),
      signal: controller.signal,
    });
  } catch {
    return { ok: false, kind: "retryable", status: null };
  } finally {
    clearTimeout(timeout);
  }
  if (response.status !== 200) {
    return {
      ok: false,
      kind: response.status >= 500 ? "retryable" : "configuration",
      status: response.status,
    };
  }
  const bytes = await readBoundedBytes(response.body, RESPONSE_MAX_BYTES);
  if (bytes === null) return { ok: false, kind: "protocol", status: response.status };
  try {
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
    const record = parsed as Record<string, unknown>;
    if (
      !boundedSecret(record.access_token, 4_096) ||
      record.token_type !== "Bearer" ||
      !Number.isSafeInteger(record.expires_in) ||
      (record.expires_in as number) < 1 ||
      (record.expires_in as number) > 86_400
    ) {
      throw new Error();
    }
    return {
      ok: true,
      accessToken: record.access_token,
      expiresAt: now + (record.expires_in as number) * 1_000,
    };
  } catch {
    return { ok: false, kind: "protocol", status: response.status };
  }
};

const googleTokenCache = new Map<string, { accessToken: string; expiresAt: number }>();

export const getGoogleAccessToken = async (
  credentials: GoogleCalendarCredentials,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<GoogleTokenResult> => {
  const key = await sha256Hex(JSON.stringify(credentials));
  const cached = googleTokenCache.get(key);
  if (cached !== undefined && cached.expiresAt - now > ADAPTER.TOKEN_CACHE_SAFETY_MS) {
    return { ok: true, ...cached };
  }
  const result = await requestGoogleAccessToken(credentials, fetcher, now);
  if (result.ok) {
    googleTokenCache.clear();
    googleTokenCache.set(key, {
      accessToken: result.accessToken,
      expiresAt: result.expiresAt,
    });
  }
  return result;
};

export const clearGoogleTokenCacheForTests = (): void => googleTokenCache.clear();

type GoogleMutationOutcome =
  | { kind: "success"; status: number }
  | { kind: "retryable"; status: number | null }
  | { kind: "configuration"; status: number | null }
  | { kind: "permanent"; status: number | null };

const googleErrorReasons = async (response: Response): Promise<string[]> => {
  const bytes = await readBoundedBytes(response.body, RESPONSE_MAX_BYTES);
  if (bytes === null) return [];
  try {
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as {
      error?: { errors?: Array<{ reason?: unknown }> };
    };
    const errors = parsed.error?.errors;
    if (!Array.isArray(errors) || errors.length > 8) return [];
    return errors.flatMap(({ reason }) =>
      typeof reason === "string" && reason.length <= 64 && !CONTROL.test(reason)
        ? [reason]
        : [],
    );
  } catch {
    return [];
  }
};

const calendarRequest = async (
  url: string,
  init: RequestInit,
): Promise<Response | null> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ADAPTER.OUTBOUND_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, redirect: "manual", signal: controller.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
};

const responseOutcome = async (response: Response): Promise<GoogleMutationOutcome> => {
  const kind = classifyGoogleResponse(response.status, await googleErrorReasons(response));
  return { kind, status: response.status };
};

const sendGoogleMutation = async (
  credentials: GoogleCalendarCredentials,
  accessToken: string,
  operation: "upsert" | "delete",
  event: CalendarProjection | null,
  externalId: string,
): Promise<GoogleMutationOutcome> => {
  const headers = {
    authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
  };
  if (operation === "delete") {
    const response = await calendarRequest(googleEventUrl(credentials.calendarId, externalId), {
      method: "DELETE",
      headers,
    });
    if (response === null) return { kind: "retryable", status: null };
    if ((response.status >= 200 && response.status < 300) || [404, 410].includes(response.status)) {
      return { kind: "success", status: response.status };
    }
    return responseOutcome(response);
  }
  if (event === null) return { kind: "permanent", status: null };
  const update = () =>
    calendarRequest(googleEventUrl(credentials.calendarId, externalId), {
      method: "PUT",
      headers,
      body: JSON.stringify(googleEventBody(event, false)),
    });
  const first = await update();
  if (first === null) return { kind: "retryable", status: null };
  if (first.status >= 200 && first.status < 300) {
    return { kind: "success", status: first.status };
  }
  if (first.status !== 404) return responseOutcome(first);
  const inserted = await calendarRequest(googleEventUrl(credentials.calendarId), {
    method: "POST",
    headers,
    body: JSON.stringify(googleEventBody(event, true)),
  });
  if (inserted === null) return { kind: "retryable", status: null };
  if (inserted.status >= 200 && inserted.status < 300) {
    return { kind: "success", status: inserted.status };
  }
  if (inserted.status !== 409) return responseOutcome(inserted);
  const converged = await update();
  if (converged === null) return { kind: "retryable", status: null };
  return responseOutcome(converged);
};

type CalendarState = "active" | "deactivating" | "disabled";

type CalendarMeta = {
  state: CalendarState;
  generation: number;
  highWater: number;
  modeFingerprint: string;
  googleConfigured: boolean;
  googleSeen: boolean;
  beginDisableAt: number | null;
  purgeCompletedAt: number | null;
  sweepCursor: string | null;
  lastReconciledAt: string | null;
  reconcileCursor: string | null;
};

type ProjectionRow = {
  reservation_id: string;
  external_id: string;
  uid: string;
  date: string;
  start_at: string;
  end_at: string;
  service_label: string;
  status: "tentative" | "confirmed";
  purge_at: number;
};

type MutationRow = {
  reservation_id: string;
  external_id: string;
  operation: "upsert" | "delete";
  payload_json: string | null;
  desired_version: number;
  generation: number;
  attempt: number;
  next_attempt_at: number | null;
  first_attempt_at: number | null;
  claimed_at: number | null;
  claimed_version: number | null;
  status: "queued" | "sending" | "awaiting-configuration" | "failed";
  purge_at: number;
};

export type CalendarDiagnostics = {
  state: CalendarState;
  generation: number;
  projectionCount: number;
  pendingCount: number;
  failedCount: number;
  oldestPendingAt: string | null;
  lastReconciledAt: string | null;
  reconcileCursor: string | null;
  sweepCursor: string | null;
  purgeCompletedAt: string | null;
  counters: Record<string, number>;
  ledger: Array<{
    reason: string;
    operation: string;
    httpStatus: number | null;
    occurredAt: string;
  }>;
};

export type CalendarFeedResult = { ok: true; body: string } | { ok: false };

const dateJst = (now: number): string => new Date(now + JST_OFFSET_MS).toISOString().slice(0, 10);

const shiftDate = (date: string, days: number): string => {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day) + days * DAY_MS).toISOString().slice(0, 10);
};

const calendarInstant = (date: string, time: string): string =>
  new Date(`${date}T${time}:00+09:00`).toISOString();

const projectionFromRow = (row: ProjectionRow): CalendarProjection => ({
  uid: row.uid,
  externalId: row.external_id,
  startAt: row.start_at,
  endAt: row.end_at,
  serviceLabel: row.service_label,
  status: row.status,
});

const constantTimeTokenMatch = async (left: string, right: string): Promise<boolean> => {
  const [leftDigest, rightDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(left)),
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(right)),
  ]);
  const leftBytes = new Uint8Array(leftDigest);
  const rightBytes = new Uint8Array(rightDigest);
  let difference = 0;
  for (let index = 0; index < leftBytes.byteLength; index += 1) {
    difference |= (leftBytes[index] as number) ^ (rightBytes[index] as number);
  }
  return difference === 0;
};

export class CalendarAdapter extends DurableObject<Env> {
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
    this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      sql.exec(`
        CREATE TABLE meta (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          state TEXT NOT NULL,
          generation INTEGER NOT NULL,
          high_water INTEGER NOT NULL,
          mode_fingerprint TEXT NOT NULL,
          google_configured INTEGER NOT NULL CHECK (google_configured IN (0, 1)),
          google_seen INTEGER NOT NULL CHECK (google_seen IN (0, 1)),
          begin_disable_at INTEGER,
          purge_completed_at INTEGER,
          sweep_cursor TEXT,
          last_reconciled_at TEXT,
          reconcile_cursor TEXT
        )
      `);
      sql.exec(`
        CREATE TABLE accepted_events (
          event_key TEXT PRIMARY KEY,
          reservation_id TEXT NOT NULL,
          generation INTEGER NOT NULL,
          seq INTEGER NOT NULL,
          accepted_at TEXT NOT NULL,
          purge_at INTEGER NOT NULL
        )
      `);
      sql.exec(`
        CREATE TABLE projections (
          reservation_id TEXT PRIMARY KEY,
          external_id TEXT NOT NULL UNIQUE,
          uid TEXT NOT NULL UNIQUE,
          date TEXT NOT NULL,
          start_at TEXT NOT NULL,
          end_at TEXT NOT NULL,
          service_label TEXT NOT NULL,
          status TEXT NOT NULL,
          purge_at INTEGER NOT NULL
        )
      `);
      sql.exec(`
        CREATE TABLE google_mutations (
          reservation_id TEXT PRIMARY KEY,
          external_id TEXT NOT NULL,
          operation TEXT NOT NULL,
          payload_json TEXT,
          desired_version INTEGER NOT NULL,
          generation INTEGER NOT NULL,
          attempt INTEGER NOT NULL,
          next_attempt_at INTEGER,
          first_attempt_at INTEGER,
          claimed_at INTEGER,
          claimed_version INTEGER,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          purge_at INTEGER NOT NULL
        )
      `);
      sql.exec(`
        CREATE TABLE ledger (
          entry_id INTEGER PRIMARY KEY AUTOINCREMENT,
          reason TEXT NOT NULL,
          operation TEXT NOT NULL,
          http_status INTEGER,
          occurred_at TEXT NOT NULL
        )
      `);
      sql.exec(`
        CREATE TABLE counters (
          name TEXT PRIMARY KEY,
          value INTEGER NOT NULL CHECK (value >= 0)
        )
      `);
    });
  }

  #readMeta(): CalendarMeta | null {
    if (!this.#hasSchema()) return null;
    const row = this.ctx.storage.sql
      .exec<{
        state: CalendarState;
        generation: number;
        high_water: number;
        mode_fingerprint: string;
        google_configured: number;
        google_seen: number;
        begin_disable_at: number | null;
        purge_completed_at: number | null;
        sweep_cursor: string | null;
        last_reconciled_at: string | null;
        reconcile_cursor: string | null;
      }>(
        `SELECT state, generation, high_water, mode_fingerprint, google_configured,
                google_seen, begin_disable_at, purge_completed_at,
                sweep_cursor, last_reconciled_at, reconcile_cursor
         FROM meta WHERE singleton = 1`,
      )
      .toArray()[0];
    if (row === undefined) return null;
    return {
      state: row.state,
      generation: row.generation,
      highWater: row.high_water,
      modeFingerprint: row.mode_fingerprint,
      googleConfigured: row.google_configured === 1,
      googleSeen: row.google_seen === 1,
      beginDisableAt: row.begin_disable_at,
      purgeCompletedAt: row.purge_completed_at,
      sweepCursor: row.sweep_cursor,
      lastReconciledAt: row.last_reconciled_at,
      reconcileCursor: row.reconcile_cursor,
    };
  }

  #configuration(): {
    feedToken: string | null;
    google: GoogleCalendarCredentials | null;
  } {
    const google = parseGoogleCredentials(this.env.GOOGLE_CALENDAR_CREDENTIALS);
    return {
      feedToken: parseCalendarFeedToken(this.env.CALENDAR_FEED_TOKEN),
      google,
    };
  }

  async #armAlarm(dueAt: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > dueAt) await this.ctx.storage.setAlarm(dueAt);
  }

  #bump(name: string, amount = 1): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO counters (name, value) VALUES (?, ?)
       ON CONFLICT(name) DO UPDATE SET value = value + excluded.value`,
      name,
      amount,
    );
  }

  #record(reason: string, operation: string, httpStatus: number | null = null): void {
    const sql = this.ctx.storage.sql;
    sql.exec(
      "INSERT INTO ledger (reason, operation, http_status, occurred_at) VALUES (?, ?, ?, ?)",
      reason,
      operation,
      httpStatus,
      new Date().toISOString(),
    );
    const count = sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM ledger").toArray()[0]?.n ?? 0;
    if (count > ADAPTER.LEDGER_CAP) {
      sql.exec(
        `DELETE FROM ledger WHERE entry_id IN (
           SELECT entry_id FROM ledger ORDER BY entry_id LIMIT ?
         )`,
        count - ADAPTER.LEDGER_CAP,
      );
    }
  }

  #pruneRetention(now: number): void {
    if (!this.#hasSchema()) return;
    const sql = this.ctx.storage.sql;
    sql.exec(
      "DELETE FROM ledger WHERE occurred_at < ?",
      new Date(now - ADAPTER.LEDGER_TTL_S * 1_000).toISOString(),
    );
    const expired = sql
      .exec<{ operation: "upsert" | "delete"; n: number }>(
        `SELECT operation, COUNT(*) AS n FROM google_mutations
         WHERE purge_at <= ? GROUP BY operation`,
        now,
      )
      .toArray();
    for (const { operation, n } of expired) {
      this.#record("past-retention", operation);
      this.#bump("retention_discarded", n);
    }
    const expiredProjections =
      sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM projections WHERE purge_at <= ?", now)
        .toArray()[0]?.n ?? 0;
    if (expiredProjections > 0 && this.#readMeta()?.googleSeen) {
      this.#record("past-retention", "delete");
      this.#bump("retention_cleanup_unresolved", expiredProjections);
    }
    sql.exec("DELETE FROM google_mutations WHERE purge_at <= ?", now);
    sql.exec("DELETE FROM projections WHERE purge_at <= ?", now);
    sql.exec("DELETE FROM accepted_events WHERE purge_at <= ?", now);
  }

  #queueMutation(
    reservationId: string,
    externalId: string,
    operation: "upsert" | "delete",
    payload: CalendarProjection | null,
    generation: number,
    purgeAt: number,
    configured: boolean,
  ): void {
    const sql = this.ctx.storage.sql;
    const existing = sql
      .exec<{ desired_version: number; created_at: string }>(
        "SELECT desired_version, created_at FROM google_mutations WHERE reservation_id = ?",
        reservationId,
      )
      .toArray()[0];
    if (existing === undefined) {
      const count =
        sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM google_mutations").toArray()[0]?.n ??
        0;
      if (count >= CALENDAR_ROW_CAP) {
        this.#record("overflow", operation);
        this.#bump("mutation_overflow");
        return;
      }
    }
    const now = new Date().toISOString();
    sql.exec(
      `INSERT OR REPLACE INTO google_mutations
         (reservation_id, external_id, operation, payload_json, desired_version, generation,
          attempt, next_attempt_at, first_attempt_at, claimed_at, claimed_version, status,
          created_at, purge_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, NULL, NULL, NULL, ?, ?, ?)`,
      reservationId,
      externalId,
      operation,
      payload === null ? null : JSON.stringify(payload),
      (existing?.desired_version ?? 0) + 1,
      generation,
      Date.now(),
      configured ? "queued" : "awaiting-configuration",
      existing?.created_at ?? now,
      purgeAt,
    );
  }

  #requeueProjections(meta: CalendarMeta): void {
    for (const row of this.ctx.storage.sql.exec<ProjectionRow>("SELECT * FROM projections")) {
      this.#queueMutation(
        row.reservation_id,
        row.external_id,
        "upsert",
        projectionFromRow(row),
        meta.generation,
        row.purge_at,
        true,
      );
    }
  }

  async descriptor(): Promise<DayAdapterDescriptor | null> {
    const configuration = this.#configuration();
    if (configuration.feedToken === null && configuration.google === null) {
      const meta = this.#readMeta();
      if (meta?.state === "active") {
        const now = Date.now();
        this.ctx.storage.sql.exec(
          `UPDATE meta SET state = 'deactivating', google_configured = 0,
                  begin_disable_at = ?
           WHERE singleton = 1`,
          now,
        );
        await this.#armAlarm(now + ADAPTER.FINAL_PASS_LEASE_WAIT_S * 1_000);
      }
      return null;
    }

    const fingerprint = await sha256Hex(JSON.stringify(configuration.google));
    this.#ensureSchema();
    this.#pruneRetention(Date.now());
    const descriptor = this.ctx.storage.transactionSync(() => {
      const current = this.#readMeta();
      const now = Date.now();
      if (current === null) {
        this.ctx.storage.sql.exec(
          `INSERT INTO meta
             (singleton, state, generation, high_water, mode_fingerprint,
              google_configured, google_seen, begin_disable_at, purge_completed_at,
              sweep_cursor, last_reconciled_at, reconcile_cursor)
           VALUES (1, 'active', 1, 1, ?, ?, ?, NULL, NULL, NULL, NULL, NULL)`,
          fingerprint,
          configuration.google === null ? 0 : 1,
          configuration.google === null ? 0 : 1,
        );
      } else {
        const generation = current.state === "active" ? current.generation : current.highWater + 1;
        const googleChanged =
          configuration.google !== null &&
          (!current.googleConfigured || current.modeFingerprint !== fingerprint);
        this.ctx.storage.sql.exec(
          `UPDATE meta SET state = 'active', generation = ?, high_water = MAX(high_water, ?),
                  mode_fingerprint = ?, google_configured = ?, google_seen = MAX(google_seen, ?),
                  begin_disable_at = NULL, purge_completed_at = NULL
           WHERE singleton = 1`,
          generation,
          generation,
          fingerprint,
          configuration.google === null ? 0 : 1,
          configuration.google === null ? 0 : 1,
        );
        if (googleChanged) this.#requeueProjections({ ...current, generation });
      }
      const active = this.#readMeta();
      if (active === null) throw new Error("calendar activation failed");
      return {
        consumer: "calendar" as const,
        generation: active.generation,
        phase: "active" as const,
        leaseIssuedAt: now,
        leaseNotAfter: now + ADAPTER.DESCRIPTOR_LEASE_WINDOW_S * 1_000,
      };
    });
    await this.#armAlarm(Date.now() + ADAPTER.SWEEP_REARM_DELAY_S * 1_000);
    return descriptor;
  }

  async #acceptEvents(events: AdapterOutboxEvent[]): Promise<number> {
    const now = Date.now();
    this.#pruneRetention(now);
    const meta = this.#readMeta();
    if (meta?.state !== "active") return 0;
    const prepared = await Promise.all(
      events.map(async (event) => ({ event, ids: await calendarIdentifiers(event.reservationId) })),
    );
    const accepted = this.ctx.storage.transactionSync(() => {
      let accepted = 0;
      const sql = this.ctx.storage.sql;
      for (const { event, ids } of prepared) {
        const eventKey = `${event.generation}:${event.eventId}`;
        if (
          sql
            .exec<{ event_key: string }>(
              "SELECT event_key FROM accepted_events WHERE event_key = ?",
              eventKey,
            )
            .toArray()[0] !== undefined
        ) {
          continue;
        }
        let disposition = "projected";
        const latest = sql
          .exec<{ seq: number }>(
            `SELECT MAX(seq) AS seq FROM accepted_events
             WHERE reservation_id = ? AND generation = ?`,
            event.reservationId,
            event.generation,
          )
          .toArray()[0]?.seq;
        if (event.generation !== meta.generation) disposition = "stale-generation";
        else if (event.purgeAt <= Date.now()) disposition = "past-retention";
        else if (latest !== undefined && latest !== null && event.seq <= latest) {
          disposition = "duplicate";
        } else if (event.endTime === null || event.reservationStatus === null) {
          disposition = "invalid";
        } else if (event.reservationStatus === "pending" || event.reservationStatus === "approved") {
          const existing = sql
            .exec<{ reservation_id: string }>(
              "SELECT reservation_id FROM projections WHERE reservation_id = ?",
              event.reservationId,
            )
            .toArray()[0];
          const count = sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM projections").toArray()[0]
            ?.n ?? 0;
          if (existing === undefined && count >= CALENDAR_ROW_CAP) {
            disposition = "overflow";
          } else {
            const projection: CalendarProjection = {
              uid: ids.uid,
              externalId: ids.externalId,
              startAt: calendarInstant(event.date, event.startTime),
              endAt: calendarInstant(event.date, event.endTime),
              serviceLabel: event.serviceLabel,
              status: event.reservationStatus === "pending" ? "tentative" : "confirmed",
            };
            sql.exec(
              `INSERT OR REPLACE INTO projections
                 (reservation_id, external_id, uid, date, start_at, end_at, service_label,
                  status, purge_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              event.reservationId,
              projection.externalId,
              projection.uid,
              event.date,
              projection.startAt,
              projection.endAt,
              projection.serviceLabel,
              projection.status,
              event.purgeAt,
            );
            if (meta.googleSeen) {
              this.#queueMutation(
                event.reservationId,
                ids.externalId,
                "upsert",
                projection,
                meta.generation,
                event.purgeAt,
                meta.googleConfigured,
              );
            }
          }
        } else {
          disposition = "removed";
          sql.exec("DELETE FROM projections WHERE reservation_id = ?", event.reservationId);
          if (meta.googleSeen) {
            this.#queueMutation(
              event.reservationId,
              ids.externalId,
              "delete",
              null,
              meta.generation,
              event.purgeAt,
              meta.googleConfigured,
            );
          }
        }
        sql.exec(
          `INSERT INTO accepted_events
             (event_key, reservation_id, generation, seq, accepted_at, purge_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          eventKey,
          event.reservationId,
          event.generation,
          event.seq,
          new Date().toISOString(),
          event.purgeAt,
        );
        this.#bump(`disposition:${disposition}`);
        accepted += 1;
      }
      return accepted;
    });
    this.#pruneRetention(now);
    const sql = this.ctx.storage.sql;
    const evidenceCount =
      sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM accepted_events").toArray()[0]?.n ?? 0;
    if (evidenceCount > ACCEPTED_EVENT_CAP) {
      const excess = evidenceCount - ACCEPTED_EVENT_CAP;
      sql.exec(
        `DELETE FROM accepted_events WHERE event_key IN (
           SELECT event_key FROM accepted_events ORDER BY accepted_at, event_key LIMIT ?
         )`,
        excess,
      );
      this.#bump("accepted_evicted", excess);
    }
    return accepted;
  }

  async pokeDay(input: { date: string }): Promise<{ ok: true; drained: number }> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new Error("bad poke input");
    const meta = this.#readMeta();
    if (meta?.state !== "active") return { ok: true, drained: 0 };
    const stub = this.env.RESERVATION_DAYS.getByName(
      `single-location:${input.date}`,
    ) as DurableObjectStub<ReservationDay>;
    const drained = await stub.drainOutbox({
      consumer: "calendar",
      limit: ADAPTER.OUTBOX_DRAIN_BATCH,
    });
    if (drained.events.length === 0) return { ok: true, drained: 0 };
    const accepted = await this.#acceptEvents(drained.events);
    await stub.ackOutbox({
      consumer: "calendar",
      events: drained.events.map(({ generation, eventId }) => ({ generation, eventId })),
    });
    if (meta.googleConfigured) await this.#armAlarm(Date.now());
    return { ok: true, drained: accepted };
  }

  async feed(input: { token: string }): Promise<CalendarFeedResult> {
    const configured = parseCalendarFeedToken(this.env.CALENDAR_FEED_TOKEN);
    if (configured === null) return { ok: false };
    if (parseCalendarFeedToken(input.token) === null) {
      if (this.#hasSchema()) this.#bump("feed_auth_failed");
      return { ok: false };
    }
    if (!(await constantTimeTokenMatch(configured, input.token))) {
      if (this.#hasSchema()) this.#bump("feed_auth_failed");
      return { ok: false };
    }
    const descriptor = await this.descriptor();
    if (descriptor === null) return { ok: false };
    const rows = this.ctx.storage.sql
      .exec<ProjectionRow>(
        "SELECT * FROM projections ORDER BY start_at, external_id LIMIT ?",
        CALENDAR_ROW_CAP + 1,
      )
      .toArray();
    if (rows.length > CALENDAR_ROW_CAP) throw new Error("projection overflow");
    return { ok: true, body: renderCalendar(rows.map(projectionFromRow), Date.now()) };
  }

  async reconcileDay(input: DayCalendarProjectionResult): Promise<{
    ok: true;
    projected: number;
    removed: number;
  }> {
    if (!input.ok) throw new Error("bad projection");
    const descriptor = await this.descriptor();
    if (descriptor === null) throw new Error("calendar not configured");
    const now = Date.now();
    this.#pruneRetention(now);
    const events = input.purgeAt <= now ? [] : input.events;
    const prepared = await Promise.all(
      events.map(async (event) => ({ event, ids: await calendarIdentifiers(event.reservationId) })),
    );
    return this.ctx.storage.transactionSync(() => {
      const meta = this.#readMeta();
      if (meta?.state !== "active") throw new Error("calendar not active");
      const sql = this.ctx.storage.sql;
      const wanted = new Set(prepared.map(({ event }) => event.reservationId));
      const removedRows = sql
        .exec<ProjectionRow>("SELECT * FROM projections WHERE date = ?", input.date)
        .toArray()
        .filter(({ reservation_id }) => !wanted.has(reservation_id));
      for (const row of removedRows) {
        sql.exec("DELETE FROM projections WHERE reservation_id = ?", row.reservation_id);
        if (meta.googleSeen) {
          this.#queueMutation(
            row.reservation_id,
            row.external_id,
            "delete",
            null,
            meta.generation,
            row.purge_at,
            meta.googleConfigured,
          );
        }
      }
      let projected = 0;
      let projectionCount =
        sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM projections").toArray()[0]?.n ?? 0;
      for (const { event, ids } of prepared) {
        const existing = sql
          .exec<{ reservation_id: string }>(
            "SELECT reservation_id FROM projections WHERE reservation_id = ?",
            event.reservationId,
          )
          .toArray()[0];
        if (existing === undefined && projectionCount >= CALENDAR_ROW_CAP) {
          this.#record("overflow", "reconcile");
          this.#bump("disposition:overflow");
          continue;
        }
        const projection: CalendarProjection = {
          uid: ids.uid,
          externalId: ids.externalId,
          startAt: calendarInstant(input.date, event.startTime),
          endAt: calendarInstant(input.date, event.endTime),
          serviceLabel: event.serviceLabel,
          status: event.status === "pending" ? "tentative" : "confirmed",
        };
        sql.exec(
          `INSERT OR REPLACE INTO projections
             (reservation_id, external_id, uid, date, start_at, end_at, service_label,
              status, purge_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          event.reservationId,
          projection.externalId,
          projection.uid,
          input.date,
          projection.startAt,
          projection.endAt,
          projection.serviceLabel,
          projection.status,
          input.purgeAt,
        );
        if (meta.googleSeen) {
          this.#queueMutation(
            event.reservationId,
            ids.externalId,
            "upsert",
            projection,
            meta.generation,
            input.purgeAt,
            meta.googleConfigured,
          );
        }
        if (existing === undefined) projectionCount += 1;
        projected += 1;
      }
      return { ok: true as const, projected, removed: removedRows.length };
    });
  }

  async finishReconcile(input: { nextCursor: string | null }): Promise<{ ok: true }> {
    if (input.nextCursor !== null && !/^\d{4}-\d{2}-\d{2}$/.test(input.nextCursor)) {
      throw new Error("bad reconcile cursor");
    }
    if (!this.#hasSchema()) throw new Error("calendar not configured");
    this.ctx.storage.sql.exec(
      "UPDATE meta SET last_reconciled_at = ?, reconcile_cursor = ? WHERE singleton = 1",
      new Date().toISOString(),
      input.nextCursor,
    );
    return { ok: true };
  }

  async diagnostics(): Promise<CalendarDiagnostics | null> {
    await this.descriptor();
    const meta = this.#readMeta();
    if (meta === null) return null;
    const sql = this.ctx.storage.sql;
    const count = (table: string, where = "") =>
      sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} ${where}`).toArray()[0]?.n ?? 0;
    const counters: Record<string, number> = {};
    for (const row of sql.exec<{ name: string; value: number }>("SELECT name, value FROM counters")) {
      counters[row.name] = row.value;
    }
    return {
      state: meta.state,
      generation: meta.generation,
      projectionCount: count("projections"),
      pendingCount: count("google_mutations", "WHERE status IN ('queued', 'sending', 'awaiting-configuration')"),
      failedCount: count("google_mutations", "WHERE status = 'failed'"),
      oldestPendingAt:
        sql
          .exec<{ oldest: string | null }>(
            "SELECT MIN(created_at) AS oldest FROM google_mutations WHERE status != 'failed'",
          )
          .toArray()[0]?.oldest ?? null,
      lastReconciledAt: meta.lastReconciledAt,
      reconcileCursor: meta.reconcileCursor,
      sweepCursor: meta.sweepCursor,
      purgeCompletedAt:
        meta.purgeCompletedAt === null ? null : new Date(meta.purgeCompletedAt).toISOString(),
      counters,
      ledger: sql
        .exec<{
          reason: string;
          operation: string;
          http_status: number | null;
          occurred_at: string;
        }>(
          "SELECT reason, operation, http_status, occurred_at FROM ledger ORDER BY entry_id DESC LIMIT 20",
        )
        .toArray()
        .map((row) => ({
          reason: row.reason,
          operation: row.operation,
          httpStatus: row.http_status,
          occurredAt: row.occurred_at,
        })),
    };
  }

  async hasDisclosure(): Promise<boolean> {
    const configuration = this.#configuration();
    if (configuration.feedToken !== null || configuration.google !== null) return true;
    const meta = this.#readMeta();
    return meta?.state === "active" || meta?.state === "deactivating";
  }

  #claimGoogle(now: number): MutationRow | null {
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      sql.exec(
        `UPDATE google_mutations SET status = 'queued', claimed_at = NULL,
                claimed_version = NULL, next_attempt_at = ?
         WHERE status = 'sending' AND claimed_at < ?`,
        now,
        now - ADAPTER.SEND_CLAIM_LEASE_S * 1_000,
      );
      while (true) {
        const row = sql
          .exec<MutationRow>(
            `SELECT reservation_id, external_id, operation, payload_json, desired_version,
                    generation, attempt, next_attempt_at, first_attempt_at, claimed_at,
                    claimed_version, status, purge_at
             FROM google_mutations
             WHERE status = 'queued' AND next_attempt_at <= ?
             ORDER BY next_attempt_at, created_at, reservation_id LIMIT 1`,
            now,
          )
          .toArray()[0];
        if (row === undefined) return null;
        const meta = this.#readMeta();
        if (row.purge_at <= now || meta === null || row.generation !== meta.generation) {
          this.#record(
            row.purge_at <= now ? "past-retention" : "stale-generation",
            row.operation,
          );
          sql.exec("DELETE FROM google_mutations WHERE reservation_id = ?", row.reservation_id);
          continue;
        }
        const firstAttemptAt = row.first_attempt_at ?? now;
        sql.exec(
          `UPDATE google_mutations SET status = 'sending', claimed_at = ?,
                  claimed_version = desired_version, first_attempt_at = ?
           WHERE reservation_id = ? AND desired_version = ?`,
          now,
          firstAttemptAt,
          row.reservation_id,
          row.desired_version,
        );
        return {
          ...row,
          status: "sending",
          claimed_at: now,
          claimed_version: row.desired_version,
          first_attempt_at: firstAttemptAt,
        };
      }
    });
  }

  #settleGoogle(row: MutationRow, outcome: GoogleMutationOutcome, now: number): void {
    this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      const fresh = sql
        .exec<MutationRow>(
          `SELECT reservation_id, external_id, operation, payload_json, desired_version,
                  generation, attempt, next_attempt_at, first_attempt_at, claimed_at,
                  claimed_version, status, purge_at
           FROM google_mutations WHERE reservation_id = ?`,
          row.reservation_id,
        )
        .toArray()[0];
      if (
        fresh === undefined ||
        fresh.status !== "sending" ||
        fresh.generation !== row.generation ||
        fresh.desired_version !== row.desired_version ||
        fresh.claimed_version !== row.desired_version
      ) {
        return;
      }
      if (outcome.kind === "success") {
        sql.exec("DELETE FROM google_mutations WHERE reservation_id = ?", row.reservation_id);
        this.#bump("delivery:success");
        return;
      }
      if (outcome.kind === "configuration") {
        sql.exec(
          `UPDATE google_mutations SET status = 'awaiting-configuration', claimed_at = NULL,
                  claimed_version = NULL, next_attempt_at = NULL WHERE reservation_id = ?`,
          row.reservation_id,
        );
        this.#bump("delivery:configuration");
        return;
      }
      if (outcome.kind === "permanent") {
        sql.exec(
          `UPDATE google_mutations SET status = 'failed', claimed_at = NULL,
                  claimed_version = NULL, next_attempt_at = NULL WHERE reservation_id = ?`,
          row.reservation_id,
        );
        this.#record("permanent", row.operation, outcome.status);
        this.#bump("delivery:permanent");
        return;
      }
      const attempt = fresh.attempt + 1;
      if (attempt >= ADAPTER.RETRY_OFFSETS_S.length) {
        sql.exec(
          `UPDATE google_mutations SET status = 'failed', attempt = ?, claimed_at = NULL,
                  claimed_version = NULL, next_attempt_at = NULL
           WHERE reservation_id = ?`,
          attempt,
          row.reservation_id,
        );
        this.#record("retry-exhausted", row.operation, outcome.status);
        this.#bump("delivery:retry-exhausted");
        return;
      }
      const firstAttemptAt = fresh.first_attempt_at ?? now;
      sql.exec(
        `UPDATE google_mutations SET status = 'queued', attempt = ?, claimed_at = NULL,
                claimed_version = NULL, next_attempt_at = ? WHERE reservation_id = ?`,
        attempt,
        firstAttemptAt + (ADAPTER.RETRY_OFFSETS_S[attempt] as number) * 1_000,
        row.reservation_id,
      );
      this.#bump("delivery:retry");
    });
  }

  async #processGoogle(now: number): Promise<void> {
    this.#pruneRetention(now);
    const credentials = parseGoogleCredentials(this.env.GOOGLE_CALENDAR_CREDENTIALS);
    if (credentials === null) {
      if (this.#hasSchema()) {
        this.ctx.storage.sql.exec(
          `UPDATE google_mutations SET status = 'awaiting-configuration', next_attempt_at = NULL,
                  claimed_at = NULL, claimed_version = NULL
           WHERE status IN ('queued', 'sending')`,
        );
      }
      return;
    }
    for (let index = 0; index < ADAPTER.SEND_BATCH; index += 1) {
      const row = this.#claimGoogle(now);
      if (row === null) return;
      const token = await getGoogleAccessToken(credentials, fetch, now);
      if (!token.ok) {
        const kind = token.kind === "retryable" ? "retryable" : "configuration";
        this.#settleGoogle(row, { kind, status: token.status }, now);
        return;
      }
      let event: CalendarProjection | null = null;
      if (row.operation === "upsert") {
        try {
          const parsed = JSON.parse(row.payload_json ?? "null") as CalendarProjection;
          if (
            typeof parsed !== "object" ||
            parsed === null ||
            parsed.externalId !== row.external_id ||
            typeof parsed.uid !== "string" ||
            typeof parsed.startAt !== "string" ||
            typeof parsed.endAt !== "string" ||
            typeof parsed.serviceLabel !== "string" ||
            (parsed.status !== "tentative" && parsed.status !== "confirmed")
          ) {
            throw new Error("invalid payload");
          }
          event = parsed;
        } catch {
          this.#settleGoogle(row, { kind: "permanent", status: null }, now);
          continue;
        }
      }
      const outcome = await sendGoogleMutation(
        credentials,
        token.accessToken,
        row.operation,
        event,
        row.external_id,
      );
      this.#settleGoogle(row, outcome, Date.now());
    }
  }

  async #sweepStep(now: number): Promise<void> {
    const meta = this.#readMeta();
    if (meta === null || meta.state === "disabled") return;
    if (
      meta.state === "deactivating" &&
      meta.beginDisableAt !== null &&
      now < meta.beginDisableAt + ADAPTER.FINAL_PASS_LEASE_WAIT_S * 1_000
    ) {
      await this.#armAlarm(meta.beginDisableAt + ADAPTER.FINAL_PASS_LEASE_WAIT_S * 1_000);
      return;
    }
    const first = shiftDate(dateJst(now), -ADAPTER.SWEEP_PAST_DAYS);
    const final = shiftDate(dateJst(now), ADAPTER.SWEEP_FUTURE_DAYS);
    let cursor = meta.sweepCursor ?? first;
    for (let index = 0; index < ADAPTER.SWEEP_DAY_BATCH && cursor <= final; index += 1) {
      try {
        if (meta.state === "deactivating") {
          await this.env.RESERVATION_DAYS.getByName(
            `single-location:${cursor}`,
          ).purgeConsumer({ consumer: "calendar" });
        } else {
          await this.pokeDay({ date: cursor });
        }
      } catch {
        this.#bump("sweep_faults");
      }
      cursor = shiftDate(cursor, 1);
    }
    if (cursor <= final) {
      this.ctx.storage.sql.exec("UPDATE meta SET sweep_cursor = ? WHERE singleton = 1", cursor);
      await this.#armAlarm(now + ADAPTER.SWEEP_REARM_DELAY_S * 1_000);
      return;
    }
    if (meta.state === "deactivating") {
      this.ctx.storage.transactionSync(() => {
        const sql = this.ctx.storage.sql;
        sql.exec("DELETE FROM accepted_events");
        sql.exec("DELETE FROM projections");
        sql.exec("DELETE FROM google_mutations");
        sql.exec("DELETE FROM ledger");
        sql.exec("DELETE FROM counters");
        sql.exec(
          `UPDATE meta SET state = 'disabled', purge_completed_at = ?,
                  sweep_cursor = NULL, reconcile_cursor = NULL
           WHERE singleton = 1`,
          now,
        );
      });
      await this.ctx.storage.deleteAlarm();
    } else {
      this.ctx.storage.sql.exec("UPDATE meta SET sweep_cursor = NULL WHERE singleton = 1");
      await this.#armAlarm(now + ADAPTER.SWEEP_REARM_DELAY_S * 1_000);
    }
  }

  override async alarm(): Promise<void> {
    const descriptor = await this.descriptor();
    if (descriptor === null && this.#readMeta()?.state !== "deactivating") return;
    if (descriptor !== null) await this.#processGoogle(Date.now());
    await this.#sweepStep(Date.now());
  }
}
