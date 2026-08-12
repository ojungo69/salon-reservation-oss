import type { DurableObject as CloudflareDurableObject } from "cloudflare:workers";

const directNodeRuntime =
  typeof navigator !== "undefined" && navigator.userAgent.startsWith("Node.js/");

// Keep the pure module runnable under Node; Workers load the real RPC base.
const DurableObjectBase: typeof CloudflareDurableObject = directNodeRuntime
  ? (class {
      constructor() {
        throw new Error("InstallationConfig requires the Workers runtime");
      }
    } as unknown as typeof CloudflareDurableObject)
  : (await import("cloudflare:workers")).DurableObject;

export type InstallationMode = "demo" | "live";
export type ThemeId = "ink" | "forest" | "clay";

export interface InstallationService {
  id: string;
  label: string;
  category: string | null;
  durationMinutes: number;
  cleanupMinutes: number;
  priceYen: number | null;
  eligibleResourceIds: string[];
  active: boolean;
}

export interface InstallationResource {
  id: string;
  label: string;
  active: boolean;
}

export interface InstallationSettings {
  locationName: string;
  timeZone: "Asia/Tokyo";
  services: InstallationService[];
  resources: InstallationResource[];
  opensAt: string;
  closesAt: string;
  startIntervalMinutes: number;
  openWeekdays: number[];
  horizonDays: number;
  retentionDays: number;
  // Optional on purpose. Stored settings are validated by re-serialising them
  // and comparing the string to what is in storage, so a key this parser adds
  // to an installation that predates it turns that installation into corrupt
  // storage on the next read. Absence is preserved here and resolved to
  // DEFAULT_PENDING_EXPIRY_MINUTES where the value is used.
  pendingExpiryMinutes?: number;
  // Optional for the same storage round-trip reason. An operator note shown
  // next to availability on the booking screen; absent means no notice.
  availabilityNotice?: string;
  // Optional for the same storage round-trip reason. When false the customer
  // screen hides the resource select and auto-assigns the best eligible
  // resource; absence means true (today's behaviour).
  exposeResourceChoice?: boolean;
  consentVersion: string;
  operatorDisplayName: string;
  operatorContact: string;
  privacyNotice: string;
  termsNotice: string;
  cancellationPolicy: string;
  sourceUrl: string;
  turnstileSiteKey: string;
  allowedHostname: string;
  themeId: ThemeId;
}

export interface ReadinessProjection {
  ready: boolean;
  owner: boolean;
  protection: boolean;
  identity: boolean;
  capacity: boolean;
  blockers: Array<"owner" | "protection" | "identity" | "capacity">;
}

interface SettingsVersionRecord {
  version: number;
  settings: InstallationSettings;
  createdAt: string;
}

interface InstallationCommandOutcome {
  mode: InstallationMode;
  settingsVersion: number;
  settings: InstallationSettings;
  readiness: ReadinessProjection;
  replayed: boolean;
}

interface SettingsCommandReceipt {
  commandId: string;
  operation: "settings.update" | "settings.live";
  fingerprint: string;
  responseJson: string;
  createdAt: string;
}

export interface InstallationState {
  schemaVersion: 1;
  activeSettingsVersion: number;
  mode: InstallationMode;
  settingsVersions: SettingsVersionRecord[];
  receipts: SettingsCommandReceipt[];
  createdAt: string;
  updatedAt: string;
}

export interface ReadinessRuntime {
  ownerSecretPresent: boolean;
  ownerAuthenticated: boolean;
  turnstileSecretPresent: boolean;
  hostname: string;
}

type CommandRuntime = ReadinessRuntime & { now: string };

type InstallationCommand =
  | {
      type: "settings.update";
      commandId: string;
      expectedSettingsVersion: number;
      settings: InstallationSettings;
    }
  | {
      type: "settings.live";
      commandId: string;
      expectedSettingsVersion: number;
      live: boolean;
    };

type InstallationCommandError =
  | { code: "INVALID_COMMAND" }
  | {
      code: "CONFIGURATION_CONFLICT";
      expectedSettingsVersion: number;
      actualSettingsVersion: number;
    }
  | { code: "IDEMPOTENCY_CONFLICT"; commandId: string }
  | { code: "READINESS_BLOCKED"; blockers: ReadinessProjection["blockers"] };

export type InstallationCommandResult =
  | { ok: true; state: InstallationState; outcome: InstallationCommandOutcome }
  | { ok: false; state: InstallationState; error: InstallationCommandError };

const SETTINGS_KEYS = [
  "locationName",
  "timeZone",
  "services",
  "resources",
  "opensAt",
  "closesAt",
  "startIntervalMinutes",
  "openWeekdays",
  "horizonDays",
  "retentionDays",
  "pendingExpiryMinutes",
  "availabilityNotice",
  "exposeResourceChoice",
  "consentVersion",
  "operatorDisplayName",
  "operatorContact",
  "privacyNotice",
  "termsNotice",
  "cancellationPolicy",
  "sourceUrl",
  "turnstileSiteKey",
  "allowedHostname",
  "themeId",
] as const;

