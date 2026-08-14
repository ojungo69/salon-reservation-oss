import { parseDateJstToUtcIso } from "./date-parse.ts";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export type ActorContext = {
  subject: string;
  capabilities: string[];
};

export type CreateReservationCommand = {
  version: 1;
  commandId: string;
  expectedRevision: number;
  actor: ActorContext;
  type: "reservation.create";
  payload: {
    reservationId: string;
    resourceId: string;
    date: string;
    startTime: string;
    durationMinutes: number;
  };
};

export type CancelReservationCommand = {
  version: 1;
  commandId: string;
  expectedRevision: number;
  actor: ActorContext;
  type: "reservation.cancel";
  payload: {
    reservationId: string;
  };
};

export type RescheduleReservationCommand = {
  version: 1;
  commandId: string;
  expectedRevision: number;
  actor: ActorContext;
  type: "reservation.reschedule";
  payload: {
    reservationId: string;
    resourceId: string;
    date: string;
    startTime: string;
    durationMinutes: number;
  };
};

export type ReservationCommand =
  | CreateReservationCommand
  | CancelReservationCommand
  | RescheduleReservationCommand;

export type Reservation = {
  id: string;
  resourceId: string;
  startAt: string;
  endAt: string;
  status: "active" | "cancelled";
  createdRevision: number;
  rescheduledRevision?: number | null;
  cancelledRevision: number | null;
};

export type ReservationCreatedEvent = {
  version: 1;
  type: "reservation.created";
  revision: number;
  commandId: string;
  actorSubject: string;
  reservationId: string;
  resourceId: string;
  startAt: string;
  endAt: string;
};

export type ReservationCancelledEvent = {
  version: 1;
  type: "reservation.cancelled";
  revision: number;
  commandId: string;
  actorSubject: string;
  reservationId: string;
};

export type ReservationRescheduledEvent = {
  version: 1;
  type: "reservation.rescheduled";
  revision: number;
  commandId: string;
  actorSubject: string;
  reservationId: string;
  resourceId: string;
  startAt: string;
  endAt: string;
};

export type ReservationEvent =
  | ReservationCreatedEvent
  | ReservationCancelledEvent
  | ReservationRescheduledEvent;

export type CommandReceipt = {
  commandId: string;
  fingerprint: string;
  event: ReservationEvent;
};

export type ReservationState = {
  version: 1;
  revision: number;
  reservations: Reservation[];
  receipts: CommandReceipt[];
};

export type RejectionCode =
  | "INVALID_STATE"
  | "INVALID_COMMAND"
  | "UNSUPPORTED_VERSION"
  | "UNAUTHORIZED"
  | "IDEMPOTENCY_CONFLICT"
  | "VERSION_CONFLICT"
  | "RESERVATION_ID_CONFLICT"
  | "OVERLAP"
  | "RESERVATION_NOT_FOUND"
  | "RESERVATION_NOT_ACTIVE"
  | "NO_CHANGE";

export type ReservationSuccess = {
  ok: true;
  state: ReservationState;
  outcome: {
    replayed: boolean;
    event: ReservationEvent;
  };
  emittedEvents: ReservationEvent[];
};

export type ReservationRejection = {
  ok: false;
  state: ReservationState | null;
  error: { code: RejectionCode } & Record<string, unknown>;
  emittedEvents: [];
};

export type ReservationExecutionResult =
  | ReservationSuccess
  | ReservationRejection;

type JsonObject = Record<string, unknown>;

type NormalizedCommand = ReservationCommand & { fingerprint: string };

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (value: JsonObject, keys: string[]): boolean => {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
};

const isIdentifier = (value: unknown): value is string =>
  typeof value === "string" && IDENTIFIER_PATTERN.test(value);

const isRevision = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

const isPositiveRevision = (value: unknown): value is number =>
  isRevision(value) && value > 0;

const isCanonicalIso = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
};

