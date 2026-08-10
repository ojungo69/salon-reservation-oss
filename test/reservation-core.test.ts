import assert from "node:assert/strict";
import test from "node:test";

import {
  createEmptyReservationState,
  executeReservationCommand,
} from "../src/reservation-core.ts";

const manager = {
  subject: "actor-demo-manager",
  capabilities: ["reservation:create", "reservation:cancel"],
};

const createCommand = () => ({
  version: 1,
  commandId: "cmd-demo-create-1",
  expectedRevision: 0,
  actor: structuredClone(manager),
  type: "reservation.create",
  payload: {
    reservationId: "reservation-demo-1",
    resourceId: "resource-demo-chair-1",
    date: "2026-08-20",
    startTime: "10:00",
    durationMinutes: 60,
  },
});

const cancelCommand = () => ({
  version: 1,
  commandId: "cmd-demo-cancel-1",
  expectedRevision: 1,
  actor: structuredClone(manager),
  type: "reservation.cancel",
  payload: {
    reservationId: "reservation-demo-1",
  },
});

const rescheduleCommand = () => ({
  version: 1,
  commandId: "cmd-demo-reschedule-1",
  expectedRevision: 1,
  actor: {
    subject: "actor-demo-manager",
    capabilities: ["reservation:reschedule"],
  },
  type: "reservation.reschedule",
  payload: {
    reservationId: "reservation-demo-1",
    resourceId: "resource-demo-chair-1",
    date: "2026-08-20",
    startTime: "12:00",
    durationMinutes: 60,
  },
});

const serializeCompleteScenario = (): string => {
  let state = createEmptyReservationState();
  const results: ReturnType<typeof executeReservationCommand>[] = [];
  const apply = (command: unknown) => {
    const result = executeReservationCommand(state, command);
    results.push(result);
    if (result.ok) state = result.state;
  };

  apply(createCommand());

  const overlap = createCommand();
  overlap.commandId = "cmd-demo-scenario-overlap";
  overlap.expectedRevision = 1;
  overlap.payload.reservationId = "reservation-demo-scenario-overlap";
  overlap.payload.startTime = "10:30";
  apply(overlap);

  apply(createCommand());

  const conflictingReplay = createCommand();
  conflictingReplay.payload.startTime = "12:00";
  apply(conflictingReplay);

  const stale = createCommand();
  stale.commandId = "cmd-demo-scenario-stale";
  stale.payload.reservationId = "reservation-demo-scenario-stale";
  apply(stale);

  apply(cancelCommand());

  const replacement = createCommand();
  replacement.commandId = "cmd-demo-scenario-replacement";
  replacement.expectedRevision = 2;
  replacement.payload.reservationId = "reservation-demo-scenario-replacement";
  apply(replacement);

  return JSON.stringify({ results, state });
};

const requireSuccess = <T extends { ok: boolean }>(
  result: T,
): asserts result is T & { ok: true } => {
  assert.equal(result.ok, true);
};

test("US1 creates one canonical JST reservation without mutating its input", () => {
  const state = createEmptyReservationState();
  const before = structuredClone(state);
  const result = executeReservationCommand(state, createCommand());

  requireSuccess(result);
  assert.deepEqual(state, before);
  assert.equal(result.state.revision, 1);
  assert.deepEqual(result.state.reservations, [
    {
      id: "reservation-demo-1",
      resourceId: "resource-demo-chair-1",
      startAt: "2026-08-20T01:00:00.000Z",
      endAt: "2026-08-20T02:00:00.000Z",
      status: "active",
      createdRevision: 1,
      cancelledRevision: null,
    },
  ]);
  assert.equal(result.state.receipts.length, 1);
  assert.equal(result.outcome.replayed, false);
  assert.equal(result.outcome.event.type, "reservation.created");
  assert.deepEqual(result.emittedEvents, [result.outcome.event]);
});

