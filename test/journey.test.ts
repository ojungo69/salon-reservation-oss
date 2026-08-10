import assert from "node:assert/strict";
import test from "node:test";

type JourneyModule = {
  decodeJourneyDraft: (encoded: unknown, now: number) => unknown;
  decodePendingMutationRecord: (encoded: unknown, now: number) => unknown;
  encodeJourneyDraft: (draft: unknown) => unknown;
  encodePendingMutationRecord: (record: unknown) => unknown;
  getJourneyStep: (state: unknown) => unknown;
  readOwnedBookingRecords: (records: unknown, now: number) => unknown;
  removeOwnedBookingRecord: (records: unknown, reservationId: string) => unknown;
  restoreJourneyDraft: (draft: unknown, current: unknown) => unknown;
  saveOwnedBookingRecord: (
    records: unknown,
    record: unknown,
    remember: boolean,
  ) => unknown;
};

const journeyModule = (await import("../public/journey.js").catch(
  () => undefined,
)) as Partial<JourneyModule> | undefined;

const journey = <Name extends keyof JourneyModule>(
  name: Name,
): JourneyModule[Name] => {
  const member = journeyModule?.[name];
  assert.equal(
    typeof member,
    "function",
    `Implement ${name} in public/journey.js`,
  );
  return member as JourneyModule[Name];
};

const hour = 60 * 60 * 1_000;
const day = 24 * hour;
const year = 365 * day;
const now = 1_800_000_000_000;
const managementKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const draft = {
  version: 1,
  settingsVersion: 7,
  serviceIds: ["trim"],
  resourceId: "chair-a",
  date: "2026-08-20",
  startTime: "10:00",
  step: "review",
  savedAt: now,
};

const completeSelection = {
  serviceIds: ["trim"],
  resourceId: "chair-a",
  date: "2026-08-20",
  startTime: "10:00",
};

test("guards the selection, details, and review stages independently", () => {
  const getJourneyStep = journey("getJourneyStep");

  assert.equal(
    getJourneyStep({
      requestedStep: "review",
      selection: { ...completeSelection, startTime: null },
      details: {
        customerName: "山田 花子",
        contact: "hanako@example.invalid",
        consent: true,
      },
    }),
    "selection",
  );
  assert.equal(
    getJourneyStep({
      requestedStep: "review",
      selection: completeSelection,
      details: {
        customerName: "",
        contact: "hanako@example.invalid",
        consent: true,
      },
    }),
    "details",
  );
  assert.equal(
    getJourneyStep({
      requestedStep: "review",
      selection: completeSelection,
      details: {
        customerName: "山田 花子",
        contact: "hanako@example.invalid",
        consent: true,
      },
    }),
    "review",
  );
  assert.equal(
    getJourneyStep({
      requestedStep: "selection",
      selection: completeSelection,
      details: {
        customerName: "山田 花子",
        contact: "hanako@example.invalid",
        consent: true,
      },
    }),
    "selection",
  );
});

test("restores the earliest valid selection after settings, service, resource, or slot stales", () => {
  const restoreJourneyDraft = journey("restoreJourneyDraft");
  const cases = [
    {
      name: "settings",
      current: {
        settingsVersion: 8,
        serviceIds: ["trim"],
        resourceIds: ["chair-a"],
        slots: [
          { resourceId: "chair-a", date: "2026-08-20", startTime: "10:00" },
        ],
      },
      expected: {
        ...draft,
        settingsVersion: 8,
        serviceIds: [],
        resourceId: null,
        date: null,
        startTime: null,
        step: "selection",
      },
    },
    {
      name: "service",
      current: {
        settingsVersion: 7,
        serviceIds: [],
        resourceIds: ["chair-a"],
        slots: [
          { resourceId: "chair-a", date: "2026-08-20", startTime: "10:00" },
        ],
      },
      expected: {
        ...draft,
        serviceIds: [],
        resourceId: null,
        date: null,
        startTime: null,
        step: "selection",
      },
    },
    {
      name: "resource",
      current: {
        settingsVersion: 7,
        serviceIds: ["trim"],
        resourceIds: [],
        slots: [],
      },
      expected: {
        ...draft,
        resourceId: null,
        date: null,
        startTime: null,
        step: "selection",
      },
    },
    {
      name: "slot",
      current: {
        settingsVersion: 7,
        serviceIds: ["trim"],
        resourceIds: ["chair-a"],
        slots: [],
      },
      expected: {
        ...draft,
        startTime: null,
        step: "selection",
      },
    },
  ] as const;

  for (const { name, current, expected } of cases) {
    assert.deepEqual(restoreJourneyDraft(draft, current), expected, name);
  }
});

test("round-trips only a fresh non-sensitive journey draft for 24 hours", () => {
  const encodeJourneyDraft = journey("encodeJourneyDraft");
  const decodeJourneyDraft = journey("decodeJourneyDraft");
  const encoded = encodeJourneyDraft(draft);

  assert.equal(typeof encoded, "string");
  assert.deepEqual(decodeJourneyDraft(encoded, now + day - 1), draft);
  assert.equal(decodeJourneyDraft(encoded, now + day), null);
});