const SERVICE_KEYS = [
  "id",
  "label",
  "category",
  "durationMinutes",
  "cleanupMinutes",
  "priceYen",
  "eligibleResourceIds",
  "active",
] as const;

const RESOURCE_KEYS = ["id", "label", "active"] as const;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const TEST_SITE_KEYS = new Set([
  "1x00000000000000000000AA",
  "2x00000000000000000000AB",
  "3x00000000000000000000FF",
]);
const STORED_STATE_BYTE_BUDGET = 1_800_000;
export const DEFAULT_PENDING_EXPIRY_MINUTES = 1440;

const DEFAULT_SETTINGS = {
  locationName: "架空予約サロン",
  timeZone: "Asia/Tokyo",
  services: [
    {
      id: "service-demo",
      label: "デモサービス",
      category: "デモ",
      durationMinutes: 60,
      cleanupMinutes: 0,
      priceYen: null,
      eligibleResourceIds: ["resource-demo"],
      active: true,
    },
  ],
  resources: [{ id: "resource-demo", label: "デモ担当", active: true }],
  opensAt: "09:00",
  closesAt: "17:00",
  startIntervalMinutes: 60,
  openWeekdays: [1, 2, 3, 4, 5, 6],
  horizonDays: 30,
  retentionDays: 30,
  pendingExpiryMinutes: DEFAULT_PENDING_EXPIRY_MINUTES,
  exposeResourceChoice: true,
  consentVersion: "demo-consent-v1",
  operatorDisplayName: "未設定",
  operatorContact: "未設定です",
  privacyNotice: "設定してください",
  termsNotice: "設定してください",
  cancellationPolicy: "設定してください",
  sourceUrl: "https://example.invalid/source",
  turnstileSiteKey: "1x00000000000000000000AA",
  allowedHostname: "localhost",
  themeId: "ink",
};

const clone = <T>(value: T): T => structuredClone(value);

const invalid = (field: string): never => {
  throw new Error(`Invalid installation settings: ${field}`);
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
};

const hasExactKeys = (
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean => {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
};

// Settings written before a key existed are still valid settings. The same
// parser reads a stored version record and an incoming update, so refusing a
// missing key would turn every installation that predates the key into corrupt
// storage. Only keys listed here may be absent, and absence is carried through
// rather than filled in, because the stored JSON has to round-trip byte for
// byte. An unknown key is still refused.
const OPTIONAL_SETTINGS_KEYS = [
  "pendingExpiryMinutes",
  "availabilityNotice",
  "exposeResourceChoice",
] as const;

const hasKnownKeys = (
  value: Record<string, unknown>,
  keys: readonly string[],
  optional: readonly string[],
): boolean =>
  Object.keys(value).every((key) => keys.includes(key)) &&
  keys.every((key) => optional.includes(key) || Object.hasOwn(value, key));

const codePointLength = (value: string): number => Array.from(value).length;

const boundedString = (
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): string => {
  if (typeof value !== "string") return invalid(field);
  const normalized = value.trim();
  const length = codePointLength(normalized);
  if (CONTROL.test(value) || length < minimum || length > maximum) return invalid(field);
  return normalized;
};

const boundedInteger = (
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number => {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    return invalid(field);
  }
  return value as number;
};

const identifier = (value: unknown, field: string): string => {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) return invalid(field);
  return value;
};

const parseTime = (value: unknown, field: string): { value: string; minutes: number } => {
  if (typeof value !== "string" || !TIME.test(value)) return invalid(field);
  const [hours, minutes] = value.split(":").map(Number);
  return { value, minutes: hours! * 60 + minutes! };
};

const parseHostname = (value: unknown): string => {
  if (typeof value !== "string") return invalid("allowedHostname");
  const hostname = value.trim().toLowerCase();
  if (hostname.length === 0) return hostname;
  if (
    hostname.length > 253 ||
    hostname.split(".").some(
      (label) =>
        label.length === 0 ||
        label.length > 63 ||
        !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
    )
  ) {
    return invalid("allowedHostname");
  }
  return hostname;
};

const parseSourceUrl = (value: unknown): string => {
  if (typeof value !== "string") return invalid("sourceUrl");
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return invalid("sourceUrl");
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
    return invalid("sourceUrl");
  }
  return url.toString();
};

const parseResource = (value: unknown, index: number): InstallationResource => {
  if (!isRecord(value) || !hasExactKeys(value, RESOURCE_KEYS)) {
    return invalid(`resources[${index}]`);
  }
  if (typeof value.active !== "boolean") return invalid(`resources[${index}].active`);
  return {
    id: identifier(value.id, `resources[${index}].id`),
    label: boundedString(value.label, `resources[${index}].label`, 1, 80),
    active: value.active,
  };
};

