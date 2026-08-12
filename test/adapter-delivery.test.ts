import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AdapterDelivery } from "../src/adapter-delivery.ts";
import type { DayAdapterDescriptor, DayConfig, ReservationDay } from "../src/reservation-day.ts";

const NOW = Date.parse("2025-01-14T15:00:00.000Z");

const day: DayConfig & {
  settingsVersion: number;
  resources: Array<{ id: string; label: string; active: boolean }>;
  services: Array<{
    id: string;
    label: string;
    category: string | null;
    durationMinutes: number;
    cleanupMinutes: number;
    priceYen: number | null;
    eligibleResourceIds: string[];
    active: boolean;
  }>;
  opensAt: string;
  closesAt: string;
  startIntervalMinutes: number;
  consentVersion: string;
} = {
  date: "2025-01-15",
  settingsVersion: 7,
  resourceIds: ["resource-chair-a"],
  resources: [{ id: "resource-chair-a", label: "架空チェア A", active: true }],
  services: [
    {
      id: "service-cut",
      label: "架空カット",
      category: "ヘア",
      durationMinutes: 45,
      cleanupMinutes: 15,
      priceYen: 4_000,
      eligibleResourceIds: ["resource-chair-a"],
      active: true,
    },
  ],
  opensAt: "09:00",
  closesAt: "13:00",
  startIntervalMinutes: 30,
  startTimes: ["09:00", "09:30", "10:00", "10:30", "11:00", "11:30", "12:00"],
  slotMinutes: 60,
  consentVersion: "consent-v2",
  purgeAt: Date.parse("2100-01-01T00:00:00.000Z"),
};

const descriptor = (
  overrides: Partial<DayAdapterDescriptor> = {},
): DayAdapterDescriptor => ({
  consumer: "line",
  generation: 1,
  phase: "active",
  leaseIssuedAt: NOW - 1_000,
  leaseNotAfter: NOW + 30_000,
  ...overrides,
});

const adapterDay = (overrides: Partial<DayAdapterDescriptor> = {}) => ({
  ...day,
  adapter: descriptor(overrides),
});

const dayStub = (config: { date: string } = day) =>
  env.RESERVATION_DAYS.getByName(
    `single-location:${config.date}`,
  ) as unknown as DurableObjectStub<ReservationDay>;

const deliveryStub = () =>
  env.ADAPTER_DELIVERY.getByName(
    "installation",
  ) as unknown as DurableObjectStub<AdapterDelivery>;

const createInput = () => ({
  commandId: crypto.randomUUID(),
  settingsVersion: day.settingsVersion,
  serviceIds: ["service-cut"],
  resourceId: "resource-chair-a",
  date: day.date,
  startTime: "09:00",
  customerName: "架空 花子",
  contact: "hanako@example.invalid",
  consentVersion: day.consentVersion,
  managementDigest: "a".repeat(64),
});

const approveInput = (reservationId: string) => ({
  commandId: crypto.randomUUID(),
  date: day.date,
  reservationId,
  action: "approve" as const,
});

const createPending = async (): Promise<string> => {
  const created = await dayStub().createPublic(day, createInput());
  expect(created).toMatchObject({ ok: true, status: "pending" });
  if (!created.ok) throw new Error("unreachable");
  return created.reservationId;
};

const outboxRows = (stub = dayStub()) =>
  runInDurableObject(stub, (_instance, state) =>
    state.storage.sql
      .exec<{ event_id: string; generation: number; seq: number; type: string }>(
        "SELECT event_id, generation, seq, type FROM __adapter_outbox ORDER BY seq",
      )
      .toArray(),
  );

const adapterTableCount = (stub = dayStub()) =>
  runInDurableObject(stub, (_instance, state) =>
    state.storage.sql
      .exec<{ n: number }>(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name GLOB '__adapter*'",
      )
      .toArray()[0]?.n ?? 0,
  );

const deliveryCounts = () =>
  runInDurableObject(deliveryStub(), (_instance, state) => {
    const count = (table: string) =>
      state.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)
        .toArray()[0]?.n ?? 0;
    return {
      accepted: count("accepted_events"),
      links: count("links"),
      deliveries: count("deliveries"),
      webhookDedup: count("webhook_dedup"),
      ledger: count("ledger"),
      counters: count("counters"),
    };
  });

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