const isCreatedEvent = (
  value: unknown,
  stateRevision: number,
): value is ReservationCreatedEvent => {
  if (!isObject(value)) return false;
  return (
    hasExactKeys(value, [
      "version",
      "type",
      "revision",
      "commandId",
      "actorSubject",
      "reservationId",
      "resourceId",
      "startAt",
      "endAt",
    ]) &&
    value.version === 1 &&
    value.type === "reservation.created" &&
    isPositiveRevision(value.revision) &&
    value.revision <= stateRevision &&
    isIdentifier(value.commandId) &&
    isIdentifier(value.actorSubject) &&
    isIdentifier(value.reservationId) &&
    isIdentifier(value.resourceId) &&
    isCanonicalIso(value.startAt) &&
    isCanonicalIso(value.endAt) &&
    value.startAt < value.endAt
  );
};

const isCancelledEvent = (
  value: unknown,
  stateRevision: number,
): value is ReservationCancelledEvent => {
  if (!isObject(value)) return false;
  return (
    hasExactKeys(value, [
      "version",
      "type",
      "revision",
      "commandId",
      "actorSubject",
      "reservationId",
    ]) &&
    value.version === 1 &&
    value.type === "reservation.cancelled" &&
    isPositiveRevision(value.revision) &&
    value.revision <= stateRevision &&
    isIdentifier(value.commandId) &&
    isIdentifier(value.actorSubject) &&
    isIdentifier(value.reservationId)
  );
};

const isRescheduledEvent = (
  value: unknown,
  stateRevision: number,
): value is ReservationRescheduledEvent => {
  if (!isObject(value)) return false;
  return (
    hasExactKeys(value, [
      "version",
      "type",
      "revision",
      "commandId",
      "actorSubject",
      "reservationId",
      "resourceId",
      "startAt",
      "endAt",
    ]) &&
    value.version === 1 &&
    value.type === "reservation.rescheduled" &&
    isPositiveRevision(value.revision) &&
    value.revision <= stateRevision &&
    isIdentifier(value.commandId) &&
    isIdentifier(value.actorSubject) &&
    isIdentifier(value.reservationId) &&
    isIdentifier(value.resourceId) &&
    isCanonicalIso(value.startAt) &&
    isCanonicalIso(value.endAt) &&
    value.startAt < value.endAt
  );
};

const isReservation = (
  value: unknown,
  stateRevision: number,
): value is Reservation => {
  if (!isObject(value)) return false;
  const hasRescheduledRevision = Object.hasOwn(value, "rescheduledRevision");
  if (
    !(hasExactKeys(value, [
      "id",
      "resourceId",
      "startAt",
      "endAt",
      "status",
      "createdRevision",
      "cancelledRevision",
    ]) ||
      (hasRescheduledRevision &&
        hasExactKeys(value, [
          "id",
          "resourceId",
          "startAt",
          "endAt",
          "status",
          "createdRevision",
          "rescheduledRevision",
          "cancelledRevision",
        ]))) ||
    !isIdentifier(value.id) ||
    !isIdentifier(value.resourceId) ||
    !isCanonicalIso(value.startAt) ||
    !isCanonicalIso(value.endAt) ||
    value.startAt >= value.endAt ||
    !isPositiveRevision(value.createdRevision) ||
    value.createdRevision > stateRevision ||
    (hasRescheduledRevision &&
      value.rescheduledRevision !== null &&
      (!isPositiveRevision(value.rescheduledRevision) ||
        value.rescheduledRevision <= value.createdRevision ||
        value.rescheduledRevision > stateRevision))
  ) {
    return false;
  }
  if (value.status === "active") return value.cancelledRevision === null;
  return (
    value.status === "cancelled" &&
    isPositiveRevision(value.cancelledRevision) &&
    value.cancelledRevision > value.createdRevision &&
    value.cancelledRevision <= stateRevision
  );
};

