import assert from "node:assert/strict";
import test from "node:test";

type JourneyModule = {
  decodeJourneyDraft: (encoded: unknown, now: number) => unknown;
  decodePendingMutationRecord: (encoded: unknown, now: number) => unknown;
  duplicateAcknowledgementNeeded: (statuses: unknown) => unknown;
  duplicateCheckCandidates: (records: unknown, date: unknown, now: number) => unknown;
  encodeJourneyDraft: (draft: unknown) => unknown;
  encodePendingMutationRecord: (record: unknown) => unknown;
  filterServiceCatalog: (services: unknown, query: unknown) => unknown;
  getJourneyStep: (state: unknown) => unknown;
  pickAutoResource: (resources: unknown, previousId: unknown) => unknown;
  readOwnedBookingRecords: (records: unknown, now: number) => unknown;
  removeOwnedBookingRecord: (records: unknown, reservationId: string) => unknown;
  restoreJourneyDraft: (draft: unknown, current: unknown) => unknown;
  saveOwnedBookingRecord: (
    records: unknown,
    record: unknown,
    remember: boolean,
  ) => unknown;
  summarizeJourney: (
    selection: unknown,
    config: unknown,
    availability: unknown,
  ) => unknown;
  summarizeServiceSelection: (services: unknown, selectedIds: unknown) => unknown;
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

test("summarizes the journey from catalog labels and server-derived totals", () => {
  const summarizeJourney = journey("summarizeJourney");
  const config = {
    services: [
      { id: "trim", label: "カット" },
      { id: "color", label: "カラー" },
    ],
    resources: [{ id: "chair-a", label: "担当 A" }],
  };

  assert.deepEqual(
    summarizeJourney({ ...completeSelection, serviceIds: ["trim", "color"] }, config, null),
    {
      serviceLabels: ["カット", "カラー"],
      resourceLabel: "担当 A",
      date: "2026-08-20",
      startTime: "10:00",
      serviceMinutes: null,
      cleanupMinutes: null,
      occupiedMinutes: null,
      priceYen: null,
    },
  );

  const availability = {
    services: [{ id: "trim", label: "カット（確定）" }],
    resources: [{ id: "chair-a", label: "担当 A（確定）", startTimes: ["10:00"] }],
    serviceMinutes: 60,
    cleanupMinutes: 15,
    occupiedMinutes: 75,
    priceYen: 5_000,
  };
  assert.deepEqual(summarizeJourney(completeSelection, config, availability), {
    serviceLabels: ["カット（確定）"],
    resourceLabel: "担当 A（確定）",
    date: "2026-08-20",
    startTime: "10:00",
    serviceMinutes: 60,
    cleanupMinutes: 15,
    occupiedMinutes: 75,
    priceYen: 5_000,
  });

  assert.deepEqual(summarizeJourney(null, null, null), {
    serviceLabels: [],
    resourceLabel: null,
    date: null,
    startTime: null,
    serviceMinutes: null,
    cleanupMinutes: null,
    occupiedMinutes: null,
    priceYen: null,
  });
});

test("auto-assigns the steadiest resource when choice is hidden", () => {
  const pickAutoResource = journey("pickAutoResource");
  const resources = [
    { id: "chair-a", label: "担当 A", startTimes: ["10:00"] },
    { id: "chair-b", label: "担当 B", startTimes: ["10:00", "11:00"] },
    { id: "chair-c", label: "担当 C", startTimes: ["09:00", "13:00"] },
  ];

  assert.deepEqual(pickAutoResource(resources, "chair-a"), resources[0]);
  assert.deepEqual(pickAutoResource(resources, null), resources[1]);
  assert.deepEqual(pickAutoResource(resources, "unknown"), resources[1]);
  assert.deepEqual(
    pickAutoResource([{ ...resources[0], startTimes: [] }, resources[1]], "chair-a"),
    resources[1],
  );
  assert.deepEqual(
    pickAutoResource([{ ...resources[0], startTimes: [] }], "chair-a"),
    { ...resources[0], startTimes: [] },
  );
  assert.equal(pickAutoResource([], "chair-a"), null);
  assert.equal(pickAutoResource(undefined, null), null);
});

test("filters the service catalog by folded label and category text", () => {
  const filterServiceCatalog = journey("filterServiceCatalog");
  const services = [
    { id: "cut", label: "カット", category: "ヘア" },
    { id: "color", label: "カラー", category: "ヘア" },
    { id: "nail", label: "ネイルケア", category: null },
  ];

  assert.deepEqual(filterServiceCatalog(services, ""), services);
  assert.deepEqual(filterServiceCatalog(services, "  "), services);
  assert.deepEqual(filterServiceCatalog(services, "ネイル"), [services[2]]);
  // NFKC folding: half-width katakana finds the full-width label.
  assert.deepEqual(filterServiceCatalog(services, "ｶｯﾄ"), [services[0]]);
  // Category text is searchable too.
  assert.deepEqual(filterServiceCatalog(services, "ヘア"), [services[0], services[1]]);
  assert.deepEqual(filterServiceCatalog(services, "存在しない"), []);
  assert.deepEqual(filterServiceCatalog(undefined, "x"), []);
});

test("totals the compact selection and withholds a partial price sum", () => {
  const summarizeServiceSelection = journey("summarizeServiceSelection");
  const services = [
    { id: "cut", label: "カット", durationMinutes: 60, priceYen: 5_000 },
    { id: "color", label: "カラー", durationMinutes: 90, priceYen: 8_000 },
    { id: "spa", label: "スパ", durationMinutes: 30, priceYen: null },
  ];

  assert.deepEqual(summarizeServiceSelection(services, ["cut", "color"]), {
    selected: [
      { id: "cut", label: "カット" },
      { id: "color", label: "カラー" },
    ],
    count: 2,
    durationMinutes: 150,
    priceYen: 13_000,
  });
  // One unlisted price poisons the sum: showing 13,000円 for a set that also
  // includes the spa would read as the full price.
  assert.equal(summarizeServiceSelection(services, ["cut", "color", "spa"]).priceYen, null);
  assert.deepEqual(summarizeServiceSelection(services, []), {
    selected: [],
    count: 0,
    durationMinutes: 0,
    priceYen: null,
  });
  assert.deepEqual(summarizeServiceSelection(undefined, ["cut"]).count, 0);
});

test("selects at most three same-day remembered bookings for the duplicate check", () => {
  const duplicateCheckCandidates = journey("duplicateCheckCandidates");
  const record = (index: number, date: string) => ({
    reservationId: `${index}1111111-1111-4111-8111-111111111111`.slice(0, 36),
    date,
    managementKey,
    savedAt: now - index,
  });
  // Stored records append oldest first, so the same-day list runs 4 → 1.
  const sameDay = [4, 3, 2, 1].map((index) => record(index, "2026-08-20"));
  const records = [record(5, "2026-08-21"), ...sameDay];

  // Only the same day counts, newest three of them, and never expired records.
  assert.deepEqual(
    duplicateCheckCandidates(records, "2026-08-20", now),
    sameDay.slice(1),
  );
  assert.deepEqual(duplicateCheckCandidates(records, "2026-08-22", now), []);
  assert.deepEqual(
    duplicateCheckCandidates([{ ...sameDay[0], savedAt: now - year }], "2026-08-20", now),
    [],
  );
  assert.deepEqual(duplicateCheckCandidates(undefined, "2026-08-20", now), []);
});

test("requires acknowledgement only for live duplicate statuses", () => {
  const duplicateAcknowledgementNeeded = journey("duplicateAcknowledgementNeeded");

  assert.equal(duplicateAcknowledgementNeeded(["pending"]), true);
  assert.equal(duplicateAcknowledgementNeeded(["cancelled", "approved"]), true);
  // Finished or failed lookups never block the journey.
  assert.equal(duplicateAcknowledgementNeeded(["cancelled", "expired", null]), false);
  assert.equal(duplicateAcknowledgementNeeded([]), false);
  assert.equal(duplicateAcknowledgementNeeded(undefined), false);
});