test("US1 accepts adjacent intervals and the same interval on another resource", () => {
  const first = executeReservationCommand(createEmptyReservationState(), createCommand());
  requireSuccess(first);

  const adjacent = createCommand();
  adjacent.commandId = "cmd-demo-create-2";
  adjacent.expectedRevision = 1;
  adjacent.payload.reservationId = "reservation-demo-2";
  adjacent.payload.startTime = "11:00";
  const second = executeReservationCommand(first.state, adjacent);
  requireSuccess(second);

  const otherResource = createCommand();
  otherResource.commandId = "cmd-demo-create-3";
  otherResource.expectedRevision = 2;
  otherResource.payload.reservationId = "reservation-demo-3";
  otherResource.payload.resourceId = "resource-demo-chair-2";
  otherResource.payload.startTime = "10:30";
  const third = executeReservationCommand(second.state, otherResource);
  requireSuccess(third);

  assert.equal(third.state.revision, 3);
  assert.equal(third.state.reservations.length, 3);
});

test("US1 rejects same-resource overlap and duplicate reservation identifiers", () => {
  const first = executeReservationCommand(createEmptyReservationState(), createCommand());
  requireSuccess(first);

  const overlap = createCommand();
  overlap.commandId = "cmd-demo-overlap";
  overlap.expectedRevision = 1;
  overlap.payload.reservationId = "reservation-demo-overlap";
  overlap.payload.startTime = "10:30";
  const overlapResult = executeReservationCommand(first.state, overlap);
  assert.equal(overlapResult.ok, false);
  if (overlapResult.ok) return;
  assert.deepEqual(overlapResult.state, first.state);
  assert.deepEqual(overlapResult.emittedEvents, []);
  assert.deepEqual(overlapResult.error, {
    code: "OVERLAP",
    conflictingReservationId: "reservation-demo-1",
  });

  const duplicate = createCommand();
  duplicate.commandId = "cmd-demo-duplicate";
  duplicate.expectedRevision = 1;
  duplicate.payload.startTime = "12:00";
  const duplicateResult = executeReservationCommand(first.state, duplicate);
  assert.equal(duplicateResult.ok, false);
  if (duplicateResult.ok) return;
  assert.equal(duplicateResult.error.code, "RESERVATION_ID_CONFLICT");
  assert.deepEqual(duplicateResult.state, first.state);
});

test("US1 rejects invalid intervals and missing exact capability", () => {
  const invalidCommands = [
    ["payload.date", (command: ReturnType<typeof createCommand>) => {
      command.payload.date = "2026-02-30";
    }],
    ["payload.startTime", (command: ReturnType<typeof createCommand>) => {
      command.payload.startTime = "9:00";
    }],
    ["payload.durationMinutes", (command: ReturnType<typeof createCommand>) => {
      command.payload.durationMinutes = 0;
    }],
    ["payload.durationMinutes", (command: ReturnType<typeof createCommand>) => {
      command.payload.startTime = "23:30";
      command.payload.durationMinutes = 31;
    }],
    ["payload.resourceId", (command: ReturnType<typeof createCommand>) => {
      command.payload.resourceId = "resource with spaces";
    }],
  ] as const;

  for (const [field, mutate] of invalidCommands) {
    const command = createCommand();
    mutate(command);
    const result = executeReservationCommand(createEmptyReservationState(), command);
    assert.equal(result.ok, false, field);
    if (result.ok) continue;
    assert.deepEqual(result.error, { code: "INVALID_COMMAND", field });
    assert.equal(result.state.revision, 0);
    assert.deepEqual(result.emittedEvents, []);
  }

  const command = createCommand();
  command.actor.capabilities = ["reservation:unknown"];
  const unauthorized = executeReservationCommand(createEmptyReservationState(), command);
  assert.equal(unauthorized.ok, false);
  if (unauthorized.ok) return;
  assert.deepEqual(unauthorized.error, {
    code: "UNAUTHORIZED",
    requiredCapability: "reservation:create",
  });
  assert.equal(unauthorized.state.revision, 0);
});

test("US2 replays one accepted command without another state change", () => {
  const command = createCommand();
  const first = executeReservationCommand(createEmptyReservationState(), command);
  requireSuccess(first);
  const before = structuredClone(first.state);

  for (let attempt = 0; attempt < 100; attempt += 1) {
    const replay = executeReservationCommand(first.state, structuredClone(command));
    requireSuccess(replay);
    assert.equal(replay.outcome.replayed, true);
    assert.deepEqual(replay.outcome.event, first.outcome.event);
    assert.deepEqual(replay.emittedEvents, []);
    assert.deepEqual(replay.state, before);
  }
  assert.deepEqual(first.state, before);
});