const validState = (state: unknown): state is ReservationState => {
  if (!isObject(state) || !hasExactKeys(state, ["version", "revision", "reservations", "receipts"])) {
    return false;
  }
  const revision = state.revision;
  if (
    state.version !== 1 ||
    !isRevision(revision) ||
    !Array.isArray(state.reservations) ||
    !Array.isArray(state.receipts) ||
    state.receipts.length !== revision
  ) {
    return false;
  }

  if (!state.reservations.every((value) => isReservation(value, revision))) return false;
  const reservationIds = new Set(state.reservations.map((reservation) => reservation.id));
  if (reservationIds.size !== state.reservations.length) return false;
  return (
    receiptsAreConsistent(state as ReservationState) &&
    reservationEventsAreConsistent(state as ReservationState) &&
    !activeReservationsOverlap(state as ReservationState)
  );
};

const receiptsAreConsistent = (state: ReservationState): boolean => {
  const receiptIds = new Set<string>();
  const receiptRevisions = new Set<number>();
  for (const value of state.receipts) {
    if (
      !isObject(value) ||
      !hasExactKeys(value, ["commandId", "fingerprint", "event"]) ||
      !isIdentifier(value.commandId) ||
      typeof value.fingerprint !== "string" ||
      value.fingerprint.length === 0 ||
      value.fingerprint.length > 4096 ||
      (!isCreatedEvent(value.event, state.revision) &&
        !isCancelledEvent(value.event, state.revision) &&
        !isRescheduledEvent(value.event, state.revision)) ||
      value.event.commandId !== value.commandId ||
      !receiptMatchesCommand(value as CommandReceipt) ||
      receiptIds.has(value.commandId) ||
      receiptRevisions.has(value.event.revision)
    ) {
      return false;
    }
    receiptIds.add(value.commandId);
    receiptRevisions.add(value.event.revision);
  }

  for (const receipt of state.receipts) {
    const reservation = state.reservations.find(
      (candidate) => candidate.id === receipt.event.reservationId,
    );
    if (!reservation) return false;
    if (receipt.event.type === "reservation.created") {
      if (reservation.createdRevision !== receipt.event.revision) return false;
    } else if (
      receipt.event.type === "reservation.cancelled" &&
      (reservation.status !== "cancelled" ||
        reservation.cancelledRevision !== receipt.event.revision)
    ) {
      return false;
    }
  }
  return true;
};

const eventsFor = (
  state: ReservationState,
  reservationId: string,
  type: CommandReceipt["event"]["type"],
): CommandReceipt[] =>
  state.receipts.filter(
    (receipt) => receipt.event.type === type && receipt.event.reservationId === reservationId,
  );

const rescheduleHistoryMatches = (
  reservation: Reservation,
  rescheduleEvents: CommandReceipt[],
): boolean => {
  const rescheduledRevision = reservation.rescheduledRevision;
  if (rescheduledRevision === undefined || rescheduledRevision === null) {
    return rescheduleEvents.length === 0;
  }
  const latestRescheduleRevision = Math.max(
    ...rescheduleEvents.map((receipt) => receipt.event.revision),
  );
  return latestRescheduleRevision === rescheduledRevision;
};

const intervalMatchesReservation = (
  state: ReservationState,
  reservation: Reservation,
): boolean => {
  const intervalRevision = reservation.rescheduledRevision ?? reservation.createdRevision;
  const intervalReceipt = state.receipts.find(
    (receipt) => receipt.event.revision === intervalRevision,
  );
  return (
    intervalReceipt !== undefined &&
    (intervalReceipt.event.type === "reservation.created" ||
      intervalReceipt.event.type === "reservation.rescheduled") &&
    intervalReceipt.event.reservationId === reservation.id &&
    intervalReceipt.event.resourceId === reservation.resourceId &&
    intervalReceipt.event.startAt === reservation.startAt &&
    intervalReceipt.event.endAt === reservation.endAt
  );
};

