import { DurableObject } from "cloudflare:workers";

import { ADAPTER } from "./adapter-constants.ts";
import {
  createEmptyReservationState,
  executeReservationCommand,
  type ReservationState,
} from "./reservation-core.ts";

// Thrown inside a storage transaction when an event would commit under an
// expired adapter lease; rolls the transaction back and surfaces RETRY_CONFIG.
class AdapterLeaseExpiredError extends Error {}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const DIGEST = /^[a-f0-9]{64}$/;
const MANAGEMENT_KEY = /^[A-Za-z0-9_-]{43}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
// The day partition's cumulative acceptance budget. 96 matches the maximum
// offer grid (8 resources x 12 start times); 192 allows two lifecycle actions
// per created booking. Deliberately never decremented: a cancellation,
// rejection or expiry releases the booking's interval, so the time goes back
// on sale, but the rows the booking created (details, receipts, kernel
// records) survive until the retention purge, and a decrementing budget would
// let a create/cancel loop grow one partition without bound. Turnstile and
// the public rate limiter stand in front of this bound, and the projection
// reports `capacityReached` so both screens can say which limit was hit.
// See docs/CLOUDFLARE.md "Free-plan fit" and issue #22.
const MAX_ACCEPTED_CREATES = 96;
const MAX_ACCEPTED_MUTATIONS = 192;
const TABLES = [
  "adapter_receipts",
  "booking_details",
  "closures",
  "core_state",
  "partition_meta",
] as const;

export type DayResource = {
  id: string;
  label: string;
  active: boolean;
};

export type DayService = {
  id: string;
  label: string;
  category: string | null;
  durationMinutes: number;
  cleanupMinutes: number;
  priceYen: number | null;
  eligibleResourceIds: string[];
  active: boolean;
};

export type DayConfig = {
  date: string;
  resourceIds: string[];
  startTimes: string[];
  slotMinutes: number;
  purgeAt: number;
  settingsVersion?: number;
  resources?: DayResource[];
  services?: DayService[];
  opensAt?: string;
  closesAt?: string;
  startIntervalMinutes?: number;
  consentVersion?: string;
  // How long a booking may stay pending before it expires. Absent means no
  // expiry, which is what every caller got before the setting existed, and it
  // is deliberately not part of scheduleJson: a day pinned before the setting
  // changed must not start failing with CONFIGURATION_CONFLICT because an
  // operator shortened the lifetime.
  pendingExpiryMinutes?: number;
  // Absent on every pre-adapter caller and while the LINE adapter is inactive;
  // deliberately not part of scheduleJson.
  adapter?: DayAdapterDescriptor;
  // Independent calendar consumer; also transient and excluded from the
  // pinned schedule so enabling an adapter cannot change availability.
  calendarAdapter?: DayAdapterDescriptor;
  // A descriptor lookup timed out. The mutation still records an unbound
  // calendar outbox event during this bounded window so the active authority
  // can adopt it durably without outliving a completed disable sweep.
  calendarRecovery?: {
    leaseIssuedAt: number;
    leaseNotAfter: number;
  };
};

type TargetDayConfig = DayConfig & {
  settingsVersion: number;
  resources: DayResource[];
  services: DayService[];
  opensAt: string;
  closesAt: string;
  startIntervalMinutes: number;
  consentVersion: string;
};

export type DayCreateInput = {
  commandId: string;
  date: string;
  resourceId: string;
  startTime: string;
  customerName: string;
  contact: string;
  managementDigest: string;
  settingsVersion?: number;
  serviceIds?: string[];
  consentVersion?: string;
};

export type DayPublicCancelInput = {
  commandId: string;
  date: string;
  reservationId: string;
  managementKey: string;
};

export type DayPublicStatusInput = {
  date: string;
  reservationId: string;
  managementKey: string;
};

export type DayOwnerTransitionInput = {
  commandId: string;
  date: string;
  reservationId: string;
  action: "approve" | "reject" | "cancel" | "complete" | "no_show" | "reschedule";
  reason?: string;
  resourceId?: string;
  startTime?: string;
};

export type DayClosureCreateInput = {
  commandId: string;
  date: string;
  resourceId: string | null;
  startTime: string;
  endTime: string;
  label: string;
};

export type DayClosureRemoveInput = {
  commandId: string;
  date: string;
  closureId: string;
};

// Forwarded by the Worker from the installation projection, never minted here.
// The lease bounds how stale a projection a mutation may commit under: the day
// validates `leaseNotAfter` inside the same transaction that writes an event,
// so a request that outlived its lease cannot attribute events to a generation
// that may have been disabled meanwhile. Expired lease → RETRY_CONFIG, and the
// Worker retries once with a freshly minted projection.
export type DayAdapterDescriptor = {
  consumer: "line" | "calendar";
  generation: number;
  phase: "active" | "deactivating";
  leaseIssuedAt: number;
  leaseNotAfter: number;
};

const calendarRecoveryDescriptor = (
  recovery: NonNullable<DayConfig["calendarRecovery"]>,
): DayAdapterDescriptor => ({
  consumer: "calendar",
  generation: 0,
  phase: "active",
  leaseIssuedAt: recovery.leaseIssuedAt,
  leaseNotAfter: recovery.leaseNotAfter,
});

export type AdapterEventType =
  | "create"
  | "approve"
  | "reject"
  | "reschedule"
  | "cancel"
  | "expire";

export type CalendarReservationStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "cancelled"
  | "expired";

export type AdapterOutboxEvent = {
  eventId: string;
  seq: number;
  generation: number;
  type: AdapterEventType;
  reservationId: string;
  date: string;
  startTime: string;
  endTime: string | null;
  serviceLabel: string;
  reservationStatus: CalendarReservationStatus | null;
  occurredAt: string;
  // The parent partition's retention deadline, carried so a consumer can hold
  // derived rows to exactly the same boundary without reading configuration.
  purgeAt: number;
};

export type DayDrainInput = { consumer: "line" | "calendar"; limit?: number };
export type DayDrainResult = { events: AdapterOutboxEvent[]; more: boolean };
export type DayAckInput = {
  consumer: "line" | "calendar";
  events: Array<{ generation: number; eventId: string }>;
};

export type DayCalendarProjectionResult =
  | DayFailure
  | {
      ok: true;
      date: string;
      purgeAt: number;
      watermark: { generation: number; seq: number };
      events: Array<{
        reservationId: string;
        stampAt: string;
        startTime: string;
        endTime: string;
        serviceLabel: string;
        status: "pending" | "approved";
      }>;
    };

export type DayFailureCode =
  | "BAD_REQUEST"
  | "CONFIGURATION_CONFLICT"
  | "IDEMPOTENCY_CONFLICT"
  | "NOT_FOUND_OR_UNAUTHORIZED"
  | "UNAVAILABLE"
  | "CAPACITY_REACHED"
  | "TEMPORARILY_UNAVAILABLE"
  // Internal to the Worker: the adapter descriptor's lease expired mid-request.
  // Mapped to one context refresh + retry, never surfaced to clients.
  | "RETRY_CONFIG";

export type DayFailure = { ok: false; code: DayFailureCode };

export type BookingStatus =
  | "active"
  | "pending"
  | "approved"
  | "rejected"
  | "cancelled"
  | "completed"
  | "expired"
  | "no_show";

export type BookingSnapshot = {
  settingsVersion: number;
  services: Array<{
    id: string;
    label: string;
    durationMinutes: number;
    cleanupMinutes: number;
    priceYen: number | null;
  }>;
  serviceMinutes: number;
  cleanupMinutes: number;
  occupiedMinutes: number;
  priceYen: number | null;
  resourceId: string;
  resourceLabel: string;
  consentVersion: string;
};

export type DayMutationSuccess = {
  ok: true;
  reservationId: string;
  date: string;
  resourceId: string;
  resourceLabel?: string;
  startTime: string;
  status: BookingStatus;
  replayed: boolean;
  snapshot?: BookingSnapshot;
  rejectionReason?: string | null;
  outcomeAt?: string | null;
};

export type DayClosureSuccess = {
  ok: true;
  closureId: string;
  date: string;
  resourceId: string | null;
  startTime: string;
  endTime: string;
  label: string;
  active: boolean;
  replayed: boolean;
};

type StoredSuccess = DayMutationSuccess | DayClosureSuccess;

export type DayMutationResult = DayMutationSuccess | DayFailure;
export type DayClosureResult = DayClosureSuccess | DayFailure;

export type DayPublicStatusSuccess = {
  ok: true;
  reservationId: string;
  date: string;
  purgeAt: number;
  startTime: string;
  status: Exclude<BookingStatus, "active">;
  resourceId: string;
  resourceLabel: string;
  snapshot: BookingSnapshot;
  rejectionReason: string | null;
  outcomeAt: string | null;
  expiresAt?: string;
  allowedActions: Array<"cancel">;
};

export type DayPublicStatusResult = DayPublicStatusSuccess | DayFailure;

export type DayAvailabilityResult =
  | {
      ok: true;
      pinned: boolean;
      capacityReached: boolean;
      settingsVersion?: number;
      serviceIds?: string[];
      services?: BookingSnapshot["services"];
      serviceMinutes?: number;
      cleanupMinutes?: number;
      occupiedMinutes?: number;
      priceYen?: number | null;
      resources: Array<{ id: string; label?: string; startTimes: string[] }>;
    }
  | DayFailure;

export type DayOwnerListResult =
  | {
      ok: true;
      settingsVersion?: number;
      opensAt?: string;
      closesAt?: string;
      reservations: Array<{
        reservationId: string;
        resourceId: string;
        resourceLabel?: string;
        startTime: string;
        status: BookingStatus;
        customerName: string;
        contact: string;
        snapshot?: BookingSnapshot;
        rejectionReason?: string | null;
        outcomeAt?: string | null;
        expiresAt?: string;
        rescheduleHistory?: Array<{
          from: { resourceId: string; startTime: string };
          to: { resourceId: string; startTime: string };
        }>;
      }>;
      closures?: Array<{
        closureId: string;
        resourceId: string | null;
        startTime: string;
        endTime: string;
        label: string;
        active: boolean;
      }>;
    }
  | DayFailure;

type Meta = {
  date: string;
  scheduleJson: string;
  acceptedCreates: number;
  acceptedMutations: number;
  purgeAt: number;
};

type RescheduleRecord = {
  from: { resourceId: string; startTime: string };
  to: { resourceId: string; startTime: string };
};

type BookingDetail = {
  reservationId: string;
  customerName: string;
  contact: string;
  managementDigest: string;
  status: BookingStatus;
  rejectionReason: string | null;
  snapshot: BookingSnapshot | null;
  rescheduleHistory: RescheduleRecord[];
  createdAt: string;
  updatedAt: string;
  outcomeAt: string | null;
};

type Closure = {
  closureId: string;
  resourceId: string | null;
  startTime: string;
  endTime: string;
  label: string;
  active: boolean;
  createdAt: string;
  removedAt: string | null;
};

type Selection = {
  serviceIds: string[];
  services: DayService[];
  serviceMinutes: number;
  cleanupMinutes: number;
  occupiedMinutes: number;
  priceYen: number | null;
};

const failure = (code: DayFailureCode): DayFailure => ({
  ok: false,
  code,
});

const rescheduleCommandFailure = (code: string): DayFailure => {
  if (code === "OVERLAP") return failure("UNAVAILABLE");
  if (code === "NO_CHANGE") return failure("BAD_REQUEST");
  if (code === "RESERVATION_NOT_FOUND" || code === "RESERVATION_NOT_ACTIVE") {
    return failure("NOT_FOUND_OR_UNAUTHORIZED");
  }
  return failure("TEMPORARILY_UNAVAILABLE");
};

const isOwnerTransitionFailure = (
  value:
    | DayFailure
    | {
        nextState: ReservationState;
        status: BookingStatus;
        rejectionReason: string | null;
        outcomeAt: string | null;
        history: BookingDetail["rescheduleHistory"];
      },
): value is DayFailure => Object.hasOwn(value, "ok");

const calendarEventStatus = (
  status: string,
): "pending" | "approved" | null => {
  if (status === "pending") return "pending";
  if (status === "approved" || status === "completed" || status === "no_show") {
    return "approved";
  }
  return null;
};

const movingAvailability = (
  movingReservation: { id: string } | undefined,
  movingDetail: { snapshot: BookingSnapshot | null; status: string } | null,
  serviceIds: string[] | undefined,
  meta: { acceptedMutations?: number } | null,
): DayFailure | null => {
  if (movingReservation === undefined || movingDetail === null) {
    return failure("NOT_FOUND_OR_UNAUTHORIZED");
  }
  if (
    movingDetail.snapshot === null ||
    (movingDetail.status !== "pending" && movingDetail.status !== "approved")
  ) {
    return failure("NOT_FOUND_OR_UNAUTHORIZED");
  }
  const snapshotServiceIds = movingDetail.snapshot.services.map(({ id }) => id);
  if (
    serviceIds?.length !== snapshotServiceIds.length ||
    serviceIds.some((id) => !snapshotServiceIds.includes(id))
  ) {
    return failure("BAD_REQUEST");
  }
  if ((meta?.acceptedMutations ?? 0) >= MAX_ACCEPTED_MUTATIONS) {
    return failure("CAPACITY_REACHED");
  }
  return null;
};