test("refuses personally identifying data and keys in a journey draft", () => {
  const encodeJourneyDraft = journey("encodeJourneyDraft");
  const decodeJourneyDraft = journey("decodeJourneyDraft");
  const forbiddenDrafts = [
    { ...draft, customerName: "山田 花子" },
    { ...draft, contact: "hanako@example.invalid" },
    { ...draft, managementKey },
    { ...draft, ownerToken: "owner-token" },
  ];

  for (const forbidden of forbiddenDrafts) {
    assert.throws(() => encodeJourneyDraft(forbidden));
    assert.equal(decodeJourneyDraft(JSON.stringify(forbidden), now), null);
  }
});

test("persists an owned booking proof only after opt-in and rejects malformed records", () => {
  const saveOwnedBookingRecord = journey("saveOwnedBookingRecord");
  const record = {
    reservationId: "11111111-1111-4111-8111-111111111111",
    date: "2026-08-20",
    managementKey,
    savedAt: now,
  };

  assert.deepEqual(saveOwnedBookingRecord([], record, false), []);
  assert.deepEqual(saveOwnedBookingRecord([], record, true), [record]);
  assert.throws(() =>
    saveOwnedBookingRecord([], { ...record, reservationId: "not-a-uuid" }, true),
  );
});

test("filters expired or malformed owned booking records and lets the customer remove one", () => {
  const readOwnedBookingRecords = journey("readOwnedBookingRecords");
  const removeOwnedBookingRecord = journey("removeOwnedBookingRecord");
  const currentRecord = {
    reservationId: "11111111-1111-4111-8111-111111111111",
    date: "2026-08-20",
    managementKey,
    savedAt: now - 1,
  };
  const otherRecord = {
    reservationId: "22222222-2222-4222-8222-222222222222",
    date: "2026-08-21",
    managementKey,
    savedAt: now - 1,
  };

  assert.deepEqual(
    readOwnedBookingRecords(
      [
        currentRecord,
        { ...currentRecord, reservationId: "invalid" },
        { ...currentRecord, savedAt: now - year },
      ],
      now,
    ),
    [currentRecord],
  );
  assert.deepEqual(
    removeOwnedBookingRecord([currentRecord, otherRecord], currentRecord.reservationId),
    [otherRecord],
  );
});

test("keeps a 24-hour pending mutation separate from journey drafts", () => {
  const encodePendingMutationRecord = journey("encodePendingMutationRecord");
  const decodePendingMutationRecord = journey("decodePendingMutationRecord");
  const decodeJourneyDraft = journey("decodeJourneyDraft");
  const pending = {
    commandId: "33333333-3333-4333-8333-333333333333",
    request: {
      settingsVersion: 7,
      serviceIds: ["trim.v2"],
      resourceId: "chair:a",
      date: "2026-08-20",
      startTime: "10:00",
      customerName: "山田 花子",
      contact: "hanako@example.invalid",
      consentVersion: "consent:v7",
      consent: true,
    },
    managementKey,
    retryAt: now,
  };
  const encoded = encodePendingMutationRecord(pending);

  assert.equal(typeof encoded, "string");
  assert.deepEqual(decodePendingMutationRecord(encoded, now + day - 1), pending);
  assert.equal(decodePendingMutationRecord(encoded, now + day), null);
  assert.equal(decodeJourneyDraft(encoded, now), null);
  assert.throws(() =>
    encodePendingMutationRecord({ ...pending, ownerToken: "owner-token" }),
  );
  assert.throws(() =>
    encodePendingMutationRecord({
      ...pending,
      request: { ...pending.request, resourceId: "chair/a" },
    }),
  );
});

test("round-trips an owner create retry without retaining the owner token or digest", () => {
  const encodePendingMutationRecord = journey("encodePendingMutationRecord");
  const decodePendingMutationRecord = journey("decodePendingMutationRecord");
  const pending = {
    operation: "owner-create",
    commandId: "55555555-5555-4555-8555-555555555555",
    request: {
      settingsVersion: 7,
      serviceIds: ["trim"],
      resourceId: "chair-a",
      date: "2026-08-20",
      startTime: "10:00",
      customerName: "架空 花子",
      contact: "hanako@example.invalid",
      consentVersion: "consent-v7",
    },
    managementKey,
    retryAt: now,
  };
  const encoded = encodePendingMutationRecord(pending);

  assert.deepEqual(decodePendingMutationRecord(encoded, now + day - 1), pending);
  assert.equal(decodePendingMutationRecord(encoded, now + day), null);
  assert.equal(encoded.includes("owner-token"), false);
  assert.equal(encoded.includes("managementDigest"), false);
  assert.throws(() =>
    encodePendingMutationRecord({ ...pending, ownerToken: "owner-token" }),
  );
  assert.throws(() =>
    encodePendingMutationRecord({
      ...pending,
      request: { ...pending.request, managementDigest: "a".repeat(64) },
    }),
  );
});

test("accepts an 80-code-point astral customer name in a pending mutation", () => {
  const encodePendingMutationRecord = journey("encodePendingMutationRecord");
  const decodePendingMutationRecord = journey("decodePendingMutationRecord");
  const pending = {
    commandId: "44444444-4444-4444-8444-444444444444",
    request: {
      settingsVersion: 7,
      serviceIds: ["trim"],
      resourceId: "chair-a",
      date: "2026-08-20",
      startTime: "10:00",
      customerName: "😀".repeat(80),
      contact: "hanako@example.invalid",
      consentVersion: "consent-v7",
      consent: true,
    },
    managementKey,
    retryAt: now,
  };

  assert.deepEqual(
    decodePendingMutationRecord(encodePendingMutationRecord(pending), now),
    pending,
  );
});