const reservationEventsAreConsistent = (state: ReservationState): boolean => {
  for (const reservation of state.reservations) {
    const creationEvents = eventsFor(state, reservation.id, "reservation.created");
    const cancellationEvents = eventsFor(state, reservation.id, "reservation.cancelled");
    const rescheduleEvents = eventsFor(state, reservation.id, "reservation.rescheduled");
    if (creationEvents.length !== 1) return false;
    if (!rescheduleHistoryMatches(reservation, rescheduleEvents)) return false;
    if (!intervalMatchesReservation(state, reservation)) return false;
    if (reservation.status === "active" && cancellationEvents.length !== 0) return false;
    const intervalRevision = reservation.rescheduledRevision ?? reservation.createdRevision;
    if (
      reservation.status === "cancelled" &&
      (cancellationEvents.length !== 1 || reservation.cancelledRevision! <= intervalRevision)
    ) {
      return false;
    }
  }
  return true;
};

const activeReservationsOverlap = (state: ReservationState): boolean => {
  const active = state.reservations.filter((reservation) => reservation.status === "active");
  // ponytail: quadratic validation fits caller-owned v1 state; index only after measured scale needs it.
  for (let left = 0; left < active.length; left += 1) {
    for (let right = left + 1; right < active.length; right += 1) {
      const a = active[left];
      const b = active[right];
      if (a.resourceId === b.resourceId && a.startAt < b.endAt && b.startAt < a.endAt) {
        return true;
      }
    }
  }
  return false;
};

const normalizeActor = (
  value: unknown,
): ActorContext | { field: string } => {
  if (!isObject(value) || !hasExactKeys(value, ["subject", "capabilities"])) {
    return { field: "actor" };
  }
  if (!isIdentifier(value.subject)) return { field: "actor.subject" };
  if (
    !Array.isArray(value.capabilities) ||
    value.capabilities.length > 16 ||
    !value.capabilities.every(isIdentifier)
  ) {
    return { field: "actor.capabilities" };
  }
  return {
    subject: value.subject,
    capabilities: [...new Set(value.capabilities)].sort((left, right) => {
      if (left < right) return -1;
      if (left > right) return 1;
      return 0;
    }),
  };
};

const normalizeCommand = (
  value: unknown,
): NormalizedCommand | { field: string } => {
  if (
    !isObject(value) ||
    !hasExactKeys(value, [
      "version",
      "commandId",
      "expectedRevision",
      "actor",
      "type",
      "payload",
    ])
  ) {
    return { field: "command" };
  }
  if (value.version !== 1) return { field: "command.version" };
  if (!isIdentifier(value.commandId)) return { field: "commandId" };
  if (!isRevision(value.expectedRevision)) return { field: "expectedRevision" };
  const actor = normalizeActor(value.actor);
  if ("field" in actor) return actor;
  if (!isObject(value.payload)) return { field: "payload" };

  let command: ReservationCommand;
  if (value.type === "reservation.create" || value.type === "reservation.reschedule") {
    const payload = normalizeIntervalPayload(value.payload);
    if ("field" in payload) return payload;
    command = {
      version: 1,
      commandId: value.commandId,
      expectedRevision: value.expectedRevision,
      actor,
      type: value.type,
      payload,
    } as CreateReservationCommand | RescheduleReservationCommand;
  } else if (value.type === "reservation.cancel") {
    if (!hasExactKeys(value.payload, ["reservationId"])) return { field: "payload" };
    if (!isIdentifier(value.payload.reservationId)) return { field: "payload.reservationId" };
    command = {
      version: 1,
      commandId: value.commandId,
      expectedRevision: value.expectedRevision,
      actor,
      type: "reservation.cancel",
      payload: { reservationId: value.payload.reservationId },
    };
  } else {
    return { field: "type" };
  }

  return { ...command, fingerprint: JSON.stringify(command) };
};