const parseService = (value: unknown, index: number): InstallationService => {
  if (!isRecord(value) || !hasExactKeys(value, SERVICE_KEYS)) {
    return invalid(`services[${index}]`);
  }
  let category: string | null;
  if (value.category === null) {
    category = null;
  } else {
    category = boundedString(value.category, `services[${index}].category`, 0, 60) || null;
  }
  let priceYen: number | null;
  if (value.priceYen === null) {
    priceYen = null;
  } else {
    priceYen = boundedInteger(value.priceYen, `services[${index}].priceYen`, 0, 10_000_000);
  }
  if (
    !Array.isArray(value.eligibleResourceIds) ||
    value.eligibleResourceIds.length < 1 ||
    value.eligibleResourceIds.length > 8
  ) {
    return invalid(`services[${index}].eligibleResourceIds`);
  }
  const eligibleResourceIds = value.eligibleResourceIds.map((resourceId, resourceIndex) =>
    identifier(resourceId, `services[${index}].eligibleResourceIds[${resourceIndex}]`),
  );
  if (new Set(eligibleResourceIds).size !== eligibleResourceIds.length) {
    return invalid(`services[${index}].eligibleResourceIds`);
  }
  if (typeof value.active !== "boolean") return invalid(`services[${index}].active`);
  return {
    id: identifier(value.id, `services[${index}].id`),
    label: boundedString(value.label, `services[${index}].label`, 1, 80),
    category,
    durationMinutes: boundedInteger(
      value.durationMinutes,
      `services[${index}].durationMinutes`,
      15,
      480,
    ),
    cleanupMinutes: boundedInteger(
      value.cleanupMinutes,
      `services[${index}].cleanupMinutes`,
      0,
      120,
    ),
    priceYen,
    eligibleResourceIds,
    active: value.active,
  };
};

export const parseInstallationSettings = (value: unknown): InstallationSettings => {
  if (!isRecord(value) || !hasKnownKeys(value, SETTINGS_KEYS, OPTIONAL_SETTINGS_KEYS)) {
    return invalid("settings");
  }
  if (!Array.isArray(value.services) || value.services.length < 1 || value.services.length > 16) {
    return invalid("services");
  }
  if (!Array.isArray(value.resources) || value.resources.length < 1 || value.resources.length > 8) {
    return invalid("resources");
  }

  const resources = value.resources.map(parseResource);
  const services = value.services.map(parseService);
  const resourceIds = resources.map(({ id }) => id);
  const serviceIds = services.map(({ id }) => id);
  if (new Set(resourceIds).size !== resourceIds.length) return invalid("resources.id");
  if (new Set(serviceIds).size !== serviceIds.length) return invalid("services.id");

  const activeResourceIds = new Set(
    resources.filter(({ active }) => active).map(({ id }) => id),
  );
  if (activeResourceIds.size === 0 || services.every(({ active }) => !active)) {
    return invalid("capacity");
  }
  for (const [index, service] of services.entries()) {
    if (service.eligibleResourceIds.some((resourceId) => !activeResourceIds.has(resourceId))) {
      return invalid(`services[${index}].eligibleResourceIds`);
    }
  }

  const opensAt = parseTime(value.opensAt, "opensAt");
  const closesAt = parseTime(value.closesAt, "closesAt");
  if (opensAt.minutes >= closesAt.minutes) return invalid("closesAt");
  const startIntervalMinutes = boundedInteger(
    value.startIntervalMinutes,
    "startIntervalMinutes",
    15,
    240,
  );
  if (
    !Array.isArray(value.openWeekdays) ||
    value.openWeekdays.length < 1 ||
    value.openWeekdays.length > 7
  ) {
    return invalid("openWeekdays");
  }
  const openWeekdays = value.openWeekdays.map((weekday) =>
    boundedInteger(weekday, "openWeekdays", 0, 6),
  );
  if (new Set(openWeekdays).size !== openWeekdays.length) return invalid("openWeekdays");

  const shortestOccupiedMinutes = Math.min(
    ...services
      .filter(({ active }) => active)
      .map(({ durationMinutes, cleanupMinutes }) => durationMinutes + cleanupMinutes),
  );
  const openMinutes = closesAt.minutes - opensAt.minutes;
  const startCount =
    openMinutes < shortestOccupiedMinutes
      ? 0
      : Math.floor((openMinutes - shortestOccupiedMinutes) / startIntervalMinutes) + 1;
  if (startCount === 0 || startCount * activeResourceIds.size > 96) return invalid("capacity");

  if (value.timeZone !== "Asia/Tokyo") return invalid("timeZone");
  if (typeof value.turnstileSiteKey !== "string") return invalid("turnstileSiteKey");
  const turnstileSiteKey = value.turnstileSiteKey.trim();
  if (codePointLength(turnstileSiteKey) > 128) return invalid("turnstileSiteKey");
  if (!(["ink", "forest", "clay"] as unknown[]).includes(value.themeId)) {
    return invalid("themeId");
  }

  return {
    locationName: boundedString(value.locationName, "locationName", 1, 80),
    timeZone: "Asia/Tokyo",
    services,
    resources,
    opensAt: opensAt.value,
    closesAt: closesAt.value,
    startIntervalMinutes,
    openWeekdays,
    horizonDays: boundedInteger(value.horizonDays, "horizonDays", 1, 90),
    retentionDays: boundedInteger(value.retentionDays, "retentionDays", 1, 365),
    ...(value.pendingExpiryMinutes === undefined
      ? {}
      : {
          pendingExpiryMinutes: boundedInteger(
            value.pendingExpiryMinutes,
            "pendingExpiryMinutes",
            15,
            10080,
          ),
        }),
    ...(value.availabilityNotice === undefined
      ? {}
      : {
          availabilityNotice: boundedString(
            value.availabilityNotice,
            "availabilityNotice",
            1,
            200,
          ),
        }),
    ...(value.exposeResourceChoice === undefined
      ? {}
      : {
          exposeResourceChoice:
            typeof value.exposeResourceChoice === "boolean"
              ? value.exposeResourceChoice
              : invalid("exposeResourceChoice"),
        }),
    consentVersion: identifier(value.consentVersion, "consentVersion"),
    operatorDisplayName: boundedString(
      value.operatorDisplayName,
      "operatorDisplayName",
      1,
      120,
    ),
    operatorContact: boundedString(value.operatorContact, "operatorContact", 3, 200),
    privacyNotice: boundedString(value.privacyNotice, "privacyNotice", 1, 500),
    termsNotice: boundedString(value.termsNotice, "termsNotice", 1, 500),
    cancellationPolicy: boundedString(
      value.cancellationPolicy,
      "cancellationPolicy",
      1,
      500,
    ),
    sourceUrl: parseSourceUrl(value.sourceUrl),
    turnstileSiteKey,
    allowedHostname: parseHostname(value.allowedHostname),
    themeId: value.themeId as ThemeId,
  };
};

