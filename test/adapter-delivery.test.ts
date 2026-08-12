import { env, reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AdapterDelivery } from "../src/adapter-delivery.ts";
import type { InstallationConfig, ReadinessRuntime } from "../src/installation-config.ts";
import type { DayAdapterDescriptor, DayConfig, ReservationDay } from "../src/reservation-day.ts";
import worker from "../src/worker.ts";

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

const identifiers = {
  liffId: "1234567890-abcdefgh",
  loginChannelId: "1234567890",
  messagingChannelId: "9876543210",
};

const installationStub = () =>
  env.INSTALLATION_CONFIG.getByName(
    "installation",
  ) as unknown as DurableObjectStub<InstallationConfig>;

const runtime = (overrides: Partial<ReadinessRuntime> = {}): ReadinessRuntime => ({
  ownerSecretPresent: true,
  ownerAuthenticated: true,
  turnstileSecretPresent: true,
  lineSecretPresent: true,
  hostname: "example.test",
  ...overrides,
});

const lineCommand = (
  operation: "line.settings" | "line.enable" | "line.disable",
  expectedLifecycleVersion: number,
  overrides: Record<string, unknown> = {},
) =>
  installationStub().executeLineCommand(
    {
      operation,
      commandId: crypto.randomUUID(),
      expectedLifecycleVersion,
      ...(operation === "line.disable" ? {} : { identifiers }),
      ...overrides,
    },
    runtime(),
  );

const fetchConfig = async (customEnv: Env = env): Promise<string> => {
  const response = await worker.fetch(
    new Request("https://example.test/api/config"),
    customEnv,
  );
  expect(response.status).toBe(200);
  return response.text();
};

