import { ADAPTER } from "./adapter-constants.ts";

// Every LINE endpoint is a fixed absolute URL: nothing request-derived ever
// reaches fetch(), so there is no SSRF surface, and redirects are terminal
// protocol errors rather than something to follow.
const VERIFY_URL = "https://api.line.me/oauth2/v2.1/verify";
const TOKEN_URL = "https://api.line.me/oauth2/v3/token";
const PUSH_URL = "https://api.line.me/v2/bot/message/push";

const LINE_USER_ID = /^U[0-9a-f]{32}$/;
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const WEBHOOK_EVENT_ID = /^[0-9A-Za-z-]{1,64}$/;

declare global {
  interface Env {
    // Optional by design: the adapter is invisible until configured, so this
    // secret never joins wrangler's required list.
    LINE_MESSAGING_CHANNEL_SECRET?: string;
  }
}

export type LineFetch = (input: string, init: RequestInit) => Promise<Response>;

// ---- bounded readers ----

/** Read at most `cap` bytes; null when the stream exceeds it. */
export const readBoundedBytes = async (
  stream: ReadableStream<Uint8Array> | null,
  cap: number,
): Promise<Uint8Array | null> => {
  if (stream === null) return new Uint8Array(0);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > cap) return null;
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
};

const readBoundedText = async (response: Response, cap: number): Promise<string | null> => {
  const bytes = await readBoundedBytes(response.body, cap);
  if (bytes === null) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
};

// ---- webhook signature (raw bytes, strict base64, constant-time) ----

const constantTimeEqual = (left: Uint8Array, right: Uint8Array): boolean => {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= (left[index] as number) ^ (right[index] as number);
  }
  return difference === 0;
};

const decodeStrictBase64 = (value: string): Uint8Array | null => {
  if (value.length === 0 || value.length % 4 !== 0 || !BASE64.test(value)) return null;
  try {
    const decoded = atob(value);
    const bytes = new Uint8Array(decoded.length);
    for (let index = 0; index < decoded.length; index += 1) {
      bytes[index] = decoded.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
};

/**
 * base64(HMAC-SHA256(channel secret, raw body bytes)) vs x-line-signature.
 * The body must already be the exact received bytes — any parse or
 * re-serialization beforehand is indistinguishable from tampering.
 */
export const verifyWebhookSignature = async (
  channelSecret: string,
  signatureHeader: string | null,
  body: Uint8Array,
): Promise<boolean> => {
  if (body.byteLength > ADAPTER.WEBHOOK_BODY_MAX_BYTES) return false;
  if (signatureHeader === null || signatureHeader.length > 64) return false;
  const presented = decodeStrictBase64(signatureHeader);
  if (presented === null || presented.byteLength !== 32) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(channelSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, body as BufferSource),
  );
  return constantTimeEqual(expected, presented);
};

// ---- webhook body parse (after the signature only) ----

export type LineWebhookEvent = {
  type: "follow" | "unfollow";
  webhookEventId: string;
  timestamp: number;
  userId: string;
  isRedelivery: boolean;
};

export type ParsedWebhook = {
  events: LineWebhookEvent[];
  // Unknown or non-user events are acknowledged with zero side effects, but
  // counted so tests can assert they were seen and dropped deliberately.
  ignoredCount: number;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Strict UTF-8 + JSON + allowlist. Null means a malformed body (400). */
export const parseWebhookBody = (body: Uint8Array): ParsedWebhook | null => {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.events)) return null;
  if (parsed.events.length > ADAPTER.WEBHOOK_EVENTS_MAX) return null;
  const events: LineWebhookEvent[] = [];
  let ignoredCount = 0;
  for (const entry of parsed.events) {
    if (!isRecord(entry)) return null;
    if (
      typeof entry.webhookEventId !== "string" ||
      !WEBHOOK_EVENT_ID.test(entry.webhookEventId) ||
      !Number.isSafeInteger(entry.timestamp) ||
      (entry.timestamp as number) < 0
    ) {
      return null;
    }
    const source = isRecord(entry.source) ? entry.source : null;
    const userId =
      source !== null && typeof source.userId === "string" ? source.userId : null;
    const isRedelivery =
      isRecord(entry.deliveryContext) && entry.deliveryContext.isRedelivery === true;
    if (
      (entry.type === "follow" || entry.type === "unfollow") &&
      userId !== null &&
      LINE_USER_ID.test(userId)
    ) {
      events.push({
        type: entry.type,
        webhookEventId: entry.webhookEventId,
        timestamp: entry.timestamp as number,
        userId,
        isRedelivery,
      });
    } else {
      ignoredCount += 1;
    }
  }
  return { events, ignoredCount };
};

// ---- ID-token verification (POST; GET on the same path is a different API) ----

export type VerifyIdTokenResult =
  | { ok: true; sub: string }
  | { ok: false; code: "INVALID_TOKEN" | "PROVIDER_UNAVAILABLE" | "PROTOCOL_ERROR" };

/**
 * Server-side verification via LINE's endpoint: signature, expiry, and
 * audience are checked by the platform; this validates the response shape
 * strictly, keeps `sub`, and discards every profile claim.
 */
export const verifyIdToken = async (
  idToken: string,
  loginChannelId: string,
  fetcher: LineFetch = fetch,
): Promise<VerifyIdTokenResult> => {
  if (
    idToken.length === 0 ||
    idToken.length > ADAPTER.ID_TOKEN_MAX_BYTES ||
    !JWT_SHAPE.test(idToken)
  ) {
    return { ok: false, code: "INVALID_TOKEN" };
  }
  let response: Response;
  try {
    response = await fetcher(VERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ id_token: idToken, client_id: loginChannelId }),
      redirect: "manual",
      signal: AbortSignal.timeout(ADAPTER.OUTBOUND_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, code: "PROVIDER_UNAVAILABLE" };
  }
  if (response.status >= 300 && response.status < 400) {
    return { ok: false, code: "PROTOCOL_ERROR" };
  }
  if (response.status === 400) return { ok: false, code: "INVALID_TOKEN" };
  if (response.status !== 200) return { ok: false, code: "PROVIDER_UNAVAILABLE" };
  const text = await readBoundedText(response, ADAPTER.VERIFY_RESPONSE_MAX_BYTES);
  if (text === null) return { ok: false, code: "PROTOCOL_ERROR" };
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return { ok: false, code: "PROTOCOL_ERROR" };
  }
  if (!isRecord(payload)) return { ok: false, code: "PROTOCOL_ERROR" };
  const { iss, sub, aud, exp, iat } = payload;
  if (
    iss !== "https://access.line.me" ||
    typeof sub !== "string" ||
    !LINE_USER_ID.test(sub) ||
    aud !== loginChannelId ||
    !Number.isSafeInteger(exp) ||
    (exp as number) * 1000 < Date.now() - 60_000 ||
    !Number.isSafeInteger(iat)
  ) {
    return { ok: false, code: "PROTOCOL_ERROR" };
  }
  // Optional profile claims: bounds-checked, then deliberately discarded —
  // nothing beyond `sub` survives this function.
  for (const claim of ["nonce", "name", "picture", "email"]) {
    const value = payload[claim];
    if (value !== undefined && (typeof value !== "string" || value.length > 1000)) {
      return { ok: false, code: "PROTOCOL_ERROR" };
    }
  }
  return { ok: true, sub };
};

export { PUSH_URL, TOKEN_URL, VERIFY_URL };
