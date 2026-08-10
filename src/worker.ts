import { parseDateJstToUtcIso } from "./date-parse.ts";
import {
  evaluateInstallationReadiness,
  InstallationConfig,
  projectPublicConfig,
  type InstallationSettings,
  type InstallationState,
  type ReadinessRuntime,
} from "./installation-config.ts";
import {
  ReservationDay,
  type BookingSnapshot,
  type DayClosureCreateInput,
  type DayClosureRemoveInput,
  type DayConfig,
  type DayCreateInput,
  type DayFailure,
  type DayMutationSuccess,
  type DayOwnerTransitionInput,
  type DayPublicCancelInput,
  type DayPublicStatusSuccess,
} from "./reservation-day.ts";

export { InstallationConfig, ReservationDay };

type AppEnv = Env & {
  INSTALLATION_CONFIG: DurableObjectNamespace<InstallationConfig>;
};

type JsonObject = Record<string, unknown>;
type ReadJsonResult =
  | { ok: true; value: unknown }
  | { ok: false; tooLarge: boolean };

type InstallationContext = {
  state: InstallationState;
  settings: InstallationSettings;
  runtime: ReadinessRuntime;
};

const MAX_BODY_BYTES = 16 * 1024;
const MAX_HORIZON_DAYS = 90;
const MAX_RETENTION_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const DIGEST = /^[a-f0-9]{64}$/;
const MANAGEMENT_KEY = /^[A-Za-z0-9_-]{43}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

const ERROR_MESSAGES = {
  BAD_REQUEST: "入力内容を確認してください。",
  NOT_FOUND_OR_UNAUTHORIZED: "予約情報または管理キーを確認できませんでした。",
  UNAVAILABLE: "選択した日時は利用できません。",
  CONFIGURATION_CONFLICT: "設定が更新されています。内容を確認してください。",
  IDEMPOTENCY_CONFLICT: "同じ操作番号を別の内容には使用できません。",
  CAPACITY_REACHED: "この日は受付上限に達しました。",
  RATE_LIMITED: "操作が多すぎます。しばらく待ってからお試しください。",
  PROTECTION_REFUSED: "確認に失敗しました。もう一度お試しください。",
  NOT_LIVE: "現在は予約を受け付けていません。",
  TEMPORARILY_UNAVAILABLE: "現在処理できません。しばらく待ってからお試しください。",
  UNAUTHORIZED: "認証情報を確認できませんでした。",
} as const;

type PublicErrorCode = keyof typeof ERROR_MESSAGES;

const jsonHeaders = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

const json = (
  value: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: { ...jsonHeaders, ...headers },
  });

const errorResponse = (
  status: number,
  code: PublicErrorCode,
  headers: Record<string, string> = {},
): Response =>
  json(
    { ok: false, error: { code, message: ERROR_MESSAGES[code] } },
    status,
    headers,
  );

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (value: JsonObject, keys: readonly string[]): boolean => {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
};

const boundedText = (
  value: unknown,
  minimum: number,
  maximum: number,
): value is string =>
  typeof value === "string" &&
  value === value.trim() &&
  !CONTROL.test(value) &&
  [...value].length >= minimum &&
  [...value].length <= maximum;

const readJson = async (request: Request): Promise<ReadJsonResult> => {
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
    return { ok: false, tooLarge: false };
  }
  const declaredLength = request.headers.get("content-length");
  if (
    declaredLength !== null &&
    /^\d+$/.test(declaredLength) &&
    Number(declaredLength) > MAX_BODY_BYTES
  ) {
    return { ok: false, tooLarge: true };
  }
  if (request.body === null) return { ok: false, tooLarge: false };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      return { ok: false, tooLarge: true };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return {
      ok: true,
      value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    };
  } catch {
    return { ok: false, tooLarge: false };
  }
};

const bodyOrError = async (
  request: Request,
): Promise<{ response: Response } | { value: unknown }> => {
  const parsed = await readJson(request);
  return parsed.ok
    ? { value: parsed.value }
    : { response: errorResponse(parsed.tooLarge ? 413 : 400, "BAD_REQUEST") };
};

const sameOrigin = (request: Request, url: URL): boolean =>
  request.headers.get("origin") === url.origin;

const requireMutationOrigin = (request: Request, url: URL): Response | null =>
  sameOrigin(request, url) ? null : errorResponse(403, "PROTECTION_REFUSED");

const rateKey = (request: Request, route: string): string =>
  `${request.headers.get("cf-connecting-ip") ?? "unknown"}:${route}`;

const limited = async (
  limiter: RateLimit,
  request: Request,
  route: string,
): Promise<boolean> =>
  !(await limiter.limit({ key: rateKey(request, route) })).success;

const rateLimited = (): Response =>
  errorResponse(429, "RATE_LIMITED", { "retry-after": "60" });

const sha256 = async (value: string): Promise<Uint8Array> =>
  new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );

const equalBytes = (left: Uint8Array, right: Uint8Array): boolean => {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= (left[index] as number) ^ (right[index] as number);
  }
  return difference === 0;
};

const secret = (env: AppEnv, name: "OWNER_TOKEN" | "TURNSTILE_SECRET"): string | null => {
  const value = (env as unknown as Record<string, unknown>)[name];
  return typeof value === "string" && !/\s/.test(value) && !CONTROL.test(value)
    ? value
    : null;
};

const TURNSTILE_TEST_SECRETS = new Set([
  "1x0000000000000000000000000000000AA",
  "2x0000000000000000000000000000000AA",
  "3x0000000000000000000000000000000AA",
]);

const turnstileSecretPresent = (env: AppEnv): boolean => {
  const value = secret(env, "TURNSTILE_SECRET");
  return value !== null && value.length > 0 && !TURNSTILE_TEST_SECRETS.has(value);
};

const OWNER_TOKEN_PLACEHOLDER = "replace-with-at-least-32-random-characters";

const ownerSecretPresent = (env: AppEnv): boolean => {
  const value = secret(env, "OWNER_TOKEN");
  return value !== null && value.length >= 32 && value !== OWNER_TOKEN_PLACEHOLDER;
};