describe("LINE lifecycle authority", () => {
  it("runs the shared command pipeline: receipts, CAS, phase gates", async () => {
    const commandId = crypto.randomUUID();
    const first = await lineCommand("line.settings", 0, { commandId });
    expect(first).toEqual({ ok: true, phase: "disabled", lifecycleVersion: 1, replayed: false });

    // Same command replays; a different payload under the same id conflicts.
    expect(await lineCommand("line.settings", 0, { commandId })).toEqual({
      ok: true,
      phase: "disabled",
      lifecycleVersion: 1,
      replayed: true,
    });
    expect(
      await lineCommand("line.settings", 1, { commandId }),
    ).toEqual({ ok: false, code: "IDEMPOTENCY_CONFLICT" });

    // Stale version, wrong phase, missing secret.
    expect(await lineCommand("line.settings", 0)).toEqual({
      ok: false,
      code: "VERSION_CONFLICT",
    });
    expect(await lineCommand("line.disable", 1)).toEqual({
      ok: false,
      code: "PHASE_CONFLICT",
    });
    expect(
      await installationStub().executeLineCommand(
        {
          operation: "line.enable",
          commandId: crypto.randomUUID(),
          expectedLifecycleVersion: 1,
          identifiers,
        },
        runtime({ lineSecretPresent: false }),
      ),
    ).toEqual({ ok: false, code: "SECRET_MISSING" });

    const status = await installationStub().lineAdapterStatus();
    expect(status).toMatchObject({
      phase: "disabled",
      lifecycleVersion: 1,
      draft: identifiers,
      active: null,
      operationInFlight: false,
    });
  });

  it("keeps the config JSON byte-identical while only a draft exists", async () => {
    const baseline = await fetchConfig();
    await lineCommand("line.settings", 0);
    expect(await fetchConfig()).toBe(baseline);

    // The lifecycle table stays invisible to the exact-set schema check.
    const tables = await runInDurableObject(installationStub(), (_instance, state) =>
      state.storage.sql
        .exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT GLOB '_cf_*' AND name NOT GLOB '__*' ORDER BY name",
        )
        .toArray()
        .map(({ name }) => name),
    );
    expect(tables).toEqual(["installation_state"]);
  });

  it("enables through the saga, mints strictly above high-water, and serves the capability", async () => {
    await lineCommand("line.settings", 0);
    const enabled = await lineCommand("line.enable", 1);
    expect(enabled).toMatchObject({ ok: true, lifecycleVersion: 2 });

    const status = await installationStub().lineAdapterStatus();
    expect(status).toMatchObject({
      phase: "active",
      lifecycleVersion: 2,
      active: { ...identifiers, generation: 1 },
      operationInFlight: false,
      highWaterCopy: 1,
    });
    expect(await deliveryStub().readMeta()).toMatchObject({
      state: "active",
      generation: 1,
      highWater: 1,
    });

    const context = await installationStub().getContext();
    expect(context.line).toMatchObject({ phase: "active", generation: 1 });
    expect(context.line!.lease.notAfter - context.line!.lease.issuedAt).toBe(30_000);

    const config = JSON.parse(await fetchConfig()) as Record<string, unknown>;
    expect(config.lineAdapter).toEqual({ liffId: identifiers.liffId });

    // Same capability read without the messaging secret: cleanup marker.
    const noSecretEnv = Object.create(env) as Env;
    Object.defineProperty(noSecretEnv, "LINE_MESSAGING_CHANNEL_SECRET", {
      value: undefined,
    });
    const degraded = JSON.parse(await fetchConfig(noSecretEnv)) as Record<string, unknown>;
    expect(degraded.lineAdapter).toEqual({ cleanup: true });
  });

  it("disables through the lease-wait saga, purges, clears the draft, and re-enables above high-water", async () => {
    const baseline = await fetchConfig();
    await lineCommand("line.settings", 0);
    await lineCommand("line.enable", 1);

    const disabled = await lineCommand("line.disable", 2);
    expect(disabled).toMatchObject({ ok: true, phase: "deactivating", lifecycleVersion: 3 });
    expect(await deliveryStub().readMeta()).toMatchObject({ state: "deactivating" });
    const during = JSON.parse(await fetchConfig()) as Record<string, unknown>;
    expect(during.lineAdapter).toEqual({ cleanup: true });

    // The final pass waits out the descriptor lease window. Under the frozen
    // clock the saga holds in deactivating; once the clock passes lease
    // expiry, driving the alarm completes the purge. (The runtime may have
    // auto-fired the past-dated alarm already, so fire-then-poll.)
    expect((await installationStub().lineAdapterStatus()).phase).toBe("deactivating");
    vi.spyOn(Date, "now").mockReturnValue(NOW + 61_000);
    await runDurableObjectAlarm(installationStub());
    await vi.waitFor(
      async () => {
        expect((await installationStub().lineAdapterStatus()).phase).toBe("disabled");
      },
      { timeout: 5_000, interval: 50 },
    );
    const after = await installationStub().lineAdapterStatus();
    expect(after).toMatchObject({ phase: "disabled", draft: null, active: null });
    expect(await deliveryStub().readMeta()).toMatchObject({
      state: "disabled",
      highWater: 1,
    });
    expect((await deliveryCounts()).links).toBe(0);
    expect((await deliveryCounts()).deliveries).toBe(0);
    expect(await fetchConfig()).toBe(baseline);

    // Re-enable mints strictly above the surviving high-water.
    await lineCommand("line.settings", 3);
    await lineCommand("line.enable", 4);
    expect(await deliveryStub().readMeta()).toMatchObject({
      state: "active",
      generation: 2,
      highWater: 2,
    });
  });

  it("gates the admin routes and accepts the full HTTP flow", async () => {
    const post = (path: string, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
      worker.fetch(
        new Request(`https://example.test${path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "https://example.test",
            ...headers,
          },
          body: JSON.stringify(body),
        }),
        env,
      );
    const ownerHeaders = {
      authorization: "Bearer owner-test-token-0123456789abcdef0123456789",
    };

    // Owner gate first.
    expect(
      (
        await post("/api/admin/line/settings", {
          commandId: crypto.randomUUID(),
          expectedLifecycleVersion: 0,
          identifiers,
        })
      ).status,
    ).toBe(401);

    const accepted = await post(
      "/api/admin/line/settings",
      { commandId: crypto.randomUUID(), expectedLifecycleVersion: 0, identifiers },
      ownerHeaders,
    );
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ ok: true, phase: "disabled" });

    // Body-supplied operation and unknown keys are refused.
    expect(
      (
        await post(
          "/api/admin/line/enable",
          {
            operation: "line.disable",
            commandId: crypto.randomUUID(),
            expectedLifecycleVersion: 1,
            identifiers,
          },
          ownerHeaders,
        )
      ).status,
    ).toBe(400);

    const enabled = await post(
      "/api/admin/line/enable",
      { commandId: crypto.randomUUID(), expectedLifecycleVersion: 1, identifiers },
      ownerHeaders,
    );
    expect(enabled.status).toBe(200);

    const statusResponse = await worker.fetch(
      new Request("https://example.test/api/admin/line/status", {
        headers: ownerHeaders,
      }),
      env,
    );
    expect(statusResponse.status).toBe(200);
    expect(await statusResponse.json()).toMatchObject({
      phase: "active",
      secretPresent: true,
      authority: { state: "active", generation: 1 },
    });
  });
});