const isCanonicalDate = (value: string): boolean => {
  if (!DATE.test(value)) return false;
  const milliseconds = Date.parse(`${value}T00:00:00.000Z`);
  return (
    Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString().slice(0, 10) === value
  );
};

const isCanonicalTimestamp = (value: unknown): value is string => {
  if (typeof value !== "string" || !TIMESTAMP.test(value)) return false;
  const milliseconds = Date.parse(value);
  return (
    Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value
  );
};

const hasExactKeys = (
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

const minutes = (value: string): number => {
  const [hours = 0, minute = 0] = value.split(":").map(Number);
  return hours * 60 + minute;
};

const overlaps = (
  leftStart: number,
  leftEnd: number,
  rightStart: number,
  rightEnd: number,
): boolean => leftStart < rightEnd && rightStart < leftEnd;

const boundedText = (value: string, minimum: number, maximum: number): boolean =>
  value === value.trim() &&
  !CONTROL.test(value) &&
  [...value].length >= minimum &&
  [...value].length <= maximum;

const hasTargetField = (config: DayConfig): boolean =>
  [
    "settingsVersion",
    "resources",
    "services",
    "opensAt",
    "closesAt",
    "startIntervalMinutes",
    "consentVersion",
  ].some((key) => Object.hasOwn(config, key));

const isResource = (value: DayResource): boolean =>
  ID.test(value.id) && boundedText(value.label, 1, 80) && typeof value.active === "boolean";

const isService = (value: DayService, resourceIds: Set<string>): boolean =>
  ID.test(value.id) &&
  boundedText(value.label, 1, 80) &&
  (value.category === null || boundedText(value.category, 1, 60)) &&
  Number.isSafeInteger(value.durationMinutes) &&
  value.durationMinutes >= 15 &&
  value.durationMinutes <= 480 &&
  Number.isSafeInteger(value.cleanupMinutes) &&
  value.cleanupMinutes >= 0 &&
  value.cleanupMinutes <= 120 &&
  (value.priceYen === null ||
    (Number.isSafeInteger(value.priceYen) && value.priceYen >= 0 && value.priceYen <= 10_000_000)) &&
  value.eligibleResourceIds.length >= 1 &&
  value.eligibleResourceIds.length <= 8 &&
  new Set(value.eligibleResourceIds).size === value.eligibleResourceIds.length &&
  value.eligibleResourceIds.every((id) => resourceIds.has(id)) &&
  typeof value.active === "boolean";

const isTargetDayConfig = (config: DayConfig): config is TargetDayConfig => {
  if (
    config.settingsVersion === undefined ||
    config.resources === undefined ||
    config.services === undefined ||
    config.opensAt === undefined ||
    config.closesAt === undefined ||
    config.startIntervalMinutes === undefined ||
    config.consentVersion === undefined
  ) {
    return false;
  }
  if (
    !Number.isSafeInteger(config.settingsVersion) ||
    config.settingsVersion < 1 ||
    config.resources.length < 1 ||
    config.resources.length > 8 ||
    !config.resources.every(isResource) ||
    new Set(config.resources.map(({ id }) => id)).size !== config.resources.length ||
    config.services.length < 1 ||
    config.services.length > 16 ||
    !TIME.test(config.opensAt) ||
    !TIME.test(config.closesAt) ||
    minutes(config.opensAt) >= minutes(config.closesAt) ||
    !Number.isSafeInteger(config.startIntervalMinutes) ||
    config.startIntervalMinutes < 15 ||
    config.startIntervalMinutes > 240 ||
    !ID.test(config.consentVersion)
  ) {
    return false;
  }
  const resources = config.resources;
  const services = config.services;
  const resourceIds = new Set(resources.map(({ id }) => id));
  return (
    services.every((service) => isService(service, resourceIds)) &&
    new Set(services.map(({ id }) => id)).size === services.length &&
    config.resourceIds.length === resources.filter(({ active }) => active).length &&
    config.resourceIds.every((id) =>
      resources.some((resource) => resource.active && resource.id === id),
    )
  );
};

const isAdapterDescriptor = (
  value: DayAdapterDescriptor | undefined,
  consumer: DayAdapterDescriptor["consumer"],
): boolean =>
  value === undefined ||
  (typeof value === "object" &&
    value !== null &&
    value.consumer === consumer &&
    Number.isSafeInteger(value.generation) &&
    value.generation >= 1 &&
    (value.phase === "active" || value.phase === "deactivating") &&
    Number.isSafeInteger(value.leaseIssuedAt) &&
    value.leaseIssuedAt > 0 &&
    Number.isSafeInteger(value.leaseNotAfter) &&
    value.leaseNotAfter > value.leaseIssuedAt &&
    value.leaseNotAfter - value.leaseIssuedAt <= ADAPTER.DESCRIPTOR_LEASE_WINDOW_S * 1_000);

const isCalendarRecovery = (value: DayConfig["calendarRecovery"]): boolean =>
  value === undefined ||
  (typeof value === "object" &&
    value !== null &&
    Number.isSafeInteger(value.leaseIssuedAt) &&
    value.leaseIssuedAt > 0 &&
    Number.isSafeInteger(value.leaseNotAfter) &&
    value.leaseNotAfter > value.leaseIssuedAt &&
    value.leaseNotAfter - value.leaseIssuedAt <= ADAPTER.DESCRIPTOR_LEASE_WINDOW_S * 1_000);

const isDayConfig = (config: DayConfig): boolean => {
  const base =
    typeof config === "object" &&
    config !== null &&
    isCanonicalDate(config.date) &&
    config.resourceIds.length >= 1 &&
    config.resourceIds.length <= 8 &&
    config.resourceIds.every((value) => ID.test(value)) &&
    new Set(config.resourceIds).size === config.resourceIds.length &&
    config.startTimes.length >= 1 &&
    config.startTimes.every((value) => TIME.test(value)) &&
    new Set(config.startTimes).size === config.startTimes.length &&
    config.resourceIds.length * config.startTimes.length <= 96 &&
    Number.isSafeInteger(config.slotMinutes) &&
    config.slotMinutes >= 15 &&
    config.slotMinutes <= 600 &&
    Number.isSafeInteger(config.purgeAt) &&
    config.purgeAt > 0 &&
    (config.pendingExpiryMinutes === undefined ||
      (Number.isSafeInteger(config.pendingExpiryMinutes) &&
        config.pendingExpiryMinutes >= 15 &&
        config.pendingExpiryMinutes <= 10080)) &&
    isCalendarRecovery(config.calendarRecovery) &&
    !(config.calendarRecovery !== undefined && config.calendarAdapter !== undefined) &&
    isAdapterDescriptor(config.adapter, "line") &&
    isAdapterDescriptor(config.calendarAdapter, "calendar");
  if (!base) return false;
  if (!hasTargetField(config)) return true;
  return isTargetDayConfig(config);
};

const scheduleJson = (config: DayConfig): string => {
  const base = {
    date: config.date,
    resourceIds: config.resourceIds,
    startTimes: config.startTimes,
    slotMinutes: config.slotMinutes,
    purgeAt: config.purgeAt,
  };
  if (!isTargetDayConfig(config)) return JSON.stringify(base);
  return JSON.stringify({
    ...base,
    settingsVersion: config.settingsVersion,
    resources: config.resources,
    services: config.services,
    opensAt: config.opensAt,
    closesAt: config.closesAt,
    startIntervalMinutes: config.startIntervalMinutes,
    consentVersion: config.consentVersion,
  });
};

const parseStoredConfig = (value: string): DayConfig => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("corrupt schedule JSON");
  }
  if (typeof parsed !== "object" || parsed === null || !isDayConfig(parsed as DayConfig)) {
    throw new Error("invalid schedule JSON");
  }
  const config = parsed as DayConfig;
  if (scheduleJson(config) !== value) throw new Error("non-canonical schedule JSON");
  return config;
};

const isCreateInput = (config: DayConfig, input: DayCreateInput): boolean =>
  UUID.test(input.commandId) &&
  input.date === config.date &&
  ID.test(input.resourceId) &&
  TIME.test(input.startTime) &&
  boundedText(input.customerName, 1, 80) &&
  boundedText(input.contact, 3, 200) &&
  DIGEST.test(input.managementDigest) &&
  (input.settingsVersion === undefined ||
    (Number.isSafeInteger(input.settingsVersion) && input.settingsVersion >= 1)) &&
  (input.serviceIds === undefined ||
    (input.serviceIds.length >= 1 &&
      input.serviceIds.length <= 4 &&
      input.serviceIds.every((id) => ID.test(id)) &&
      new Set(input.serviceIds).size === input.serviceIds.length)) &&
  (input.consentVersion === undefined || ID.test(input.consentVersion));

const isPublicStatusInput = (
  config: DayConfig,
  input: unknown,
): input is DayPublicStatusInput => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return false;
  }
  const value = input as Record<string, unknown>;
  return (
    Object.keys(value).length === 3 &&
    Object.hasOwn(value, "date") &&
    Object.hasOwn(value, "reservationId") &&
    Object.hasOwn(value, "managementKey") &&
    typeof value.date === "string" &&
    value.date === config.date &&
    isCanonicalDate(value.date) &&
    typeof value.reservationId === "string" &&
    UUID.test(value.reservationId) &&
    typeof value.managementKey === "string" &&
    MANAGEMENT_KEY.test(value.managementKey)
  );
};

const selectServices = (
  config: TargetDayConfig,
  serviceIds: string[] | undefined,
): Selection | null => {
  if (
    serviceIds === undefined ||
    serviceIds.length < 1 ||
    serviceIds.length > 4 ||
    new Set(serviceIds).size !== serviceIds.length
  ) {
    return null;
  }
  const services = serviceIds.map((id) =>
    config.services.find((service) => service.active && service.id === id),
  );
  if (services.includes(undefined)) return null;
  const selected = services as DayService[];
  const serviceMinutes = selected.reduce(
    (total, service) => total + service.durationMinutes,
    0,
  );
  const cleanupMinutes = selected.reduce(
    (total, service) => total + service.cleanupMinutes,
    0,
  );
  return {
    serviceIds: [...serviceIds],
    services: selected,
    serviceMinutes,
    cleanupMinutes,
    occupiedMinutes: serviceMinutes + cleanupMinutes,
    priceYen: selected.some(({ priceYen }) => priceYen === null)
      ? null
      : selected.reduce((total, service) => total + (service.priceYen ?? 0), 0),
  };
};

const resourceEligible = (
  config: TargetDayConfig,
  selection: Selection,
  resourceId: string,
): boolean =>
  config.resources.some(
    (resource) => resource.active && resource.id === resourceId,
  ) &&
  selection.services.every((service) =>
    service.eligibleResourceIds.includes(resourceId),
  );

const validStart = (
  config: TargetDayConfig,
  startTime: string,
  occupiedMinutes: number,
): boolean =>
  config.startTimes.includes(startTime) &&
  minutes(startTime) >= minutes(config.opensAt) &&
  minutes(startTime) + occupiedMinutes <= minutes(config.closesAt);

const bookingSnapshot = (
  config: TargetDayConfig,
  selection: Selection,
  resourceId: string,
  consentVersion: string,
): BookingSnapshot => {
  const resource = config.resources.find(({ id }) => id === resourceId);
  if (resource === undefined) throw new Error("missing resource");
  return {
    settingsVersion: config.settingsVersion,
    services: selection.services.map((service) => ({
      id: service.id,
      label: service.label,
      durationMinutes: service.durationMinutes,
      cleanupMinutes: service.cleanupMinutes,
      priceYen: service.priceYen,
    })),
    serviceMinutes: selection.serviceMinutes,
    cleanupMinutes: selection.cleanupMinutes,
    occupiedMinutes: selection.occupiedMinutes,
    priceYen: selection.priceYen,
    resourceId,
    resourceLabel: resource.label,
    consentVersion,
  };
};

const bookingServiceLabel = (snapshot: BookingSnapshot | null): string =>
  snapshot?.services.map(({ label }) => label).join("、") ?? "サービス情報なし";

const SNAPSHOT_SERVICE_KEYS = [
  "id",
  "label",
  "durationMinutes",
  "cleanupMinutes",
  "priceYen",
] as const;

const SNAPSHOT_KEYS = [
  "settingsVersion",
  "services",
  "serviceMinutes",
  "cleanupMinutes",
  "occupiedMinutes",
  "priceYen",
  "resourceId",
  "resourceLabel",
  "consentVersion",
] as const;

type SnapshotService = BookingSnapshot["services"][number];