const ownerAuthenticated = async (
  request: Request,
  env: AppEnv,
): Promise<"accepted" | "refused" | "unavailable"> => {
  const expected = secret(env, "OWNER_TOKEN");
  if (!ownerSecretPresent(env) || expected === null) return "unavailable";
  const authorization = request.headers.get("authorization");
  const match = authorization?.match(/^Bearer ([^\s]+)$/);
  const provided = match?.[1];
  if (provided === undefined) return "refused";
  return equalBytes(await sha256(provided), await sha256(expected))
    ? "accepted"
    : "refused";
};

const ownerGate = async (
  request: Request,
  env: AppEnv,
  route: string,
): Promise<Response | null> => {
  if (await limited(env.OWNER_RATE_LIMITER, request, route)) return rateLimited();
  const authentication = await ownerAuthenticated(request, env);
  if (authentication === "unavailable") {
    return errorResponse(503, "TEMPORARILY_UNAVAILABLE");
  }
  return authentication === "accepted"
    ? null
    : errorResponse(401, "UNAUTHORIZED", { "www-authenticate": "Bearer" });
};

const installationStub = (env: AppEnv): DurableObjectStub<InstallationConfig> =>
  env.INSTALLATION_CONFIG.getByName("installation");

const dayStub = (env: AppEnv, date: string): DurableObjectStub<ReservationDay> =>
  env.RESERVATION_DAYS.getByName(`single-location:${date}`);

const runtimeFor = (
  env: AppEnv,
  url: URL,
  authenticated: boolean,
): ReadinessRuntime => ({
  ownerSecretPresent: ownerSecretPresent(env),
  ownerAuthenticated: authenticated,
  turnstileSecretPresent: turnstileSecretPresent(env),
  hostname: url.hostname.toLowerCase(),
});

const installationContext = async (
  env: AppEnv,
  url: URL,
  authenticated: boolean,
): Promise<InstallationContext> => {
  const state = await installationStub(env).getState();
  const record = state.settingsVersions.find(
    ({ version }) => version === state.activeSettingsVersion,
  );
  if (record === undefined) throw new Error("missing active installation settings");
  return { state, settings: record.settings, runtime: runtimeFor(env, url, authenticated) };
};

const minutes = (time: string): number => {
  const [hour, minute] = time.split(":").map(Number);
  return (hour as number) * 60 + (minute as number);
};