const publicSettings = (settings: InstallationSettings) => ({
  locationName: settings.locationName,
  timeZone: settings.timeZone,
  services: settings.services
    .filter(({ active }) => active)
    .map(({ active: _active, ...service }) => clone(service)),
  resources: settings.resources
    .filter(({ active }) => active)
    .map(({ active: _active, ...resource }) => clone(resource)),
  schedule: {
    opensAt: settings.opensAt,
    closesAt: settings.closesAt,
    startIntervalMinutes: settings.startIntervalMinutes,
    openWeekdays: [...settings.openWeekdays],
    horizonDays: settings.horizonDays,
  },
  // Default-resolved here: stored settings must stay byte-identical, so an
  // installation that predates these keys resolves them at projection time.
  availabilityNotice: settings.availabilityNotice ?? null,
  exposeResourceChoice: settings.exposeResourceChoice ?? true,
  consentVersion: settings.consentVersion,
  operatorDisplayName: settings.operatorDisplayName,
  operatorContact: settings.operatorContact,
  privacyNotice: settings.privacyNotice,
  termsNotice: settings.termsNotice,
  cancellationPolicy: settings.cancellationPolicy,
  sourceUrl: settings.sourceUrl,
  turnstileSiteKey: settings.turnstileSiteKey,
  themeId: settings.themeId,
});

const activeVersion = (state: InstallationState): SettingsVersionRecord => {
  const record = state.settingsVersions.find(
    ({ version }) => version === state.activeSettingsVersion,
  );
  if (record === undefined) throw new Error("Invalid installation state");
  return record;
};

export const projectPublicConfig = (state: InstallationState) => ({
  mode: state.mode,
  settingsVersion: state.activeSettingsVersion,
  ...publicSettings(activeVersion(state).settings),
});

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Cannot canonicalize non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!isRecord(value)) throw new Error("Cannot canonicalize unsupported value");
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
};