const normalizeIntervalPayload = (
  payload: Record<string, unknown>,
): CreateReservationCommand["payload"] | { field: string } => {
  if (
    !hasExactKeys(payload, [
      "reservationId",
      "resourceId",
      "date",
      "startTime",
      "durationMinutes",
    ])
  ) {
    return { field: "payload" };
  }
  if (!isIdentifier(payload.reservationId)) return { field: "payload.reservationId" };
  if (!isIdentifier(payload.resourceId)) return { field: "payload.resourceId" };
  if (typeof payload.date !== "string" || !parseDateJstToUtcIso(payload.date)) {
    return { field: "payload.date" };
  }
  if (typeof payload.startTime !== "string" || !TIME_PATTERN.test(payload.startTime)) {
    return { field: "payload.startTime" };
  }
  const durationMinutes = payload.durationMinutes;
  if (
    typeof durationMinutes !== "number" ||
    !Number.isSafeInteger(durationMinutes) ||
    durationMinutes <= 0
  ) {
    return { field: "payload.durationMinutes" };
  }
  const [hours, minutes] = payload.startTime.split(":").map(Number);
  if (hours * 60 + minutes + durationMinutes > 24 * 60) {
    return { field: "payload.durationMinutes" };
  }
  return {
    reservationId: payload.reservationId,
    resourceId: payload.resourceId,
    date: payload.date,
    startTime: payload.startTime,
    durationMinutes,
  };
};

const reject = (
  state: ReservationState | null,
  code: RejectionCode,
  context: Record<string, unknown> = {},
): ReservationRejection => ({
  ok: false,
  state,
  error: { code, ...context },
  emittedEvents: [],
});

const requiredCapability = (command: ReservationCommand): string => {
  if (command.type === "reservation.create") return "reservation:create";
  if (command.type === "reservation.cancel") return "reservation:cancel";
  return "reservation:reschedule";
};

const intervalFor = (
  command: CreateReservationCommand | RescheduleReservationCommand,
): { startAt: string; endAt: string } => {
  const midnight = parseDateJstToUtcIso(command.payload.date) as string;
  const [hours, minutes] = command.payload.startTime.split(":").map(Number);
  const startMilliseconds = Date.parse(midnight) + (hours * 60 + minutes) * 60_000;
  const endMilliseconds = startMilliseconds + command.payload.durationMinutes * 60_000;
  return {
    startAt: new Date(startMilliseconds).toISOString(),
    endAt: new Date(endMilliseconds).toISOString(),
  };
};

const receiptMatchesCommand = (receipt: CommandReceipt): boolean => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(receipt.fingerprint);
  } catch {
    return false;
  }
  const normalized = normalizeCommand(parsed);
  if (
    "field" in normalized ||
    normalized.fingerprint !== receipt.fingerprint ||
    normalized.commandId !== receipt.commandId ||
    normalized.actor.subject !== receipt.event.actorSubject ||
    !normalized.actor.capabilities.includes(requiredCapability(normalized)) ||
    normalized.expectedRevision + 1 !== receipt.event.revision
  ) {
    return false;
  }
  if (normalized.type === "reservation.create") {
    if (
      receipt.event.type !== "reservation.created" ||
      normalized.payload.reservationId !== receipt.event.reservationId ||
      normalized.payload.resourceId !== receipt.event.resourceId
    ) {
      return false;
    }
    const interval = intervalFor(normalized);
    return (
      interval.startAt === receipt.event.startAt &&
      interval.endAt === receipt.event.endAt
    );
  }
  if (normalized.type === "reservation.reschedule") {
    if (
      receipt.event.type !== "reservation.rescheduled" ||
      normalized.payload.reservationId !== receipt.event.reservationId ||
      normalized.payload.resourceId !== receipt.event.resourceId
    ) {
      return false;
    }
    const interval = intervalFor(normalized);
    return (
      interval.startAt === receipt.event.startAt &&
      interval.endAt === receipt.event.endAt
    );
  }
  return (
    receipt.event.type === "reservation.cancelled" &&
    normalized.payload.reservationId === receipt.event.reservationId
  );
};

