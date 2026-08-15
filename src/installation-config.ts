import type { DurableObject as CloudflareDurableObject } from "cloudflare:workers";

import { ADAPTER } from "./adapter-constants.ts";

const directNodeRuntime =
  typeof navigator !== "undefined" && navigator.userAgent.startsWith("Node.js/");

// Keep the pure module runnable under Node; Workers load the real RPC base.
const DurableObjectBase: typeof CloudflareDurableObject = directNodeRuntime
  ? (class {
      constructor() {
        throw new Error("InstallationConfig requires the Workers runtime");
      }
      fetch(): never {
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
  lineSecretPresent: boolean;
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

const parseCatalog = (
  resourceValues: unknown[],
  serviceValues: unknown[],
): {
  resources: InstallationResource[];
  services: InstallationService[];
  activeResourceIds: Set<string>;
} => {
  const resources = resourceValues.map((resource, index) => parseResource(resource, index));
  const services = serviceValues.map((service, index) => parseService(service, index));
  const resourceIds = resources.map(({ id }) => id);
  const serviceIds = services.map(({ id }) => id);
  if (new Set(resourceIds).size !== resourceIds.length) return invalid("resources.id");
  if (new Set(serviceIds).size !== serviceIds.length) return invalid("services.id");
  const activeResourceIds = new Set(resources.filter(({ active }) => active).map(({ id }) => id));
  if (activeResourceIds.size === 0 || services.every(({ active }) => !active)) {
    return invalid("capacity");
  }
  for (const [index, service] of services.entries()) {
    if (service.eligibleResourceIds.some((resourceId) => !activeResourceIds.has(resourceId))) {
      return invalid(`services[${index}].eligibleResourceIds`);
    }
  }
  return { resources, services, activeResourceIds };
};

const parseHours = (
  value: Record<string, unknown>,
  services: InstallationService[],
  activeResourceIds: Set<string>,
): {
  opensAt: string;
  closesAt: string;
  startIntervalMinutes: number;
  openWeekdays: number[];
} => {
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
  return {
    opensAt: opensAt.value,
    closesAt: closesAt.value,
    startIntervalMinutes,
    openWeekdays,
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

  const { resources, services, activeResourceIds } = parseCatalog(value.resources, value.services);
  const hours = parseHours(value, services, activeResourceIds);

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
    opensAt: hours.opensAt,
    closesAt: hours.closesAt,
    startIntervalMinutes: hours.startIntervalMinutes,
    openWeekdays: hours.openWeekdays,
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
    .sort((left, right) => {
      if (left < right) return -1;
      if (left > right) return 1;
      return 0;
    })
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
};

/**
 * Exported because the Worker mints staff credentials and needs the same
 * encoding this object stores digests in. One definition, so the two cannot
 * disagree about case or padding and stop matching.
 */
export const sha256Hex = async (value: string): Promise<string> => {
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
  "lineSecretPresent",
  "hostname",
] as const;
const INSTALLATION_TABLES = ["installation_state"] as const;
const APPLICATION_VERSION = "0.2.0";
const SHA256_HEX = /^[a-f0-9]{64}$/;

// ---- LINE adapter lifecycle (specs/003-line-adapter/plan.md, decision 8) ----
// Lives in its own `__`-prefixed table so the exact-set schema check above and
// the settings JSON round-trip never see it: a pre-adapter Worker reads this
// storage exactly as before, and no `lineAdapter` settings key ever exists.

const LIFF_ID = /^\d{7,14}-[A-Za-z0-9]{4,20}$/;
const CHANNEL_ID = /^\d{7,14}$/;
const LINE_OPERATIONS = ["line.settings", "line.enable", "line.disable"] as const;
type LineOperationName = (typeof LINE_OPERATIONS)[number];

export type LineIdentifiers = {
  liffId: string;
  loginChannelId: string;
  messagingChannelId: string;
};

export type LineLifecyclePhase = "disabled" | "activating" | "active" | "deactivating";

type LineSagaOperation = {
  operationId: string;
  kind: "enable" | "disable";
  step: "activate" | "begin-disable" | "final-wait";
  startedAt: string;
  identifiers: LineIdentifiers | null;
  finalPassAt: number | null;
};

type LineReceipt = {
  commandId: string;
  operation: LineOperationName;
  fingerprint: string;
  responseJson: string;
  createdAt: string;
};

type LineLifecycle = {
  schemaVersion: 1;
  lifecycleVersion: number;
  phase: LineLifecyclePhase;
  draft: LineIdentifiers | null;
  active: (LineIdentifiers & { generation: number; activatedAt: string }) | null;
  operation: LineSagaOperation | null;
  // Diagnostic copy only — the authoritative high-water lives in AdapterDelivery.
  highWaterCopy: number;
  receipts: LineReceipt[];
  updatedAt: string;
};

export type LineCommandInput = {
  operation: LineOperationName;
  commandId: string;
  expectedLifecycleVersion: number;
  identifiers?: LineIdentifiers;
};

export type LineCommandOutcome = {
  ok: true;
  phase: LineLifecyclePhase;
  lifecycleVersion: number;
  replayed: boolean;
};

export type LineCommandResult =
  | LineCommandOutcome
  | {
      ok: false;
      code:
        | "BAD_REQUEST"
        | "IDEMPOTENCY_CONFLICT"
        | "VERSION_CONFLICT"
        | "PHASE_CONFLICT"
        | "SECRET_MISSING"
        | "ORIGIN_UNCONFIGURED"
        | "TEMPORARILY_UNAVAILABLE";
    };

// What the Worker's per-request context read receives. The lease is minted
// here, at the projection read, and forwarded to days unmodified.
export type LineContext = {
  phase: LineLifecyclePhase;
  lifecycleVersion: number;
  liffId?: string;
  loginChannelId?: string;
  messagingChannelId?: string;
  generation?: number;
  lease: { issuedAt: number; notAfter: number };
};

const LINE_LIFECYCLE_KEYS = [
  "schemaVersion",
  "lifecycleVersion",
  "phase",
  "draft",
  "active",
  "operation",
  "highWaterCopy",
  "receipts",
  "updatedAt",
] as const;
const LINE_IDENTIFIER_KEYS = ["liffId", "loginChannelId", "messagingChannelId"] as const;
const LINE_ACTIVE_KEYS = [...LINE_IDENTIFIER_KEYS, "generation", "activatedAt"] as const;
const LINE_OPERATION_KEYS = [
  "operationId",
  "kind",
  "step",
  "startedAt",
  "identifiers",
  "finalPassAt",
] as const;
const LINE_RECEIPT_KEYS = [
  "commandId",
  "operation",
  "fingerprint",
  "responseJson",
  "createdAt",
] as const;

const parseLineIdentifiers = (value: unknown): LineIdentifiers => {
  if (!isRecord(value) || !hasExactKeys(value, LINE_IDENTIFIER_KEYS)) {
    return corruptStorage();
  }
  if (
    typeof value.liffId !== "string" ||
    !LIFF_ID.test(value.liffId) ||
    typeof value.loginChannelId !== "string" ||
    !CHANNEL_ID.test(value.loginChannelId) ||
    typeof value.messagingChannelId !== "string" ||
    !CHANNEL_ID.test(value.messagingChannelId)
  ) {
    return corruptStorage();
  }
  return {
    liffId: value.liffId,
    loginChannelId: value.loginChannelId,
    messagingChannelId: value.messagingChannelId,
  };
};

const parseLineActive = (value: unknown): LineLifecycle["active"] => {
  if (value === null) return null;
  if (!isRecord(value) || !hasExactKeys(value, LINE_ACTIVE_KEYS)) {
    return corruptStorage();
  }
  const { generation, activatedAt, ...identifiers } = value;
  if (
    !Number.isSafeInteger(generation) ||
    (generation as number) < 1 ||
    typeof activatedAt !== "string"
  ) {
    return corruptStorage();
  }
  return {
    ...parseLineIdentifiers(identifiers),
    generation: generation as number,
    activatedAt: canonicalTimestamp(activatedAt),
  };
};

const parseLineOperation = (value: unknown): LineSagaOperation | null => {
  if (value === null) return null;
  if (!isRecord(value) || !hasExactKeys(value, LINE_OPERATION_KEYS)) {
    return corruptStorage();
  }
  if (
    typeof value.operationId !== "string" ||
    !UUID.test(value.operationId) ||
    (value.kind !== "enable" && value.kind !== "disable") ||
    !["activate", "begin-disable", "final-wait"].includes(value.step as string) ||
    typeof value.startedAt !== "string" ||
    (value.finalPassAt !== null && !Number.isSafeInteger(value.finalPassAt))
  ) {
    return corruptStorage();
  }
  return {
    operationId: value.operationId,
    kind: value.kind,
    step: value.step as LineSagaOperation["step"],
    startedAt: canonicalTimestamp(value.startedAt),
    identifiers:
      value.identifiers === null ? null : parseLineIdentifiers(value.identifiers),
    finalPassAt: value.finalPassAt as number | null,
  };
};

const parseLineLifecycle = (value: unknown): LineLifecycle => {
  if (!isRecord(value) || !hasExactKeys(value, LINE_LIFECYCLE_KEYS)) {
    return corruptStorage();
  }
  if (
    value.schemaVersion !== 1 ||
    !Number.isSafeInteger(value.lifecycleVersion) ||
    (value.lifecycleVersion as number) < 0 ||
    !["disabled", "activating", "active", "deactivating"].includes(
      value.phase as string,
    ) ||
    !Number.isSafeInteger(value.highWaterCopy) ||
    (value.highWaterCopy as number) < 0 ||
    !Array.isArray(value.receipts) ||
    value.receipts.length > 64 ||
    typeof value.updatedAt !== "string"
  ) {
    return corruptStorage();
  }
  const draft = value.draft === null ? null : parseLineIdentifiers(value.draft);
  const active = parseLineActive(value.active);
  const operation = parseLineOperation(value.operation);
  const receipts = value.receipts.map((entry): LineReceipt => {
    if (!isRecord(entry) || !hasExactKeys(entry, LINE_RECEIPT_KEYS)) {
      return corruptStorage();
    }
    if (
      typeof entry.commandId !== "string" ||
      !UUID.test(entry.commandId) ||
      !LINE_OPERATIONS.includes(entry.operation as LineOperationName) ||
      typeof entry.fingerprint !== "string" ||
      !SHA256_HEX.test(entry.fingerprint) ||
      typeof entry.responseJson !== "string" ||
      typeof entry.createdAt !== "string"
    ) {
      return corruptStorage();
    }
    return {
      commandId: entry.commandId,
      operation: entry.operation as LineOperationName,
      fingerprint: entry.fingerprint,
      responseJson: entry.responseJson,
      createdAt: canonicalTimestamp(entry.createdAt),
    };
  });
  if (new Set(receipts.map(({ commandId }) => commandId)).size !== receipts.length) {
    return corruptStorage();
  }
  return {
    schemaVersion: 1,
    lifecycleVersion: value.lifecycleVersion as number,
    phase: value.phase as LineLifecyclePhase,
    draft,
    active,
    operation,
    highWaterCopy: value.highWaterCopy as number,
    receipts,
    updatedAt: canonicalTimestamp(value.updatedAt),
  };
};

const defaultLineLifecycle = (now: string): LineLifecycle => ({
  schemaVersion: 1,
  lifecycleVersion: 0,
  phase: "disabled",
  draft: null,
  active: null,
  operation: null,
  highWaterCopy: 0,
  receipts: [],
  updatedAt: now,
});

const parseLineCommand = (value: unknown): LineCommandInput | null => {
  if (!isRecord(value)) return null;
  const withIdentifiers =
    value.operation === "line.settings" || value.operation === "line.enable";
  const expected = withIdentifiers
    ? ["operation", "commandId", "expectedLifecycleVersion", "identifiers"]
    : ["operation", "commandId", "expectedLifecycleVersion"];
  if (!hasExactKeys(value, expected)) return null;
  if (
    !LINE_OPERATIONS.includes(value.operation as LineOperationName) ||
    typeof value.commandId !== "string" ||
    !UUID.test(value.commandId) ||
    !Number.isSafeInteger(value.expectedLifecycleVersion) ||
    (value.expectedLifecycleVersion as number) < 0
  ) {
    return null;
  }
  let identifiers: LineIdentifiers | undefined;
  if (withIdentifiers) {
    try {
      identifiers = parseLineIdentifiers(value.identifiers);
    } catch {
      return null;
    }
  }
  return {
    operation: value.operation as LineOperationName,
    commandId: value.commandId,
    expectedLifecycleVersion: value.expectedLifecycleVersion as number,
    ...(identifiers === undefined ? {} : { identifiers }),
  };
};

const lineCommandFingerprint = async (input: LineCommandInput): Promise<string> =>
  sha256Hex(
    canonicalJson([
      1,
      input.operation,
      input.commandId,
      input.expectedLifecycleVersion,
      input.identifiers ?? null,
    ]),
  );

// ---- Staff roster (specs/005-staff-role-boundary/data-model.md) ----
// Its own `__`-prefixed table, for the same reason the LINE lifecycle has one:
// the exact-set schema check above excludes those names, so the roster reaches
// an installation provisioned before it existed. An installation with no table
// has no roster, which is the state every installation is in today.

/**
 * Compares two hex digests without letting the position of the first differing
 * character show in the time taken. Both operands are the output of SHA-256, so
 * neither is secret on its own; what must not leak is *where* they diverge,
 * because that is what turns a refusal into an oracle.
 *
 * An inactive member holds `""`, which fails the length check immediately. That
 * is a structural fact about the record rather than a fact about the presented
 * credential, and the caller visits every member regardless.
 */
const timingSafeEqualHex = (left: string, right: string): boolean => {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
};

export type StaffRole = "owner" | "staff";

type StaffMember = {
  id: string;
  displayName: string;
  role: StaffRole;
  active: boolean;
  // Empty exactly when the member is inactive. Clearing it is what revokes the
  // credential, so revocation is a property of the stored record rather than of
  // a check someone has to remember to write.
  credentialDigest: string;
  createdAt: string;
  deactivatedAt: string | null;
};

type StaffRoster = {
  version: 1;
  members: StaffMember[];
};

const STAFF_MEMBER_KEYS = [
  "id",
  "displayName",
  "role",
  "active",
  "credentialDigest",
  "createdAt",
  "deactivatedAt",
] as const;

// A stored display name is already normalised, so this only has to recognise
// one rather than produce one — `boundedString` trims and would let an
// untrimmed stored value through as valid, which the round-trip check forbids.
const isStoredDisplayName = (value: unknown): value is string =>
  typeof value === "string" &&
  value === value.trim() &&
  !CONTROL.test(value) &&
  codePointLength(value) >= 1 &&
  codePointLength(value) <= 80;

const parseStaffMember = (value: unknown): StaffMember => {
  if (!isRecord(value) || !hasExactKeys(value, STAFF_MEMBER_KEYS)) {
    return corruptStorage();
  }
  if (
    typeof value.id !== "string" ||
    !UUID.test(value.id) ||
    !isStoredDisplayName(value.displayName) ||
    (value.role !== "owner" && value.role !== "staff") ||
    typeof value.active !== "boolean" ||
    typeof value.credentialDigest !== "string" ||
    // A live digest on an inactive record, or none on an active one, would make
    // the active flag and the credential disagree about who can sign in.
    (value.active
      ? !SHA256_HEX.test(value.credentialDigest)
      : value.credentialDigest !== "") ||
    typeof value.createdAt !== "string" ||
    (value.deactivatedAt !== null && typeof value.deactivatedAt !== "string")
  ) {
    return corruptStorage();
  }
  return {
    id: value.id,
    displayName: value.displayName,
    role: value.role,
    active: value.active,
    credentialDigest: value.credentialDigest,
    createdAt: canonicalTimestamp(value.createdAt),
    deactivatedAt:
      value.deactivatedAt === null ? null : canonicalTimestamp(value.deactivatedAt),
  };
};

export const parseStaffRoster = (value: unknown): StaffRoster => {
  if (!isRecord(value) || !hasExactKeys(value, ["version", "members"])) {
    return corruptStorage();
  }
  // A document from a future version is refused rather than migrated: this
  // object cannot know what a later shape meant.
  if (value.version !== 1 || !Array.isArray(value.members)) return corruptStorage();
  const members = value.members.map(parseStaffMember);
  if (new Set(members.map(({ id }) => id)).size !== members.length) {
    return corruptStorage();
  }
  return { version: 1, members };
};

// The one invariant every roster write is checked against. Stated over the
// resulting document rather than over the operation, so it also covers the role
// changes and record removals a later slice may add.
export const hasActiveOwner = (roster: StaffRoster): boolean =>
  roster.members.some(({ role, active }) => role === "owner" && active);

/** A staff record as anyone outside this object may see it: never the digest. */
type PublicStaffMember = Omit<StaffMember, "credentialDigest">;

const publicStaffMember = ({
  credentialDigest: _digest,
  ...rest
}: StaffMember): PublicStaffMember => rest;

/**
 * The credential digest is minted by the Worker, which is the only place the
 * plaintext ever exists, so every command that issues a credential carries the
 * digest in rather than computing one here.
 */
type RosterCommand =
  | {
      operation: "staff.create";
      displayName: string;
      role: StaffRole;
      credentialDigest: string;
      dryRun: boolean;
    }
  | { operation: "staff.rotate"; staffId: string; credentialDigest: string }
  | { operation: "staff.deactivate"; staffId: string }
  | { operation: "staff.reactivate"; staffId: string; credentialDigest: string };

export type RosterFailureCode =
  | "BAD_REQUEST"
  | "STAFF_UNAVAILABLE"
  | "VERSION_CONFLICT"
  | "LAST_OWNER"
  | "ROSTER_FULL"
  | "UNAUTHORIZED";

/**
 * The roster is one document read in full on every staff-credentialled request,
 * and it is rewritten whole on every command, so its size is a running cost
 * rather than a one-time one. Far above any salon's headcount and far below the
 * point where the document stops being writable — the bound exists so the
 * failure is a refusal an owner can read, not a roster that can no longer be
 * repaired from the screen.
 */
const ROSTER_LIMIT = 200;

export type RosterCommandResult =
  | { ok: true; member: PublicStaffMember }
  | { ok: true; dryRun: true; wouldBeFirstMember: boolean }
  | { ok: false; code: RosterFailureCode };

const EMPTY_ROSTER: StaffRoster = { version: 1, members: [] };

/**
 * Validates a command arriving over RPC. The Worker has already checked the
 * request body, but this object is the one that owns the roster's shape, so it
 * does not take the caller's word for it.
 */
const parseRosterCommand = (value: unknown): RosterCommand | null => {
  if (!isRecord(value)) return null;
  const digestValid = (digest: unknown): digest is string =>
    typeof digest === "string" && SHA256_HEX.test(digest);
  if (value.operation === "staff.create") {
    if (
      !hasExactKeys(value, ["operation", "displayName", "role", "credentialDigest", "dryRun"]) ||
      !isStoredDisplayName(value.displayName) ||
      (value.role !== "owner" && value.role !== "staff") ||
      !digestValid(value.credentialDigest) ||
      typeof value.dryRun !== "boolean"
    ) {
      return null;
    }
    return {
      operation: "staff.create",
      displayName: value.displayName,
      role: value.role,
      credentialDigest: value.credentialDigest,
      dryRun: value.dryRun,
    };
  }
  if (typeof value.staffId !== "string" || !UUID.test(value.staffId)) return null;
  if (value.operation === "staff.deactivate") {
    return hasExactKeys(value, ["operation", "staffId"])
      ? { operation: "staff.deactivate", staffId: value.staffId }
      : null;
  }
  if (value.operation !== "staff.rotate" && value.operation !== "staff.reactivate") {
    return null;
  }
  return hasExactKeys(value, ["operation", "staffId", "credentialDigest"]) &&
    digestValid(value.credentialDigest)
    ? { operation: value.operation, staffId: value.staffId, credentialDigest: value.credentialDigest }
    : null;
};

const rosterFailure = (code: RosterFailureCode): { ok: false; code: RosterFailureCode } => ({
  ok: false,
  code,
});

/**
 * Computes the roster a command would produce, or the reason it may not.
 * Pure: the caller decides whether to store the result.
 *
 * An unknown identifier and an ineligible one answer the same
 * `STAFF_UNAVAILABLE`, so the endpoint never confirms which identifiers are
 * real to a caller probing them.
 */
const applyRosterCommand = (
  roster: StaffRoster,
  command: RosterCommand,
  now: string,
  newId: string,
): { roster: StaffRoster; member: StaffMember } | { ok: false; code: RosterFailureCode } => {
  if (command.operation === "staff.create") {
    // Counted over every record, active or not: a stopped member is still a row
    // this document carries forever, because past attribution resolves through
    // it. Making room means the roster needs a way to forget people, which is a
    // deletion this slice deliberately does not have.
    if (roster.members.length >= ROSTER_LIMIT) return rosterFailure("ROSTER_FULL");
    const member: StaffMember = {
      id: newId,
      displayName: command.displayName,
      role: command.role,
      active: true,
      credentialDigest: command.credentialDigest,
      createdAt: now,
      deactivatedAt: null,
    };
    return { roster: { version: 1, members: [...roster.members, member] }, member };
  }

  const index = roster.members.findIndex(({ id }) => id === command.staffId);
  const current = roster.members[index];
  if (current === undefined) return rosterFailure("STAFF_UNAVAILABLE");

  let member: StaffMember;
  if (command.operation === "staff.rotate") {
    // Rotating a record that cannot authenticate would put a live digest on an
    // inactive member, which the parser refuses and revocation depends on.
    if (!current.active) return rosterFailure("STAFF_UNAVAILABLE");
    member = { ...current, credentialDigest: command.credentialDigest };
  } else if (command.operation === "staff.deactivate") {
    if (!current.active) return rosterFailure("STAFF_UNAVAILABLE");
    // Clearing the digest is the revocation. The record survives with its
    // identifier and role so past attribution stays resolvable.
    member = { ...current, active: false, credentialDigest: "", deactivatedAt: now };
  } else {
    if (current.active) return rosterFailure("STAFF_UNAVAILABLE");
    // A new credential, always: the previous digest was destroyed at
    // deactivation and there is nothing to restore. `deactivatedAt` goes with
    // it — the record is in the list the roster hands out, and an active member
    // still carrying the date they were stopped describes a state that is not
    // true of them any more.
    member = {
      ...current,
      active: true,
      credentialDigest: command.credentialDigest,
      deactivatedAt: null,
    };
  }

  const members = [...roster.members];
  members[index] = member;
  const next = { version: 1, members } as StaffRoster;
  // Stated as "may not take away the last one" rather than "must always have
  // one", because a roster of staff alone is a legitimate state: the
  // OWNER_TOKEN holder administers it and adds people who are not owners. What
  // must never happen is an owner-role account being removed when it was the
  // only one. Checked on the resulting document, so a later role change or
  // record removal is covered by this same line.
  if (hasActiveOwner(roster) && !hasActiveOwner(next)) return rosterFailure("LAST_OWNER");
  return { roster: next, member };
};

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
    typeof value.turnstileSecretPresent !== "boolean" ||
    typeof value.lineSecretPresent !== "boolean"
  ) {
    throw new TypeError("Invalid installation runtime");
  }
  return {
    ownerSecretPresent: value.ownerSecretPresent,
    ownerAuthenticated: value.ownerAuthenticated,
    turnstileSecretPresent: value.turnstileSecretPresent,
    lineSecretPresent: value.lineSecretPresent,
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
    if (rows.length !== 1 || row?.singleton !== 1 || typeof row.state_json !== "string") {
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

  /**
   * Whether one of this object's `__`-prefixed side tables has been provisioned
   * yet. Absent is a legitimate state — it is where every installation starts —
   * so the readers below distinguish it from a table that exists and has lost
   * its row, which is corruption.
   */
  #tableExists(name: string): boolean {
    return (
      this.ctx.storage.sql
        .exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
          name,
        )
        .toArray().length > 0
    );
  }

  // ---- LINE lifecycle storage (own `__` table; settings JSON untouched) ----

  #readLineLifecycle(): LineLifecycle | null {
    if (!this.#tableExists("__line_lifecycle")) return null;
    const rows = this.ctx.storage.sql
      .exec<{ singleton: number; lifecycle_json: string }>(
        "SELECT singleton, lifecycle_json FROM __line_lifecycle",
      )
      .toArray();
    const row = rows[0];
    if (rows.length !== 1 || row?.singleton !== 1) {
      return corruptStorage();
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.lifecycle_json);
    } catch {
      return corruptStorage();
    }
    const lifecycle = parseLineLifecycle(parsed);
    if (JSON.stringify(lifecycle) !== row.lifecycle_json) return corruptStorage();
    return lifecycle;
  }

  // First write creates the table — the lifecycle appears only on operator
  // commands, never on reads.
  #writeLineLifecycle(lifecycle: LineLifecycle): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS __line_lifecycle (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        lifecycle_json TEXT NOT NULL
      )
    `);
    this.ctx.storage.sql.exec(
      `INSERT INTO __line_lifecycle (singleton, lifecycle_json) VALUES (1, ?)
       ON CONFLICT(singleton) DO UPDATE SET lifecycle_json = excluded.lifecycle_json`,
      JSON.stringify(parseLineLifecycle(lifecycle)),
    );
  }

  // ---- Staff roster storage (own `__` table; settings JSON untouched) ----

  // Answers null for an installation that has never had a roster, which is the
  // state every installation is in until an owner adds the first member.
  #readRoster(): { roster: StaffRoster; rosterJson: string } | null {
    if (!this.#tableExists("__staff_roster")) return null;
    const rows = this.ctx.storage.sql
      .exec<{ singleton: number; roster_json: string }>(
        "SELECT singleton, roster_json FROM __staff_roster",
      )
      .toArray();
    const row = rows[0];
    if (rows.length !== 1 || row.singleton !== 1) return corruptStorage();
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.roster_json);
    } catch {
      return corruptStorage();
    }
    const roster = parseStaffRoster(parsed);
    if (JSON.stringify(roster) !== row.roster_json) return corruptStorage();
    return { roster, rosterJson: row.roster_json };
  }

  /**
   * One statement for the first write and every later one. The insert path
   * bootstraps a roster that does not exist yet; on an existing row the `WHERE`
   * is the compare-and-swap, so a second owner editing concurrently writes zero
   * rows and is refused rather than silently overwriting.
   *
   * `previousJson` is null only when the caller read no roster at all. Two
   * commands both seeing no roster still cannot both land: the second one's
   * insert hits the singleton conflict, and its `WHERE` fails against the row
   * the first one wrote.
   *
   * No request can currently lose this compare-and-swap: `executeRosterCommand`
   * has no `await` between its read and this write, so an object turn cannot be
   * suspended mid-command and the previous document is always the current one.
   * The clause guards that invariant rather than an observed race — introduce a
   * suspension point up there and the window opens, and this is what turns the
   * lost update into a refusal instead of silent corruption.
   */
  #writeRoster(roster: StaffRoster, previousJson: string | null): boolean {
    // Validated before the table is created, because the two statements are not
    // in one transaction: a parser that threw after the `CREATE` would leave a
    // table holding no rows, which `#readRoster` reads as corruption forever and
    // which no screen can repair. Unreachable while everything
    // `applyRosterCommand` builds parses — the ordering is what keeps it so.
    const rosterJson = JSON.stringify(parseStaffRoster(roster));
    const sql = this.ctx.storage.sql;
    sql.exec(`
      CREATE TABLE IF NOT EXISTS __staff_roster (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        roster_json TEXT NOT NULL
      )
    `);
    const write = sql.exec(
      `INSERT INTO __staff_roster (singleton, roster_json) VALUES (1, ?)
       ON CONFLICT(singleton) DO UPDATE SET roster_json = excluded.roster_json
       WHERE roster_json = ?`,
      rosterJson,
      previousJson ?? "",
    );
    if (write.rowsWritten === 1) return true;
    // Same anomaly check `executeCommand`'s compare-and-swap makes: a count
    // that is neither 0 nor 1 is not a lost race, and reporting it as one would
    // tell an owner their `staff.create` failed while the member is in the
    // roster holding a credential the response threw away.
    if (write.rowsWritten !== 0) throw new Error("Invalid roster CAS result");
    return false;
  }

  /**
   * Resolves a presented credential to an actor, or to null. The Worker calls
   * this only after the deployment secret has failed to match, so a corrupt or
   * absent roster can never take the break-glass path down with it.
   *
   * Every member is compared, with no early exit on the first match, so the
   * work done is the same whether the digest belongs to nobody, to an active
   * member, or to a deactivated one. `ROSTER_LIMIT` is what keeps the naive
   * loop the cheap option as well as the one that does not leak which
   * identifiers exist.
   */
  resolveActor(digest: unknown): { staffId: string; role: StaffRole } | null {
    if (typeof digest !== "string" || !SHA256_HEX.test(digest)) return null;
    const stored = this.#readRoster();
    if (stored === null) return null;
    let found: { staffId: string; role: StaffRole } | null = null;
    for (const member of stored.roster.members) {
      // An inactive member holds an empty digest, which no SHA-256 hex string
      // equals, so deactivation needs no separate check here. `parseStaffMember`
      // is what guarantees that — it refuses a stored record whose `active` and
      // digest disagree in either direction, so revocation rests on the parser
      // rather than on a test of `active` that could be forgotten here.
      if (timingSafeEqualHex(member.credentialDigest, digest)) {
        found = { staffId: member.id, role: member.role };
      }
    }
    return found;
  }

  /** The roster as the operator screen sees it. Never a credential digest. */
  listRoster(): PublicStaffMember[] {
    return (this.#readRoster()?.roster.members ?? []).map(publicStaffMember);
  }

  /**
   * One attempt, never a retry loop. `executeCommand` retries a lost
   * compare-and-swap because it recomputes settings from scratch; a roster
   * command must not, because "deactivate this person" recomputed against a
   * roster somebody else just edited can do something the caller never asked
   * for. A lost race is reported as a conflict and the operator re-reads.
   */
  async executeRosterCommand(
    input: unknown,
    actorId: unknown,
  ): Promise<RosterCommandResult> {
    const command = parseRosterCommand(input);
    if (command === null) return rosterFailure("BAD_REQUEST");
    if (actorId !== null && (typeof actorId !== "string" || !UUID.test(actorId))) {
      return rosterFailure("BAD_REQUEST");
    }
    const stored = this.#readRoster();
    const roster = stored?.roster ?? EMPTY_ROSTER;
    // Re-checked here, not just at the gate. The Worker authorized this caller
    // before the request body arrived, and on this surface that gap is the
    // difference between an operation finishing with the rights it opened with
    // and an operation restoring rights that were taken away while it was open.
    // Read in the same synchronous turn as the write below, so the roster this
    // decision is made against is the roster the command lands on.
    // `null` is the deployment secret, which no roster command can revoke.
    if (
      actorId !== null &&
      !roster.members.some(
        ({ id, role, active }) => id === actorId && role === "owner" && active,
      )
    ) {
      return rosterFailure("UNAUTHORIZED");
    }
    const applied = applyRosterCommand(
      roster,
      command,
      new Date().toISOString(),
      crypto.randomUUID(),
    );
    if ("ok" in applied) return applied;
    if (command.operation === "staff.create" && command.dryRun) {
      // Run the same parser the write runs, so "this would have worked" is a
      // result rather than a claim. Nothing is written, and no credential is
      // handed out for a record that will not exist.
      parseStaffRoster(applied.roster);
      return { ok: true, dryRun: true, wouldBeFirstMember: roster.members.length === 0 };
    }
    return this.#writeRoster(applied.roster, stored?.rosterJson ?? null)
      ? { ok: true, member: publicStaffMember(applied.member) }
      : rosterFailure("VERSION_CONFLICT");
  }

  /**
   * The Worker's single per-request read: installation state plus the LINE
   * projection with a freshly minted descriptor lease. The lease bounds how
   * long the projection may be trusted by a day-side event commit.
   */
  getContext(): { state: InstallationState; line?: LineContext } {
    const state = clone(this.#readStoredState().state);
    const lifecycle = this.#readLineLifecycle();
    if (lifecycle === null) return { state };
    const issuedAt = Date.now();
    const line: LineContext = {
      phase: lifecycle.phase,
      lifecycleVersion: lifecycle.lifecycleVersion,
      lease: {
        issuedAt,
        notAfter: issuedAt + ADAPTER.DESCRIPTOR_LEASE_WINDOW_S * 1000,
      },
      ...(lifecycle.active === null
        ? {}
        : {
            liffId: lifecycle.active.liffId,
            loginChannelId: lifecycle.active.loginChannelId,
            messagingChannelId: lifecycle.active.messagingChannelId,
            generation: lifecycle.active.generation,
          }),
    };
    return { state, line };
  }

  /** Owner setup surface: draft and lifecycle facts (never the secret). */
  lineAdapterStatus(): {
    phase: LineLifecyclePhase;
    lifecycleVersion: number;
    draft: LineIdentifiers | null;
    active: (LineIdentifiers & { generation: number; activatedAt: string }) | null;
    operationInFlight: boolean;
    highWaterCopy: number;
  } {
    const lifecycle = this.#readLineLifecycle();
    if (lifecycle === null) {
      return {
        phase: "disabled",
        lifecycleVersion: 0,
        draft: null,
        active: null,
        operationInFlight: false,
        highWaterCopy: 0,
      };
    }
    return {
      phase: lifecycle.phase,
      lifecycleVersion: lifecycle.lifecycleVersion,
      draft: clone(lifecycle.draft),
      active: clone(lifecycle.active),
      operationInFlight: lifecycle.operation !== null,
      highWaterCopy: lifecycle.highWaterCopy,
    };
  }

  /**
   * The three lifecycle commands share this one pipeline: receipt match →
   * phase + version CAS → execute. `lifecycleVersion` bumps exactly once per
   * accepted external command; saga re-drives never change it.
   */
  #nextLineLifecycle(
    command: LineCommandInput,
    lifecycle: LineLifecycle,
    safeRuntime: ReadinessRuntime,
    now: string,
  ): LineLifecycle | { ok: false; code: "PHASE_CONFLICT" | "SECRET_MISSING" | "ORIGIN_UNCONFIGURED" } {
    if (command.operation === "line.settings") {
      if (lifecycle.phase !== "disabled" || command.identifiers === undefined) {
        return { ok: false, code: "PHASE_CONFLICT" };
      }
      return {
        ...lifecycle,
        draft: command.identifiers,
        lifecycleVersion: lifecycle.lifecycleVersion + 1,
        updatedAt: now,
      };
    }
    if (command.operation === "line.enable") {
      if (lifecycle.phase !== "disabled" || command.identifiers === undefined) {
        return { ok: false, code: "PHASE_CONFLICT" };
      }
      if (!safeRuntime.lineSecretPresent) return { ok: false, code: "SECRET_MISSING" };
      const settings = activeVersion(this.#readStoredState().state).settings;
      if (!protectionReady(settings, safeRuntime)) {
        return { ok: false, code: "ORIGIN_UNCONFIGURED" };
      }
      return {
        ...lifecycle,
        phase: "activating",
        operation: {
          operationId: crypto.randomUUID(),
          kind: "enable",
          step: "activate",
          startedAt: now,
          identifiers: command.identifiers,
          finalPassAt: null,
        },
        lifecycleVersion: lifecycle.lifecycleVersion + 1,
        updatedAt: now,
      };
    }
    if (lifecycle.phase !== "active") {
      return { ok: false, code: "PHASE_CONFLICT" };
    }
    return {
      ...lifecycle,
      phase: "deactivating",
      operation: {
        operationId: crypto.randomUUID(),
        kind: "disable",
        step: "begin-disable",
        startedAt: now,
        identifiers: null,
        finalPassAt: null,
      },
      lifecycleVersion: lifecycle.lifecycleVersion + 1,
      updatedAt: now,
    };
  }

  async executeLineCommand(
    input: unknown,
    runtime: ReadinessRuntime,
  ): Promise<LineCommandResult> {
    const safeRuntime = parseRpcRuntime(runtime);
    const command = parseLineCommand(input);
    if (command === null) return { ok: false, code: "BAD_REQUEST" };
    const fingerprint = await lineCommandFingerprint(command);
    const now = new Date().toISOString();

    // Pre-armed before the accepting commit: if this invocation dies between
    // the commit and the saga driver below, the coordinator alarm still wakes
    // and re-drives the stored operation to completion. A spurious wake-up
    // with no operation is a no-op.
    await this.ctx.storage.setAlarm(Date.now() + ADAPTER.SAGA_REDRIVE_DELAY_S * 1000);

    const result = this.ctx.storage.transactionSync((): LineCommandResult => {
      const lifecycle = this.#readLineLifecycle() ?? defaultLineLifecycle(now);

      const receipt = lifecycle.receipts.find(
        ({ commandId }) => commandId === command.commandId,
      );
      if (receipt !== undefined) {
        if (receipt.fingerprint !== fingerprint) {
          return { ok: false, code: "IDEMPOTENCY_CONFLICT" };
        }
        const stored = JSON.parse(receipt.responseJson) as LineCommandOutcome;
        return { ...stored, replayed: true };
      }
      if (command.expectedLifecycleVersion !== lifecycle.lifecycleVersion) {
        return { ok: false, code: "VERSION_CONFLICT" };
      }

      const next = this.#nextLineLifecycle(command, lifecycle, safeRuntime, now);
      if ("code" in next) return next;

      const outcome: LineCommandOutcome = {
        ok: true,
        phase: next.phase,
        lifecycleVersion: next.lifecycleVersion,
        replayed: false,
      };
      const cutoff = Date.now() - ADAPTER.RECEIPT_TTL_S * 1000;
      next.receipts = [
        ...lifecycle.receipts.filter(
          ({ createdAt }) => Date.parse(createdAt) >= cutoff,
        ),
        {
          commandId: command.commandId,
          operation: command.operation,
          fingerprint,
          responseJson: JSON.stringify(outcome),
          createdAt: now,
        },
      ].slice(-ADAPTER.RECEIPT_CAP);
      this.#writeLineLifecycle(next);
      return outcome;
    });

    if (result.ok && !result.replayed) await this.#driveLineSaga();
    return result;
  }

  // Single-coordinator saga driver: idempotent, re-entrant, alarm re-driven.
  // Every step reads its work from storage, performs one adapter RPC, then
  // records the step's completion; a crash anywhere re-drives from the record.
  async #driveEnableSaga(
    operation: LineSagaOperation,
    authority: ReturnType<Env["ADAPTER_DELIVERY"]["getByName"]>,
    now: string,
  ): Promise<"done" | "retry"> {
    if (operation.identifiers === null) throw new Error("corrupt enable operation");
    const meta = await authority.readMeta();
    const generation = (meta?.highWater ?? 0) + 1;
    const activated = await authority.activate({
      operationId: operation.operationId,
      generation,
      snapshot: {
        messagingChannelId: (operation.identifiers as LineIdentifiers).messagingChannelId,
      },
    });
    if (!activated.ok) return "retry";
    this.ctx.storage.transactionSync(() => {
      const current = this.#readLineLifecycle();
      if (current?.operation?.operationId !== operation.operationId) return;
      this.#writeLineLifecycle({
        ...current,
        phase: "active",
        active: {
          ...(operation.identifiers as LineIdentifiers),
          generation: activated.meta.generation,
          activatedAt: now,
        },
        operation: null,
        highWaterCopy: activated.meta.highWater,
        updatedAt: now,
      });
    });
    return "done";
  }

  async #driveBeginDisableStep(
    operation: LineSagaOperation,
    authority: ReturnType<Env["ADAPTER_DELIVERY"]["getByName"]>,
    now: string,
  ): Promise<void> {
    await authority.beginDisable();
    const finalPassAt = Date.now() + ADAPTER.FINAL_PASS_LEASE_WAIT_S * 1000;
    // Pre-arm before recording the step so a crash between the two can
    // only re-run the idempotent beginDisable, never lose the wake-up.
    await this.ctx.storage.setAlarm(finalPassAt);
    this.ctx.storage.transactionSync(() => {
      const current = this.#readLineLifecycle();
      if (current?.operation?.operationId !== operation.operationId) return;
      this.#writeLineLifecycle({
        ...current,
        operation: { ...operation, step: "final-wait", finalPassAt },
        updatedAt: now,
      });
    });
  }

  async #driveFinalWaitStep(
    operation: LineSagaOperation,
    authority: ReturnType<Env["ADAPTER_DELIVERY"]["getByName"]>,
    now: string,
  ): Promise<void> {
    if (operation.finalPassAt === null || Date.now() < operation.finalPassAt) {
      await this.ctx.storage.setAlarm(
        operation.finalPassAt ?? Date.now() + ADAPTER.FINAL_PASS_LEASE_WAIT_S * 1000,
      );
      return;
    }
    // The idempotent beginDisable re-call reports purge progress; the
    // authority refuses completion until a post-lease full purge pass
    // finished, so keep polling until it flips to disabled.
    const progress = await authority.beginDisable();
    if (!progress.purgeComplete) {
      await this.ctx.storage.setAlarm(Date.now() + 60_000);
      return;
    }
    const completed = await authority.completeDisable();
    if (completed.meta.state !== "disabled") {
      await this.ctx.storage.setAlarm(Date.now() + 60_000);
      return;
    }
    this.ctx.storage.transactionSync(() => {
      const current = this.#readLineLifecycle();
      if (current?.operation?.operationId !== operation.operationId) return;
      this.#writeLineLifecycle({
        ...current,
        phase: "disabled",
        active: null,
        // Draft cleared on disable completion: re-enabling re-enters
        // identifiers deliberately.
        draft: null,
        operation: null,
        updatedAt: now,
      });
    });
  }

  async #driveLineSaga(): Promise<void> {
    for (let step = 0; step < 4; step += 1) {
      const lifecycle = this.#readLineLifecycle();
      const operation = lifecycle?.operation ?? null;
      if (lifecycle === null || operation === null) return;
      const authority = this.env.ADAPTER_DELIVERY.getByName("installation");
      const now = new Date().toISOString();
      try {
        if (operation.kind === "enable") {
          if ((await this.#driveEnableSaga(operation, authority, now)) === "retry") continue;
          return;
        }
        if (operation.step === "begin-disable") {
          await this.#driveBeginDisableStep(operation, authority, now);
          return;
        }
        if (operation.step === "final-wait") {
          await this.#driveFinalWaitStep(operation, authority, now);
          return;
        }
        return;
      } catch {
        // Adapter RPC failed; leave the operation recorded and let the alarm
        // re-drive it.
        await this.ctx.storage.setAlarm(Date.now() + 60_000);
        return;
      }
    }
    await this.ctx.storage.setAlarm(Date.now() + ADAPTER.SAGA_REDRIVE_DELAY_S * 1000);
  }

  override async alarm(): Promise<void> {
    await this.#driveLineSaga();
    // No re-arm when idle: with no operation in flight this object keeps no
    // pending alarm (the same disarm invariant the delivery object holds).
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