const sha256Hex = async (value: string): Promise<string> => {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

export const digestPublicSettings = async (value: unknown): Promise<string> =>
  sha256Hex(canonicalJson(publicSettings(parseInstallationSettings(value))));

const placeholder = (value: unknown): boolean => {
  if (typeof value !== "string") return true;
  const normalized = value.normalize("NFKC").trim().toLowerCase();
  return (
    normalized.length === 0 ||
    normalized.includes("未設定") ||
    normalized.includes("設定してください") ||
    /\b(?:todo|tbd|placeholder|replace me)\b/.test(normalized)
  );
};

const identityReady = (value: unknown): boolean => {
  if (!isRecord(value)) return false;
  if (
    placeholder(value.operatorDisplayName) ||
    placeholder(value.operatorContact) ||
    placeholder(value.privacyNotice) ||
    placeholder(value.termsNotice) ||
    placeholder(value.cancellationPolicy) ||
    typeof value.sourceUrl !== "string"
  ) {
    return false;
  }
  try {
    const source = new URL(value.sourceUrl);
    return (
      source.protocol === "https:" &&
      source.username === "" &&
      source.password === "" &&
      !source.hostname.endsWith(".invalid")
    );
  } catch {
    return false;
  }
};

const localHostname = (hostname: string): boolean =>
  hostname === "localhost" ||
  hostname.endsWith(".localhost") ||
  hostname.endsWith(".local") ||
  hostname === "127.0.0.1" ||
  hostname === "0.0.0.0" ||
  hostname === "::1" ||
  hostname === "[::1]";

const protectionReady = (value: unknown, runtime: ReadinessRuntime): boolean => {
  if (!isRecord(value)) return false;
  const siteKey = typeof value.turnstileSiteKey === "string" ? value.turnstileSiteKey.trim() : "";
  const allowedHostname =
    typeof value.allowedHostname === "string" ? value.allowedHostname.trim().toLowerCase() : "";
  const hostname = runtime.hostname.trim().toLowerCase();
  return (
    runtime.turnstileSecretPresent &&
    siteKey.length > 0 &&
    !TEST_SITE_KEYS.has(siteKey) &&
    allowedHostname.length > 0 &&
    allowedHostname === hostname &&
    !localHostname(hostname)
  );
};

export const evaluateInstallationReadiness = (
  settings: unknown,
  runtime: ReadinessRuntime,
): ReadinessProjection => {
  let capacity = true;
  try {
    parseInstallationSettings(settings);
  } catch {
    capacity = false;
  }
  const owner = runtime.ownerSecretPresent && runtime.ownerAuthenticated;
  const protection = protectionReady(settings, runtime);
  const identity = identityReady(settings);
  const blockers: ReadinessProjection["blockers"] = [];
  if (!owner) blockers.push("owner");
  if (!protection) blockers.push("protection");
  if (!identity) blockers.push("identity");
  if (!capacity) blockers.push("capacity");
  return { ready: blockers.length === 0, owner, protection, identity, capacity, blockers };
};

const canonicalTimestamp = (value: string): string => {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new Error("Invalid canonical timestamp");
  }
  return value;
};