export const createEmptyReservationState = (): ReservationState => ({
  version: 1,
  revision: 0,
  reservations: [],
  receipts: [],
});

export const executeReservationCommand = (
  stateValue: unknown,
  commandValue: unknown,
): ReservationExecutionResult => {
  if (isObject(stateValue) && Object.hasOwn(stateValue, "version") && stateValue.version !== 1) {
    return reject(null, "UNSUPPORTED_VERSION", { field: "state.version" });
  }
  if (!validState(stateValue)) return reject(null, "INVALID_STATE");
  const state = stateValue;

  if (isObject(commandValue) && Object.hasOwn(commandValue, "version") && commandValue.version !== 1) {
    return reject(state, "UNSUPPORTED_VERSION", { field: "command.version" });
  }
  const normalized = normalizeCommand(commandValue);
  if ("field" in normalized) return reject(state, "INVALID_COMMAND", normalized);

  const priorReceipt = state.receipts.find(
    (receipt) => receipt.commandId === normalized.commandId,
  );
  if (priorReceipt) {
    if (priorReceipt.fingerprint !== normalized.fingerprint) {
      return reject(state, "IDEMPOTENCY_CONFLICT", {
        commandId: normalized.commandId,
      });
    }
    return {
      ok: true,
      state,
      outcome: { replayed: true, event: { ...priorReceipt.event } },
      emittedEvents: [],
    };
  }

  const capability = requiredCapability(normalized);
  if (!normalized.actor.capabilities.includes(capability)) {
    return reject(state, "UNAUTHORIZED", { requiredCapability: capability });
  }
  if (normalized.expectedRevision !== state.revision) {
    return reject(state, "VERSION_CONFLICT", {
      expectedRevision: normalized.expectedRevision,
      actualRevision: state.revision,
    });
  }
  if (normalized.type === "reservation.cancel") {
    return applyCancel(state, normalized);
  }

  if (normalized.type === "reservation.reschedule") {
    return applyReschedule(state, normalized);
  }
  return applyCreate(state, normalized);
};

const isRejection = (
  value: Reservation | ReservationRejection,
): value is ReservationRejection =>
  Object.hasOwn(value, "ok") && (value as ReservationRejection).ok === false;

const requireActiveReservation = (
  state: ReservationState,
  reservationId: string,
): Reservation | ReservationRejection => {
  const reservation = state.reservations.find((candidate) => candidate.id === reservationId);
  if (!reservation) {
    return reject(state, "RESERVATION_NOT_FOUND", { reservationId });
  }
  if (reservation.status !== "active") {
    return reject(state, "RESERVATION_NOT_ACTIVE", { reservationId: reservation.id });
  }
  return reservation;
};

const applyCancel = (
  state: ReservationState,
  normalized: Extract<NormalizedCommand, { type: "reservation.cancel" }>,
): ReservationExecutionResult => {
  const reservation = requireActiveReservation(state, normalized.payload.reservationId);
  if (isRejection(reservation)) return reservation;

  const revision = state.revision + 1;
  const event: ReservationCancelledEvent = {
    version: 1,
    type: "reservation.cancelled",
    revision,
    commandId: normalized.commandId,
    actorSubject: normalized.actor.subject,
    reservationId: reservation.id,
  };
  const nextState: ReservationState = {
    version: 1,
    revision,
    reservations: state.reservations.map((candidate) =>
      candidate.id === reservation.id
        ? { ...candidate, status: "cancelled", cancelledRevision: revision }
        : candidate,
    ),
    receipts: [
      ...state.receipts,
      {
        commandId: normalized.commandId,
        fingerprint: normalized.fingerprint,
        event: { ...event },
      },
    ],
  };
  return {
    ok: true,
    state: nextState,
    outcome: { replayed: false, event: { ...event } },
    emittedEvents: [{ ...event }],
  };
};