describe("adapter event foundation", () => {
  it("keeps adapter tables invisible to legacy callers while still refusing unknown tables", async () => {
    const reservationId = await createPending();
    const approved = await dayStub().transitionOwner(adapterDay(), approveInput(reservationId));
    expect(approved).toMatchObject({ ok: true, status: "approved" });

    expect(await adapterTableCount()).toBe(2);
    expect(await outboxRows()).toMatchObject([
      { event_id: "2025-01-15#1", generation: 1, seq: 1, type: "approve" },
    ]);

    // A pre-adapter caller (no adapter field) sees a fully working day.
    const status = await dayStub().statusPublic(day, {
      date: day.date,
      reservationId,
      managementKey: "K".repeat(43),
    });
    expect(status).toMatchObject({ ok: false });
    const availability = await dayStub().availability(day, ["service-cut"]);
    expect(availability).toMatchObject({ ok: true });
    const listed = await dayStub().listOwner(day);
    expect(listed).toMatchObject({ ok: true });

    // The exact-set schema check still refuses a non-`__` stranger.
    await runInDurableObject(dayStub(), (_instance, state) => {
      state.storage.sql.exec("CREATE TABLE rogue (x INTEGER)");
    });
    const refused = await dayStub().availability(day, ["service-cut"]);
    expect(refused).toEqual({ ok: false, code: "TEMPORARILY_UNAVAILABLE" });
  });

  it("assigns deterministic event ids from a dedicated monotonic sequence", async () => {
    const reservationId = await createPending();
    await dayStub().transitionOwner(adapterDay(), approveInput(reservationId));
    const cancelled = await dayStub().transitionOwner(adapterDay(), {
      commandId: crypto.randomUUID(),
      date: day.date,
      reservationId,
      action: "cancel",
    });
    expect(cancelled).toMatchObject({ ok: true, status: "cancelled" });

    expect(await outboxRows()).toMatchObject([
      { event_id: "2025-01-15#1", seq: 1, type: "approve" },
      { event_id: "2025-01-15#2", seq: 2, type: "cancel" },
    ]);
    expect(await dayStub().readEventSequence()).toEqual({ eventSeq: 2 });
  });

  it("rolls the whole transaction back on an expired lease and reports RETRY_CONFIG", async () => {
    const reservationId = await createPending();
    const result = await dayStub().transitionOwner(
      adapterDay({ leaseNotAfter: NOW - 1 }),
      approveInput(reservationId),
    );
    expect(result).toEqual({ ok: false, code: "RETRY_CONFIG" });

    // Nothing committed: no adapter schema, booking still pending.
    expect(await adapterTableCount()).toBe(0);
    const listed = await dayStub().listOwner(day);
    expect(listed).toMatchObject({
      ok: true,
      reservations: [{ reservationId, status: "pending" }],
    });
  });

  it("emits nothing while the descriptor phase is deactivating", async () => {
    const reservationId = await createPending();
    const approved = await dayStub().transitionOwner(
      adapterDay({ phase: "deactivating" }),
      approveInput(reservationId),
    );
    expect(approved).toMatchObject({ ok: true, status: "approved" });
    expect(await adapterTableCount()).toBe(0);
  });

  it("delivers via poke, dedups a lost ack, and leaves the outbox empty", async () => {
    // Emit both events while the delivery object is inactive so the automatic
    // post-commit poke cannot race this test's own choreography.
    const reservationId = await createPending();
    await dayStub().transitionOwner(adapterDay(), approveInput(reservationId));
    await dayStub().transitionOwner(adapterDay(), {
      commandId: crypto.randomUUID(),
      date: day.date,
      reservationId,
      action: "cancel",
    });
    expect(await outboxRows()).toHaveLength(2);

    const activated = await deliveryStub().activate({ generation: 1, watermark: 0 });
    expect(activated).toMatchObject({ ok: true, meta: { state: "active", generation: 1 } });
    // Accept-then-die-before-ack: event #2 is already recorded on the
    // receiver while the day still holds both rows. The poke must record #1,
    // skip #2, and ack both.
    await runInDurableObject(deliveryStub(), (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO accepted_events (event_id, date, generation, seq, disposition, accepted_at)
         VALUES ('2025-01-15#2', '2025-01-15', 1, 2, 'accepted', ?)`,
        new Date().toISOString(),
      );
    });
    const poked = await deliveryStub().pokeDay({ date: day.date });
    expect(poked).toEqual({ ok: true, drained: 2 });
    expect(await outboxRows()).toEqual([]);
    const counts = await deliveryCounts();
    expect(counts.accepted).toBe(2);
  });

  it("cancels stale-generation events at the receiver", async () => {
    const reservationId = await createPending();
    await dayStub().transitionOwner(adapterDay({ generation: 1 }), approveInput(reservationId));

    const activated = await deliveryStub().activate({ generation: 2, watermark: 0 });
    expect(activated).toMatchObject({ ok: true });
    await deliveryStub().pokeDay({ date: day.date });

    const dispositions = await runInDurableObject(deliveryStub(), (_instance, state) =>
      state.storage.sql
        .exec<{ event_id: string; disposition: string }>(
          "SELECT event_id, disposition FROM accepted_events",
        )
        .toArray(),
    );
    expect(dispositions).toEqual([
      { event_id: "2025-01-15#1", disposition: "canceled" },
    ]);
  });

  it("refuses generations at or below the persistent high-water", async () => {
    await deliveryStub().activate({ generation: 3, watermark: 0 });
    await deliveryStub().beginDisable();
    await deliveryStub().completeDisable();

    expect(await deliveryStub().activate({ generation: 3, watermark: 0 })).toEqual({
      ok: false,
      code: "STALE_GENERATION",
    });
    expect(await deliveryStub().activate({ generation: 2, watermark: 0 })).toEqual({
      ok: false,
      code: "STALE_GENERATION",
    });
    const meta = await deliveryStub().readMeta();
    expect(meta).toMatchObject({ state: "disabled", highWater: 3 });
  });

  it("acknowledges nothing and persists nothing while disabled", async () => {
    await deliveryStub().activate({ generation: 1, watermark: 0 });
    await deliveryStub().beginDisable();
    await deliveryStub().completeDisable();

    // A stale projection still claiming an active generation commits an event
    // after the authority disabled — exactly the writer the priority-0 branch
    // exists for. The automatic handoff poke must refuse it too.
    const reservationId = await createPending();
    await dayStub().transitionOwner(adapterDay(), approveInput(reservationId));
    expect(await outboxRows()).toHaveLength(1);

    const before = await deliveryCounts();
    const metaBefore = await deliveryStub().readMeta();
    const poked = await deliveryStub().pokeDay({ date: day.date });
    expect(poked).toEqual({ ok: true, drained: 0 });
    expect(await deliveryCounts()).toEqual(before);
    expect(await deliveryStub().readMeta()).toEqual(metaBefore);
    // The day row is refused, not consumed — the disable saga's final pass
    // owns its removal.
    expect(await outboxRows()).toHaveLength(1);
  });

  it("keeps no alarm scheduled once disabled with drained stores", async () => {
    await deliveryStub().activate({ generation: 1, watermark: 0 });
    await deliveryStub().beginDisable();
    await deliveryStub().completeDisable();
    const alarm = await runInDurableObject(deliveryStub(), (_instance, state) =>
      state.storage.getAlarm(),
    );
    expect(alarm).toBeNull();
  });

  it("creates nothing on a day that never emitted an event", async () => {
    const fresh = dayStub({ date: "2025-02-01" });
    expect(await fresh.drainOutbox({ consumer: "line" })).toEqual({
      events: [],
      more: false,
    });
    expect(await fresh.readEventSequence()).toEqual({ eventSeq: 0 });
    const tables = await runInDurableObject(fresh, (_instance, state) =>
      state.storage.sql
        .exec<{ n: number }>(
          "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT GLOB '_cf_*'",
        )
        .toArray()[0]?.n ?? 0,
    );
    expect(tables).toBe(0);
    const alarm = await runInDurableObject(fresh, (_instance, state) =>
      state.storage.getAlarm(),
    );
    expect(alarm).toBeNull();
  });

  it("re-pokes lazily on next use after a died handoff", async () => {
    const reservationId = await createPending();
    // Handoff target inactive at commit time: rows stay behind.
    await dayStub().transitionOwner(adapterDay(), approveInput(reservationId));
    expect(await outboxRows()).toHaveLength(1);

    await deliveryStub().activate({ generation: 1, watermark: 0 });
    // Any later use of the day re-pokes the delivery object.
    await dayStub().statusPublic(adapterDay(), {
      date: day.date,
      reservationId,
      managementKey: "K".repeat(43),
    });
    await vi.waitFor(
      async () => {
        expect((await deliveryCounts()).accepted).toBe(1);
        expect(await outboxRows()).toEqual([]);
      },
      { timeout: 5_000, interval: 100 },
    );
  });
});