// Mirrors the write-side bounds in isService for the frozen per-service copy that
// bookingSnapshot stores, so a corrupted snapshot cannot describe a service the
// configuration would never have accepted.
const isSnapshotService = (value: unknown): value is SnapshotService => {
  if (!hasExactKeys(value, SNAPSHOT_SERVICE_KEYS)) return false;
  return (
    typeof value.id === "string" &&
    ID.test(value.id) &&
    typeof value.label === "string" &&
    boundedText(value.label, 1, 80) &&
    Number.isSafeInteger(value.durationMinutes) &&
    (value.durationMinutes as number) >= 15 &&
    (value.durationMinutes as number) <= 480 &&
    Number.isSafeInteger(value.cleanupMinutes) &&
    (value.cleanupMinutes as number) >= 0 &&
    (value.cleanupMinutes as number) <= 120 &&
    (value.priceYen === null ||
      (Number.isSafeInteger(value.priceYen) &&
        (value.priceYen as number) >= 0 &&
        (value.priceYen as number) <= 10_000_000))
  );
};

const isBookingSnapshot = (value: unknown): value is BookingSnapshot => {
  if (!hasExactKeys(value, SNAPSHOT_KEYS)) return false;
  const snapshot = value;
  if (
    !Number.isSafeInteger(snapshot.settingsVersion) ||
    (snapshot.settingsVersion as number) < 1 ||
    !Array.isArray(snapshot.services) ||
    snapshot.services.length < 1 ||
    snapshot.services.length > 4 ||
    !snapshot.services.every(isSnapshotService) ||
    typeof snapshot.resourceId !== "string" ||
    !ID.test(snapshot.resourceId) ||
    typeof snapshot.resourceLabel !== "string" ||
    !boundedText(snapshot.resourceLabel, 1, 80) ||
    typeof snapshot.consentVersion !== "string" ||
    !ID.test(snapshot.consentVersion)
  ) {
    return false;
  }
  const services = snapshot.services as SnapshotService[];
  const serviceMinutes = services.reduce(
    (total, service) => total + service.durationMinutes,
    0,
  );
  const cleanupMinutes = services.reduce(
    (total, service) => total + service.cleanupMinutes,
    0,
  );
  const priceYen = services.some((service) => service.priceYen === null)
    ? null
    : services.reduce((total, service) => total + (service.priceYen ?? 0), 0);
  return (
    snapshot.serviceMinutes === serviceMinutes &&
    snapshot.cleanupMinutes === cleanupMinutes &&
    snapshot.occupiedMinutes === serviceMinutes + cleanupMinutes &&
    snapshot.priceYen === priceYen
  );
};

const RESCHEDULE_POINT_KEYS = ["resourceId", "startTime"] as const;
const RESCHEDULE_RECORD_KEYS = ["from", "to"] as const;

const isReschedulePoint = (value: unknown): boolean =>
  hasExactKeys(value, RESCHEDULE_POINT_KEYS) &&
  typeof value.resourceId === "string" &&
  ID.test(value.resourceId) &&
  typeof value.startTime === "string" &&
  TIME.test(value.startTime);

const isRescheduleRecord = (value: unknown): value is RescheduleRecord =>
  hasExactKeys(value, RESCHEDULE_RECORD_KEYS) &&
  isReschedulePoint(value.from) &&
  isReschedulePoint(value.to);

const sha256Hex = async (value: string): Promise<string> => {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

const equalDigest = (left: string, right: string): boolean => {
  if (!DIGEST.test(left) || !DIGEST.test(right)) return false;
  let difference = 0;
  for (let index = 0; index < 64; index += 1) {
    difference |= (left.codePointAt(index) ?? 0) ^ (right.codePointAt(index) ?? 0);
  }
  return difference === 0;
};

const jstTime = (iso: string): string =>
  new Date(Date.parse(iso) + JST_OFFSET_MS).toISOString().slice(11, 16);

const isElapsedStart = (date: string, startTime: string): boolean => {
  const now = new Date(Date.now() + JST_OFFSET_MS).toISOString();
  const today = now.slice(0, 10);
  return date < today || (date === today && startTime <= now.slice(11, 16));
};

// A pending booking expires this long after it was created. The deadline is
// derived rather than stored: booking_details is created with
// CREATE TABLE IF NOT EXISTS, so a new column would never reach a Durable
// Object that already exists, and the snapshot is validated against an exact
// key list. Deriving it also gives the setting the behaviour an operator
// expects — shortening the lifetime moves the deadline of bookings that are
// still pending, rather than only applying to future ones.
const pendingDeadline = (config: DayConfig, createdAt: string): number | null =>
  config.pendingExpiryMinutes === undefined
    ? null
    : Date.parse(createdAt) + config.pendingExpiryMinutes * 60_000;

// Only ever called after the sweep, so a booking still pending here has a
// deadline in the future.
const expiresAt = (config: DayConfig, detail: BookingDetail): string | null => {
  const deadline =
    detail.status === "pending" ? pendingDeadline(config, detail.createdAt) : null;
  return deadline === null ? null : new Date(deadline).toISOString();
};

const isStoredSuccess = (value: unknown): value is StoredSuccess => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.ok !== true || typeof candidate.replayed !== "boolean") return false;
  if (typeof candidate.reservationId === "string") {
    return (
      UUID.test(candidate.reservationId) &&
      typeof candidate.date === "string" &&
      isCanonicalDate(candidate.date) &&
      typeof candidate.resourceId === "string" &&
      ID.test(candidate.resourceId) &&
      (candidate.resourceLabel === undefined ||
        (typeof candidate.resourceLabel === "string" &&
          boundedText(candidate.resourceLabel, 1, 80))) &&
      typeof candidate.startTime === "string" &&
      TIME.test(candidate.startTime) &&
      [
        "active",
        "pending",
        "approved",
        "rejected",
        "cancelled",
        "completed",
        "expired",
        "no_show",
      ].includes(candidate.status as string) &&
      (candidate.rejectionReason === undefined ||
        candidate.rejectionReason === null ||
        (typeof candidate.rejectionReason === "string" &&
          boundedText(candidate.rejectionReason, 1, 200))) &&
      (candidate.outcomeAt === undefined ||
        candidate.outcomeAt === null ||
        isCanonicalTimestamp(candidate.outcomeAt)) &&
      (candidate.snapshot === undefined || isBookingSnapshot(candidate.snapshot))
    );
  }
  return (
    typeof candidate.closureId === "string" &&
    UUID.test(candidate.closureId) &&
    typeof candidate.date === "string" &&
    isCanonicalDate(candidate.date) &&
    (candidate.resourceId === null ||
      (typeof candidate.resourceId === "string" && ID.test(candidate.resourceId))) &&
    typeof candidate.startTime === "string" &&
    TIME.test(candidate.startTime) &&
    typeof candidate.endTime === "string" &&
    TIME.test(candidate.endTime) &&
    typeof candidate.label === "string" &&
    boundedText(candidate.label, 1, 80) &&
    typeof candidate.active === "boolean"
  );
};