export const createDefaultInstallationState = (now: string): InstallationState => {
  const timestamp = canonicalTimestamp(now);
  return {
    schemaVersion: 1,
    activeSettingsVersion: 1,
    mode: "demo",
    settingsVersions: [
      {
        version: 1,
        settings: parseInstallationSettings(DEFAULT_SETTINGS),
        createdAt: timestamp,
      },
    ],
    receipts: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
};

const parseCommand = (value: unknown): InstallationCommand => {
  if (!isRecord(value) || typeof value.type !== "string") throw new Error("Invalid command");
  const commonValid =
    typeof value.commandId === "string" &&
    UUID.test(value.commandId) &&
    Number.isInteger(value.expectedSettingsVersion) &&
    (value.expectedSettingsVersion as number) >= 1;
  if (!commonValid) throw new Error("Invalid command");

  if (value.type === "settings.update") {
    if (!hasExactKeys(value, ["type", "commandId", "expectedSettingsVersion", "settings"])) {
      throw new Error("Invalid command");
    }
    return {
      type: value.type,
      commandId: value.commandId as string,
      expectedSettingsVersion: value.expectedSettingsVersion as number,
      settings: parseInstallationSettings(value.settings),
    };
  }
  if (value.type === "settings.live") {
    if (
      !hasExactKeys(value, ["type", "commandId", "expectedSettingsVersion", "live"]) ||
      typeof value.live !== "boolean"
    ) {
      throw new Error("Invalid command");
    }
    return {
      type: value.type,
      commandId: value.commandId as string,
      expectedSettingsVersion: value.expectedSettingsVersion as number,
      live: value.live,
    };
  }
  throw new Error("Invalid command");
};

const commandFingerprint = async (command: InstallationCommand): Promise<string> => {
  const semantic =
    command.type === "settings.update"
      ? {
          operation: command.type,
          expectedSettingsVersion: command.expectedSettingsVersion,
          settings: command.settings,
        }
      : {
          operation: command.type,
          expectedSettingsVersion: command.expectedSettingsVersion,
          live: command.live,
        };
  return sha256Hex(canonicalJson(semantic));
};

const appendReceipt = (
  state: InstallationState,
  command: InstallationCommand,
  fingerprint: string,
  outcome: InstallationCommandOutcome,
  now: string,
): SettingsCommandReceipt[] => [
  ...state.receipts,
  {
    commandId: command.commandId,
    operation: command.type,
    fingerprint,
    responseJson: canonicalJson(outcome),
    createdAt: now,
  },
].slice(-64);

const compactStoredState = (state: InstallationState): InstallationState => {
  let compacted = state;
  while (
    new TextEncoder().encode(JSON.stringify(compacted)).byteLength >=
    STORED_STATE_BYTE_BUDGET
  ) {
    if (compacted.settingsVersions.length > 1) {
      compacted = {
        ...compacted,
        settingsVersions: compacted.settingsVersions.slice(1),
      };
    } else if (compacted.receipts.length > 1) {
      compacted = { ...compacted, receipts: compacted.receipts.slice(1) };
    } else {
      throw new Error("Installation state exceeds storage budget");
    }
  }
  return compacted;
};

export const executeInstallationCommand = async (
  state: InstallationState,
  input: unknown,
  runtime: CommandRuntime,
): Promise<InstallationCommandResult> => {
  const original = clone(state);
  let command: InstallationCommand;
  try {
    command = parseCommand(input);
  } catch {
    return { ok: false, state: original, error: { code: "INVALID_COMMAND" } };
  }
  const now = canonicalTimestamp(runtime.now);
  const fingerprint = await commandFingerprint(command);
  const priorReceipt = state.receipts.find(({ commandId }) => commandId === command.commandId);

  if (priorReceipt !== undefined) {
    if (priorReceipt.fingerprint !== fingerprint) {
      return {
        ok: false,
        state: original,
        error: { code: "IDEMPOTENCY_CONFLICT", commandId: command.commandId },
      };
    }
    const outcome = JSON.parse(priorReceipt.responseJson) as InstallationCommandOutcome;
    return {
      ok: true,
      state: original,
      outcome: {
        ...outcome,
        readiness: evaluateInstallationReadiness(outcome.settings, runtime),
        replayed: true,
      },
    };
  }

  if (command.expectedSettingsVersion !== state.activeSettingsVersion) {
    return {
      ok: false,
      state: original,
      error: {
        code: "CONFIGURATION_CONFLICT",
        expectedSettingsVersion: command.expectedSettingsVersion,
        actualSettingsVersion: state.activeSettingsVersion,
      },
    };
  }

  if (command.type === "settings.update") {
    const currentSettings = activeVersion(state).settings;
    if (
      command.settings.consentVersion === currentSettings.consentVersion &&
      (command.settings.privacyNotice !== currentSettings.privacyNotice ||
        command.settings.termsNotice !== currentSettings.termsNotice ||
        command.settings.cancellationPolicy !== currentSettings.cancellationPolicy)
    ) {
      return { ok: false, state: original, error: { code: "INVALID_COMMAND" } };
    }
    const nextVersion = state.activeSettingsVersion + 1;
    const readiness = evaluateInstallationReadiness(command.settings, runtime);
    const outcome: InstallationCommandOutcome = {
      mode: state.mode,
      settingsVersion: nextVersion,
      settings: clone(command.settings),
      readiness,
      replayed: false,
    };
    const nextState = compactStoredState({
      ...original,
      activeSettingsVersion: nextVersion,
      settingsVersions: [
        ...state.settingsVersions,
        { version: nextVersion, settings: clone(command.settings), createdAt: now },
      ].slice(-32),
      receipts: appendReceipt(state, command, fingerprint, outcome, now),
      updatedAt: now,
    });
    return { ok: true, state: nextState, outcome };
  }

  const settings = clone(activeVersion(state).settings);
  const readiness = evaluateInstallationReadiness(settings, runtime);
  if (command.live && !readiness.ready) {
    return {
      ok: false,
      state: original,
      error: { code: "READINESS_BLOCKED", blockers: [...readiness.blockers] },
    };
  }
  const mode: InstallationMode = command.live ? "live" : "demo";
  const outcome: InstallationCommandOutcome = {
    mode,
    settingsVersion: state.activeSettingsVersion,
    settings,
    readiness,
    replayed: false,
  };
  return {
    ok: true,
    state: compactStoredState({
      ...original,
      mode,
      receipts: appendReceipt(state, command, fingerprint, outcome, now),
      updatedAt: now,
    }),
    outcome,
  };
};

export const createInstallationReceipt = async (
  state: InstallationState,
  runtime: ReadinessRuntime & { applicationVersion: string; now: string },
) => {
  const now = canonicalTimestamp(runtime.now);
  const active = activeVersion(state);
  const settings = active.settings;
  return {
    applicationVersion: boundedString(runtime.applicationVersion, "applicationVersion", 1, 64),
    settingsVersion: state.activeSettingsVersion,
    settingsEffectiveAt: active.createdAt,
    dayPartitionPolicy: "pinned_until_purge" as const,
    consentPolicy: "current_at_acceptance" as const,
    settingsDigest: await digestPublicSettings(settings),
    mode: state.mode,
    readiness: evaluateInstallationReadiness(settings, runtime),
    resourceKinds: [
      "worker",
      "static-assets",
      "installation-settings-durable-object",
      "reservation-day-durable-object",
      "rate-limiters",
    ],
    createdAt: now,
    guidance: {
      setup: "/setup.html",
      rollback:
        "https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/",
      recovery:
        "https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#pitr-point-in-time-recovery-api",
      export: "/privacy.html#data-export",
      deletion: "https://developers.cloudflare.com/workers/wrangler/commands/#delete",
    },
  };
};

export type InstallationReceipt = Awaited<ReturnType<typeof createInstallationReceipt>>;

const STATE_KEYS = [
  "schemaVersion",
  "activeSettingsVersion",
  "mode",
  "settingsVersions",
  "receipts",
  "createdAt",
  "updatedAt",
] as const;
const SETTINGS_VERSION_KEYS = ["version", "settings", "createdAt"] as const;
const STORED_RECEIPT_KEYS = [
  "commandId",
  "operation",
  "fingerprint",
  "responseJson",
  "createdAt",
] as const;
const STORED_OUTCOME_KEYS = [
  "mode",
  "settingsVersion",
  "settings",
  "readiness",
  "replayed",
] as const;
const READINESS_KEYS = [
  "ready",
  "owner",
  "protection",
  "identity",
  "capacity",
  "blockers",
] as const;
const RPC_RUNTIME_KEYS = [
  "ownerSecretPresent",
  "ownerAuthenticated",
  "turnstileSecretPresent",
  "hostname",
] as const;
const INSTALLATION_TABLES = ["installation_state"] as const;
const APPLICATION_VERSION = "0.2.0";
const SHA256_HEX = /^[a-f0-9]{64}$/;

const corruptStorage = (): never => {
  throw new Error("Invalid installation storage");
};

const parseStoredReadiness = (value: unknown): ReadinessProjection => {
  if (!isRecord(value) || !hasExactKeys(value, READINESS_KEYS)) return corruptStorage();
  if (
    typeof value.ready !== "boolean" ||
    typeof value.owner !== "boolean" ||
    typeof value.protection !== "boolean" ||
    typeof value.identity !== "boolean" ||
    typeof value.capacity !== "boolean" ||
    !Array.isArray(value.blockers)
  ) {
    return corruptStorage();
  }
  const expected: ReadinessProjection["blockers"] = [];
  if (!value.owner) expected.push("owner");
  if (!value.protection) expected.push("protection");
  if (!value.identity) expected.push("identity");
  if (!value.capacity) expected.push("capacity");
  if (
    value.ready !== (expected.length === 0) ||
    value.blockers.length !== expected.length ||
    value.blockers.some((blocker, index) => blocker !== expected[index])
  ) {
    return corruptStorage();
  }
  return {
    ready: value.ready,
    owner: value.owner,
    protection: value.protection,
    identity: value.identity,
    capacity: value.capacity,
    blockers: expected,
  };
};

const parseStoredOutcome = (value: unknown): InstallationCommandOutcome => {
  if (!isRecord(value) || !hasExactKeys(value, STORED_OUTCOME_KEYS)) {
    return corruptStorage();
  }
  if (
    (value.mode !== "demo" && value.mode !== "live") ||
    !Number.isSafeInteger(value.settingsVersion) ||
    (value.settingsVersion as number) < 1 ||
    value.replayed !== false
  ) {
    return corruptStorage();
  }
  return {
    mode: value.mode,
    settingsVersion: value.settingsVersion as number,
    settings: parseInstallationSettings(value.settings),
    readiness: parseStoredReadiness(value.readiness),
    replayed: false,
  };
};

const parseSettingsVersionRecord = (value: unknown): SettingsVersionRecord => {
  if (!isRecord(value) || !hasExactKeys(value, SETTINGS_VERSION_KEYS)) {
    return corruptStorage();
  }
  if (!Number.isSafeInteger(value.version) || (value.version as number) < 1) {
    return corruptStorage();
  }
  return {
    version: value.version as number,
    settings: parseInstallationSettings(value.settings),
    createdAt: canonicalTimestamp(
      typeof value.createdAt === "string" ? value.createdAt : corruptStorage(),
    ),
  };
};

const parseStoredReceipt = (value: unknown): SettingsCommandReceipt => {
  if (!isRecord(value) || !hasExactKeys(value, STORED_RECEIPT_KEYS)) {
    return corruptStorage();
  }
  if (
    typeof value.commandId !== "string" ||
    !UUID.test(value.commandId) ||
    (value.operation !== "settings.update" && value.operation !== "settings.live") ||
    typeof value.fingerprint !== "string" ||
    !SHA256_HEX.test(value.fingerprint) ||
    typeof value.responseJson !== "string" ||
    typeof value.createdAt !== "string"
  ) {
    return corruptStorage();
  }
  let parsedResponse: unknown;
  try {
    parsedResponse = JSON.parse(value.responseJson);
  } catch {
    return corruptStorage();
  }
  const outcome = parseStoredOutcome(parsedResponse);
  if (canonicalJson(outcome) !== value.responseJson) return corruptStorage();
  return {
    commandId: value.commandId,
    operation: value.operation,
    fingerprint: value.fingerprint,
    responseJson: value.responseJson,
    createdAt: canonicalTimestamp(value.createdAt),
  };
};

const parseInstallationState = (value: unknown): InstallationState => {
  if (!isRecord(value) || !hasExactKeys(value, STATE_KEYS)) return corruptStorage();
  if (
    value.schemaVersion !== 1 ||
    !Number.isSafeInteger(value.activeSettingsVersion) ||
    (value.activeSettingsVersion as number) < 1 ||
    (value.mode !== "demo" && value.mode !== "live") ||
    !Array.isArray(value.settingsVersions) ||
    value.settingsVersions.length < 1 ||
    value.settingsVersions.length > 32 ||
    !Array.isArray(value.receipts) ||
    value.receipts.length > 64 ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    return corruptStorage();
  }
  const activeSettingsVersion = value.activeSettingsVersion as number;
  const settingsVersions = value.settingsVersions.map(parseSettingsVersionRecord);
  const firstVersion = activeSettingsVersion - settingsVersions.length + 1;
  if (
    firstVersion < 1 ||
    settingsVersions.some(({ version }, index) => version !== firstVersion + index)
  ) {
    return corruptStorage();
  }
  const receipts = value.receipts.map(parseStoredReceipt);
  if (new Set(receipts.map(({ commandId }) => commandId)).size !== receipts.length) {
    return corruptStorage();
  }
  const createdAt = canonicalTimestamp(value.createdAt);
  const updatedAt = canonicalTimestamp(value.updatedAt);
  if (Date.parse(updatedAt) < Date.parse(createdAt)) return corruptStorage();
  return {
    schemaVersion: 1,
    activeSettingsVersion,
    mode: value.mode,
    settingsVersions,
    receipts,
    createdAt,
    updatedAt,
  };
};

const storedStateJson = (state: InstallationState): string =>
  JSON.stringify(parseInstallationState(state));

const parseRpcRuntime = (value: unknown): ReadinessRuntime => {
  if (!isRecord(value) || !hasExactKeys(value, RPC_RUNTIME_KEYS)) {
    throw new Error("Invalid installation runtime");
  }
  if (
    typeof value.ownerSecretPresent !== "boolean" ||
    typeof value.ownerAuthenticated !== "boolean" ||
    typeof value.turnstileSecretPresent !== "boolean"
  ) {
    throw new Error("Invalid installation runtime");
  }
  return {
    ownerSecretPresent: value.ownerSecretPresent,
    ownerAuthenticated: value.ownerAuthenticated,
    turnstileSecretPresent: value.turnstileSecretPresent,
    hostname: parseHostname(value.hostname),
  };
};

export class InstallationConfig extends DurableObjectBase<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.transactionSync(() => this.#initialize());
    });
  }

  #userTables(): string[] {
    return this.ctx.storage.sql
      .exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT GLOB '_cf_*' AND name NOT GLOB '__*' ORDER BY name",
      )
      .toArray()
      .map(({ name }) => name);
  }

  #initialize(): void {
    const tables = this.#userTables();
    if (tables.length === 0) {
      this.ctx.storage.sql.exec(`
        CREATE TABLE installation_state (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          state_json TEXT NOT NULL
        )
      `);
      const state = createDefaultInstallationState(new Date().toISOString());
      this.ctx.storage.sql.exec(
        "INSERT INTO installation_state (singleton, state_json) VALUES (1, ?)",
        storedStateJson(state),
      );
      return;
    }
    if (tables.join("\0") !== INSTALLATION_TABLES.join("\0")) {
      throw new Error("Unexpected installation schema");
    }
    this.#readStoredState();
  }

  #readStoredState(): { state: InstallationState; stateJson: string } {
    const rows = this.ctx.storage.sql
      .exec<{ singleton: number; state_json: string }>(
        "SELECT singleton, state_json FROM installation_state",
      )
      .toArray();
    const row = rows[0];
    if (
      rows.length !== 1 ||
      row === undefined ||
      row.singleton !== 1 ||
      typeof row.state_json !== "string"
    ) {
      return corruptStorage();
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.state_json);
    } catch {
      return corruptStorage();
    }
    const state = parseInstallationState(parsed);
    if (JSON.stringify(state) !== row.state_json) return corruptStorage();
    return { state, stateJson: row.state_json };
  }

  getState(): InstallationState {
    return clone(this.#readStoredState().state);
  }

  async executeCommand(
    input: unknown,
    runtime: ReadinessRuntime,
  ): Promise<InstallationCommandResult> {
    const safeRuntime = parseRpcRuntime(runtime);
    const now = new Date().toISOString();

    while (true) {
      const stored = this.#readStoredState();
      const result = await executeInstallationCommand(stored.state, input, {
        ...safeRuntime,
        now,
      });
      if (!result.ok) return result;

      const nextStateJson = storedStateJson(result.state);
      if (nextStateJson === stored.stateJson) return result;
      const write = this.ctx.storage.sql.exec(
        `UPDATE installation_state SET state_json = ?
         WHERE singleton = 1 AND state_json = ?`,
        nextStateJson,
        stored.stateJson,
      );
      if (write.rowsWritten === 1) return result;
      if (write.rowsWritten !== 0) throw new Error("Invalid installation CAS result");
    }
  }

  async installationReceipt(runtime: ReadinessRuntime): Promise<InstallationReceipt> {
    const safeRuntime = parseRpcRuntime(runtime);
    return createInstallationReceipt(this.#readStoredState().state, {
      ...safeRuntime,
      applicationVersion: APPLICATION_VERSION,
      now: new Date().toISOString(),
    });
  }
}
