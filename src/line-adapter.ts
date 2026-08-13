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

/** Read at most `cap` bytes; null when the stream exceeds it or fails. */
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
  } catch {
    return null;
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
  let decoded: string;
  try {
    decoded = atob(value);
  } catch {
    return null;
  }
  // atob ignores non-zero padding bits, so two different strings can decode to
  // the same bytes. Re-encoding and comparing rejects every non-canonical
  // spelling, leaving exactly one valid representation per signature.
  if (btoa(decoded) !== value) return null;
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index);
  }
  return bytes;
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
      source !== null && source.type === "user" && typeof source.userId === "string"
        ? source.userId
        : null;
    const handledType =
      entry.type === "follow" || entry.type === "unfollow" ? entry.type : null;
    const handled = handledType !== null && userId !== null && LINE_USER_ID.test(userId);
    // A handled event must be well formed all the way down: a malformed
    // deliveryContext on an event we act upon is a protocol violation, not
    // something to coerce into `false`.
    if (handled) {
      if (
        !isRecord(entry.deliveryContext) ||
        typeof entry.deliveryContext.isRedelivery !== "boolean"
      ) {
        return null;
      }
    }
    const isRedelivery =
      isRecord(entry.deliveryContext) && entry.deliveryContext.isRedelivery === true;
    if (handled && handledType !== null && userId !== null) {
      events.push({
        type: handledType,
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
  if (
    payload.auth_time !== undefined &&
    (!Number.isSafeInteger(payload.auth_time) || (payload.auth_time as number) < 0)
  ) {
    return { ok: false, code: "PROTOCOL_ERROR" };
  }
  if (
    payload.amr !== undefined &&
    (!Array.isArray(payload.amr) ||
      payload.amr.length > 16 ||
      payload.amr.some((entry) => typeof entry !== "string" || entry.length > 64))
  ) {
    return { ok: false, code: "PROTOCOL_ERROR" };
  }
  return { ok: true, sub };
};

// ---- stateless channel access token (v3, client_credentials) ----

export type TokenResult =
  | { ok: true; accessToken: string }
  | { ok: false; code: "RETRYABLE" | "CONFIG_REJECTED" };

// Isolate-local cache. Stateless v3 tokens live 900 s and are unlimited to
// mint, so losing this cache costs one extra HTTP call, never correctness.
// The key never contains the secret itself — only a digest discriminator, so
// a rotated secret misses the cache instead of reusing the old token.
const tokenCache = new Map<string, { accessToken: string; expiresAt: number }>();

export const clearTokenCacheForTests = (): void => {
  tokenCache.clear();
};

const secretDiscriminator = async (secret: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(secret),
  );
  return [...new Uint8Array(digest).slice(0, 8)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
};

export const mintChannelToken = async (
  input: { generation: number; channelId: string; channelSecret: string },
  fetcher: LineFetch = fetch,
): Promise<TokenResult> => {
  const cacheKey = `${input.generation}:${input.channelId}:${await secretDiscriminator(input.channelSecret)}`;
  const cached = tokenCache.get(cacheKey);
  if (cached !== undefined && cached.expiresAt > Date.now()) {
    return { ok: true, accessToken: cached.accessToken };
  }
  // Measured before the request: the lifetime LINE reports starts when it
  // issues the token, not when the response finishes arriving.
  const requestedAt = Date.now();
  let response: Response;
  try {
    response = await fetcher(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: input.channelId,
        client_secret: input.channelSecret,
      }),
      redirect: "manual",
      signal: AbortSignal.timeout(ADAPTER.OUTBOUND_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, code: "RETRYABLE" };
  }
  if (response.status === 408 || response.status === 429 || response.status >= 500) {
    return { ok: false, code: "RETRYABLE" };
  }
  if (response.status !== 200) return { ok: false, code: "CONFIG_REJECTED" };
  const text = await readBoundedText(response, ADAPTER.VERIFY_RESPONSE_MAX_BYTES);
  if (text === null) return { ok: false, code: "RETRYABLE" };
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return { ok: false, code: "RETRYABLE" };
  }
  if (
    !isRecord(payload) ||
    typeof payload.access_token !== "string" ||
    payload.access_token.length === 0 ||
    payload.access_token.length > ADAPTER.ACCESS_TOKEN_MAX_BYTES ||
    payload.token_type !== "Bearer" ||
    !Number.isSafeInteger(payload.expires_in) ||
    (payload.expires_in as number) <= 0
  ) {
    return { ok: false, code: "RETRYABLE" };
  }
  // Never outlive what the provider granted: a short-lived token is cached for
  // its own lifetime minus the safety margin, or not at all if that is nothing.
  const grantedMs = (payload.expires_in as number) * 1000;
  const cacheableMs = Math.min(
    grantedMs - ADAPTER.TOKEN_CACHE_SAFETY_MS,
    ADAPTER.TOKEN_CACHE_TTL_S * 1000,
  );
  if (cacheableMs > 0) {
    tokenCache.set(cacheKey, {
      accessToken: payload.access_token,
      expiresAt: requestedAt + cacheableMs,
    });
  }
  return { ok: true, accessToken: payload.access_token };
};