export class ReservationDay extends DurableObject<Env> {
  #hasSchema(): boolean {
    const tables = this.ctx.storage.sql
      .exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT GLOB '_cf_*' AND name NOT GLOB '__*' ORDER BY name",
      )
      .toArray()
      .map(({ name }) => name);
    if (tables.length === 0) return false;
    if (tables.join("\0") !== TABLES.join("\0")) {
      throw new Error("unexpected schema");
    }
    return true;
  }

  #ensureSchema(): void {
    if (this.#hasSchema()) return;
    const sql = this.ctx.storage.sql;
    this.ctx.storage.transactionSync(() => {
      sql.exec(`
      CREATE TABLE IF NOT EXISTS core_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        revision INTEGER NOT NULL CHECK (revision >= 0),
        state_json TEXT NOT NULL
      )
    `);
      sql.exec(`
      CREATE TABLE IF NOT EXISTS booking_details (
        reservation_id TEXT PRIMARY KEY,
        customer_name TEXT NOT NULL,
        contact TEXT NOT NULL,
        management_digest TEXT NOT NULL,
        status TEXT NOT NULL,
        rejection_reason TEXT,
        snapshot_json TEXT,
        reschedule_history_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        outcome_at TEXT
      )
    `);
      sql.exec(`
      CREATE TABLE IF NOT EXISTS adapter_receipts (
        command_id TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL,
        response_json TEXT NOT NULL,
        reservation_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);
      sql.exec(`
      CREATE TABLE IF NOT EXISTS closures (
        closure_id TEXT PRIMARY KEY,
        resource_id TEXT,
        start_time TEXT NOT NULL,
        end_time TEXT NOT NULL,
        label TEXT NOT NULL,
        active INTEGER NOT NULL CHECK (active IN (0, 1)),
        created_at TEXT NOT NULL,
        removed_at TEXT
      )
    `);
      sql.exec(`
      CREATE TABLE IF NOT EXISTS partition_meta (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        date TEXT NOT NULL,
        schedule_json TEXT NOT NULL,
        accepted_creates INTEGER NOT NULL CHECK (accepted_creates BETWEEN 0 AND ${MAX_ACCEPTED_CREATES}),
        accepted_mutations INTEGER NOT NULL CHECK (accepted_mutations BETWEEN 0 AND ${MAX_ACCEPTED_MUTATIONS}),
        purge_at INTEGER NOT NULL
      )
      `);
    });
  }

  // ---- Adapter outbox (decision records: specs/003-line-adapter/plan.md) ----
  // Everything below lives in `__`-prefixed tables, which every legacy schema
  // check excludes (`NOT GLOB '__*'` above), so a pre-adapter Worker reads this
  // storage exactly as before. The day alarm stays a plain deleteAll: the
  // outbox dies with its day, and the delivery object's terminal lead
  // guarantees events are resolved long before purge.

  #adapterOutboxExists(): boolean {
    return (
      this.ctx.storage.sql
        .exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = '__adapter_outbox'",
        )
        .toArray().length > 0
    );
  }

  #calendarWatermark(config: DayConfig): { generation: number; seq: number } {
    const generation = config.calendarAdapter?.generation ?? 0;
    if (generation === 0 || !this.#adapterOutboxExists()) return { generation, seq: 0 };
    const seq = this.ctx.storage.sql
      .exec<{ event_seq: number | null }>(
        "SELECT MAX(event_seq) AS event_seq FROM __adapter_meta WHERE consumer = 'calendar'",
      )
      .one().event_seq;
    return { generation, seq: seq ?? 0 };
  }

  // Called only inside an already-open storage transaction. Event commits
  // create/upgrade the schema; drains upgrade a released outbox before reading.
  #ensureAdapterSchema(): void {
    const sql = this.ctx.storage.sql;
    sql.exec(`
      CREATE TABLE IF NOT EXISTS __adapter_meta (
        consumer TEXT NOT NULL,
        generation INTEGER NOT NULL,
        event_seq INTEGER NOT NULL CHECK (event_seq >= 0),
        PRIMARY KEY (consumer, generation)
      )
    `);
    sql.exec(`
      CREATE TABLE IF NOT EXISTS __adapter_outbox (
        consumer TEXT NOT NULL,
        generation INTEGER NOT NULL,
        seq INTEGER NOT NULL,
        event_id TEXT NOT NULL,
        reservation_id TEXT NOT NULL,
        type TEXT NOT NULL,
        start_time TEXT NOT NULL,
        end_time TEXT,
        service_label TEXT NOT NULL,
        reservation_status TEXT,
        occurred_at TEXT NOT NULL,
        purge_at INTEGER NOT NULL,
        PRIMARY KEY (consumer, generation, seq)
      )
    `);
    const columns = new Set(
      sql
        .exec<{ name: string }>("PRAGMA table_info('__adapter_outbox')")
        .toArray()
        .map(({ name }) => name),
    );
    if (!columns.has("end_time")) {
      sql.exec("ALTER TABLE __adapter_outbox ADD COLUMN end_time TEXT");
    }
    if (!columns.has("reservation_status")) {
      sql.exec("ALTER TABLE __adapter_outbox ADD COLUMN reservation_status TEXT");
    }
  }

  // Records committed reservation changes for the adapter, atomically with the
  // commit itself. No adapter configured → no-op. Deactivating → no new events
  // (disable is an explicit stop; the sweep drains what already exists).
  // An expired LINE lease preserves the released retry contract. Calendar is
  // optional: a stale or unavailable lease writes generation 0 only inside
  // the bounded final-pass window; later commits omit the optional event.
  #emitAdapterEvents(
    config: DayConfig,
    events: Array<{
      type: AdapterEventType;
      reservationId: string;
      startTime: string;
      endTime: string;
      serviceLabel: string;
      reservationStatus: CalendarReservationStatus;
    }>,
  ): void {
    if (events.length === 0) return;
    const adapters = [
      config.adapter,
      config.calendarAdapter,
      config.calendarRecovery === undefined
        ? undefined
        : calendarRecoveryDescriptor(config.calendarRecovery),
    ].filter(
      (adapter): adapter is DayAdapterDescriptor => adapter !== undefined,
    );
    if (adapters.length === 0) return;
    // A partition's retention boundary is frozen on first write. A later
    // config snapshot may have a different retentionDays value, but events
    // from this partition must keep the boundary already stored with it.
    const purgeAt = this.#readMeta()?.purgeAt ?? config.purgeAt;
    const occurredAt = new Date().toISOString();
    for (const adapter of adapters) {
      this.#writeAdapterOutbox(config, adapter, events, purgeAt, occurredAt);
    }
  }

  #writeAdapterOutbox(
    config: DayConfig,
    adapter: DayAdapterDescriptor,
    events: Array<{
      type: AdapterEventType;
      reservationId: string;
      startTime: string;
      endTime: string;
      serviceLabel: string;
      reservationStatus: CalendarReservationStatus;
    }>,
    purgeAt: number,
    occurredAt: string,
  ): void {
    const accepted =
      adapter.consumer === "line" ? events.filter(({ type }) => type !== "create") : events;
    if (adapter.phase !== "active" || accepted.length === 0) return;
    let generation = adapter.generation;
    const now = Date.now();
    if (now > adapter.leaseNotAfter) {
      if (adapter.consumer === "line") throw new AdapterLeaseExpiredError();
      if (
        adapter.generation === 0 ||
        now >= adapter.leaseIssuedAt + ADAPTER.FINAL_PASS_LEASE_WAIT_S * 1_000
      ) {
        return;
      }
      generation = 0;
    }
    this.#ensureAdapterSchema();
    const sql = this.ctx.storage.sql;
    let seq =
      adapter.consumer === "calendar"
        ? (sql
            .exec<{ event_seq: number | null }>(
              "SELECT MAX(event_seq) AS event_seq FROM __adapter_meta WHERE consumer = 'calendar'",
            )
            .one().event_seq ?? 0)
        : (sql
            .exec<{ event_seq: number }>(
              "SELECT event_seq FROM __adapter_meta WHERE consumer = ? AND generation = ?",
              adapter.consumer,
              adapter.generation,
            )
            .toArray()[0]?.event_seq ?? 0);
    for (const event of accepted) {
      seq += 1;
      sql.exec(
        `INSERT INTO __adapter_outbox
             (consumer, generation, seq, event_id, reservation_id, type, start_time,
              end_time, service_label, reservation_status, occurred_at, purge_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        adapter.consumer,
        generation,
        seq,
        `${config.date}#${seq}`,
        event.reservationId,
        event.type,
        event.startTime,
        event.endTime,
        event.serviceLabel,
        event.reservationStatus,
        occurredAt,
        purgeAt,
      );
    }
    sql.exec(
      `INSERT INTO __adapter_meta (consumer, generation, event_seq) VALUES (?, ?, ?)
         ON CONFLICT(consumer, generation) DO UPDATE SET event_seq = excluded.event_seq`,
      adapter.consumer,
      generation,
      seq,
    );
  }

  // Post-commit handoff: wake the delivery object when this day holds outbox
  // rows. Fire-and-forget — the delivery object's sweep is the durable path,
  // this only shortens the common case. Also serves as the lazy re-poke on
  // next use after a died handoff.
  #adapterHandoff(config: DayConfig): void {
    if (
      config.adapter === undefined &&
      config.calendarAdapter === undefined &&
      config.calendarRecovery === undefined
    ) {
      return;
    }
    if (!this.#adapterOutboxExists()) return;
    for (const adapter of [
      config.adapter,
      config.calendarAdapter,
      config.calendarRecovery === undefined
        ? undefined
        : calendarRecoveryDescriptor(config.calendarRecovery),
    ]) {
      if (adapter === undefined) continue;
      try {
        const pending = this.ctx.storage.sql
          .exec<{ n: number }>(
            "SELECT COUNT(*) AS n FROM __adapter_outbox WHERE consumer = ?",
            adapter.consumer,
          )
          .toArray()[0]?.n;
        if (pending === undefined || pending === 0) continue;
        const namespace =
          adapter.consumer === "line" ? this.env.ADAPTER_DELIVERY : this.env.CALENDAR_ADAPTER;
        const stub = namespace.getByName("installation");
        this.ctx.waitUntil(
          Promise.resolve(stub.pokeDay({ date: config.date })).then(
            () => undefined,
            () => undefined,
          ),
        );
      } catch {
        // The consumer's sweep recovers anything a failed poke leaves behind.
      }
    }
  }

  // Pull protocol for the delivery object. Reads and deletes touch only the
  // `__`-prefixed adapter tables; on a day that never emitted an event these
  // return immediately and create no schema, storage, or alarm.
  async drainOutbox(input: DayDrainInput): Promise<DayDrainResult> {
    if (
      typeof input !== "object" ||
      input === null ||
      !["line", "calendar"].includes(input.consumer) ||
      (input.limit !== undefined &&
        (!Number.isSafeInteger(input.limit) || input.limit < 1))
    ) {
      throw new Error("bad drain input");
    }
    const limit = Math.min(input.limit ?? ADAPTER.OUTBOX_DRAIN_BATCH, ADAPTER.OUTBOX_DRAIN_BATCH);
    if (!this.#adapterOutboxExists()) return { events: [], more: false };
    this.ctx.storage.transactionSync(() => this.#ensureAdapterSchema());
    const rows = this.ctx.storage.sql
      .exec<{
        generation: number;
        seq: number;
        event_id: string;
        reservation_id: string;
        type: string;
        start_time: string;
        end_time: string | null;
        service_label: string;
        reservation_status: string | null;
        occurred_at: string;
        purge_at: number;
      }>(
        `SELECT generation, seq, event_id, reservation_id, type, start_time, end_time,
                service_label, reservation_status, occurred_at, purge_at
         FROM __adapter_outbox WHERE consumer = ?
         ORDER BY generation, seq LIMIT ?`,
        input.consumer,
        limit + 1,
      )
      .toArray();
    const more = rows.length > limit;
    const meta = this.ctx.storage.sql
      .exec<{ date: string }>("SELECT date FROM partition_meta WHERE singleton = 1")
      .toArray()[0];
    if (meta === undefined) return { events: [], more: false };
    const events: AdapterOutboxEvent[] = [];
    for (const row of rows.slice(0, limit)) {
      if (
        !Number.isSafeInteger(row.generation) ||
        (row.generation < 1 && !(input.consumer === "calendar" && row.generation === 0)) ||
        !Number.isSafeInteger(row.seq) ||
        row.seq < 1 ||
        row.event_id !== `${meta.date}#${row.seq}` ||
        !UUID.test(row.reservation_id) ||
        !["create", "approve", "reject", "reschedule", "cancel", "expire"].includes(row.type) ||
        !TIME.test(row.start_time) ||
        (row.end_time !== null && !TIME.test(row.end_time)) ||
        !boundedText(row.service_label, 1, 323) ||
        (row.reservation_status !== null &&
          !["pending", "approved", "rejected", "cancelled", "expired"].includes(
            row.reservation_status,
          )) ||
        (input.consumer === "calendar" &&
          (row.end_time === null || row.reservation_status === null)) ||
        (input.consumer === "line" && row.type === "create") ||
        !TIMESTAMP.test(row.occurred_at) ||
        !Number.isSafeInteger(row.purge_at)
      ) {
        throw new Error("corrupt outbox row");
      }
      events.push({
        eventId: row.event_id,
        seq: row.seq,
        generation: row.generation,
        type: row.type as AdapterEventType,
        reservationId: row.reservation_id,
        date: meta.date,
        startTime: row.start_time,
        endTime: row.end_time,
        serviceLabel: row.service_label,
        reservationStatus: row.reservation_status as CalendarReservationStatus | null,
        occurredAt: row.occurred_at,
        purgeAt: row.purge_at,
      });
    }
    return { events, more };
  }

  async ackOutbox(input: DayAckInput): Promise<{ ok: true }> {
    if (
      typeof input !== "object" ||
      input === null ||
      !["line", "calendar"].includes(input.consumer) ||
      !Array.isArray(input.events) ||
      input.events.length > ADAPTER.OUTBOX_DRAIN_BATCH ||
      !input.events.every(
        (event) =>
          typeof event === "object" &&
          event !== null &&
          Number.isSafeInteger(event.generation) &&
          (event.generation >= 1 ||
            (input.consumer === "calendar" && event.generation === 0)) &&
          typeof event.eventId === "string" &&
          /^\d{4}-\d{2}-\d{2}#\d{1,9}$/.test(event.eventId),
      )
    ) {
      throw new Error("bad ack input");
    }
    if (!this.#adapterOutboxExists() || input.events.length === 0) return { ok: true };
    this.ctx.storage.transactionSync(() => {
      for (const event of input.events) {
        this.ctx.storage.sql.exec(
          `DELETE FROM __adapter_outbox
           WHERE consumer = ? AND generation = ? AND event_id = ?`,
          input.consumer,
          event.generation,
          event.eventId,
        );
      }
    });
    return { ok: true };
  }

  /**
   * Disable-saga purge: remove one consumer's outbox rows, and drop the
   * adapter tables entirely when no consumer's rows remain — returning the day
   * to the exact pre-adapter storage shape. On a day that never emitted an
   * event this is a no-op that creates nothing.
   */
  async purgeConsumer(input: {
    consumer: "line" | "calendar";
    throughGeneration?: number;
  }): Promise<{
    ok: true;
    removed: number;
    dropped: boolean;
  }> {
    if (
      typeof input !== "object" ||
      input === null ||
      !["line", "calendar"].includes(input.consumer) ||
      (input.throughGeneration !== undefined &&
        (!Number.isSafeInteger(input.throughGeneration) || input.throughGeneration < 1))
    ) {
      throw new Error("bad purge input");
    }
    if (!this.#adapterOutboxExists()) return { ok: true, removed: 0, dropped: false };
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      const removed =
        input.throughGeneration === undefined
          ? sql.exec("DELETE FROM __adapter_outbox WHERE consumer = ?", input.consumer).rowsWritten
          : sql.exec(
              "DELETE FROM __adapter_outbox WHERE consumer = ? AND generation <= ?",
              input.consumer,
              input.throughGeneration,
            ).rowsWritten;
      if (input.throughGeneration === undefined) {
        sql.exec("DELETE FROM __adapter_meta WHERE consumer = ?", input.consumer);
      } else {
        sql.exec(
          "DELETE FROM __adapter_meta WHERE consumer = ? AND generation <= ?",
          input.consumer,
          input.throughGeneration,
        );
      }
      const remaining =
        sql
          .exec<{ n: number }>(
            `SELECT (SELECT COUNT(*) FROM __adapter_outbox) +
                    (SELECT COUNT(*) FROM __adapter_meta) AS n`,
          )
          .toArray()[0]?.n ?? 0;
      if (remaining > 0) return { ok: true as const, removed, dropped: false };
      sql.exec("DROP TABLE __adapter_outbox");
      sql.exec("DROP TABLE __adapter_meta");
      return { ok: true as const, removed, dropped: true };
    });
  }

  // Link finalization's watermark read: events at or below this sequence predate
  // the link and are never delivered retroactively.
  async readEventSequence(input: {
    consumer: string;
    generation: number;
  }): Promise<{ eventSeq: number }> {
    if (
      typeof input !== "object" ||
      input === null ||
      !ID.test(input.consumer) ||
      !Number.isSafeInteger(input.generation) ||
      input.generation < 1
    ) {
      throw new Error("bad sequence input");
    }
    if (!this.#adapterOutboxExists()) return { eventSeq: 0 };
    const row = this.ctx.storage.sql
      .exec<{ event_seq: number }>(
        "SELECT event_seq FROM __adapter_meta WHERE consumer = ? AND generation = ?",
        input.consumer,
        input.generation,
      )
      .toArray()[0];
    if (row !== undefined && !Number.isSafeInteger(row.event_seq)) {
      throw new Error("corrupt adapter meta");
    }
    return { eventSeq: row?.event_seq ?? 0 };
  }

  async #prepareStorage(config: DayConfig): Promise<void> {
    const hadSchema = this.#hasSchema();
    if (!hadSchema) await this.ctx.storage.setAlarm(config.purgeAt);
    this.#ensureSchema();
    if (hadSchema && this.#readMeta() === null) {
      await this.ctx.storage.setAlarm(config.purgeAt);
    }
  }

  #readMeta(): Meta | null {
    const rows = this.ctx.storage.sql
      .exec<{
        date: string;
        schedule_json: string;
        accepted_creates: number;
        accepted_mutations: number;
        purge_at: number;
      }>(
        `SELECT date, schedule_json, accepted_creates, accepted_mutations, purge_at
         FROM partition_meta WHERE singleton = 1`,
      )
      .toArray();
    if (rows.length === 0) return null;
    const row = rows[0];
    if (
      row === undefined ||
      typeof row.date !== "string" ||
      !isCanonicalDate(row.date) ||
      typeof row.schedule_json !== "string" ||
      !Number.isSafeInteger(row.accepted_creates) ||
      row.accepted_creates < 0 ||
      row.accepted_creates > MAX_ACCEPTED_CREATES ||
      !Number.isSafeInteger(row.accepted_mutations) ||
      row.accepted_mutations < 0 ||
      row.accepted_mutations > MAX_ACCEPTED_MUTATIONS ||
      !Number.isSafeInteger(row.purge_at) ||
      row.purge_at <= 0
    ) {
      throw new Error("corrupt meta");
    }
    return {
      date: row.date,
      scheduleJson: row.schedule_json,
      acceptedCreates: row.accepted_creates,
      acceptedMutations: row.accepted_mutations,
      purgeAt: row.purge_at,
    };
  }

  #effectiveConfig(
    config: DayConfig,
    meta: Meta | null,
    persistedState: boolean,
  ): DayConfig | DayFailure {
    if (meta === null) {
      return persistedState ? failure("TEMPORARILY_UNAVAILABLE") : config;
    }
    if (meta.date !== config.date) return failure("CONFIGURATION_CONFLICT");
    const stored = parseStoredConfig(meta.scheduleJson);
    // The date exists twice in partition_meta: as its own column and inside
    // schedule_json. #writeMeta writes both from one object and never rewrites
    // them, so a disagreement is corruption rather than a configuration change,
    // and the target-mode branch below would otherwise return the stored copy
    // without ever comparing it to the column this method just validated.
    if (stored.date !== meta.date) return failure("TEMPORARILY_UNAVAILABLE");
    if (isTargetDayConfig(stored) && isTargetDayConfig(config)) return stored;
    return meta.scheduleJson === scheduleJson(config)
      ? stored
      : failure("CONFIGURATION_CONFLICT");
  }

  #readState(): { state: ReservationState; persisted: boolean } {
    const rows = this.ctx.storage.sql
      .exec<{ revision: number; state_json: string }>(
        "SELECT revision, state_json FROM core_state WHERE singleton = 1",
      )
      .toArray();
    if (rows.length === 0) {
      return { state: createEmptyReservationState(), persisted: false };
    }
    const row = rows[0];
    if (row === undefined || !Number.isSafeInteger(row.revision)) {
      throw new Error("corrupt state row");
    }
    let state: unknown;
    try {
      state = JSON.parse(row.state_json);
    } catch {
      throw new Error("corrupt state JSON");
    }
    const probe = executeReservationCommand(state, {});
    if (
      probe.ok ||
      probe.error.code !== "INVALID_COMMAND" ||
      probe.state?.revision !== row.revision
    ) {
      throw new Error("invalid core state");
    }
    return { state: probe.state, persisted: true };
  }

  #readReceipt(
    commandId: string,
  ): { fingerprint: string; response: StoredSuccess } | null {
    const rows = this.ctx.storage.sql
      .exec<{ fingerprint: string; response_json: string }>(
        "SELECT fingerprint, response_json FROM adapter_receipts WHERE command_id = ?",
        commandId,
      )
      .toArray();
    if (rows.length === 0) return null;
    const row = rows[0];
    if (row === undefined || !DIGEST.test(row.fingerprint)) {
      throw new Error("corrupt adapter receipt");
    }
    let response: unknown;
    try {
      response = JSON.parse(row.response_json);
    } catch {
      throw new Error("corrupt adapter receipt JSON");
    }
    if (!isStoredSuccess(response)) throw new Error("invalid adapter receipt");
    return { fingerprint: row.fingerprint, response };
  }

  // Shared transactional prologue: replay the stored receipt for a command
  // (refusing a same-id retry whose payload fingerprint differs), then admit
  // a fresh command against the day's acceptance budget. Replay must stay
  // ahead of the budget check so an already-accepted command still replays
  // on a day whose budget is spent. Returns null when the handler may
  // proceed with a fresh command.
  #commandGate(
    commandId: string,
    fingerprint: string,
    kind: "reservation",
    meta: Meta | null,
    budget: "creates" | "mutations",
    allowFresh?: boolean,
  ): DayMutationResult | null;
  #commandGate(
    commandId: string,
    fingerprint: string,
    kind: "closure",
    meta: Meta | null,
    budget: "creates" | "mutations",
    allowFresh?: boolean,
  ): DayClosureResult | null;
  #commandGate(
    commandId: string,
    fingerprint: string,
    kind: "reservation" | "closure",
    meta: Meta | null,
    budget: "creates" | "mutations",
    allowFresh = true,
  ): DayMutationResult | DayClosureResult | null {
    const receipt = this.#readReceipt(commandId);
    if (receipt !== null) {
      if (kind === "reservation") {
        return receipt.fingerprint === fingerprint &&
          "reservationId" in receipt.response
          ? { ...receipt.response, replayed: true }
          : failure("IDEMPOTENCY_CONFLICT");
      }
      return receipt.fingerprint === fingerprint &&
        "closureId" in receipt.response
        ? { ...receipt.response, replayed: true }
        : failure("IDEMPOTENCY_CONFLICT");
    }
    if (!allowFresh) return failure("UNAVAILABLE");
    const spent =
      budget === "creates"
        ? meta?.acceptedCreates ?? 0
        : meta?.acceptedMutations ?? 0;
    const limit =
      budget === "creates" ? MAX_ACCEPTED_CREATES : MAX_ACCEPTED_MUTATIONS;
    return spent >= limit ? failure("CAPACITY_REACHED") : null;
  }

  #readDetail(reservationId: string): BookingDetail | null {
    const row = this.ctx.storage.sql
      .exec<{
        reservation_id: string;
        customer_name: string;
        contact: string;
        management_digest: string;
        status: string;
        rejection_reason: string | null;
        snapshot_json: string | null;
        reschedule_history_json: string;
        created_at: string;
        updated_at: string;
        outcome_at: string | null;
      }>(
        `SELECT reservation_id, customer_name, contact, management_digest, status,
                rejection_reason, snapshot_json, reschedule_history_json,
                created_at, updated_at, outcome_at
         FROM booking_details WHERE reservation_id = ?`,
        reservationId,
      )
      .toArray()[0];
    if (row === undefined) return null;
    const statuses: BookingStatus[] = [
      "active",
      "pending",
      "approved",
      "rejected",
      "cancelled",
      "completed",
      "expired",
      "no_show",
    ];
    if (
      !UUID.test(row.reservation_id) ||
      !boundedText(row.customer_name, 1, 80) ||
      !boundedText(row.contact, 3, 200) ||
      !DIGEST.test(row.management_digest) ||
      !statuses.includes(row.status as BookingStatus) ||
      (row.rejection_reason !== null &&
        !boundedText(row.rejection_reason, 1, 200)) ||
      !isCanonicalTimestamp(row.created_at) ||
      !isCanonicalTimestamp(row.updated_at) ||
      (row.outcome_at !== null && !isCanonicalTimestamp(row.outcome_at))
    ) {
      throw new Error("corrupt booking detail");
    }
    let snapshot: BookingSnapshot | null = null;
    let history: unknown;
    try {
      if (row.snapshot_json !== null) snapshot = JSON.parse(row.snapshot_json);
      history = JSON.parse(row.reschedule_history_json);
    } catch {
      throw new Error("corrupt booking JSON");
    }
    if (
      (snapshot !== null && !isBookingSnapshot(snapshot)) ||
      !Array.isArray(history) ||
      !history.every(isRescheduleRecord)
    ) {
      throw new Error("invalid booking JSON");
    }
    return {
      reservationId: row.reservation_id,
      customerName: row.customer_name,
      contact: row.contact,
      managementDigest: row.management_digest,
      status: row.status as BookingStatus,
      rejectionReason: row.rejection_reason,
      snapshot,
      rescheduleHistory: history as RescheduleRecord[],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      outcomeAt: row.outcome_at,
    };
  }

  #readAllDetails(): Map<string, BookingDetail> {
    const ids = this.ctx.storage.sql
      .exec<{ reservation_id: string }>(
        "SELECT reservation_id FROM booking_details",
      )
      .toArray();
    return new Map(
      ids.map(({ reservation_id }) => {
        const detail = this.#readDetail(reservation_id);
        if (detail === null) throw new Error("missing booking detail");
        return [reservation_id, detail] as const;
      }),
    );
  }

  #readClosures(): Closure[] {
    return this.ctx.storage.sql
      .exec<{
        closure_id: string;
        resource_id: string | null;
        start_time: string;
        end_time: string;
        label: string;
        active: number;
        created_at: string;
        removed_at: string | null;
      }>(
        `SELECT closure_id, resource_id, start_time, end_time, label,
                active, created_at, removed_at
         FROM closures ORDER BY start_time, closure_id`,
      )
      .toArray()
      .map((row) => {
        if (
          !UUID.test(row.closure_id) ||
          (row.resource_id !== null && !ID.test(row.resource_id)) ||
          !TIME.test(row.start_time) ||
          !TIME.test(row.end_time) ||
          minutes(row.start_time) >= minutes(row.end_time) ||
          !boundedText(row.label, 1, 80) ||
          (row.active !== 0 && row.active !== 1) ||
          !isCanonicalTimestamp(row.created_at) ||
          (row.removed_at !== null && !isCanonicalTimestamp(row.removed_at))
        ) {
          throw new Error("corrupt closure");
        }
        return {
          closureId: row.closure_id,
          resourceId: row.resource_id,
          startTime: row.start_time,
          endTime: row.end_time,
          label: row.label,
          active: row.active === 1,
          createdAt: row.created_at,
          removedAt: row.removed_at,
        };
      });
  }

  // Only the two columns the deadline needs, so the common case where nothing
  // is due costs one query and no row validation.
  #readPendingDeadlines(config: DayConfig): Array<{
    reservationId: string;
    deadline: number;
  }> {
    if (config.pendingExpiryMinutes === undefined) return [];
    return this.ctx.storage.sql
      .exec<{ reservation_id: string; created_at: string }>(
        "SELECT reservation_id, created_at FROM booking_details WHERE status = 'pending'",
      )
      .toArray()
      .map((row) => {
        const deadline =
          isCanonicalTimestamp(row.created_at) === true
            ? pendingDeadline(config, row.created_at)
            : null;
        if (!UUID.test(row.reservation_id) || deadline === null) {
          throw new Error("corrupt booking detail");
        }
        return { reservationId: row.reservation_id, deadline };
      });
  }

  // Expiry is applied when the object is next used rather than on a timer. A
  // Durable Object has exactly one alarm and it already carries the retention
  // purge, and every path that can observe or change a booking calls this
  // first, inside the same transaction it makes its decision in. A lazily
  // expired booking is therefore indistinguishable from an eagerly expired one
  // to anything outside the object, and an approve, reject or cancel that
  // arrives after the deadline loses to the expiry deterministically.
  #expire(config: DayConfig): void {
    const now = Date.now();
    const due = this.#readPendingDeadlines(config).filter(
      ({ deadline }) => deadline <= now,
    );
    if (due.length === 0) return;
    let { state } = this.#readState();
    const outcomeAt = new Date().toISOString();
    const expired: Array<{
      type: AdapterEventType;
      reservationId: string;
      startTime: string;
      endTime: string;
      serviceLabel: string;
      reservationStatus: CalendarReservationStatus;
    }> = [];
    for (const { reservationId } of due) {
      const detail = this.#readDetail(reservationId);
      if (detail?.status !== "pending") {
        throw new Error("missing expiring booking");
      }
      const reservation = state.reservations.find(({ id }) => id === reservationId);
      const cancelled = executeReservationCommand(state, {
        version: 1,
        commandId: crypto.randomUUID(),
        expectedRevision: state.revision,
        actor: {
          subject: "actor-system-expiry",
          capabilities: ["reservation:cancel"],
        },
        type: "reservation.cancel",
        payload: { reservationId },
      });
      // Releasing the interval in the kernel is the point: a status label on
      // its own would leak the capacity the abandoned booking is holding. A
      // pending booking whose kernel reservation is not active is corruption
      // rather than a race, because nothing can cancel one without writing
      // its detail row in the same transaction.
      if (!cancelled.ok || reservation === undefined) {
        throw new Error("expiring booking could not be released");
      }
      state = cancelled.state;
      this.#writeDetail({
        ...detail,
        status: "expired",
        rejectionReason: null,
        outcomeAt,
        updatedAt: outcomeAt,
      });
      expired.push({
        type: "expire",
        reservationId,
        startTime: jstTime(reservation.startAt),
        endTime: jstTime(reservation.endAt),
        serviceLabel: bookingServiceLabel(detail.snapshot),
        reservationStatus: "expired",
      });
    }
    this.#writeState(state);
    this.#emitAdapterEvents(config, expired);
  }

  #writeState(state: ReservationState): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO core_state (singleton, revision, state_json)
       VALUES (1, ?, ?)
       ON CONFLICT(singleton) DO UPDATE SET
         revision = excluded.revision,
         state_json = excluded.state_json`,
      state.revision,
      JSON.stringify(state),
    );
  }

  #writeMeta(
    config: DayConfig,
    meta: Meta | null,
    creates: number,
    mutations: number,
  ): void {
    if (meta === null) {
      this.ctx.storage.sql.exec(
        `INSERT INTO partition_meta
           (singleton, date, schedule_json, accepted_creates, accepted_mutations, purge_at)
         VALUES (1, ?, ?, ?, ?, ?)`,
        config.date,
        scheduleJson(config),
        creates,
        mutations,
        config.purgeAt,
      );
      return;
    }
    this.ctx.storage.sql.exec(
      `UPDATE partition_meta
       SET accepted_creates = ?, accepted_mutations = ?
       WHERE singleton = 1`,
      creates,
      mutations,
    );
  }

  #writeReceipt(
    commandId: string,
    fingerprint: string,
    response: StoredSuccess,
    operation: string,
    subjectId: string,
  ): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO adapter_receipts
         (command_id, fingerprint, response_json, reservation_id, operation, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      commandId,
      fingerprint,
      JSON.stringify(response),
      subjectId,
      operation,
      new Date().toISOString(),
    );
  }

  #writeDetail(detail: BookingDetail): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO booking_details
         (reservation_id, customer_name, contact, management_digest, status,
          rejection_reason, snapshot_json, reschedule_history_json,
          created_at, updated_at, outcome_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(reservation_id) DO UPDATE SET
         status = excluded.status,
         rejection_reason = excluded.rejection_reason,
         reschedule_history_json = excluded.reschedule_history_json,
         updated_at = excluded.updated_at,
         outcome_at = excluded.outcome_at`,
      detail.reservationId,
      detail.customerName,
      detail.contact,
      detail.managementDigest,
      detail.status,
      detail.rejectionReason,
      detail.snapshot === null ? null : JSON.stringify(detail.snapshot),
      JSON.stringify(detail.rescheduleHistory),
      detail.createdAt,
      detail.updatedAt,
      detail.outcomeAt,
    );
  }

  #closureOverlaps(
    closures: Closure[],
    resourceId: string,
    start: number,
    end: number,
  ): boolean {
    return closures.some(
      (closure) =>
        closure.active &&
        (closure.resourceId === null || closure.resourceId === resourceId) &&
        overlaps(
          start,
          end,
          minutes(closure.startTime),
          minutes(closure.endTime),
        ),
    );
  }

  async availability(
    config: DayConfig,
    serviceIds?: string[],
    reservationId?: string,
  ): Promise<DayAvailabilityResult> {
    if (
      !isDayConfig(config) ||
      (reservationId !== undefined && !UUID.test(reservationId))
    ) {
      return failure("CONFIGURATION_CONFLICT");
    }
    try {
      let meta: Meta | null = null;
      let state = createEmptyReservationState();
      let closures: Closure[] = [];
      let persisted = false;
      if (this.#hasSchema()) {
        this.ctx.storage.transactionSync(() => this.#expire(config));
        meta = this.#readMeta();
        ({ state, persisted } = this.#readState());
        closures = this.#readClosures();
      }
      const effective = this.#effectiveConfig(config, meta, persisted);
      if ("ok" in effective) return effective;
      const capacityReached = (meta?.acceptedCreates ?? 0) >= MAX_ACCEPTED_CREATES;
      const movingReservation = state.reservations.find(
        ({ id, status }) => status === "active" && id === reservationId,
      );
      const movingDetail = reservationId === undefined || meta === null
        ? null
        : this.#readDetail(reservationId);
      if (reservationId !== undefined) {
        const moving = movingAvailability(movingReservation, movingDetail, serviceIds, meta);
        if (moving !== null) return moving;
      }
      const availableStartTimes = effective.startTimes.filter(
        (startTime) => !isElapsedStart(effective.date, startTime),
      );
      if (!isTargetDayConfig(effective)) {
        const occupied = new Set(
          state.reservations
            .filter(
              ({ id, status }) => status === "active" && id !== reservationId,
            )
            .map(({ resourceId, startAt }) => `${resourceId}:${jstTime(startAt)}`),
        );
        return {
          ok: true,
          pinned: meta !== null,
          capacityReached,
          resources: effective.resourceIds.map((id) => ({
            id,
            startTimes: capacityReached && reservationId === undefined
              ? []
              : availableStartTimes.filter(
                  (time) =>
                    (movingReservation?.resourceId !== id ||
                      jstTime(movingReservation.startAt) !== time) &&
                    !occupied.has(`${id}:${time}`),
                ),
          })),
        };
      }

      const selection = selectServices(effective, serviceIds);
      if (selection === null) return failure("BAD_REQUEST");
      const resources = effective.resources.filter(
        ({ id, active }) => active && resourceEligible(effective, selection, id),
      );
      return {
        ok: true,
        pinned: meta !== null,
        capacityReached,
        settingsVersion: effective.settingsVersion,
        serviceIds: selection.serviceIds,
        services: selection.services.map((service) => ({
          id: service.id,
          label: service.label,
          durationMinutes: service.durationMinutes,
          cleanupMinutes: service.cleanupMinutes,
          priceYen: service.priceYen,
        })),
        serviceMinutes: selection.serviceMinutes,
        cleanupMinutes: selection.cleanupMinutes,
        occupiedMinutes: selection.occupiedMinutes,
        priceYen: selection.priceYen,
        resources: resources.map((resource) => ({
          id: resource.id,
          label: resource.label,
          startTimes: capacityReached && reservationId === undefined
            ? []
            : availableStartTimes.filter((startTime) => {
                if (!validStart(effective, startTime, selection.occupiedMinutes)) {
                  return false;
                }
                if (
                  movingReservation?.resourceId === resource.id &&
                  jstTime(movingReservation.startAt) === startTime
                ) {
                  return false;
                }
                const start = minutes(startTime);
                const end = start + selection.occupiedMinutes;
                const reservationOverlap = state.reservations.some(
                  (reservation) =>
                    reservation.status === "active" &&
                    reservation.id !== reservationId &&
                    reservation.resourceId === resource.id &&
                    overlaps(
                      start,
                      end,
                      minutes(jstTime(reservation.startAt)),
                      minutes(jstTime(reservation.endAt)),
                    ),
                );
                return (
                  !reservationOverlap &&
                  !this.#closureOverlaps(closures, resource.id, start, end)
                );
              }),
        })),
      };
    } catch (error) {
      if (error instanceof AdapterLeaseExpiredError) return failure("RETRY_CONFIG");
      return failure("TEMPORARILY_UNAVAILABLE");
    } finally {
      this.#adapterHandoff(config);
    }
  }

  #prepareCreate(
    effective: DayConfig,
    config: DayConfig,
    input: DayCreateInput,
    operation: "public-create" | "owner-create",
  ):
    | DayFailure
    | { durationMinutes: number; snapshot: BookingSnapshot | null; status: BookingStatus } {
    if (isTargetDayConfig(effective)) {
      if (
        !isTargetDayConfig(config) ||
        input.settingsVersion !== effective.settingsVersion ||
        input.consentVersion !== config.consentVersion
      ) {
        return failure("CONFIGURATION_CONFLICT");
      }
      const selection = selectServices(effective, input.serviceIds);
      if (
        selection === null ||
        !resourceEligible(effective, selection, input.resourceId) ||
        !validStart(effective, input.startTime, selection.occupiedMinutes)
      ) {
        return failure("UNAVAILABLE");
      }
      if (
        this.#closureOverlaps(
          this.#readClosures(),
          input.resourceId,
          minutes(input.startTime),
          minutes(input.startTime) + selection.occupiedMinutes,
        )
      ) {
        return failure("UNAVAILABLE");
      }
      return {
        durationMinutes: selection.occupiedMinutes,
        snapshot: bookingSnapshot(effective, selection, input.resourceId, input.consentVersion),
        status: operation === "public-create" ? "pending" : "approved",
      };
    }
    if (
      !effective.resourceIds.includes(input.resourceId) ||
      !effective.startTimes.includes(input.startTime)
    ) {
      return failure("UNAVAILABLE");
    }
    return { durationMinutes: effective.slotMinutes, snapshot: null, status: "active" };
  }

  async #create(
    config: DayConfig,
    input: DayCreateInput,
    operation: "public-create" | "owner-create",
    subject: "actor-public-customer" | "actor-owner",
    allowFresh: boolean,
  ): Promise<DayMutationResult> {
    if (!isDayConfig(config) || !isCreateInput(config, input)) {
      return failure("UNAVAILABLE");
    }
    const fingerprint = await sha256Hex(
      JSON.stringify([
        2,
        operation,
        input.commandId,
        input.date,
        input.settingsVersion ?? null,
        input.serviceIds ?? null,
        input.resourceId,
        input.startTime,
        input.customerName,
        input.contact,
        input.consentVersion ?? null,
        input.managementDigest,
      ]),
    );
    try {
      if (allowFresh) await this.#prepareStorage(config);
      else if (!this.#hasSchema()) return failure("UNAVAILABLE");
      return this.ctx.storage.transactionSync(() => {
        this.#expire(config);
        const meta = this.#readMeta();
        const { state, persisted } = this.#readState();
        const effective = this.#effectiveConfig(config, meta, persisted);
        if ("ok" in effective) return effective;

        const gate = this.#commandGate(
          input.commandId,
          fingerprint,
          "reservation",
          meta,
          "creates",
          allowFresh,
        );
        if (gate !== null) return gate;

        const preparedCreate = this.#prepareCreate(effective, config, input, operation);
        if ("ok" in preparedCreate) return preparedCreate;
        const { durationMinutes, snapshot, status } = preparedCreate;
        if (isElapsedStart(effective.date, input.startTime)) {
          return failure("UNAVAILABLE");
        }

        const reservationId = crypto.randomUUID();
        const result = executeReservationCommand(state, {
          version: 1,
          commandId: input.commandId,
          expectedRevision: state.revision,
          actor: { subject, capabilities: ["reservation:create"] },
          type: "reservation.create",
          payload: {
            reservationId,
            resourceId: input.resourceId,
            date: input.date,
            startTime: input.startTime,
            durationMinutes,
          },
        });
        if (!result.ok) {
          return result.error.code === "OVERLAP" ||
            result.error.code === "RESERVATION_ID_CONFLICT"
            ? failure("UNAVAILABLE")
            : failure("TEMPORARILY_UNAVAILABLE");
        }

        const response: DayMutationSuccess = {
          ok: true,
          reservationId,
          date: input.date,
          resourceId: input.resourceId,
          ...(snapshot === null ? {} : { resourceLabel: snapshot.resourceLabel }),
          startTime: input.startTime,
          status,
          replayed: false,
          ...(snapshot === null ? {} : { snapshot }),
        };
        const now = new Date().toISOString();
        this.#writeState(result.state);
        this.#writeDetail({
          reservationId,
          customerName: input.customerName,
          contact: input.contact,
          managementDigest: input.managementDigest,
          status,
          rejectionReason: null,
          snapshot,
          rescheduleHistory: [],
          createdAt: now,
          updatedAt: now,
          outcomeAt: null,
        });
        this.#writeReceipt(
          input.commandId,
          fingerprint,
          response,
          operation,
          reservationId,
        );
        this.#writeMeta(
          effective,
          meta,
          (meta?.acceptedCreates ?? 0) + 1,
          meta?.acceptedMutations ?? 0,
        );
        if (status === "pending" || status === "approved") {
          const reservation = result.state.reservations.find(({ id }) => id === reservationId);
          if (reservation === undefined) throw new Error("missing created reservation");
          this.#emitAdapterEvents(config, [
            {
              type: "create",
              reservationId,
              startTime: input.startTime,
              endTime: jstTime(reservation.endAt),
              serviceLabel: bookingServiceLabel(snapshot),
              reservationStatus: status,
            },
          ]);
        }
        return response;
      });
    } catch (error) {
      if (error instanceof AdapterLeaseExpiredError) return failure("RETRY_CONFIG");
      return failure("TEMPORARILY_UNAVAILABLE");
    } finally {
      this.#adapterHandoff(config);
    }
  }

  createPublic(
    config: DayConfig,
    input: DayCreateInput,
    allowFresh = true,
  ): Promise<DayMutationResult> {
    return this.#create(
      config,
      input,
      "public-create",
      "actor-public-customer",
      allowFresh,
    );
  }

  createOwner(
    config: DayConfig,
    input: DayCreateInput,
    allowFresh = true,
  ): Promise<DayMutationResult> {
    return this.#create(config, input, "owner-create", "actor-owner", allowFresh);
  }

  #applyOwnerTransitionAction(
    input: DayOwnerTransitionInput,
    state: ReservationState,
    reservation: { resourceId: string; startAt: string; endAt: string },
    detail: BookingDetail,
    effective: TargetDayConfig,
  ):
    | DayFailure
    | {
        nextState: ReservationState;
        status: BookingStatus;
        rejectionReason: string | null;
        outcomeAt: string | null;
        history: BookingDetail["rescheduleHistory"];
      } {
    let nextState = state;
    let status = detail.status;
    let rejectionReason = detail.rejectionReason;
    let outcomeAt = detail.outcomeAt;
    const history = [...detail.rescheduleHistory];
    if (input.action === "approve") {
      if (status !== "pending") return failure("NOT_FOUND_OR_UNAUTHORIZED");
      status = "approved";
    } else if (input.action === "reject" || input.action === "cancel") {
      if (
        (input.action === "reject" && status !== "pending") ||
        (input.action === "cancel" && status !== "pending" && status !== "approved")
      ) {
        return failure("NOT_FOUND_OR_UNAUTHORIZED");
      }
      const cancelled = executeReservationCommand(state, {
        version: 1,
        commandId: input.commandId,
        expectedRevision: state.revision,
        actor: {
          subject: "actor-owner",
          capabilities: ["reservation:cancel"],
        },
        type: "reservation.cancel",
        payload: { reservationId: input.reservationId },
      });
      if (!cancelled.ok) {
        return cancelled.error.code === "RESERVATION_NOT_FOUND" ||
          cancelled.error.code === "RESERVATION_NOT_ACTIVE"
          ? failure("NOT_FOUND_OR_UNAUTHORIZED")
          : failure("TEMPORARILY_UNAVAILABLE");
      }
      nextState = cancelled.state;
      status = input.action === "reject" ? "rejected" : "cancelled";
      rejectionReason = input.action === "reject" ? input.reason ?? null : null;
      outcomeAt = new Date().toISOString();
    } else if (input.action === "complete" || input.action === "no_show") {
      if (status !== "approved" || Date.parse(reservation.endAt) > Date.now()) {
        return failure("NOT_FOUND_OR_UNAUTHORIZED");
      }
      status = input.action === "complete" ? "completed" : "no_show";
      outcomeAt = new Date().toISOString();
    } else {
      if (status !== "pending" && status !== "approved") {
        return failure("NOT_FOUND_OR_UNAUTHORIZED");
      }
      if (detail.snapshot === null) return failure("NOT_FOUND_OR_UNAUTHORIZED");
      const selection = selectServices(
        effective,
        detail.snapshot.services.map(({ id }) => id),
      );
      if (
        selection === null ||
        input.resourceId === undefined ||
        input.startTime === undefined ||
        !resourceEligible(effective, selection, input.resourceId) ||
        !validStart(effective, input.startTime, detail.snapshot.occupiedMinutes) ||
        isElapsedStart(effective.date, input.startTime) ||
        this.#closureOverlaps(
          this.#readClosures(),
          input.resourceId,
          minutes(input.startTime),
          minutes(input.startTime) + detail.snapshot.occupiedMinutes,
        )
      ) {
        return failure("UNAVAILABLE");
      }
      const rescheduled = executeReservationCommand(state, {
        version: 1,
        commandId: input.commandId,
        expectedRevision: state.revision,
        actor: {
          subject: "actor-owner",
          capabilities: ["reservation:reschedule"],
        },
        type: "reservation.reschedule",
        payload: {
          reservationId: input.reservationId,
          resourceId: input.resourceId,
          date: input.date,
          startTime: input.startTime,
          durationMinutes: detail.snapshot.occupiedMinutes,
        },
      });
      if (!rescheduled.ok) return rescheduleCommandFailure(rescheduled.error.code);
      history.push({
        from: {
          resourceId: reservation.resourceId,
          startTime: jstTime(reservation.startAt),
        },
        to: { resourceId: input.resourceId, startTime: input.startTime },
      });
      nextState = rescheduled.state;
    }
    return { nextState, status, rejectionReason, outcomeAt, history };
  }

  async transitionOwner(
    config: DayConfig,
    input: DayOwnerTransitionInput,
  ): Promise<DayMutationResult> {
    if (
      !isDayConfig(config) ||
      !UUID.test(input.commandId) ||
      input.date !== config.date ||
      !UUID.test(input.reservationId) ||
      !["approve", "reject", "cancel", "complete", "no_show", "reschedule"].includes(
        input.action,
      ) ||
      (input.action === "reject" &&
        (input.reason === undefined || !boundedText(input.reason, 1, 200))) ||
      (input.action === "reschedule" &&
        (input.resourceId === undefined ||
          !ID.test(input.resourceId) ||
          input.startTime === undefined ||
          !TIME.test(input.startTime)))
    ) {
      return failure("BAD_REQUEST");
    }
    const fingerprint = await sha256Hex(
      JSON.stringify([
        2,
        "owner-transition",
        input.commandId,
        input.date,
        input.reservationId,
        input.action,
        input.reason ?? null,
        input.resourceId ?? null,
        input.startTime ?? null,
      ]),
    );
    try {
      if (!this.#hasSchema()) return failure("NOT_FOUND_OR_UNAUTHORIZED");
      return this.ctx.storage.transactionSync(() => {
        this.#expire(config);
        const meta = this.#readMeta();
        const { state, persisted } = this.#readState();
        const effective = this.#effectiveConfig(config, meta, persisted);
        if ("ok" in effective) return effective;
        if (!isTargetDayConfig(effective) || meta === null) {
          return failure("BAD_REQUEST");
        }

        const gate = this.#commandGate(
          input.commandId,
          fingerprint,
          "reservation",
          meta,
          "mutations",
        );
        if (gate !== null) return gate;

        const reservation = state.reservations.find(
          ({ id }) => id === input.reservationId,
        );
        const detail = this.#readDetail(input.reservationId);
        if (reservation === undefined || detail === null || detail.snapshot === null) {
          return failure("NOT_FOUND_OR_UNAUTHORIZED");
        }

        const applied = this.#applyOwnerTransitionAction(
          input,
          state,
          reservation,
          detail,
          effective,
        );
        if (isOwnerTransitionFailure(applied)) return applied;
        const { nextState, status, rejectionReason, outcomeAt, history } = applied;

        const current = nextState.reservations.find(
          ({ id }) => id === input.reservationId,
        );
        if (current === undefined) throw new Error("missing transitioned reservation");
        const currentResource = effective.resources.find(
          ({ id }) => id === current.resourceId,
        );
        if (currentResource === undefined) throw new Error("missing transitioned resource");
        const response: DayMutationSuccess = {
          ok: true,
          reservationId: input.reservationId,
          date: input.date,
          resourceId: current.resourceId,
          resourceLabel: currentResource.label,
          startTime: jstTime(current.startAt),
          status,
          replayed: false,
          snapshot: detail.snapshot,
          ...(rejectionReason === null ? {} : { rejectionReason }),
          ...(outcomeAt === null ? {} : { outcomeAt }),
        };
        if (nextState !== state) this.#writeState(nextState);
        this.#writeDetail({
          ...detail,
          status,
          rejectionReason,
          outcomeAt,
          rescheduleHistory: history,
          updatedAt: new Date().toISOString(),
        });
        this.#writeReceipt(
          input.commandId,
          fingerprint,
          response,
          `owner-${input.action}`,
          input.reservationId,
        );
        this.#writeMeta(
          effective,
          meta,
          meta.acceptedCreates,
          meta.acceptedMutations + 1,
        );
        if (input.action !== "complete" && input.action !== "no_show") {
          this.#emitAdapterEvents(config, [
            {
              type: input.action,
              reservationId: input.reservationId,
              startTime: response.startTime,
              endTime: jstTime(current.endAt),
              serviceLabel: bookingServiceLabel(detail.snapshot),
              reservationStatus: status as CalendarReservationStatus,
            },
          ]);
        }
        return response;
      });
    } catch (error) {
      if (error instanceof AdapterLeaseExpiredError) return failure("RETRY_CONFIG");
      return failure("TEMPORARILY_UNAVAILABLE");
    } finally {
      this.#adapterHandoff(config);
    }
  }

  async statusPublic(
    config: DayConfig,
    input: DayPublicStatusInput,
  ): Promise<DayPublicStatusResult> {
    if (!isDayConfig(config) || !isPublicStatusInput(config, input)) {
      return failure("NOT_FOUND_OR_UNAUTHORIZED");
    }
    const presentedDigest = await sha256Hex(input.managementKey);
    try {
      if (!this.#hasSchema()) return failure("NOT_FOUND_OR_UNAUTHORIZED");
      this.ctx.storage.transactionSync(() => this.#expire(config));
      const meta = this.#readMeta();
      const { state, persisted } = this.#readState();
      const effective = this.#effectiveConfig(config, meta, persisted);
      if ("ok" in effective) {
        return effective.code === "TEMPORARILY_UNAVAILABLE"
          ? effective
          : failure("NOT_FOUND_OR_UNAUTHORIZED");
      }
      if (meta === null || !isTargetDayConfig(effective)) {
        return failure("NOT_FOUND_OR_UNAUTHORIZED");
      }

      const reservation = state.reservations.find(
        ({ id }) => id === input.reservationId,
      );
      const detail = this.#readDetail(input.reservationId);
      const storedDigest = detail?.managementDigest ?? "0".repeat(64);
      const proofMatches = equalDigest(storedDigest, presentedDigest);
      if (reservation === undefined || detail === null || !proofMatches) {
        return failure("NOT_FOUND_OR_UNAUTHORIZED");
      }
      if (detail.snapshot === null || detail.status === "active") {
        return failure("TEMPORARILY_UNAVAILABLE");
      }
      const resource = effective.resources.find(
        ({ id }) => id === reservation.resourceId,
      );
      if (resource === undefined) return failure("TEMPORARILY_UNAVAILABLE");
      const deadline = expiresAt(config, detail);

      const coreShouldBeActive = ![
        "rejected",
        "cancelled",
        "expired",
      ].includes(detail.status);
      if ((reservation.status === "active") !== coreShouldBeActive) {
        return failure("TEMPORARILY_UNAVAILABLE");
      }
      return {
        ok: true,
        reservationId: reservation.id,
        date: effective.date,
        purgeAt: meta.purgeAt,
        startTime: jstTime(reservation.startAt),
        status: detail.status,
        resourceId: reservation.resourceId,
        resourceLabel: resource.label,
        snapshot: detail.snapshot,
        rejectionReason: detail.rejectionReason,
        outcomeAt: detail.outcomeAt,
        ...(deadline === null ? {} : { expiresAt: deadline }),
        allowedActions:
          detail.status === "pending" || detail.status === "approved"
            ? ["cancel"]
            : [],
      };
    } catch (error) {
      if (error instanceof AdapterLeaseExpiredError) return failure("RETRY_CONFIG");
      return failure("TEMPORARILY_UNAVAILABLE");
    } finally {
      this.#adapterHandoff(config);
    }
  }

  async #cancel(
    config: DayConfig,
    input: Omit<DayPublicCancelInput, "managementKey">,
    managementDigest: string,
  ): Promise<DayMutationResult> {
    if (
      !isDayConfig(config) ||
      !UUID.test(input.commandId) ||
      input.date !== config.date ||
      !UUID.test(input.reservationId)
    ) {
      return failure("NOT_FOUND_OR_UNAUTHORIZED");
    }
    const fingerprint = await sha256Hex(
      JSON.stringify([
        2,
        "public-cancel",
        input.commandId,
        input.date,
        input.reservationId,
        managementDigest,
      ]),
    );
    try {
      if (!this.#hasSchema()) return failure("NOT_FOUND_OR_UNAUTHORIZED");
      return this.ctx.storage.transactionSync(() => {
        this.#expire(config);
        const meta = this.#readMeta();
        const { state, persisted } = this.#readState();
        const effective = this.#effectiveConfig(config, meta, persisted);
        if ("ok" in effective) {
          return meta === null
            ? failure("NOT_FOUND_OR_UNAUTHORIZED")
            : effective;
        }
        if (meta === null) return failure("NOT_FOUND_OR_UNAUTHORIZED");

        const reservation = state.reservations.find(
          ({ id }) => id === input.reservationId,
        );
        const detail = this.#readDetail(input.reservationId);
        if (reservation === undefined || detail === null) {
          return failure("NOT_FOUND_OR_UNAUTHORIZED");
        }
        if (!equalDigest(detail.managementDigest, managementDigest)) {
          return failure("NOT_FOUND_OR_UNAUTHORIZED");
        }

        const gate = this.#commandGate(
          input.commandId,
          fingerprint,
          "reservation",
          meta,
          "mutations",
        );
        if (gate !== null) return gate;
        if (!["active", "pending", "approved"].includes(detail.status)) {
          return failure("NOT_FOUND_OR_UNAUTHORIZED");
        }

        const result = executeReservationCommand(state, {
          version: 1,
          commandId: input.commandId,
          expectedRevision: state.revision,
          actor: {
            subject: "actor-public-customer",
            capabilities: ["reservation:cancel"],
          },
          type: "reservation.cancel",
          payload: { reservationId: input.reservationId },
        });
        if (!result.ok) {
          return result.error.code === "RESERVATION_NOT_FOUND" ||
            result.error.code === "RESERVATION_NOT_ACTIVE"
            ? failure("NOT_FOUND_OR_UNAUTHORIZED")
            : failure("TEMPORARILY_UNAVAILABLE");
        }

        const currentResource = isTargetDayConfig(effective)
          ? effective.resources.find(({ id }) => id === reservation.resourceId)
          : undefined;
        if (isTargetDayConfig(effective) && currentResource === undefined) {
          throw new Error("missing cancelled resource");
        }
        const response: DayMutationSuccess = {
          ok: true,
          reservationId: reservation.id,
          date: input.date,
          resourceId: reservation.resourceId,
          ...(currentResource === undefined ? {} : { resourceLabel: currentResource.label }),
          startTime: jstTime(reservation.startAt),
          status: "cancelled",
          replayed: false,
          ...(detail.snapshot === null ? {} : { snapshot: detail.snapshot }),
        };
        this.#writeState(result.state);
        this.#writeDetail({
          ...detail,
          status: "cancelled",
          rejectionReason: null,
          outcomeAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        this.#writeReceipt(
          input.commandId,
          fingerprint,
          response,
          "public-cancel",
          input.reservationId,
        );
        this.#writeMeta(
          effective,
          meta,
          meta.acceptedCreates,
          meta.acceptedMutations + 1,
        );
        this.#emitAdapterEvents(config, [
          {
            type: "cancel",
            reservationId: reservation.id,
            startTime: response.startTime,
            endTime: jstTime(reservation.endAt),
            serviceLabel: bookingServiceLabel(detail.snapshot),
            reservationStatus: "cancelled",
          },
        ]);
        return response;
      });
    } catch (error) {
      if (error instanceof AdapterLeaseExpiredError) return failure("RETRY_CONFIG");
      return failure("TEMPORARILY_UNAVAILABLE");
    } finally {
      this.#adapterHandoff(config);
    }
  }

  async cancelPublic(
    config: DayConfig,
    input: DayPublicCancelInput,
  ): Promise<DayMutationResult> {
    if (!MANAGEMENT_KEY.test(input.managementKey)) {
      return failure("NOT_FOUND_OR_UNAUTHORIZED");
    }
    const managementDigest = await sha256Hex(input.managementKey);
    return this.#cancel(
      config,
      {
        commandId: input.commandId,
        date: input.date,
        reservationId: input.reservationId,
      },
      managementDigest,
    );
  }

  async createClosure(
    config: DayConfig,
    input: DayClosureCreateInput,
    allowFresh = true,
  ): Promise<DayClosureResult> {
    if (
      !isDayConfig(config) ||
      !isTargetDayConfig(config) ||
      !UUID.test(input.commandId) ||
      input.date !== config.date ||
      (input.resourceId !== null && !ID.test(input.resourceId)) ||
      !TIME.test(input.startTime) ||
      !TIME.test(input.endTime) ||
      minutes(input.startTime) >= minutes(input.endTime) ||
      !boundedText(input.label, 1, 80)
    ) {
      return failure("BAD_REQUEST");
    }
    const fingerprint = await sha256Hex(
      JSON.stringify([
        2,
        "closure-create",
        input.commandId,
        input.date,
        input.resourceId,
        input.startTime,
        input.endTime,
        input.label,
      ]),
    );
    try {
      if (allowFresh) await this.#prepareStorage(config);
      else if (!this.#hasSchema()) return failure("UNAVAILABLE");
      return this.ctx.storage.transactionSync(() => {
        this.#expire(config);
        const meta = this.#readMeta();
        const { state, persisted } = this.#readState();
        const effective = this.#effectiveConfig(config, meta, persisted);
        if ("ok" in effective) return effective;
        if (!isTargetDayConfig(effective)) return failure("BAD_REQUEST");

        if (
          (input.resourceId === null &&
            (input.startTime !== effective.opensAt ||
              input.endTime !== effective.closesAt)) ||
          (input.resourceId !== null &&
            (!effective.resources.some(
              ({ id, active }) => active && id === input.resourceId,
            ) ||
              minutes(input.startTime) < minutes(effective.opensAt) ||
              minutes(input.endTime) > minutes(effective.closesAt)))
        ) {
          return failure("BAD_REQUEST");
        }

        const gate = this.#commandGate(
          input.commandId,
          fingerprint,
          "closure",
          meta,
          "mutations",
          allowFresh,
        );
        if (gate !== null) return gate;
        const start = minutes(input.startTime);
        const end = minutes(input.endTime);
        if (
          state.reservations.some(
            (reservation) =>
              reservation.status === "active" &&
              (input.resourceId === null ||
                input.resourceId === reservation.resourceId) &&
              overlaps(
                start,
                end,
                minutes(jstTime(reservation.startAt)),
                minutes(jstTime(reservation.endAt)),
              ),
          )
        ) {
          return failure("UNAVAILABLE");
        }

        const closureId = crypto.randomUUID();
        const now = new Date().toISOString();
        const response: DayClosureSuccess = {
          ok: true,
          closureId,
          date: input.date,
          resourceId: input.resourceId,
          startTime: input.startTime,
          endTime: input.endTime,
          label: input.label,
          active: true,
          replayed: false,
        };
        this.ctx.storage.sql.exec(
          `INSERT INTO closures
             (closure_id, resource_id, start_time, end_time, label, active,
              created_at, removed_at)
           VALUES (?, ?, ?, ?, ?, 1, ?, NULL)`,
          closureId,
          input.resourceId,
          input.startTime,
          input.endTime,
          input.label,
          now,
        );
        this.#writeReceipt(
          input.commandId,
          fingerprint,
          response,
          "closure-create",
          closureId,
        );
        this.#writeMeta(
          effective,
          meta,
          meta?.acceptedCreates ?? 0,
          (meta?.acceptedMutations ?? 0) + 1,
        );
        return response;
      });
    } catch (error) {
      if (error instanceof AdapterLeaseExpiredError) return failure("RETRY_CONFIG");
      return failure("TEMPORARILY_UNAVAILABLE");
    } finally {
      this.#adapterHandoff(config);
    }
  }

  async removeClosure(
    config: DayConfig,
    input: DayClosureRemoveInput,
  ): Promise<DayClosureResult> {
    if (
      !isDayConfig(config) ||
      !UUID.test(input.commandId) ||
      input.date !== config.date ||
      !UUID.test(input.closureId)
    ) {
      return failure("BAD_REQUEST");
    }
    const fingerprint = await sha256Hex(
      JSON.stringify([
        2,
        "closure-remove",
        input.commandId,
        input.date,
        input.closureId,
      ]),
    );
    try {
      if (!this.#hasSchema()) return failure("NOT_FOUND_OR_UNAUTHORIZED");
      return this.ctx.storage.transactionSync(() => {
        this.#expire(config);
        const meta = this.#readMeta();
        const { persisted } = this.#readState();
        const effective = this.#effectiveConfig(config, meta, persisted);
        if ("ok" in effective) return effective;
        if (!isTargetDayConfig(effective) || meta === null) {
          return failure("NOT_FOUND_OR_UNAUTHORIZED");
        }
        const gate = this.#commandGate(
          input.commandId,
          fingerprint,
          "closure",
          meta,
          "mutations",
        );
        if (gate !== null) return gate;
        const closure = this.#readClosures().find(
          ({ closureId }) => closureId === input.closureId,
        );
        if (!closure?.active) {
          return failure("NOT_FOUND_OR_UNAUTHORIZED");
        }
        const response: DayClosureSuccess = {
          ok: true,
          closureId: closure.closureId,
          date: input.date,
          resourceId: closure.resourceId,
          startTime: closure.startTime,
          endTime: closure.endTime,
          label: closure.label,
          active: false,
          replayed: false,
        };
        this.ctx.storage.sql.exec(
          "UPDATE closures SET active = 0, removed_at = ? WHERE closure_id = ?",
          new Date().toISOString(),
          closure.closureId,
        );
        this.#writeReceipt(
          input.commandId,
          fingerprint,
          response,
          "closure-remove",
          closure.closureId,
        );
        this.#writeMeta(
          effective,
          meta,
          meta.acceptedCreates,
          meta.acceptedMutations + 1,
        );
        return response;
      });
    } catch (error) {
      if (error instanceof AdapterLeaseExpiredError) return failure("RETRY_CONFIG");
      return failure("TEMPORARILY_UNAVAILABLE");
    } finally {
      this.#adapterHandoff(config);
    }
  }

  async calendarProjection(config: DayConfig): Promise<DayCalendarProjectionResult> {
    if (!isDayConfig(config) || !isTargetDayConfig(config)) {
      return failure("CONFIGURATION_CONFLICT");
    }
    try {
      if (!this.#hasSchema()) {
        return {
          ok: true,
          date: config.date,
          purgeAt: config.purgeAt,
          watermark: this.#calendarWatermark(config),
          events: [],
        };
      }
      this.ctx.storage.transactionSync(() => this.#expire(config));
      const meta = this.#readMeta();
      const { state, persisted } = this.#readState();
      const effective = this.#effectiveConfig(config, meta, persisted);
      if ("ok" in effective) return effective;
      if (!isTargetDayConfig(effective)) return failure("CONFIGURATION_CONFLICT");
      if (meta === null) {
        return {
          ok: true,
          date: effective.date,
          purgeAt: config.purgeAt,
          watermark: this.#calendarWatermark(config),
          events: [],
        };
      }
      const details = this.#readAllDetails();
      const events = state.reservations
        .flatMap((reservation) => {
          const detail = details.get(reservation.id);
          if (detail === undefined) throw new Error("missing detail");
          const status = calendarEventStatus(detail.status);
          if (status === null || detail.snapshot === null) return [];
          return [
            {
              reservationId: reservation.id,
              stampAt: detail.createdAt,
              startTime: jstTime(reservation.startAt),
              endTime: jstTime(reservation.endAt),
              serviceLabel: bookingServiceLabel(detail.snapshot),
              status,
            },
          ];
        })
        .sort(
          (left, right) =>
            left.startTime.localeCompare(right.startTime) ||
            left.reservationId.localeCompare(right.reservationId),
        );
      return {
        ok: true,
        date: effective.date,
        purgeAt: meta.purgeAt,
        watermark: this.#calendarWatermark(config),
        events,
      };
    } catch (error) {
      if (error instanceof AdapterLeaseExpiredError) return failure("RETRY_CONFIG");
      return failure("TEMPORARILY_UNAVAILABLE");
    } finally {
      this.#adapterHandoff(config);
    }
  }

  async listOwner(config: DayConfig): Promise<DayOwnerListResult> {
    if (!isDayConfig(config)) return failure("CONFIGURATION_CONFLICT");
    try {
      if (!this.#hasSchema()) {
        return isTargetDayConfig(config)
          ? {
              ok: true,
              settingsVersion: config.settingsVersion,
              opensAt: config.opensAt,
              closesAt: config.closesAt,
              reservations: [],
              closures: [],
            }
          : { ok: true, reservations: [] };
      }
      this.ctx.storage.transactionSync(() => this.#expire(config));
      const meta = this.#readMeta();
      const { state, persisted } = this.#readState();
      const effective = this.#effectiveConfig(config, meta, persisted);
      if ("ok" in effective) return effective;
      if (meta === null) {
        return isTargetDayConfig(effective)
          ? {
              ok: true,
              settingsVersion: effective.settingsVersion,
              opensAt: effective.opensAt,
              closesAt: effective.closesAt,
              reservations: [],
              closures: [],
            }
          : { ok: true, reservations: [] };
      }

      const details = this.#readAllDetails();
      if (
        details.size !== state.reservations.length ||
        state.reservations.some(({ id }) => !details.has(id))
      ) {
        return failure("TEMPORARILY_UNAVAILABLE");
      }
      const target = isTargetDayConfig(effective);
      const reservations = state.reservations
        .map((reservation) => {
          const detail = details.get(reservation.id);
          if (detail === undefined) throw new Error("missing detail");
          const resource = target
            ? effective.resources.find(({ id }) => id === reservation.resourceId)
            : undefined;
          if (target && resource === undefined) throw new Error("missing resource");
          const deadline = expiresAt(config, detail);
          return {
            reservationId: reservation.id,
            resourceId: reservation.resourceId,
            ...(resource === undefined ? {} : { resourceLabel: resource.label }),
            startTime: jstTime(reservation.startAt),
            status: detail.status,
            customerName: detail.customerName,
            contact: detail.contact,
            ...(detail.snapshot === null ? {} : { snapshot: detail.snapshot }),
            ...(detail.rejectionReason === null
              ? {}
              : { rejectionReason: detail.rejectionReason }),
            ...(detail.outcomeAt === null ? {} : { outcomeAt: detail.outcomeAt }),
            ...(deadline === null ? {} : { expiresAt: deadline }),
            ...(detail.rescheduleHistory.length === 0
              ? {}
              : { rescheduleHistory: detail.rescheduleHistory }),
          };
        })
        .sort(
          (left, right) =>
            left.startTime.localeCompare(right.startTime) ||
            left.resourceId.localeCompare(right.resourceId) ||
            left.reservationId.localeCompare(right.reservationId),
        );
      if (!target) return { ok: true, reservations };
      return {
        ok: true,
        settingsVersion: effective.settingsVersion,
        opensAt: effective.opensAt,
        closesAt: effective.closesAt,
        reservations,
        closures: this.#readClosures().map((closure) => ({
          closureId: closure.closureId,
          resourceId: closure.resourceId,
          startTime: closure.startTime,
          endTime: closure.endTime,
          label: closure.label,
          active: closure.active,
        })),
      };
    } catch (error) {
      if (error instanceof AdapterLeaseExpiredError) return failure("RETRY_CONFIG");
      return failure("TEMPORARILY_UNAVAILABLE");
    } finally {
      this.#adapterHandoff(config);
    }
  }

  override async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}