test("US2 rejects conflicting command reuse and a stale new command", () => {
  const first = executeReservationCommand(createEmptyReservationState(), createCommand());
  requireSuccess(first);

  const conflicting = createCommand();
  conflicting.payload.startTime = "12:00";
  const conflict = executeReservationCommand(first.state, conflicting);
  assert.equal(conflict.ok, false);
  if (conflict.ok) return;
  assert.deepEqual(conflict.error, {
    code: "IDEMPOTENCY_CONFLICT",
    commandId: "cmd-demo-create-1",
  });
  assert.deepEqual(conflict.state, first.state);

  const stale = createCommand();
  stale.commandId = "cmd-demo-stale";
  stale.payload.reservationId = "reservation-demo-stale";
  const staleResult = executeReservationCommand(first.state, stale);
  assert.equal(staleResult.ok, false);
  if (staleResult.ok) return;
  assert.deepEqual(staleResult.error, {
    code: "VERSION_CONFLICT",
    expectedRevision: 0,
    actualRevision: 1,
  });
  assert.deepEqual(staleResult.emittedEvents, []);
  assert.deepEqual(staleResult.state, first.state);
});

test("US2 cancels once, refuses missing or repeated cancellation, and releases capacity", () => {
  const created = executeReservationCommand(createEmptyReservationState(), createCommand());
  requireSuccess(created);
  const before = structuredClone(created.state);

  const cancelled = executeReservationCommand(created.state, cancelCommand());
  requireSuccess(cancelled);
  assert.deepEqual(created.state, before);
  assert.equal(cancelled.state.revision, 2);
  assert.deepEqual(cancelled.state.reservations[0], {
    ...created.state.reservations[0],
    status: "cancelled",
    cancelledRevision: 2,
  });
  assert.equal(cancelled.outcome.event.type, "reservation.cancelled");

  const repeated = cancelCommand();
  repeated.commandId = "cmd-demo-cancel-2";
  repeated.expectedRevision = 2;
  const repeatedResult = executeReservationCommand(cancelled.state, repeated);
  assert.equal(repeatedResult.ok, false);
  if (repeatedResult.ok) return;
  assert.equal(repeatedResult.error.code, "RESERVATION_NOT_ACTIVE");
  assert.deepEqual(repeatedResult.state, cancelled.state);

  const missing = cancelCommand();
  missing.commandId = "cmd-demo-cancel-missing";
  missing.expectedRevision = 2;
  missing.payload.reservationId = "reservation-demo-missing";
  const missingResult = executeReservationCommand(cancelled.state, missing);
  assert.equal(missingResult.ok, false);
  if (missingResult.ok) return;
  assert.equal(missingResult.error.code, "RESERVATION_NOT_FOUND");

  const replacement = createCommand();
  replacement.commandId = "cmd-demo-create-replacement";
  replacement.expectedRevision = 2;
  replacement.payload.reservationId = "reservation-demo-replacement";
  const replaced = executeReservationCommand(cancelled.state, replacement);
  requireSuccess(replaced);
  assert.equal(replaced.state.revision, 3);
});

test("US2 requires the exact cancel capability", () => {
  const created = executeReservationCommand(createEmptyReservationState(), createCommand());
  requireSuccess(created);
  const command = cancelCommand();
  command.actor.capabilities = ["reservation:create", "reservation:unknown"];
  const result = executeReservationCommand(created.state, command);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.deepEqual(result.error, {
    code: "UNAUTHORIZED",
    requiredCapability: "reservation:cancel",
  });
  assert.deepEqual(result.state, created.state);
});

test("T006 reschedules an active reservation within its day while keeping its reference", () => {
  const created = executeReservationCommand(createEmptyReservationState(), createCommand());
  requireSuccess(created);

  const moved = executeReservationCommand(created.state, rescheduleCommand());
  requireSuccess(moved);
  assert.equal(moved.state.revision, 2);
  assert.equal(moved.state.receipts.length, 2);
  assert.deepEqual(moved.state.reservations, [
    {
      ...created.state.reservations[0],
      startAt: "2026-08-20T03:00:00.000Z",
      endAt: "2026-08-20T04:00:00.000Z",
      rescheduledRevision: 2,
    },
  ]);
  assert.equal(moved.outcome.event.type, "reservation.rescheduled");
});