const timeFromMinutes = (value: number): string =>
  `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;

const startTimes = (settings: InstallationSettings): string[] => {
  const values: string[] = [];
  const shortestOccupiedMinutes = Math.min(
    ...settings.services
      .filter(({ active }) => active)
      .map(({ durationMinutes, cleanupMinutes }) => durationMinutes + cleanupMinutes),
  );
  for (
    let value = minutes(settings.opensAt);
    value + shortestOccupiedMinutes <= minutes(settings.closesAt);
    value += settings.startIntervalMinutes
  ) {
    values.push(timeFromMinutes(value));
  }
  return values;
};

const dayOffset = (date: string, now: number): number | null => {
  const target = parseDateJstToUtcIso(date);
  const today = new Date(now + JST_OFFSET_MS).toISOString().slice(0, 10);
  const start = parseDateJstToUtcIso(today);
  if (target === null || start === null) return null;
  const value = (Date.parse(target) - Date.parse(start)) / DAY_MS;
  return Number.isInteger(value) ? value : null;
};

const weekday = (date: string): number =>
  new Date(`${date}T00:00:00.000Z`).getUTCDay();

const isBookableDate = (
  date: string,
  now: number,
  settings: InstallationSettings,
): boolean => {
  const offset = dayOffset(date, now);
  return (
    offset !== null &&
    offset >= 0 &&
    offset < settings.horizonDays &&
    settings.openWeekdays.includes(weekday(date))
  );
};

const withinPartitionWindow = (
  date: string,
  now: number,
): boolean => {
  const offset = dayOffset(date, now);
  return offset !== null && offset >= -MAX_RETENTION_DAYS && offset < MAX_HORIZON_DAYS;
};

const addDays = (date: string, count: number): string =>
  new Date(Date.parse(`${date}T00:00:00.000Z`) + count * DAY_MS)
    .toISOString()
    .slice(0, 10);

const toDayConfig = (date: string, context: InstallationContext): DayConfig => {
  const midnight = parseDateJstToUtcIso(date);
  if (midnight === null) throw new Error("invalid date");
  const { settings, state } = context;
  return {
    date,
    resourceIds: settings.resources.filter(({ active }) => active).map(({ id }) => id),
    startTimes: startTimes(settings),
    slotMinutes: settings.startIntervalMinutes,
    purgeAt: Date.parse(midnight) + (settings.retentionDays + 1) * DAY_MS,
    settingsVersion: state.activeSettingsVersion,
    resources: settings.resources.map((resource) => ({ ...resource })),
    services: settings.services.map((service) => ({
      ...service,
      eligibleResourceIds: [...service.eligibleResourceIds],
    })),
    opensAt: settings.opensAt,
    closesAt: settings.closesAt,
    startIntervalMinutes: settings.startIntervalMinutes,
    consentVersion: settings.consentVersion,
  };
};

const validDate = (value: unknown): value is string =>
  typeof value === "string" && DATE.test(value) && parseDateJstToUtcIso(value) !== null;

const validIdList = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length >= 1 &&
  value.length <= 4 &&
  value.every((id) => typeof id === "string" && ID.test(id)) &&
  new Set(value).size === value.length;

const isActiveSelection = (
  settings: InstallationSettings,
  serviceIds: string[],
  resourceId?: string,
): boolean =>
  serviceIds.every((id) =>
    settings.services.some((service) => service.active && service.id === id),
  ) &&
  (resourceId === undefined ||
    settings.resources.some((resource) => resource.active && resource.id === resourceId));

const parseCreate = (
  value: unknown,
  publicRequest: boolean,
): (DayCreateInput & { turnstileToken?: string; replayOnly?: boolean }) | null => {
  if (!isObject(value)) return null;
  const keys = [
    "commandId",
    "settingsVersion",
    "serviceIds",
    "resourceId",
    "date",
    "startTime",
    "customerName",
    "contact",
    "consentVersion",
    "managementDigest",
  ];
  if (publicRequest) keys.push("turnstileToken", "replayOnly");
  if (!hasExactKeys(value, keys)) return null;
  const {
    commandId,
    settingsVersion,
    serviceIds,
    resourceId,
    date,
    startTime,
    customerName,
    contact,
    consentVersion,
    managementDigest,
    turnstileToken,
    replayOnly,
  } = value;
  if (
    typeof commandId !== "string" ||
    !UUID.test(commandId) ||
    !Number.isInteger(settingsVersion) ||
    (settingsVersion as number) < 1 ||
    !validIdList(serviceIds) ||
    typeof resourceId !== "string" ||
    !ID.test(resourceId) ||
    !validDate(date) ||
    typeof startTime !== "string" ||
    !TIME.test(startTime) ||
    !boundedText(customerName, 1, 80) ||
    !boundedText(contact, 3, 200) ||
    typeof consentVersion !== "string" ||
    !ID.test(consentVersion) ||
    typeof managementDigest !== "string" ||
    !DIGEST.test(managementDigest) ||
    (publicRequest &&
      (typeof replayOnly !== "boolean" ||
        typeof turnstileToken !== "string" ||
        (!replayOnly && turnstileToken.length < 1) ||
        turnstileToken.length > 2048))
  ) {
    return null;
  }
  return {
    commandId,
    settingsVersion: settingsVersion as number,
    serviceIds,
    resourceId,
    date,
    startTime,
    customerName,
    contact,
    consentVersion,
    managementDigest,
    ...(publicRequest && typeof turnstileToken === "string" ? { turnstileToken } : {}),
    ...(publicRequest && typeof replayOnly === "boolean" ? { replayOnly } : {}),
  };
};

const parseStatus = (
  value: unknown,
  reservationId: string,
): { date: string; reservationId: string; managementKey: string } | null => {
  if (
    !UUID.test(reservationId) ||
    !isObject(value) ||
    !hasExactKeys(value, ["date", "managementKey"])
  ) {
    return null;
  }
  return validDate(value.date) &&
    typeof value.managementKey === "string" &&
    MANAGEMENT_KEY.test(value.managementKey)
    ? { date: value.date, reservationId, managementKey: value.managementKey }
    : null;
};

const parsePublicCancel = (
  value: unknown,
  reservationId: string,
): DayPublicCancelInput | null => {
  if (
    !UUID.test(reservationId) ||
    !isObject(value) ||
    !hasExactKeys(value, ["commandId", "date", "managementKey"])
  ) {
    return null;
  }
  return typeof value.commandId === "string" &&
    UUID.test(value.commandId) &&
    validDate(value.date) &&
    typeof value.managementKey === "string" &&
    MANAGEMENT_KEY.test(value.managementKey)
    ? {
        commandId: value.commandId,
        date: value.date,
        reservationId,
        managementKey: value.managementKey,
      }
    : null;
};

const parseTransition = (
  value: unknown,
  reservationId: string,
): DayOwnerTransitionInput | null => {
  if (!UUID.test(reservationId) || !isObject(value)) return null;
  const common =
    typeof value.commandId === "string" &&
    UUID.test(value.commandId) &&
    validDate(value.date);
  if (!common) return null;
  if (
    hasExactKeys(value, ["commandId", "date", "action"]) &&
    ["approve", "cancel", "complete", "no_show"].includes(value.action as string)
  ) {
    return {
      commandId: value.commandId as string,
      date: value.date as string,
      reservationId,
      action: value.action as "approve" | "cancel" | "complete" | "no_show",
    };
  }
  if (
    hasExactKeys(value, ["commandId", "date", "action", "reason"]) &&
    value.action === "reject" &&
    boundedText(value.reason, 1, 200)
  ) {
    return {
      commandId: value.commandId as string,
      date: value.date as string,
      reservationId,
      action: "reject",
      reason: value.reason,
    };
  }
  if (
    hasExactKeys(value, ["commandId", "date", "action", "resourceId", "startTime"]) &&
    value.action === "reschedule" &&
    typeof value.resourceId === "string" &&
    ID.test(value.resourceId) &&
    typeof value.startTime === "string" &&
    TIME.test(value.startTime)
  ) {
    return {
      commandId: value.commandId as string,
      date: value.date as string,
      reservationId,
      action: "reschedule",
      resourceId: value.resourceId,
      startTime: value.startTime,
    };
  }
  return null;
};

const parseClosureCreate = (value: unknown): DayClosureCreateInput | null => {
  if (
    !isObject(value) ||
    !hasExactKeys(value, [
      "commandId",
      "date",
      "resourceId",
      "startTime",
      "endTime",
      "label",
    ])
  ) {
    return null;
  }
  return typeof value.commandId === "string" &&
    UUID.test(value.commandId) &&
    validDate(value.date) &&
    (value.resourceId === null ||
      (typeof value.resourceId === "string" && ID.test(value.resourceId))) &&
    typeof value.startTime === "string" &&
    TIME.test(value.startTime) &&
    typeof value.endTime === "string" &&
    TIME.test(value.endTime) &&
    boundedText(value.label, 1, 80)
    ? {
        commandId: value.commandId,
        date: value.date,
        resourceId: value.resourceId,
        startTime: value.startTime,
        endTime: value.endTime,
        label: value.label,
      }
    : null;
};

const parseClosureRemove = (
  value: unknown,
  closureId: string,
): DayClosureRemoveInput | null => {
  if (
    !UUID.test(closureId) ||
    !isObject(value) ||
    !hasExactKeys(value, ["commandId", "date"])
  ) {
    return null;
  }
  return typeof value.commandId === "string" &&
    UUID.test(value.commandId) &&
    validDate(value.date)
    ? { commandId: value.commandId, date: value.date, closureId }
    : null;
};

const availabilityQuery = (
  url: URL,
  requireReservationId = false,
): { date: string; serviceIds: string[]; reservationId?: string } | null => {
  const entries = [...url.searchParams.entries()];
  const dates = entries.filter(([key]) => key === "date").map(([, value]) => value);
  const serviceIds = entries
    .filter(([key]) => key === "serviceId")
    .map(([, value]) => value);
  const reservationIds = entries
    .filter(([key]) => key === "reservationId")
    .map(([, value]) => value);
  if (
    entries.some(
      ([key]) =>
        key !== "date" &&
        key !== "serviceId" &&
        (!requireReservationId || key !== "reservationId"),
    ) ||
    dates.length !== 1 ||
    !validDate(dates[0]) ||
    !validIdList(serviceIds) ||
    (requireReservationId
      ? reservationIds.length !== 1 || !UUID.test(reservationIds[0] ?? "")
      : reservationIds.length !== 0)
  ) {
    return null;
  }
  return {
    date: dates[0],
    serviceIds,
    ...(reservationIds[0] === undefined
      ? {}
      : { reservationId: reservationIds[0] }),
  };
};

const scheduleQuery = (url: URL): { startDate: string; days: 1 | 7 } | null => {
  const entries = [...url.searchParams.entries()];
  if (
    entries.length !== 2 ||
    entries.filter(([key]) => key === "startDate").length !== 1 ||
    entries.filter(([key]) => key === "days").length !== 1 ||
    entries.some(([key]) => key !== "startDate" && key !== "days")
  ) {
    return null;
  }
  const startDate = url.searchParams.get("startDate");
  const days = url.searchParams.get("days");
  return validDate(startDate) && (days === "1" || days === "7")
    ? { startDate, days: days === "1" ? 1 : 7 }
    : null;
};

const SITEVERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const SITEVERIFY_TIMEOUT_MS = 4_000;
const SITEVERIFY_ATTEMPTS = 2;
const SITEVERIFY_RETRY_DELAY_MS = 300;

// The seven codes Cloudflare documents for this endpoint. Only internal-error is
// described as retryable; the rest are terminal for the presented token and the
// customer needs a fresh challenge. Anything outside this set is treated as
// terminal and dropped from diagnostics rather than echoed back.
const SITEVERIFY_ERROR_CODES = new Set([
  "missing-input-secret",
  "invalid-input-secret",
  "missing-input-response",
  "invalid-input-response",
  "bad-request",
  "timeout-or-duplicate",
  "internal-error",
]);
const SITEVERIFY_RETRYABLE_CODE = "internal-error";

type SiteverifyOutcome = "accepted" | "refused" | "unavailable";
type SiteverifyAttempt = SiteverifyOutcome | "retry";

// Siteverify's idempotency_key exists so one token's validation can be retried
// safely. It has to be stable for the same proof and different for a different
// proof. Deriving it from commandId alone would be wrong: the browser keeps
// commandId when a submission is retried but calls turnstile.reset() first, so a
// previous verdict could answer for a token it never saw. Binding the key to the
// token as well keeps "same proof, retried" as the only case that shares a key.
const siteverifyIdempotencyKey = async (
  commandId: string,
  token: string,
): Promise<string> => {
  const digest = await sha256(`turnstile ${commandId} ${token}`);
  const bytes = digest.slice(0, 16);
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x80;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

// The only application log in the Worker. It carries a fixed outcome label, the
// attempt count, and documented provider error codes: never the token, secret,
// idempotency key, customer fields, or IP address.
const logSiteverify = (
  outcome: string,
  attempts: number,
  codes: string[] = [],
): void => {
  console.warn(
    JSON.stringify({
      event: "turnstile.siteverify",
      outcome,
      attempts,
      ...(codes.length === 0 ? {} : { codes }),
    }),
  );
};

const siteverifyAttempt = async (
  payload: string,
  settings: InstallationSettings,
  attempt: number,
): Promise<SiteverifyAttempt> => {
  let response: Response;
  try {
    response = await fetch(SITEVERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
      signal: AbortSignal.timeout(SITEVERIFY_TIMEOUT_MS),
    });
  } catch {
    logSiteverify("unreachable", attempt);
    return "retry";
  }
  if (response.status === 429 || response.status >= 500) {
    logSiteverify("provider_status", attempt);
    return "retry";
  }
  if (!response.ok) {
    logSiteverify("rejected_request", attempt);
    return "unavailable";
  }
  let result: unknown;
  try {
    result = await response.json();
  } catch {
    logSiteverify("malformed_response", attempt);
    return "unavailable";
  }
  if (!isObject(result) || typeof result.success !== "boolean") {
    logSiteverify("malformed_response", attempt);
    return "unavailable";
  }
  if (!result.success) {
    const raw = result["error-codes"];
    const codes = Array.isArray(raw)
      ? raw.filter(
          (code): code is string =>
            typeof code === "string" && SITEVERIFY_ERROR_CODES.has(code),
        )
      : [];
    if (codes.includes(SITEVERIFY_RETRYABLE_CODE)) {
      logSiteverify("provider_error", attempt, codes);
      return "retry";
    }
    logSiteverify("refused", attempt, codes);
    return "refused";
  }
  if (
    result.action !== "reservation-create" ||
    result.hostname !== settings.allowedHostname
  ) {
    logSiteverify("unexpected_proof", attempt);
    return "refused";
  }
  return "accepted";
};

const verifyTurnstile = async (
  request: Request,
  env: AppEnv,
  settings: InstallationSettings,
  token: string,
  commandId: string,
): Promise<SiteverifyOutcome> => {
  const turnstileSecret = secret(env, "TURNSTILE_SECRET");
  if (turnstileSecret === null || turnstileSecret.length === 0) return "unavailable";
  const body: Record<string, string> = {
    secret: turnstileSecret,
    response: token,
    idempotency_key: await siteverifyIdempotencyKey(commandId, token),
  };
  const remoteip = request.headers.get("cf-connecting-ip");
  if (remoteip !== null) body.remoteip = remoteip;
  const payload = JSON.stringify(body);
  for (let attempt = 1; attempt <= SITEVERIFY_ATTEMPTS; attempt += 1) {
    const outcome = await siteverifyAttempt(payload, settings, attempt);
    if (outcome !== "retry") return outcome;
    if (attempt < SITEVERIFY_ATTEMPTS) {
      await scheduler.wait(SITEVERIFY_RETRY_DELAY_MS);
    }
  }
  return "unavailable";
};

const allowedActions = (status: string): string[] =>
  status === "pending" || status === "approved" ? ["cancel"] : [];

const ownedReservation = (
  value: DayMutationSuccess | DayPublicStatusSuccess,
) => {
  const snapshot = value.snapshot as BookingSnapshot;
  const resourceLabel =
    "resourceLabel" in value ? value.resourceLabel : snapshot.resourceLabel;
  return {
    reservationId: value.reservationId,
    date: value.date,
    startTime: value.startTime,
    status: value.status,
    resourceLabel,
    services: snapshot.services,
    settingsVersion: snapshot.settingsVersion,
    consentVersion: snapshot.consentVersion,
    serviceMinutes: snapshot.serviceMinutes,
    cleanupMinutes: snapshot.cleanupMinutes,
    priceYen: snapshot.priceYen,
    ...("rejectionReason" in value && value.rejectionReason !== undefined
      ? { rejectionReason: value.rejectionReason }
      : {}),
    allowedActions: allowedActions(value.status),
  };
};

const mutationResponse = (
  result: Awaited<ReturnType<ReservationDay["createPublic"]>>,
  operation: string,
  successStatus: number,
): Response =>
  result.ok
    ? json(
        {
          ok: true,
          operation,
          replayed: result.replayed,
          reservation: ownedReservation(result),
        },
        successStatus,
      )
    : failureResponse(result);

const closureResponse = (
  result: Awaited<ReturnType<ReservationDay["createClosure"]>>,
  operation: "closure_create" | "closure_remove",
  successStatus: number,
): Response =>
  result.ok
    ? json(
        {
          ok: true,
          operation,
          replayed: result.replayed,
          closureId: result.closureId,
        },
        successStatus,
      )
    : failureResponse(result);

const failureResponse = (result: DayFailure): Response => {
  switch (result.code) {
    case "BAD_REQUEST":
      return errorResponse(400, "BAD_REQUEST");
    case "CONFIGURATION_CONFLICT":
      return errorResponse(409, "CONFIGURATION_CONFLICT");
    case "IDEMPOTENCY_CONFLICT":
      return errorResponse(409, "IDEMPOTENCY_CONFLICT");
    case "NOT_FOUND_OR_UNAUTHORIZED":
      return errorResponse(404, "NOT_FOUND_OR_UNAUTHORIZED");
    case "UNAVAILABLE":
      return errorResponse(409, "UNAVAILABLE");
    case "CAPACITY_REACHED":
      return errorResponse(409, "CAPACITY_REACHED");
    case "TEMPORARILY_UNAVAILABLE":
      return errorResponse(503, "TEMPORARILY_UNAVAILABLE");
  }
};

const setupResultResponse = (
  result: Awaited<ReturnType<InstallationConfig["executeCommand"]>>,
): Response => {
  if (result.ok) return json(result.outcome);
  switch (result.error.code) {
    case "INVALID_COMMAND":
      return errorResponse(400, "BAD_REQUEST");
    case "CONFIGURATION_CONFLICT":
      return errorResponse(409, "CONFIGURATION_CONFLICT");
    case "IDEMPOTENCY_CONFLICT":
      return errorResponse(409, "IDEMPOTENCY_CONFLICT");
    case "READINESS_BLOCKED":
      return errorResponse(409, "NOT_LIVE");
  }
};

const setupProjection = (context: InstallationContext) => ({
  mode: context.state.mode,
  settingsVersion: context.state.activeSettingsVersion,
  settings: context.settings,
  readiness: evaluateInstallationReadiness(context.settings, context.runtime),
  replayed: false,
});

const handleConfig = async (
  request: Request,
  env: AppEnv,
  url: URL,
): Promise<Response> => {
  if (request.method !== "GET") {
    return errorResponse(405, "BAD_REQUEST", { allow: "GET" });
  }
  if (url.search !== "") return errorResponse(400, "BAD_REQUEST");
  const context = await installationContext(env, url, false);
  const readiness = evaluateInstallationReadiness(context.settings, {
    ...context.runtime,
    ownerAuthenticated: context.runtime.ownerSecretPresent,
  });
  const projected = projectPublicConfig(context.state);
  return json({
    ...projected,
    mode: context.state.mode === "live" && readiness.ready ? "live" : "demo",
  });
};

const handleAvailability = async (
  request: Request,
  env: AppEnv,
  url: URL,
): Promise<Response> => {
  if (request.method !== "GET") {
    return errorResponse(405, "BAD_REQUEST", { allow: "GET" });
  }
  const query = availabilityQuery(url);
  if (query === null) return errorResponse(400, "BAD_REQUEST");
  const context = await installationContext(env, url, false);
  if (
    !isActiveSelection(context.settings, query.serviceIds) ||
    !isBookableDate(query.date, Date.now(), context.settings)
  ) {
    return errorResponse(400, "BAD_REQUEST");
  }
  const result = await dayStub(env, query.date).availability(
    toDayConfig(query.date, context),
    query.serviceIds,
  );
  if (!result.ok) return failureResponse(result);
  const { ok: _ok, ...availability } = result;
  return json({
    date: query.date,
    ...availability,
    resources: availability.resources.filter(({ id }) =>
      context.settings.resources.some((resource) => resource.active && resource.id === id),
    ),
  });
};

const handleOwnerAvailability = async (
  request: Request,
  env: AppEnv,
  url: URL,
): Promise<Response> => {
  if (request.method !== "GET") {
    return errorResponse(405, "BAD_REQUEST", { allow: "GET" });
  }
  const gate = await ownerGate(request, env, "owner-availability");
  if (gate !== null) return gate;
  const query = availabilityQuery(url, true);
  if (
    query === null ||
    query.reservationId === undefined ||
    !withinPartitionWindow(query.date, Date.now())
  ) {
    return errorResponse(400, "BAD_REQUEST");
  }
  const context = await installationContext(env, url, true);
  const result = await dayStub(env, query.date).availability(
    toDayConfig(query.date, context),
    query.serviceIds,
    query.reservationId,
  );
  if (!result.ok) return failureResponse(result);
  if (!result.pinned && !isBookableDate(query.date, Date.now(), context.settings)) {
    return errorResponse(400, "BAD_REQUEST");
  }
  const { ok: _ok, ...availability } = result;
  return json({ date: query.date, ...availability });
};

const handlePublicCreate = async (
  request: Request,
  env: AppEnv,
  url: URL,
): Promise<Response> => {
  if (request.method !== "POST") {
    return errorResponse(405, "BAD_REQUEST", { allow: "POST" });
  }
  const originFailure = requireMutationOrigin(request, url);
  if (originFailure !== null) return originFailure;
  if (await limited(env.PUBLIC_RATE_LIMITER, request, "public-create")) {
    return rateLimited();
  }
  const context = await installationContext(env, url, false);
  const parsed = await bodyOrError(request);
  if ("response" in parsed) return parsed.response;
  const input = parseCreate(parsed.value, true);
  if (
    input === null ||
    input.turnstileToken === undefined ||
    input.replayOnly === undefined
  ) {
    return errorResponse(400, "BAD_REQUEST");
  }
  const {
    turnstileToken,
    replayOnly,
    ...dayInput
  } = input;
  if (replayOnly) {
    if (!withinPartitionWindow(input.date, Date.now())) {
      return errorResponse(400, "BAD_REQUEST");
    }
    return mutationResponse(
      await dayStub(env, input.date).createPublic(
        toDayConfig(input.date, context),
        dayInput,
        false,
      ),
      "create",
      201,
    );
  }
  if (!isActiveSelection(context.settings, dayInput.serviceIds ?? [], dayInput.resourceId)) {
    return errorResponse(400, "BAD_REQUEST");
  }
  if (context.state.mode !== "live") return errorResponse(403, "NOT_LIVE");
  const readiness = evaluateInstallationReadiness(context.settings, {
    ...context.runtime,
    ownerAuthenticated: context.runtime.ownerSecretPresent,
  });
  if (!readiness.ready) return errorResponse(403, "PROTECTION_REFUSED");
  if (!isBookableDate(input.date, Date.now(), context.settings)) {
    return errorResponse(400, "BAD_REQUEST");
  }
  const verification = await verifyTurnstile(
    request,
    env,
    context.settings,
    turnstileToken,
    dayInput.commandId,
  );
  if (verification === "refused") return errorResponse(403, "PROTECTION_REFUSED");
  if (verification === "unavailable") {
    return errorResponse(503, "TEMPORARILY_UNAVAILABLE");
  }
  const result = await dayStub(env, input.date).createPublic(
    toDayConfig(input.date, context),
    dayInput,
    true,
  );
  return mutationResponse(result, "create", 201);
};

const handlePublicStatus = async (
  request: Request,
  env: AppEnv,
  url: URL,
  reservationId: string,
): Promise<Response> => {
  if (request.method !== "POST") {
    return errorResponse(405, "BAD_REQUEST", { allow: "POST" });
  }
  const originFailure = requireMutationOrigin(request, url);
  if (originFailure !== null) return originFailure;
  if (await limited(env.PUBLIC_RATE_LIMITER, request, "public-status")) {
    return rateLimited();
  }
  const parsed = await bodyOrError(request);
  if ("response" in parsed) return parsed.response;
  const input = parseStatus(parsed.value, reservationId);
  if (input === null) return errorResponse(400, "BAD_REQUEST");
  const context = await installationContext(env, url, false);
  if (!withinPartitionWindow(input.date, Date.now())) {
    return errorResponse(400, "BAD_REQUEST");
  }
  const result = await dayStub(env, input.date).statusPublic(
    toDayConfig(input.date, context),
    input,
  );
  return result.ok
    ? json(ownedReservation(result))
    : failureResponse(result);
};

const handlePublicCancel = async (
  request: Request,
  env: AppEnv,
  url: URL,
  reservationId: string,
): Promise<Response> => {
  if (request.method !== "POST") {
    return errorResponse(405, "BAD_REQUEST", { allow: "POST" });
  }
  const originFailure = requireMutationOrigin(request, url);
  if (originFailure !== null) return originFailure;
  if (await limited(env.PUBLIC_RATE_LIMITER, request, "public-cancel")) {
    return rateLimited();
  }
  const context = await installationContext(env, url, false);
  const parsed = await bodyOrError(request);
  if ("response" in parsed) return parsed.response;
  const input = parsePublicCancel(parsed.value, reservationId);
  if (
    input === null ||
    !withinPartitionWindow(input.date, Date.now())
  ) {
    return errorResponse(400, "BAD_REQUEST");
  }
  return mutationResponse(
    await dayStub(env, input.date).cancelPublic(toDayConfig(input.date, context), input),
    "cancel",
    200,
  );
};

const handleSetup = async (
  request: Request,
  env: AppEnv,
  url: URL,
): Promise<Response> => {
  if (request.method !== "GET" && request.method !== "PUT") {
    return errorResponse(405, "BAD_REQUEST", { allow: "GET, PUT" });
  }
  if (request.method === "PUT") {
    const originFailure = requireMutationOrigin(request, url);
    if (originFailure !== null) return originFailure;
  }
  const gate = await ownerGate(request, env, "owner-setup");
  if (gate !== null) return gate;
  if (url.search !== "") return errorResponse(400, "BAD_REQUEST");
  if (request.method === "GET") {
    return json(setupProjection(await installationContext(env, url, true)));
  }
  const parsed = await bodyOrError(request);
  if ("response" in parsed) return parsed.response;
  if (
    !isObject(parsed.value) ||
    !hasExactKeys(parsed.value, ["commandId", "expectedSettingsVersion", "settings"])
  ) {
    return errorResponse(400, "BAD_REQUEST");
  }
  const result = await installationStub(env).executeCommand(
    { type: "settings.update", ...parsed.value },
    runtimeFor(env, url, true),
  );
  return setupResultResponse(result);
};

const handleLive = async (
  request: Request,
  env: AppEnv,
  url: URL,
): Promise<Response> => {
  if (request.method !== "POST") {
    return errorResponse(405, "BAD_REQUEST", { allow: "POST" });
  }
  const originFailure = requireMutationOrigin(request, url);
  if (originFailure !== null) return originFailure;
  const gate = await ownerGate(request, env, "owner-live");
  if (gate !== null) return gate;
  if (url.search !== "") return errorResponse(400, "BAD_REQUEST");
  const parsed = await bodyOrError(request);
  if ("response" in parsed) return parsed.response;
  if (
    !isObject(parsed.value) ||
    !hasExactKeys(parsed.value, ["commandId", "expectedSettingsVersion", "live"])
  ) {
    return errorResponse(400, "BAD_REQUEST");
  }
  const result = await installationStub(env).executeCommand(
    { type: "settings.live", ...parsed.value },
    runtimeFor(env, url, true),
  );
  return setupResultResponse(result);
};

const handleReceipt = async (
  request: Request,
  env: AppEnv,
  url: URL,
): Promise<Response> => {
  if (request.method !== "GET") {
    return errorResponse(405, "BAD_REQUEST", { allow: "GET" });
  }
  const gate = await ownerGate(request, env, "owner-receipt");
  if (gate !== null) return gate;
  if (url.search !== "") return errorResponse(400, "BAD_REQUEST");
  return json(
    await installationStub(env).installationReceipt(runtimeFor(env, url, true)),
  );
};

const ownerListReservation = (
  reservation: {
    reservationId: string;
    resourceId: string;
    resourceLabel?: string;
    startTime: string;
    status: string;
    customerName: string;
    contact: string;
    snapshot?: BookingSnapshot;
    rejectionReason?: string | null;
    rescheduleHistory?: Array<{
      from: { resourceId: string; startTime: string };
      to: { resourceId: string; startTime: string };
    }>;
  },
  date: string,
) => {
  const snapshot = reservation.snapshot as BookingSnapshot;
  const projected = ownedReservation(
    {
      ok: true,
      reservationId: reservation.reservationId,
      date,
      resourceId: reservation.resourceId,
      startTime: reservation.startTime,
      status: reservation.status as DayMutationSuccess["status"],
      replayed: false,
      snapshot,
      ...(reservation.rejectionReason === undefined
        ? {}
        : { rejectionReason: reservation.rejectionReason }),
    },
  );
  return {
    ...projected,
    ...(reservation.resourceLabel === undefined
      ? {}
      : { resourceLabel: reservation.resourceLabel }),
    customerName: reservation.customerName,
    contact: reservation.contact,
    ...(reservation.rescheduleHistory === undefined
      ? {}
      : { rescheduleHistory: reservation.rescheduleHistory }),
  };
};

const handleSchedule = async (
  request: Request,
  env: AppEnv,
  url: URL,
): Promise<Response> => {
  if (request.method !== "GET") {
    return errorResponse(405, "BAD_REQUEST", { allow: "GET" });
  }
  const gate = await ownerGate(request, env, "owner-schedule");
  if (gate !== null) return gate;
  const query = scheduleQuery(url);
  if (query === null) return errorResponse(400, "BAD_REQUEST");
  const context = await installationContext(env, url, true);
  if (
    !withinPartitionWindow(query.startDate, Date.now()) ||
    !withinPartitionWindow(addDays(query.startDate, query.days - 1), Date.now())
  ) {
    return errorResponse(400, "BAD_REQUEST");
  }
  const boards = [];
  let attentionCount = evaluateInstallationReadiness(
    context.settings,
    context.runtime,
  ).blockers.length;
  for (let offset = 0; offset < query.days; offset += 1) {
    const date = addDays(query.startDate, offset);
    const result = await dayStub(env, date).listOwner(toDayConfig(date, context));
    if (!result.ok) return failureResponse(result);
    attentionCount += result.reservations.filter(({ status }) => status === "pending").length;
    if (
      result.settingsVersion !== undefined &&
      result.settingsVersion !== context.state.activeSettingsVersion
    ) {
      attentionCount += 1;
    }
    boards.push({
      date,
      settingsVersion: result.settingsVersion ?? context.state.activeSettingsVersion,
      opensAt: result.opensAt ?? context.settings.opensAt,
      closesAt: result.closesAt ?? context.settings.closesAt,
      reservations: result.reservations.map((reservation) =>
        ownerListReservation(reservation, date),
      ),
      closures: result.closures ?? [],
    });
  }
  return json({ startDate: query.startDate, days: query.days, attentionCount, boards });
};

const handleOwnerCreate = async (
  request: Request,
  env: AppEnv,
  url: URL,
): Promise<Response> => {
  if (request.method !== "POST") {
    return errorResponse(405, "BAD_REQUEST", { allow: "POST" });
  }
  const originFailure = requireMutationOrigin(request, url);
  if (originFailure !== null) return originFailure;
  const gate = await ownerGate(request, env, "owner-create");
  if (gate !== null) return gate;
  const context = await installationContext(env, url, true);
  const parsed = await bodyOrError(request);
  if ("response" in parsed) return parsed.response;
  const input = parseCreate(parsed.value, false);
  if (input === null) {
    return errorResponse(400, "BAD_REQUEST");
  }
  const readiness = evaluateInstallationReadiness(context.settings, context.runtime);
  const dateFresh = isBookableDate(input.date, Date.now(), context.settings);
  const allowFresh =
    context.state.mode === "live" &&
    readiness.ready &&
    dateFresh &&
    isActiveSelection(context.settings, input.serviceIds ?? [], input.resourceId);
  if (!allowFresh && !withinPartitionWindow(input.date, Date.now())) {
    return errorResponse(400, "BAD_REQUEST");
  }
  const result = await dayStub(env, input.date).createOwner(
    toDayConfig(input.date, context),
    input,
    allowFresh,
  );
  if (!allowFresh && !result.ok && result.code === "UNAVAILABLE") {
    if (context.state.mode !== "live") return errorResponse(403, "NOT_LIVE");
    if (!readiness.ready) return errorResponse(403, "PROTECTION_REFUSED");
    return errorResponse(400, "BAD_REQUEST");
  }
  return mutationResponse(result, "create", 201);
};

const handleOwnerTransition = async (
  request: Request,
  env: AppEnv,
  url: URL,
  reservationId: string,
): Promise<Response> => {
  if (request.method !== "POST") {
    return errorResponse(405, "BAD_REQUEST", { allow: "POST" });
  }
  const originFailure = requireMutationOrigin(request, url);
  if (originFailure !== null) return originFailure;
  const gate = await ownerGate(request, env, "owner-transition");
  if (gate !== null) return gate;
  const parsed = await bodyOrError(request);
  if ("response" in parsed) return parsed.response;
  const input = parseTransition(parsed.value, reservationId);
  if (input === null) return errorResponse(400, "BAD_REQUEST");
  const context = await installationContext(env, url, true);
  if (!withinPartitionWindow(input.date, Date.now())) {
    return errorResponse(400, "BAD_REQUEST");
  }
  return mutationResponse(
    await dayStub(env, input.date).transitionOwner(toDayConfig(input.date, context), input),
    input.action,
    200,
  );
};

const handleClosureCreate = async (
  request: Request,
  env: AppEnv,
  url: URL,
): Promise<Response> => {
  if (request.method !== "POST") {
    return errorResponse(405, "BAD_REQUEST", { allow: "POST" });
  }
  const originFailure = requireMutationOrigin(request, url);
  if (originFailure !== null) return originFailure;
  const gate = await ownerGate(request, env, "owner-closure-create");
  if (gate !== null) return gate;
  const parsed = await bodyOrError(request);
  if ("response" in parsed) return parsed.response;
  const input = parseClosureCreate(parsed.value);
  if (input === null) return errorResponse(400, "BAD_REQUEST");
  const context = await installationContext(env, url, true);
  const allowFresh = isBookableDate(input.date, Date.now(), context.settings);
  if (!allowFresh && !withinPartitionWindow(input.date, Date.now())) {
    return errorResponse(400, "BAD_REQUEST");
  }
  const result = await dayStub(env, input.date).createClosure(
    toDayConfig(input.date, context),
    input,
    allowFresh,
  );
  return !allowFresh && !result.ok && result.code === "UNAVAILABLE"
    ? errorResponse(400, "BAD_REQUEST")
    : closureResponse(result, "closure_create", 201);
};

const handleClosureRemove = async (
  request: Request,
  env: AppEnv,
  url: URL,
  closureId: string,
): Promise<Response> => {
  if (request.method !== "POST") {
    return errorResponse(405, "BAD_REQUEST", { allow: "POST" });
  }
  const originFailure = requireMutationOrigin(request, url);
  if (originFailure !== null) return originFailure;
  const gate = await ownerGate(request, env, "owner-closure-remove");
  if (gate !== null) return gate;
  const parsed = await bodyOrError(request);
  if ("response" in parsed) return parsed.response;
  const input = parseClosureRemove(parsed.value, closureId);
  if (input === null) return errorResponse(400, "BAD_REQUEST");
  const context = await installationContext(env, url, true);
  if (!withinPartitionWindow(input.date, Date.now())) {
    return errorResponse(400, "BAD_REQUEST");
  }
  return closureResponse(
    await dayStub(env, input.date).removeClosure(toDayConfig(input.date, context), input),
    "closure_remove",
    200,
  );
};

const handle = async (request: Request, env: AppEnv): Promise<Response> => {
  const url = new URL(request.url);
  if (url.pathname === "/api/config") return handleConfig(request, env, url);
  if (url.pathname === "/api/availability") return handleAvailability(request, env, url);
  if (url.pathname === "/api/reservations") return handlePublicCreate(request, env, url);

  const publicStatus = url.pathname.match(/^\/api\/reservations\/([^/]+)\/status$/);
  if (publicStatus?.[1] !== undefined) {
    return handlePublicStatus(request, env, url, publicStatus[1]);
  }
  const publicCancel = url.pathname.match(/^\/api\/reservations\/([^/]+)\/cancel$/);
  if (publicCancel?.[1] !== undefined) {
    return handlePublicCancel(request, env, url, publicCancel[1]);
  }

  if (url.pathname === "/api/admin/setup") return handleSetup(request, env, url);
  if (url.pathname === "/api/admin/setup/live") return handleLive(request, env, url);
  if (url.pathname === "/api/admin/installation-receipt") {
    return handleReceipt(request, env, url);
  }
  if (url.pathname === "/api/admin/availability") {
    return handleOwnerAvailability(request, env, url);
  }
  if (url.pathname === "/api/admin/schedule") return handleSchedule(request, env, url);
  if (url.pathname === "/api/admin/reservations") {
    return handleOwnerCreate(request, env, url);
  }

  const transition = url.pathname.match(
    /^\/api\/admin\/reservations\/([^/]+)\/transition$/,
  );
  if (transition?.[1] !== undefined) {
    return handleOwnerTransition(request, env, url, transition[1]);
  }
  if (url.pathname === "/api/admin/closures") {
    return handleClosureCreate(request, env, url);
  }
  const closureRemove = url.pathname.match(
    /^\/api\/admin\/closures\/([^/]+)\/remove$/,
  );
  if (closureRemove?.[1] !== undefined) {
    return handleClosureRemove(request, env, url, closureRemove[1]);
  }

  if (url.pathname.startsWith("/api/")) return errorResponse(404, "BAD_REQUEST");
  return env.ASSETS.fetch(request);
};

export default {
  async fetch(request, env): Promise<Response> {
    try {
      return await handle(request, env as AppEnv);
    } catch {
      return errorResponse(503, "TEMPORARILY_UNAVAILABLE");
    }
  },
} satisfies ExportedHandler<Env>;