const applyReschedule = (
  state: ReservationState,
  normalized: Extract<NormalizedCommand, { type: "reservation.reschedule" }>,
): ReservationExecutionResult => {
  const reservation = requireActiveReservation(state, normalized.payload.reservationId);
  if (isRejection(reservation)) return reservation;

  const interval = intervalFor(normalized);
  if (
    reservation.resourceId === normalized.payload.resourceId &&
    reservation.startAt === interval.startAt &&
    reservation.endAt === interval.endAt
  ) {
    return reject(state, "NO_CHANGE");
  }
  const conflict = state.reservations.find(
    (candidate) =>
      candidate.id !== reservation.id &&
      candidate.status === "active" &&
      candidate.resourceId === normalized.payload.resourceId &&
      candidate.startAt < interval.endAt &&
      interval.startAt < candidate.endAt,
  );
  if (conflict) {
    return reject(state, "OVERLAP", { conflictingReservationId: conflict.id });
  }

  const revision = state.revision + 1;
  const event: ReservationRescheduledEvent = {
    version: 1,
    type: "reservation.rescheduled",
    revision,
    commandId: normalized.commandId,
    actorSubject: normalized.actor.subject,
    reservationId: reservation.id,
    resourceId: normalized.payload.resourceId,
    ...interval,
  };
  const nextState: ReservationState = {
    version: 1,
    revision,
    reservations: state.reservations.map((candidate) =>
      candidate.id === reservation.id
        ? {
            ...candidate,
            resourceId: normalized.payload.resourceId,
            ...interval,
            rescheduledRevision: revision,
          }
        : candidate,
    ),
    receipts: [
      ...state.receipts,
      {
        commandId: normalized.commandId,
        fingerprint: normalized.fingerprint,
        event: { ...event },
      },
    ],
  };
  return {
    ok: true,
    state: nextState,
    outcome: { replayed: false, event: { ...event } },
    emittedEvents: [{ ...event }],
  };
};

const applyCreate = (
  state: ReservationState,
  normalized: Extract<NormalizedCommand, { type: "reservation.create" }>,
): ReservationExecutionResult => {
  if (state.reservations.some((reservation) => reservation.id === normalized.payload.reservationId)) {
    return reject(state, "RESERVATION_ID_CONFLICT", {
      reservationId: normalized.payload.reservationId,
    });
  }

  const interval = intervalFor(normalized);
  // ponytail: linear overlap scan is the v1 ceiling; index after a storage adapter measures need.
  const conflict = state.reservations.find(
    (reservation) =>
      reservation.status === "active" &&
      reservation.resourceId === normalized.payload.resourceId &&
      reservation.startAt < interval.endAt &&
      interval.startAt < reservation.endAt,
  );
  if (conflict) {
    return reject(state, "OVERLAP", { conflictingReservationId: conflict.id });
  }

  const revision = state.revision + 1;
  const reservation: Reservation = {
    id: normalized.payload.reservationId,
    resourceId: normalized.payload.resourceId,
    ...interval,
    status: "active",
    createdRevision: revision,
    cancelledRevision: null,
  };
  const event: ReservationCreatedEvent = {
    version: 1,
    type: "reservation.created",
    revision,
    commandId: normalized.commandId,
    actorSubject: normalized.actor.subject,
    reservationId: reservation.id,
    resourceId: reservation.resourceId,
    startAt: reservation.startAt,
    endAt: reservation.endAt,
  };
  // ponytail: receipts grow with accepted commands; persistence must add retention without weakening replay.
  const nextState: ReservationState = {
    version: 1,
    revision,
    reservations: [...state.reservations, reservation],
    receipts: [
      ...state.receipts,
      {
        commandId: normalized.commandId,
        fingerprint: normalized.fingerprint,
        event: { ...event },
      },
    ],
  };
  return {
    ok: true,
    state: nextState,
    outcome: { replayed: false, event: { ...event } },
    emittedEvents: [{ ...event }],
  };
};