test("T006 leaves the original reservation untouched when the destination overlaps", () => {
  const created = executeReservationCommand(createEmptyReservationState(), createCommand());
  requireSuccess(created);

  const occupiedCommand = createCommand();
  occupiedCommand.commandId = "cmd-demo-create-occupied";
  occupiedCommand.expectedRevision = 1;
  occupiedCommand.payload.reservationId = "reservation-demo-occupied";
  occupiedCommand.payload.startTime = "12:00";
  const occupied = executeReservationCommand(created.state, occupiedCommand);
  requireSuccess(occupied);

  const command = rescheduleCommand();
  command.expectedRevision = 2;
  command.payload.startTime = "12:30";
  const result = executeReservationCommand(occupied.state, command);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.deepEqual(result.error, {
    code: "OVERLAP",
    conflictingReservationId: "reservation-demo-occupied",
  });
  assert.deepEqual(result.state, occupied.state);
  assert.deepEqual(result.emittedEvents, []);
});

test("T006 refuses an exact current interval without changing revision or receipt", () => {
  const created = executeReservationCommand(createEmptyReservationState(), createCommand());
  requireSuccess(created);
  const before = structuredClone(created.state);

  const command = rescheduleCommand();
  command.payload.startTime = "10:00";
  const result = executeReservationCommand(created.state, command);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.deepEqual(result.error, { code: "NO_CHANGE" });
  assert.equal(result.state.revision, 1);
  assert.equal(result.state.receipts.length, 1);
  assert.deepEqual(result.state, before);
  assert.deepEqual(result.emittedEvents, []);
});

test("T006 replays an accepted reschedule without another state change", () => {
  const created = executeReservationCommand(createEmptyReservationState(), createCommand());
  requireSuccess(created);
  const command = rescheduleCommand();
  const moved = executeReservationCommand(created.state, command);
  requireSuccess(moved);

  const replay = executeReservationCommand(moved.state, structuredClone(command));
  requireSuccess(replay);
  assert.equal(replay.outcome.replayed, true);
  assert.deepEqual(replay.outcome.event, moved.outcome.event);
  assert.deepEqual(replay.state, moved.state);
  assert.deepEqual(replay.emittedEvents, []);
});

test("T006 requires the exact reschedule capability", () => {
  const created = executeReservationCommand(createEmptyReservationState(), createCommand());
  requireSuccess(created);
  const command = rescheduleCommand();
  command.actor.capabilities = ["reservation:create", "reservation:cancel"];

  const result = executeReservationCommand(created.state, command);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.deepEqual(result.error, {
    code: "UNAUTHORIZED",
    requiredCapability: "reservation:reschedule",
  });
  assert.deepEqual(result.state, created.state);
  assert.deepEqual(result.emittedEvents, []);
});

test("US3 rejects unsupported versions, malformed state, and unknown fields safely", () => {
  const unsupportedState = {
    ...createEmptyReservationState(),
    version: 2,
  };
  const stateResult = executeReservationCommand(unsupportedState, createCommand());
  assert.deepEqual(stateResult, {
    ok: false,
    state: null,
    error: { code: "UNSUPPORTED_VERSION", field: "state.version" },
    emittedEvents: [],
  });

  const unsupportedCommand = createCommand();
  unsupportedCommand.version = 2;
  const commandResult = executeReservationCommand(
    createEmptyReservationState(),
    unsupportedCommand,
  );
  assert.equal(commandResult.ok, false);
  if (commandResult.ok) return;
  assert.deepEqual(commandResult.error, {
    code: "UNSUPPORTED_VERSION",
    field: "command.version",
  });

  const created = executeReservationCommand(createEmptyReservationState(), createCommand());
  requireSuccess(created);
  const malformedState = { ...created.state, receipts: [] };
  const malformedResult = executeReservationCommand(malformedState, createCommand());
  assert.deepEqual(malformedResult, {
    ok: false,
    state: null,
    error: { code: "INVALID_STATE" },
    emittedEvents: [],
  });

  const extraField = { ...createCommand(), extra: true };
  const extraResult = executeReservationCommand(createEmptyReservationState(), extraField);
  assert.equal(extraResult.ok, false);
  if (extraResult.ok) return;
  assert.deepEqual(extraResult.error, { code: "INVALID_COMMAND", field: "command" });

  const inheritedActor = Object.assign(
    Object.create({ capabilities: ["reservation:create"] }),
    { subject: "actor-demo-manager", extra: true },
  );
  const inheritedCommand = createCommand();
  inheritedCommand.actor = inheritedActor;
  const inheritedResult = executeReservationCommand(
    createEmptyReservationState(),
    inheritedCommand,
  );
  assert.equal(inheritedResult.ok, false);
  if (inheritedResult.ok) return;
  assert.deepEqual(inheritedResult.error, {
    code: "INVALID_COMMAND",
    field: "actor",
  });

  for (const value of [null, [], {}, "invalid"]) {
    assert.doesNotThrow(() => executeReservationCommand(value, createCommand()));
    assert.doesNotThrow(() =>
      executeReservationCommand(createEmptyReservationState(), value),
    );
  }
});

