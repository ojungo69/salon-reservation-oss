import { parseDateJstToUtcIso } from "./date-parse.ts";
import {
  DEFAULT_PENDING_EXPIRY_MINUTES,
  evaluateInstallationReadiness,
  InstallationConfig,
  projectPublicConfig,
  type InstallationSettings,
  type InstallationState,
  type LineContext,
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

import { AdapterDelivery } from "./adapter-delivery.ts";
import {
  parseWebhookBody,
  readBoundedBytes,
  verifyIdToken,
  verifyWebhookSignature,
} from "./line-adapter.ts";
import { ADAPTER } from "./adapter-constants.ts";

export { AdapterDelivery, InstallationConfig, ReservationDay };

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
  line?: LineContext;
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
  CAPACITY_REACHED:
    "この日の受付回数が上限に達しているため、この操作はお受けできません。上限は取り消しや期限切れでは戻りません。",
  RATE_LIMITED: "操作が多すぎます。しばらく待ってからお試しください。",
  PROTECTION_REFUSED: "確認に失敗しました。もう一度お試しください。",
  NOT_LIVE: "現在は予約を受け付けていません。",
  TEMPORARILY_UNAVAILABLE: "現在処理できません。しばらく待ってからお試しください。",
  UNAUTHORIZED: "認証情報を確認できませんでした。",
  VERSION_CONFLICT: "設定が更新されています。最新の状態を読み込み直してください。",
  LINE_LINK_CONFLICT:
    "この予約には別の LINE アカウントが連携されています。現在の連携を解除してからやり直してください。",
  PHASE_CONFLICT: "現在の連携状態ではこの操作を実行できません。",
  ORIGIN_UNCONFIGURED:
    "公開ホスト名が設定されていません。設定画面で公開ホスト名を保存してから有効化してください。",
  SECRET_MISSING:
    "LINE のチャネルシークレットが設定されていません。シークレットを登録してから有効化してください。",
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

const secret = (
  env: AppEnv,
  name: "OWNER_TOKEN" | "TURNSTILE_SECRET" | "LINE_MESSAGING_CHANNEL_SECRET",
): string | null => {
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

const lineSecretPresent = (env: AppEnv): boolean => {
  const value = secret(env, "LINE_MESSAGING_CHANNEL_SECRET");
  return value !== null && value.length >= 16 && value.length <= 128;
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

const adapterDeliveryStub = (env: AppEnv): DurableObjectStub<AdapterDelivery> =>
  env.ADAPTER_DELIVERY.getByName("installation");

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
  lineSecretPresent: lineSecretPresent(env),
  hostname: url.hostname.toLowerCase(),
});

const installationContext = async (
  env: AppEnv,
  url: URL,
  authenticated: boolean,
): Promise<InstallationContext> => {
  const { state, line } = await installationStub(env).getContext();
  const record = state.settingsVersions.find(
    ({ version }) => version === state.activeSettingsVersion,
  );
  if (record === undefined) throw new Error("missing active installation settings");
  return {
    state,
    settings: record.settings,
    runtime: runtimeFor(env, url, authenticated),
    ...(line === undefined ? {} : { line }),
  };
};

// The day-side descriptor travels only while events may be committed (active)
// or drained (deactivating); the lease is forwarded unmodified from the
// projection read.
const adapterDescriptor = (
  context: InstallationContext,
): DayConfig["adapter"] | undefined => {
  const line = context.line;
  if (line === undefined || line.generation === undefined) return undefined;
  if (line.phase !== "active" && line.phase !== "deactivating") return undefined;
  // Without the secret the adapter is in cleanup mode: it can still drain what
  // exists, but a fresh request must not create new outbox rows that nothing
  // is able to send. Only leases issued before the secret vanished still
  // apply, and those expire on their own.
  if (line.phase === "active" && !context.runtime.lineSecretPresent) return undefined;
  return {
    consumer: "line",
    generation: line.generation,
    phase: line.phase,
    leaseIssuedAt: line.lease.issuedAt,
    leaseNotAfter: line.lease.notAfter,
  };
};

// One retry with a fresh projection when a day refuses an expired lease;
// booking commands are idempotent, so re-invoking is safe.
const dayCallWithRetry = async <R>(
  env: AppEnv,
  url: URL,
  authenticated: boolean,
  date: string,
  context: InstallationContext,
  invoke: (config: DayConfig) => PromiseLike<R>,
): Promise<R> => {
  const result = await invoke(toDayConfig(date, context));
  const failed = result as { ok?: unknown; code?: unknown };
  if (failed.ok === false && failed.code === "RETRY_CONFIG") {
    const fresh = await installationContext(env, url, authenticated);
    return invoke(toDayConfig(date, fresh));
  }
  return result;
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

/** The partition's retention deadline: the one boundary every reservation-scoped
 * row — day-side or adapter-side — is held to. */
const purgeAtFor = (date: string, context: InstallationContext): number => {
  const midnight = parseDateJstToUtcIso(date);
  if (midnight === null) throw new Error("invalid date");
  return Date.parse(midnight) + (context.settings.retentionDays + 1) * DAY_MS;
};

const toDayConfig = (date: string, context: InstallationContext): DayConfig => {
  const midnight = parseDateJstToUtcIso(date);
  if (midnight === null) throw new Error("invalid date");
  const { settings, state } = context;
  const adapter = adapterDescriptor(context);
  return {
    date,
    resourceIds: settings.resources.filter(({ active }) => active).map(({ id }) => id),
    startTimes: startTimes(settings),
    slotMinutes: settings.startIntervalMinutes,
    purgeAt: purgeAtFor(date, context),
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
    // Installations created before the setting existed do not store it, so the
    // default is applied here rather than in the parser, which has to leave the
    // stored JSON byte-identical.
    pendingExpiryMinutes: settings.pendingExpiryMinutes ?? DEFAULT_PENDING_EXPIRY_MINUTES,
    ...(adapter === undefined ? {} : { adapter }),
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

type SiteverifyOutcome = "accepted" | "refused" | "unavailable";
type SiteverifyAttempt = SiteverifyOutcome | "retry";

// Siteverify's idempotency_key exists so one token's validation can be retried
// safely: a token is otherwise single-use, and a second verification of it comes
// back as timeout-or-duplicate. That makes the key a replay permit, so it has to
// name the exact request being retried and nothing wider.
//
// Deriving it from commandId alone would be wrong twice over. The browser keeps
// commandId when a submission is retried but calls turnstile.reset() first, so a
// previous verdict could answer for a token it never saw. And a reservation's
// idempotency is scoped to one day: the Durable Object is addressed by date and
// only dedupes commandId inside it, so the same commandId on two dates is two
// bookings. A key without the date would let one solved challenge be replayed
// once per bookable date. Binding all three keeps "this exact submission,
// retried" as the only case that shares a key.
const siteverifyIdempotencyKey = async (
  date: string,
  commandId: string,
  token: string,
): Promise<string> => {
  const digest = await sha256(`turnstile:${date}:${commandId}:${token}`);
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
    if (codes.includes("internal-error")) {
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
  date: string,
  commandId: string,
): Promise<SiteverifyOutcome> => {
  const turnstileSecret = secret(env, "TURNSTILE_SECRET");
  if (turnstileSecret === null || turnstileSecret.length === 0) return "unavailable";
  const body: Record<string, string> = {
    secret: turnstileSecret,
    response: token,
    idempotency_key: await siteverifyIdempotencyKey(date, commandId, token),
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
    ...("expiresAt" in value && value.expiresAt !== undefined
      ? { expiresAt: value.expiresAt }
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
    // Internal retry marker: the caller refreshes the installation context and
    // retries once before mapping; reaching here means the retry also raced a
    // lifecycle change, which is a plain transient failure to the client.
    case "RETRY_CONFIG":
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
  // The effective settings, so the setup form shows the lifetime that is
  // actually in force on an installation that predates the setting. Saving the
  // form is what writes it down.
  settings: {
    ...context.settings,
    pendingExpiryMinutes:
      context.settings.pendingExpiryMinutes ?? DEFAULT_PENDING_EXPIRY_MINUTES,
    // availabilityNotice stays absent when unset: the form renders it as an
    // empty field and omits the key on save, which is what the 1–200 char
    // validation expects.
    exposeResourceChoice: context.settings.exposeResourceChoice ?? true,
  },
  readiness: evaluateInstallationReadiness(context.settings, context.runtime),
  replayed: false,
});

// Public capability while effectively active; cleanup-only marker while
// previously created LINE data may still exist (missing secret, deactivating);
// otherwise the property is absent so the JSON stays byte-identical to its
// pre-adapter shape. The adapter state table in specs/003-line-adapter/plan.md
// is the single authority for this mapping.
const linePublicConfig = (
  context: InstallationContext,
): { liffId: string } | { cleanup: true } | null => {
  const line = context.line;
  if (line === undefined) return null;
  if (line.phase === "active" && line.liffId !== undefined) {
    return context.runtime.lineSecretPresent
      ? { liffId: line.liffId }
      : { cleanup: true };
  }
  if (line.phase === "deactivating") return { cleanup: true };
  return null;
};

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
  const line = linePublicConfig(context);
  return json({
    ...projected,
    mode: context.state.mode === "live" && readiness.ready ? "live" : "demo",
    ...(line === null ? {} : { lineAdapter: line }),
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
  const result = await dayCallWithRetry(env, url, false, query.date, context, async (config) =>
    dayStub(env, query.date).availability(config, query.serviceIds),
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
  const result = await dayCallWithRetry(env, url, true, query.date, context, async (config) =>
    dayStub(env, query.date).availability(config, query.serviceIds, query.reservationId),
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
      await dayCallWithRetry(env, url, false, input.date, context, async (config) =>
        dayStub(env, input.date).createPublic(config, dayInput, false),
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
    input.date,
    dayInput.commandId,
  );
  if (verification === "refused") return errorResponse(403, "PROTECTION_REFUSED");
  if (verification === "unavailable") {
    return errorResponse(503, "TEMPORARILY_UNAVAILABLE");
  }
  const result = await dayCallWithRetry(env, url, false, input.date, context, async (config) =>
    dayStub(env, input.date).createPublic(config, dayInput, true),
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
  const result = await dayCallWithRetry(env, url, false, input.date, context, async (config) =>
    dayStub(env, input.date).statusPublic(config, input),
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
    await dayCallWithRetry(env, url, false, input.date, context, async (config) =>
      dayStub(env, input.date).cancelPublic(config, input),
    ),
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

const LINE_COMMAND_STATUS: Record<
  Exclude<Awaited<ReturnType<InstallationConfig["executeLineCommand"]>>, { ok: true }>["code"],
  number
> = {
  BAD_REQUEST: 400,
  IDEMPOTENCY_CONFLICT: 409,
  VERSION_CONFLICT: 409,
  PHASE_CONFLICT: 409,
  SECRET_MISSING: 409,
  ORIGIN_UNCONFIGURED: 409,
  TEMPORARILY_UNAVAILABLE: 503,
};

const lineCommandResponse = (
  result: Awaited<ReturnType<InstallationConfig["executeLineCommand"]>>,
): Response => {
  if (result.ok) {
    return json({
      ok: true,
      phase: result.phase,
      lifecycleVersion: result.lifecycleVersion,
      replayed: result.replayed,
    });
  }
  return errorResponse(LINE_COMMAND_STATUS[result.code], result.code);
};

const handleLineLifecycle = async (
  request: Request,
  env: AppEnv,
  url: URL,
  operation: "line.settings" | "line.enable" | "line.disable",
): Promise<Response> => {
  if (request.method !== "POST") {
    return errorResponse(405, "BAD_REQUEST", { allow: "POST" });
  }
  const originFailure = requireMutationOrigin(request, url);
  if (originFailure !== null) return originFailure;
  const gate = await ownerGate(request, env, "line-lifecycle");
  if (gate !== null) return gate;
  if (url.search !== "") return errorResponse(400, "BAD_REQUEST");
  const parsed = await bodyOrError(request);
  if ("response" in parsed) return parsed.response;
  if (!isObject(parsed.value) || "operation" in parsed.value) {
    return errorResponse(400, "BAD_REQUEST");
  }
  const result = await installationStub(env).executeLineCommand(
    { operation, ...parsed.value },
    runtimeFor(env, url, true),
  );
  return lineCommandResponse(result);
};

const handleLineStatus = async (
  request: Request,
  env: AppEnv,
  url: URL,
): Promise<Response> => {
  if (request.method !== "GET") {
    return errorResponse(405, "BAD_REQUEST", { allow: "GET" });
  }
  const gate = await ownerGate(request, env, "line-status");
  if (gate !== null) return gate;
  if (url.search !== "") return errorResponse(400, "BAD_REQUEST");
  const lifecycle = await installationStub(env).lineAdapterStatus();
  // The authority read is diagnostic; a stalled delivery object must not take
  // the setup surface down with it.
  let authority: Awaited<ReturnType<AdapterDelivery["diagnostics"]>> | "unavailable" = null;
  try {
    authority = await adapterDeliveryStub(env).diagnostics();
  } catch {
    authority = "unavailable";
  }
  return json({
    ...lifecycle,
    secretPresent: lineSecretPresent(env),
    authority,
  });
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
    expiresAt?: string;
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
      ...(reservation.expiresAt === undefined
        ? {}
        : { expiresAt: reservation.expiresAt }),
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
    const result = await dayCallWithRetry(env, url, true, date, context, async (config) =>
      dayStub(env, date).listOwner(config),
    );
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
  const result = await dayCallWithRetry(env, url, true, input.date, context, async (config) =>
    dayStub(env, input.date).createOwner(config, input, allowFresh),
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
    await dayCallWithRetry(env, url, true, input.date, context, async (config) =>
      dayStub(env, input.date).transitionOwner(config, input),
    ),
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
  const result = await dayCallWithRetry(env, url, true, input.date, context, async (config) =>
    dayStub(env, input.date).createClosure(config, input, allowFresh),
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
    await dayCallWithRetry(env, url, true, input.date, context, async (config) =>
      dayStub(env, input.date).removeClosure(config, input),
    ),
    "closure_remove",
    200,
  );
};

// Effectively active: lifecycle phase active with the messaging secret bound.
// This is the gate for every customer-facing LINE surface; without it the
// routes 404 like they never existed.
const lineEffectivelyActive = (
  context: InstallationContext,
): context is InstallationContext & {
  line: LineContext & { generation: number; liffId: string; loginChannelId: string };
} =>
  context.line !== undefined &&
  context.line.phase === "active" &&
  context.line.generation !== undefined &&
  context.line.liffId !== undefined &&
  context.line.loginChannelId !== undefined &&
  context.runtime.lineSecretPresent;

// Management proof: the same body shape and day check the public status route
// uses; holding the management key is what authorizes link operations.
const lineManagementProof = async (
  env: AppEnv,
  url: URL,
  context: InstallationContext,
  reservationId: string,
  body: unknown,
): Promise<
  | { ok: true; date: string; status: string }
  | { ok: false; response: Response }
> => {
  if (
    !isObject(body) ||
    !hasExactKeys(body, ["date", "managementKey"]) ||
    !validDate(body.date) ||
    typeof body.managementKey !== "string" ||
    !withinPartitionWindow(body.date, Date.now())
  ) {
    return { ok: false, response: errorResponse(404, "NOT_FOUND_OR_UNAUTHORIZED") };
  }
  const date = body.date;
  const managementKey = body.managementKey;
  const result = await dayCallWithRetry(env, url, false, date, context, async (config) =>
    dayStub(env, date).statusPublic(config, { date, reservationId, managementKey }),
  );
  if (!result.ok) {
    return {
      ok: false,
      response:
        result.code === "TEMPORARILY_UNAVAILABLE" || result.code === "RETRY_CONFIG"
          ? errorResponse(503, "TEMPORARILY_UNAVAILABLE")
          : errorResponse(404, "NOT_FOUND_OR_UNAUTHORIZED"),
    };
  }
  return { ok: true, date, status: result.status };
};

// A hidden LINE surface must be indistinguishable from a path that was never
// routed: the method check, the Origin check and the rate limiter all come
// after the lifecycle gate, so none of them can answer for a route that is
// supposed to not exist. `residual` marks the cleanup routes, which stay
// reachable while previously created LINE data may still exist.
const lineRouteGate = async (
  env: AppEnv,
  url: URL,
  residual: boolean,
): Promise<InstallationContext | null> => {
  const context = await installationContext(env, url, false);
  if (lineEffectivelyActive(context)) return context;
  const line = context.line;
  if (
    residual &&
    line !== undefined &&
    line.generation !== undefined &&
    (line.phase === "active" || line.phase === "deactivating")
  ) {
    // Missing secret or mid-deactivation: the customer can still see and
    // remove their own link. A draft, an activating installation and a
    // completed purge all fall through to the 404 below.
    return context;
  }
  return null;
};

/** Shared preamble for the three reservation-scoped LINE routes. */
const lineReservationRoute = async (
  request: Request,
  env: AppEnv,
  url: URL,
  reservationId: string,
  options: { bucket: string; residual: boolean },
  run: (
    context: InstallationContext,
    proof: { date: string; status: string },
  ) => Promise<Response>,
): Promise<Response> => {
  const context = await lineRouteGate(env, url, options.residual);
  if (context === null) return errorResponse(404, "NOT_FOUND_OR_UNAUTHORIZED");
  if (request.method !== "POST") {
    return errorResponse(405, "BAD_REQUEST", { allow: "POST" });
  }
  const originFailure = requireMutationOrigin(request, url);
  if (originFailure !== null) return originFailure;
  if (await limited(env.PUBLIC_RATE_LIMITER, request, options.bucket)) {
    return rateLimited();
  }
  if (!UUID.test(reservationId)) return errorResponse(404, "NOT_FOUND_OR_UNAUTHORIZED");
  const parsed = await bodyOrError(request);
  if ("response" in parsed) return parsed.response;
  const proof = await lineManagementProof(env, url, context, reservationId, parsed.value);
  if (!proof.ok) return proof.response;
  return run(context, { date: proof.date, status: proof.status });
};

const handleLineLinkIntent = async (
  request: Request,
  env: AppEnv,
  url: URL,
  reservationId: string,
): Promise<Response> =>
  lineReservationRoute(
    request,
    env,
    url,
    reservationId,
    { bucket: "line-intent", residual: false },
    async (context, proof) => {
      if (proof.status !== "pending" && proof.status !== "approved") {
        return errorResponse(404, "NOT_FOUND_OR_UNAUTHORIZED");
      }
      const line = context.line as LineContext & { generation: number; liffId: string };
      const minted = await adapterDeliveryStub(env).mintIntent({
        reservationId,
        date: proof.date,
        generation: line.generation,
        purgeAt: purgeAtFor(proof.date, context),
      });
      if (!minted.ok) return errorResponse(404, "NOT_FOUND_OR_UNAUTHORIZED");
      return json({
        nonce: minted.nonce,
        liffId: line.liffId,
        expiresAt: minted.expiresAt,
      });
    },
  );

const handleLineLinkComplete = async (
  request: Request,
  env: AppEnv,
  url: URL,
): Promise<Response> => {
  const context = await lineRouteGate(env, url, false);
  if (context === null || !lineEffectivelyActive(context)) {
    return errorResponse(404, "NOT_FOUND_OR_UNAUTHORIZED");
  }
  if (request.method !== "POST") {
    return errorResponse(405, "BAD_REQUEST", { allow: "POST" });
  }
  const originFailure = requireMutationOrigin(request, url);
  if (originFailure !== null) return originFailure;
  if (await limited(env.PUBLIC_RATE_LIMITER, request, "line-link")) {
    return rateLimited();
  }
  const parsed = await bodyOrError(request);
  if ("response" in parsed) return parsed.response;
  if (
    !isObject(parsed.value) ||
    !hasExactKeys(parsed.value, ["nonce", "idToken"]) ||
    typeof parsed.value.nonce !== "string" ||
    typeof parsed.value.idToken !== "string"
  ) {
    return errorResponse(400, "BAD_REQUEST");
  }
  const { nonce, idToken } = parsed.value;
  // Nonce checked before any LINE fetch, and again inside the completing
  // transaction — a captured token alone can never attach a link.
  const pre = await adapterDeliveryStub(env).checkIntent({ nonce });
  if (!pre.ok) return errorResponse(404, "NOT_FOUND_OR_UNAUTHORIZED");
  const verified = await verifyIdToken(idToken, context.line.loginChannelId);
  if (!verified.ok) {
    return verified.code === "INVALID_TOKEN"
      ? errorResponse(401, "UNAUTHORIZED")
      : errorResponse(503, "TEMPORARILY_UNAVAILABLE");
  }
  const finalized = await adapterDeliveryStub(env).finalizeLink({
    nonce,
    subject: verified.sub,
  });
  if (!finalized.ok) {
    if (finalized.code === "LINK_CONFLICT") return errorResponse(409, "LINE_LINK_CONFLICT");
    if (finalized.code === "TEMPORARILY_UNAVAILABLE") {
      return errorResponse(503, "TEMPORARILY_UNAVAILABLE");
    }
    return errorResponse(404, "NOT_FOUND_OR_UNAUTHORIZED");
  }
  return json({ ok: true, linked: true, replayed: finalized.replayed });
};

const handleLineUnlink = async (
  request: Request,
  env: AppEnv,
  url: URL,
  reservationId: string,
): Promise<Response> =>
  lineReservationRoute(
    request,
    env,
    url,
    reservationId,
    { bucket: "line-unlink", residual: true },
    async () => {
      const result = await adapterDeliveryStub(env).unlink({ reservationId });
      return json({ ok: true, unlinked: result.existed });
    },
  );

const handleLineLinkStatus = async (
  request: Request,
  env: AppEnv,
  url: URL,
  reservationId: string,
): Promise<Response> =>
  lineReservationRoute(
    request,
    env,
    url,
    reservationId,
    { bucket: "line-link-status", residual: true },
    async () => {
      const status = await adapterDeliveryStub(env).linkStatus({ reservationId });
      if (status.linked === null) return errorResponse(404, "NOT_FOUND_OR_UNAUTHORIZED");
      return json({ linked: status.linked });
    },
  );

const handleLineWebhook = async (
  request: Request,
  env: AppEnv,
  url: URL,
): Promise<Response> => {
  // LINE posts cross-origin; the signature is the only authentication, and
  // while the adapter is not effectively active the endpoint does not exist.
  const context = await installationContext(env, url, false);
  if (!lineEffectivelyActive(context)) {
    return errorResponse(404, "NOT_FOUND_OR_UNAUTHORIZED");
  }
  if (request.method !== "POST") {
    return errorResponse(405, "BAD_REQUEST", { allow: "POST" });
  }
  const channelSecret = secret(env, "LINE_MESSAGING_CHANNEL_SECRET");
  if (channelSecret === null) return errorResponse(404, "NOT_FOUND_OR_UNAUTHORIZED");
  // Unauthenticated endpoint: reject on the cheapest evidence first, so a
  // header-less flood never pays for the body read, the HMAC, or a durable
  // write, and give it its own rate-limit bucket so it cannot crowd out the
  // customer routes. LINE retries webhooks, and duplicates are deduplicated.
  const signature = request.headers.get("x-line-signature");
  if (signature === null || signature.length === 0 || signature.length > 64) {
    return errorResponse(403, "PROTECTION_REFUSED");
  }
  if (await limited(env.PUBLIC_RATE_LIMITER, request, "line-webhook")) {
    return rateLimited();
  }
  const body = await readBoundedBytes(request.body, ADAPTER.WEBHOOK_BODY_MAX_BYTES);
  if (body === null) return errorResponse(413, "BAD_REQUEST");
  const signatureValid = await verifyWebhookSignature(channelSecret, signature, body);
  if (!signatureValid) {
    await adapterDeliveryStub(env).noteSignatureFailure();
    return errorResponse(403, "PROTECTION_REFUSED");
  }
  const parsedBody = parseWebhookBody(body);
  if (parsedBody === null) return errorResponse(400, "BAD_REQUEST");
  await adapterDeliveryStub(env).processWebhook({ events: parsedBody.events });
  return json({});
};

// The LIFF page needs LINE's SDK origin, so it gets its own tightened CSP
// instead of the site-wide one from _headers. connect-src covers liff.init's
// API calls; everything else stays same-origin.
// Every path the assets service serves the LIFF page under, plus its modules:
// one source for the router, the gate, and the run_worker_first list.
const LINE_PAGE_PATHS = new Set(["/line", "/line/", "/line.html", "/line/index", "/line/index.html"]);
const LINE_MODULE_PATHS = new Set(["/line-link.mjs", "/line-liff.mjs"]);

const LINE_PAGE_CSP =
  "default-src 'self'; script-src 'self' https://static.line-scdn.net; " +
  "connect-src 'self' https://api.line.me https://liff.line.me; " +
  "img-src 'self' data:; style-src 'self'; font-src 'self'; base-uri 'none'; " +
  "form-action 'self'; frame-ancestors 'none'; object-src 'none'";

// The assets service html-handles paths, so the canonical form is asked for
// directly; requesting "/404.html" would answer with its redirect instead of
// the page. The security headers the asset carries are kept.
const notFoundPage = async (env: AppEnv, url: URL): Promise<Response> => {
  const asset = await env.ASSETS.fetch(new Request(new URL("/404", url.origin)));
  const headers = new Headers(asset.headers);
  headers.set("content-type", "text/html; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.delete("etag");
  return new Response(asset.ok ? asset.body : null, { status: 404, headers });
};

// Worker-first LINE assets (run_worker_first routes /line* here): served only
// in the states the adapter state table allows, 404 otherwise — a
// never-configured installation shows no LINE trace at any of these paths.
const handleLineAsset = async (
  request: Request,
  env: AppEnv,
  url: URL,
): Promise<Response> => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return errorResponse(405, "BAD_REQUEST", { allow: "GET, HEAD" });
  }
  const context = await installationContext(env, url, false);
  const line = linePublicConfig(context);
  const isOptInModule = url.pathname === "/line-link.mjs";
  // The opt-in module also serves cleanup mode; the LIFF page and its script
  // require the full capability.
  const allowed =
    line !== null && (isOptInModule || !("cleanup" in line));
  if (!allowed) return notFoundPage(env, url);
  // The assets service html-handles paths (/line serves line.html; asking for
  // the .html form gets a redirect), so the binding is always asked for the
  // extensionless page path.
  const isPage = LINE_PAGE_PATHS.has(url.pathname);
  const assetPath = isPage ? "/line" : url.pathname;
  // Fetched without the caller's validators: a 304 here would leave the gated
  // response with no body to serve.
  const asset = await env.ASSETS.fetch(
    new Request(new URL(assetPath, url.origin), { method: request.method }),
  );
  if (!asset.ok) return notFoundPage(env, url);
  const headers = new Headers(asset.headers);
  headers.set("cache-control", "no-store");
  if (isPage) {
    headers.set("content-security-policy", LINE_PAGE_CSP);
  }
  return new Response(asset.body, { status: asset.status, headers });
};

// Rendered into privacy.html only while the adapter state table says the
// section exists (active, missing-secret, deactivating): the state rule, not
// the request, decides — a never-configured installation serves the asset
// byte-identically (the slot comment stays, invisible in the DOM).
const LINE_PRIVACY_SECTION = `<h2>LINE 連携を利用する場合</h2>
      <p>
        連携の運用記録(処理件数や失敗理由と時刻だけの、個人を特定しない記録)は、障害の把握のために一定期間だけ保持し、それぞれの保持期限と件数上限を過ぎたものから自動的に削除します。
      </p>
      <p>
        この設置では、予約の通知を LINE で受け取る連携を有効にしています。連携はお客様が予約ごとに自分で選んだ場合にだけ行われ、連携した予約について LINE のユーザー識別子と予約の対応、および通知の送信記録を保存します。お名前やご連絡先を LINE に送ることはありません。通知の本文には日時と予約の状態だけを含めます。
      </p>
      <p>
        連携は予約管理ページからいつでも解除でき、解除すると対応関係と未送信の通知を削除します。予約の保存期限が過ぎたとき、および運営者が連携機能を停止したときも同じように削除します。LINE 側でのデータの取り扱いは LINE の利用規約とプライバシーポリシーに従います。
      </p>`;

// Both public privacy paths are worker-served, and only a state that actually has
// a disclosure changes anything: without one the assets response is returned
// exactly as the platform produced it — same status, same headers, same body —
// so an installation without the adapter is byte-identical to one built before
// this feature existed.
const handlePrivacyPage = async (
  request: Request,
  env: AppEnv,
  url: URL,
): Promise<Response> => {
  const context = await installationContext(env, url, false);
  const disclose = linePublicConfig(context) !== null;
  const asset = await env.ASSETS.fetch(
    new Request(new URL("/privacy", url.origin), disclose ? { method: request.method } : request),
  );
  if (!disclose) return asset;
  if (!asset.ok) return asset;
  const headers = new Headers(asset.headers);
  // State-dependent and rewritten: a cached copy must never leak across
  // states, and the asset's own validators no longer describe this body.
  headers.set("cache-control", "no-store");
  headers.delete("etag");
  headers.delete("content-length");
  const body = (await asset.text()).replace(
    "<!-- adapter-disclosure-slot -->",
    LINE_PRIVACY_SECTION,
  );
  return new Response(request.method === "HEAD" ? null : body, {
    status: asset.status,
    headers,
  });
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

  const lineIntent = url.pathname.match(
    /^\/api\/reservations\/([^/]+)\/line\/link-intent$/,
  );
  if (lineIntent?.[1] !== undefined) {
    return handleLineLinkIntent(request, env, url, lineIntent[1]);
  }
  const lineUnlink = url.pathname.match(/^\/api\/reservations\/([^/]+)\/line\/unlink$/);
  if (lineUnlink?.[1] !== undefined) {
    return handleLineUnlink(request, env, url, lineUnlink[1]);
  }
  const lineStatus = url.pathname.match(/^\/api\/reservations\/([^/]+)\/line\/status$/);
  if (lineStatus?.[1] !== undefined) {
    return handleLineLinkStatus(request, env, url, lineStatus[1]);
  }
  if (url.pathname === "/api/adapters/line/link") {
    return handleLineLinkComplete(request, env, url);
  }
  if (url.pathname === "/api/adapters/line/webhook") {
    return handleLineWebhook(request, env, url);
  }

  if (url.pathname === "/api/admin/setup") return handleSetup(request, env, url);
  if (url.pathname === "/api/admin/line/settings") {
    return handleLineLifecycle(request, env, url, "line.settings");
  }
  if (url.pathname === "/api/admin/line/enable") {
    return handleLineLifecycle(request, env, url, "line.enable");
  }
  if (url.pathname === "/api/admin/line/disable") {
    return handleLineLifecycle(request, env, url, "line.disable");
  }
  if (url.pathname === "/api/admin/line/status") {
    return handleLineStatus(request, env, url);
  }
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

  if (LINE_PAGE_PATHS.has(url.pathname) || LINE_MODULE_PATHS.has(url.pathname)) {
    return handleLineAsset(request, env, url);
  }
  if (url.pathname === "/privacy" || url.pathname === "/privacy.html") {
    return handlePrivacyPage(request, env, url);
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