// ---- canonical message fragments and the v1 wire serializer ----

export type MessageFragment = {
  v: 1;
  type: "approve" | "reject" | "reschedule" | "cancel" | "expire";
  date: string;
  startTime: string;
  serviceLabel: string;
};

const EVENT_LINES: Record<MessageFragment["type"], string> = {
  approve: "ご予約が確定しました。",
  reject: "ご予約をお受けできませんでした。",
  reschedule: "ご予約の日時が変更されました。",
  cancel: "ご予約がキャンセルされました。",
  expire: "ご予約の申し込みが期限切れになりました。",
};

/**
 * Wire-format v1: one text message containing only state, time, and service
 * label (spec FR-009; no notes, names, contact, or management URL). v1 is never
 * removed or changed once shipped — retries must stay byte-identical across
 * deploys, and an independent installation can hold a v1 delivery until the
 * retention bound.
 */
export const serializeMessageV1 = (
  fragment: MessageFragment,
): { type: "text"; text: string }[] => {
  return [
    {
      type: "text",
      text:
        `${EVENT_LINES[fragment.type]}\n` +
        `日時: ${fragment.date} ${fragment.startTime}\n` +
        `サービス: ${fragment.serviceLabel}`,
    },
  ];
};

// ---- push client (retry-key idempotent) ----

export type PushOutcome =
  | { ok: true; accepted: boolean }
  | { ok: false; code: "RETRYABLE" | "CONFIG_REJECTED" | "REJECTED"; status: number | null };

/**
 * One push attempt. The caller persists the retry key before the first
 * attempt and rebuilds the body from the canonical fragment each time, so a
 * repeat of an uncertain send is byte-identical and deduplicated by LINE.
 * 409 means a previous attempt already landed (x-line-accepted-request-id).
 */
export const pushMessage = async (
  input: {
    accessToken: string;
    to: string;
    messages: { type: "text"; text: string }[];
    retryKey: string;
  },
  fetcher: LineFetch = fetch,
): Promise<PushOutcome> => {
  let response: Response;
  try {
    response = await fetcher(PUSH_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.accessToken}`,
        "content-type": "application/json",
        "x-line-retry-key": input.retryKey,
      },
      body: JSON.stringify({ to: input.to, messages: input.messages }),
      redirect: "manual",
      signal: AbortSignal.timeout(ADAPTER.OUTBOUND_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, code: "RETRYABLE", status: null };
  }
  // Only the status class is ever inspected or recorded — the response body
  // and headers are never read, so nothing a provider sends can be stored.
  if (response.status === 200) return { ok: true, accepted: false };
  if (response.status === 409) return { ok: true, accepted: true };
  if (response.status >= 500) return { ok: false, code: "RETRYABLE", status: response.status };
  // 401 means the channel credentials no longer match: an operator has to fix
  // the configuration, so retrying the same credentials cannot help.
  if (response.status === 401) return { ok: false, code: "CONFIG_REJECTED", status: 401 };
  return { ok: false, code: "REJECTED", status: response.status };
};

export { PUSH_URL, TOKEN_URL, VERIFY_URL };