test("US3 produces identical serialized results across runtime timezones", () => {
  const originalTimezone = process.env.TZ;
  const serialized: string[] = [];

  try {
    for (const timezone of ["UTC", "Asia/Tokyo", "America/New_York"]) {
      process.env.TZ = timezone;
      serialized.push(serializeCompleteScenario());
    }
  } finally {
    if (originalTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimezone;
  }

  assert.equal(new Set(serialized).size, 1);
});

test("US3 normalizes capability order for successful replay identity", () => {
  const command = createCommand();
  const created = executeReservationCommand(createEmptyReservationState(), command);
  requireSuccess(created);

  const reordered = createCommand();
  reordered.actor.capabilities.reverse();
  const replay = executeReservationCommand(created.state, reordered);
  requireSuccess(replay);
  assert.equal(replay.outcome.replayed, true);
  assert.deepEqual(replay.state, created.state);
  assert.deepEqual(replay.emittedEvents, []);
});

test("US3 rejects phantom reservations and forged receipt history", () => {
  const created = executeReservationCommand(createEmptyReservationState(), createCommand());
  requireSuccess(created);

  const phantomState = structuredClone(created.state);
  phantomState.reservations.push({
    id: "reservation-demo-phantom",
    resourceId: "resource-demo-chair-2",
    startAt: "2026-08-20T03:00:00.000Z",
    endAt: "2026-08-20T04:00:00.000Z",
    status: "active",
    createdRevision: 1,
    cancelledRevision: null,
  });
  const phantomResult = executeReservationCommand(phantomState, cancelCommand());
  assert.deepEqual(phantomResult, {
    ok: false,
    state: null,
    error: { code: "INVALID_STATE" },
    emittedEvents: [],
  });

  const forgedReceiptState = structuredClone(created.state);
  forgedReceiptState.receipts[0].fingerprint = "forged";
  const forgedResult = executeReservationCommand(forgedReceiptState, cancelCommand());
  assert.deepEqual(forgedResult, {
    ok: false,
    state: null,
    error: { code: "INVALID_STATE" },
    emittedEvents: [],
  });

  const unauthorizedCommand = createCommand();
  unauthorizedCommand.actor.capabilities = [];
  const unauthorizedReceiptState = structuredClone(created.state);
  unauthorizedReceiptState.receipts[0].fingerprint = JSON.stringify(unauthorizedCommand);
  const unauthorizedReceiptResult = executeReservationCommand(
    unauthorizedReceiptState,
    unauthorizedCommand,
  );
  assert.deepEqual(unauthorizedReceiptResult, {
    ok: false,
    state: null,
    error: { code: "INVALID_STATE" },
    emittedEvents: [],
  });
});

test("US3 isolates returned event views from persisted receipt state", () => {
  const created = executeReservationCommand(createEmptyReservationState(), createCommand());
  requireSuccess(created);
  assert.notStrictEqual(created.outcome.event, created.emittedEvents[0]);
  assert.notStrictEqual(created.outcome.event, created.state.receipts[0].event);
  assert.notStrictEqual(created.emittedEvents[0], created.state.receipts[0].event);

  created.emittedEvents[0].actorSubject = "actor-demo-mutated";
  created.outcome.event.actorSubject = "actor-demo-mutated-again";
  assert.equal(
    created.state.receipts[0].event.actorSubject,
    "actor-demo-manager",
  );

  const replay = executeReservationCommand(created.state, createCommand());
  requireSuccess(replay);
  replay.outcome.event.actorSubject = "actor-demo-replay-mutated";
  assert.equal(
    created.state.receipts[0].event.actorSubject,
    "actor-demo-manager",
  );
});
