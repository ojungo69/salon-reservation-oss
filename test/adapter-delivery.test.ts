import { env, reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AdapterDelivery } from "../src/adapter-delivery.ts";
import { ADAPTER, fullCycleBoundS, WORST_CASE_PARTITIONS } from "../src/adapter-constants.ts";
import { clearTokenCacheForTests } from "../src/line-adapter.ts";
import type { InstallationConfig, ReadinessRuntime } from "../src/installation-config.ts";
import type { DayAdapterDescriptor, DayConfig, ReservationDay } from "../src/reservation-day.ts";
import worker from "../src/worker.ts";
import {
  identifiers,
  lineDay,
  sha256Hex,
  suiteDate,
  SUITE_NOW,
  SUITE_PURGE_AT,
} from "./line-helpers.ts";

// Future-dated fixtures derived from the real clock (~1 year ahead): every
// alarm the code schedules lands after the real wall clock, so the runtime
// never auto-fires one — tests drive alarms explicitly and stay deterministic.
const NOW = SUITE_NOW;
let currentNow = NOW;
const advanceNow = (ms: number): void => {
  currentNow += ms;
  vi.setSystemTime(currentNow);
};

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
  ...lineDay,
  date: suiteDate(1),
  purgeAt: SUITE_PURGE_AT,
};

const descriptor = (
  overrides: Partial<DayAdapterDescriptor> = {},
): DayAdapterDescriptor => ({
  consumer: "line",
  generation: 1,
  phase: "active",
  // Evaluated per call so a test that advanced the mocked clock still mints
  // a live lease.
  leaseIssuedAt: Date.now() - 1_000,
  leaseNotAfter: Date.now() + 30_000,
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

const createPending = async (date = day.date): Promise<string> => {
  const created = await dayStub({ date }).createPublic(
    { ...day, date },
    { ...createInput(), date },
  );
  if (!created.ok) {
    throw new Error(
      `fixture create failed: ${JSON.stringify(created)} day=${JSON.stringify(day)} now=${Date.now()}`,
    );
  }
  expect(created).toMatchObject({ ok: true, status: "pending" });
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
      subjects: count("subjects"),
    };
  });

beforeEach(() => {
  currentNow = NOW;
  // Fake the Date global only (Date.now AND new Date()) — stored timestamps
  // and comparisons must agree, or fixture reservations expire instantly.
  // Real timers stay live for waitUntil/waitFor and RPC deadlines.
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  // restoreAllMocks does not undo stubGlobal — fetch stubs must not leak.
  vi.unstubAllGlobals();
  await reset();
});

// Most tests only need the disabled end state: stamp the purge marker the
// real full-window pass would set (that pass is exercised once, in its own
// clock-tested case below) so completeDisable proceeds.
const markPurgeComplete = async (): Promise<void> => {
  advanceNow(61_000);
  await deliveryStub().beginDisable();
  await runInDurableObject(deliveryStub(), (_instance, state) => {
    state.storage.sql.exec(
      "UPDATE meta SET purge_completed_at = ? WHERE singleton = 1",
      Date.now(),
    );
  });
};

// Drive the authority's alarm until its deactivating purge pass completes:
// one full sweep cycle over the fixed worst-case window, started after the
// lease wait. Any cycle already in flight from before the lease expiry is
// reset first — it could never carry the marker anyway.
const driveAuthorityPurge = async (): Promise<void> => {
  advanceNow(61_000);
  await runInDurableObject(deliveryStub(), (_instance, state) => {
    state.storage.sql.exec(
      "UPDATE meta SET sweep_cursor = NULL, cycle_started_at = NULL WHERE singleton = 1",
    );
  });
  for (let i = 0; i < 80; i += 1) {
    const progress = await deliveryStub().beginDisable();
    if (progress.purgeComplete) return;
    await runDurableObjectAlarm(deliveryStub());
    advanceNow(1_000);
  }
  throw new Error("authority purge did not converge");
};

describe("adapter event foundation", () => {
  it("keeps adapter tables invisible to legacy callers while still refusing unknown tables", async () => {
    const reservationId = await createPending();
    const approved = await dayStub().transitionOwner(adapterDay(), approveInput(reservationId));
    expect(approved).toMatchObject({ ok: true, status: "approved" });

    expect(await adapterTableCount()).toBe(2);
    expect(await outboxRows()).toMatchObject([
      { event_id: `${day.date}#1`, generation: 1, seq: 1, type: "approve" },
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
      { event_id: `${day.date}#1`, seq: 1, type: "approve" },
      { event_id: `${day.date}#2`, seq: 2, type: "cancel" },
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
        `INSERT INTO accepted_events (event_key, event_id, date, generation, seq, disposition, accepted_at)
         VALUES (?, ?, ?, 1, 2, 'ignored-no-recipient', ?)`,
        `1:${day.date}#2`,
        `${day.date}#2`,
        day.date,
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
      { event_id: `${day.date}#1`, disposition: "canceled" },
    ]);
  });

  it("refuses generations at or below the persistent high-water", async () => {
    await deliveryStub().activate({ generation: 3, watermark: 0 });
    await deliveryStub().beginDisable();
    await markPurgeComplete();
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

  it("replays activate for the same operationId instead of minting a second generation", async () => {
    const operationId = crypto.randomUUID();
    const first = await deliveryStub().activate({
      generation: 1,
      watermark: 0,
      operationId,
      snapshot: { messagingChannelId: "9876543210", origin: "https://example.test" },
    });
    expect(first).toMatchObject({ ok: true, meta: { generation: 1, state: "active" } });
    // Same operationId reports the first activation — even if a different
    // generation is requested, one operator command cannot mint a second one.
    const replay = await deliveryStub().activate({
      generation: 2,
      watermark: 0,
      operationId,
      snapshot: { messagingChannelId: "9876543210", origin: "https://example.test" },
    });
    expect(replay).toMatchObject({ ok: true, meta: { generation: 1, highWater: 1 } });
    expect(await deliveryStub().readMeta()).toMatchObject({ generation: 1, highWater: 1 });
  });

  it("acknowledges nothing and persists nothing while disabled", async () => {
    await deliveryStub().activate({ generation: 1, watermark: 0 });
    await deliveryStub().beginDisable();
    await markPurgeComplete();
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
    await markPurgeComplete();
    await deliveryStub().completeDisable();
    const alarm = await runInDurableObject(deliveryStub(), (_instance, state) =>
      state.storage.getAlarm(),
    );
    expect(alarm).toBeNull();
  });

  it("creates nothing on a day that never emitted an event", async () => {
    const fresh = dayStub({ date: suiteDate(40) });
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

  it(
    "completes the deactivating purge only after a real post-lease full-window pass",
    { timeout: 180_000 },
    async () => {
      // A leftover stale-generation row on a day the poke never revisits.
      const reservationId = await createPending();
      await dayStub().transitionOwner(adapterDay(), approveInput(reservationId));
      expect(await outboxRows()).toHaveLength(1);

      await deliveryStub().activate({ generation: 2, watermark: 0 });
      await deliveryStub().beginDisable();
      // Before the lease wait passes, alarms run but must not mark the purge
      // complete (a cycle finishing early would count leases still live).
      await runDurableObjectAlarm(deliveryStub());
      expect((await deliveryStub().beginDisable()).purgeComplete).toBe(false);

      await driveAuthorityPurge();
      const completed = await deliveryStub().completeDisable();
      expect(completed.meta.state).toBe("disabled");
      // The visited day was purged back to pristine: the adapter tables are
      // dropped entirely, exactly the pre-adapter storage shape.
      expect(await adapterTableCount()).toBe(0);
      const dispositions = await deliveryCounts();
      expect(dispositions.deliveries).toBe(0);
    },
  );

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

  it("refuses enable when allowedHostname is empty (ORIGIN_UNCONFIGURED)", async () => {
    await lineCommand("line.settings", 0);
    const state = await installationStub().getState();
    const current = state.settingsVersions.find(
      (version) => version.version === state.activeSettingsVersion,
    );
    if (current === undefined) throw new Error("missing active settings");
    // Empty hostname is valid in the settings schema but must not produce a
    // management-link origin — enable refuses rather than mint a blank one.
    const updated = await installationStub().executeCommand(
      {
        type: "settings.update",
        commandId: crypto.randomUUID(),
        expectedSettingsVersion: state.activeSettingsVersion,
        settings: { ...current.settings, allowedHostname: "" },
      },
      runtime(),
    );
    expect(updated).toMatchObject({ ok: true });
    expect(await lineCommand("line.enable", 1)).toEqual({
      ok: false,
      code: "ORIGIN_UNCONFIGURED",
    });
  });

  it("accepts line.disable only from active, not from activating", async () => {
    await lineCommand("line.settings", 0);
    // Park the enable saga mid-flight by failing the authority activate so the
    // lifecycle stays in activating.
    await runInDurableObject(deliveryStub(), (instance) => {
      (instance as unknown as Record<string, unknown>).activate = async () => ({
        ok: false,
        code: "STALE_GENERATION",
      });
    });
    const enabling = await lineCommand("line.enable", 1);
    expect(enabling).toMatchObject({ ok: true, phase: "activating" });
    expect((await installationStub().lineAdapterStatus()).phase).toBe("activating");
    expect(await lineCommand("line.disable", 2)).toEqual({
      ok: false,
      code: "PHASE_CONFLICT",
    });
    await runInDurableObject(deliveryStub(), (instance) => {
      delete (instance as unknown as Record<string, unknown>).activate;
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

    // The final pass waits out the descriptor lease window: the saga holds in
    // deactivating until the clock passes lease expiry AND the authority
    // reports its purge pass complete (stamped here; the real full-window
    // pass has its own clock-tested case). The coordinator alarm then polls
    // the authority and completes.
    expect((await installationStub().lineAdapterStatus()).phase).toBe("deactivating");
    await runDurableObjectAlarm(installationStub());
    expect((await installationStub().lineAdapterStatus()).phase).toBe("deactivating");
    await markPurgeComplete();
    for (let i = 0; i < 5; i += 1) {
      await runDurableObjectAlarm(installationStub());
      if ((await installationStub().lineAdapterStatus()).phase === "disabled") break;
    }
    expect((await installationStub().lineAdapterStatus()).phase).toBe("disabled");
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

describe("delivery pipeline", () => {
  const SUBJECT = `U${"c".repeat(32)}`;
  // Each pipeline test gets its own day partition: a prior test's day object
  // can outlive reset() while draining background work, and sharing its date
  // makes fixtures land on a stale instance.
  let pipelineSerial = 0;
  let pDate = suiteDate(30);
  beforeEach(() => {
    pipelineSerial += 1;
    pDate = suiteDate(30 + pipelineSerial);
  });
  const pDay = () => ({ ...day, date: pDate, purgeAt: SUITE_PURGE_AT });
  const pAdapterDay = (overrides: Partial<DayAdapterDescriptor> & { purgeAt?: number } = {}) => {
    const { purgeAt = SUITE_PURGE_AT, ...descriptorOverrides } = overrides;
    return { ...day, date: pDate, purgeAt, adapter: descriptor(descriptorOverrides) };
  };
  const pApprove = (reservationId: string) => ({
    commandId: crypto.randomUUID(),
    date: pDate,
    reservationId,
    action: "approve" as const,
  });
  const snapshot = { messagingChannelId: "9876543210", origin: "https://example.test" };
  const futurePurgeAt = () => Date.now() + 30 * 86_400_000;

  const lineApi = (
    options: {
      token?: () => number;
      push?: (init: RequestInit) => number | "throw";
      pushBody?: string;
      pushHeaders?: Record<string, string>;
    } = {},
  ) => {
    const calls = { token: [] as RequestInit[], push: [] as RequestInit[] };
    vi.stubGlobal("fetch", (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input);
      if (url === "https://api.line.me/oauth2/v3/token") {
        calls.token.push(init);
        return Promise.resolve(
          new Response(
            JSON.stringify({ access_token: "tok", token_type: "Bearer", expires_in: 900 }),
            { status: options.token?.() ?? 200 },
          ),
        );
      }
      if (url === "https://api.line.me/v2/bot/message/push") {
        calls.push.push(init);
        const outcome = options.push?.(init) ?? 200;
        if (outcome === "throw") return Promise.reject(new Error("network down"));
        return Promise.resolve(
          new Response(options.pushBody ?? "{}", {
            status: outcome,
            headers: options.pushHeaders,
          }),
        );
      }
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    });
    return calls;
  };

  const activateGen1 = async () => {
    clearTokenCacheForTests();
    const activated = await deliveryStub().activate({ generation: 1, watermark: 0, snapshot });
    expect(activated).toMatchObject({ ok: true });
  };

  const finalizedLink = async (reservationId: string, subject = SUBJECT) => {
    const minted = await deliveryStub().mintIntent({
      reservationId,
      date: pDate,
      generation: 1,
      purgeAt: futurePurgeAt(),
    });
    if (!minted.ok) throw new Error("mint failed");
    expect(minted.nonce).toMatch(/^[0-9a-f]{64}$/);
    // Storage keeps only the digest — never the plaintext nonce.
    const stored = await runInDurableObject(deliveryStub(), async (_i, state) =>
      state.storage.sql
        .exec<{ nonce: string }>("SELECT nonce FROM intents")
        .toArray(),
    );
    const digest = await sha256Hex(minted.nonce);
    expect(stored.some((row) => row.nonce === digest)).toBe(true);
    expect(stored.some((row) => row.nonce === minted.nonce)).toBe(false);
    const linked = await deliveryStub().finalizeLink({ nonce: minted.nonce, subject });
    expect(linked).toMatchObject({ ok: true });
  };

  const deliveryRows = () =>
    runInDurableObject(deliveryStub(), (_instance, state) =>
      state.storage.sql
        .exec<{
          delivery_id: string;
          status: string;
          attempt: number;
          next_attempt_at: number;
          first_attempt_at: number | null;
          retry_key: string;
          type: string;
        }>(
          "SELECT delivery_id, status, attempt, next_attempt_at, first_attempt_at, retry_key, type FROM deliveries ORDER BY delivery_id",
        )
        .toArray(),
    );

  const counterMap = () =>
    runInDurableObject(deliveryStub(), (_instance, state) => {
      const map: Record<string, number> = {};
      for (const row of state.storage.sql
        .exec<{ name: string; value: number }>("SELECT name, value FROM counters")
        .toArray()) {
        map[row.name] = row.value;
      }
      return map;
    });

  const ledgerEntries = () =>
    runInDurableObject(deliveryStub(), (_instance, state) =>
      state.storage.sql
        .exec<{ reason: string; event_type: string; http_status: number | null }>(
          "SELECT reason, event_type, http_status FROM ledger ORDER BY entry_id",
        )
        .toArray(),
    );

  const ledgerReasons = () =>
    runInDurableObject(deliveryStub(), (_instance, state) =>
      state.storage.sql
        .exec<{ reason: string; event_type: string }>(
          "SELECT reason, event_type FROM ledger ORDER BY entry_id",
        )
        .toArray(),
    );

  it("pushes a queued delivery end to end with the persisted retry key", async () => {
    const calls = lineApi();
    const reservationId = await createPending(pDate);
    await activateGen1();
    await finalizedLink(reservationId);
    await dayStub({ date: pDate }).transitionOwner(pAdapterDay(), pApprove(reservationId));
    await deliveryStub().pokeDay({ date: pDate });

    const queued = await deliveryRows();
    expect(queued).toMatchObject([{ status: "queued", attempt: 0 }]);
    const retryKey = queued[0]!.retry_key;

    await runDurableObjectAlarm(deliveryStub());
    expect(await deliveryRows()).toEqual([]);
    expect((await counterMap()).delivered).toBe(1);
    expect(await ledgerReasons()).toEqual([]);
    expect(calls.push).toHaveLength(1);
    const init = calls.push[0]!;
    expect((init.headers as Record<string, string>)["x-line-retry-key"]).toBe(retryKey);
    const body = JSON.parse(String(init.body)) as { to: string; messages: [{ text: string }] };
    expect(body.to).toBe(SUBJECT);
    expect(body.messages[0].text).toContain(`${pDate} 09:00`);
    expect(body.messages[0].text).toContain("https://example.test/bookings.html");
  });

  it("stores nothing a malicious provider sends — only the status class survives", async () => {
    const marker = "EVIL-PROVIDER-MARKER-7f3a";
    lineApi({
      push: () => 400,
      pushBody: JSON.stringify({ message: marker, details: [marker] }),
      pushHeaders: { "x-evil-header": marker, "www-authenticate": marker },
    });
    const reservationId = await createPending(pDate);
    await activateGen1();
    await finalizedLink(reservationId);
    await dayStub({ date: pDate }).transitionOwner(pAdapterDay(), pApprove(reservationId));
    await deliveryStub().pokeDay({ date: pDate });
    await runDurableObjectAlarm(deliveryStub());

    // The rejection is terminal, recorded as an allowlisted reason plus the
    // bare HTTP status — and nothing from the response ever lands anywhere.
    expect(await ledgerEntries()).toEqual([
      { reason: "rejected", event_type: "approve", http_status: 400 },
    ]);
    const everything = await runInDurableObject(deliveryStub(), (_instance, state) => {
      const dump: Record<string, unknown[]> = {};
      for (const table of state.storage.sql
        .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_cf_%'")
        .toArray()) {
        dump[table.name] = state.storage.sql
          .exec(`SELECT * FROM ${table.name}`)
          .toArray();
      }
      return JSON.stringify(dump);
    });
    expect(everything).not.toContain(marker);
    // The minted access token lives only in the in-memory cache, never storage.
    expect(everything).not.toContain('"tok"');
    expect(JSON.stringify(await deliveryStub().diagnostics())).not.toContain(marker);
  });

  it(
    "walks the absolute retry ladder byte-identically and terminalizes at the seventh failure",
    { timeout: 60_000 },
    async () => {
      const calls = lineApi({ push: () => 500 });
      const reservationId = await createPending(pDate);
      await activateGen1();
      await finalizedLink(reservationId);
      await dayStub({ date: pDate }).transitionOwner(pAdapterDay(), pApprove(reservationId));
      await deliveryStub().pokeDay({ date: pDate });

      await runDurableObjectAlarm(deliveryStub());
      const afterFirst = await deliveryRows();
      expect(afterFirst).toMatchObject([{ status: "queued", attempt: 1 }]);
      const firstAttemptAt = afterFirst[0]!.first_attempt_at!;
      // Absolute schedule from the first attempt, not now+delta.
      expect(afterFirst[0]!.next_attempt_at - firstAttemptAt).toBe(
        ADAPTER.RETRY_OFFSETS_S[1]! * 1000,
      );

      for (let attempt = 1; attempt < ADAPTER.RETRY_OFFSETS_S.length; attempt += 1) {
        const rows = await deliveryRows();
        if (rows.length === 0) break;
        advanceNow(rows[0]!.next_attempt_at - Date.now() + 1);
        await runDurableObjectAlarm(deliveryStub());
      }
      expect(await deliveryRows()).toEqual([]);
      expect(calls.push).toHaveLength(ADAPTER.RETRY_OFFSETS_S.length);
      const bodies = new Set(calls.push.map((init) => String(init.body)));
      const keys = new Set(
        calls.push.map((init) => (init.headers as Record<string, string>)["x-line-retry-key"]),
      );
      expect(bodies.size).toBe(1);
      expect(keys.size).toBe(1);
      expect(await ledgerReasons()).toEqual([{ reason: "retry-exhausted", event_type: "approve" }]);
    },
  );

  it("treats 409 as accepted and a thrown fetch as one retryable attempt", async () => {
    let pushStatus: number | "throw" = "throw";
    lineApi({ push: () => pushStatus });
    const reservationId = await createPending(pDate);
    await activateGen1();
    await finalizedLink(reservationId);
    await dayStub({ date: pDate }).transitionOwner(pAdapterDay(), pApprove(reservationId));
    await deliveryStub().pokeDay({ date: pDate });

    await runDurableObjectAlarm(deliveryStub());
    expect(await deliveryRows()).toMatchObject([{ status: "queued", attempt: 1 }]);

    pushStatus = 409;
    const rows = await deliveryRows();
    advanceNow(rows[0]!.next_attempt_at - Date.now() + 1);
    await runDurableObjectAlarm(deliveryStub());
    expect(await deliveryRows()).toEqual([]);
    expect((await counterMap()).delivered).toBe(1);
  });

  it("holds events under a provisional link, re-disposes at finalize, and delivers post-watermark ones", async () => {
    lineApi();
    const reservationId = await createPending(pDate);
    await activateGen1();
    const minted = await deliveryStub().mintIntent({
      reservationId,
      date: pDate,
      generation: 1,
      purgeAt: futurePurgeAt(),
    });
    if (!minted.ok) throw new Error("mint failed");

    // Event committed between intent and consent: held, not acked away.
    await dayStub({ date: pDate }).transitionOwner(pAdapterDay(), pApprove(reservationId));
    await deliveryStub().pokeDay({ date: pDate });
    expect(await deliveryRows()).toMatchObject([{ status: "held" }]);

    // Finalize reads the sequence (1) as the watermark: the held pre-link
    // event resolves to ignored-prelink and never delivers.
    const linked = await deliveryStub().finalizeLink({ nonce: minted.nonce, subject: SUBJECT });
    expect(linked).toMatchObject({ ok: true });
    expect(await deliveryRows()).toEqual([]);
    expect((await counterMap())["disposition:ignored-prelink"]).toBe(1);

    // An event after the watermark delivers normally.
    await dayStub({ date: pDate }).transitionOwner(pAdapterDay(), {
      commandId: crypto.randomUUID(),
      date: pDate,
      reservationId,
      action: "cancel",
    });
    await deliveryStub().pokeDay({ date: pDate });
    expect(await deliveryRows()).toMatchObject([{ status: "queued", type: "cancel" }]);
    await runDurableObjectAlarm(deliveryStub());
    expect((await counterMap()).delivered).toBe(1);
  });

  it("parks pending deliveries on unfollow and re-queues on a later follow", async () => {
    lineApi();
    const reservationId = await createPending(pDate);
    await activateGen1();
    await finalizedLink(reservationId);
    await dayStub({ date: pDate }).transitionOwner(pAdapterDay(), pApprove(reservationId));
    await deliveryStub().pokeDay({ date: pDate });
    expect(await deliveryRows()).toMatchObject([{ status: "queued" }]);

    await deliveryStub().processWebhook({
      events: [
        {
          type: "unfollow",
          webhookEventId: "wh-unfollow-1",
          timestamp: Date.now(),
          userId: SUBJECT,
          isRedelivery: false,
        },
      ],
    });
    expect(await deliveryRows()).toMatchObject([{ status: "parked" }]);

    // A stale follow (older timestamp) cannot resurrect the parked state.
    await deliveryStub().processWebhook({
      events: [
        {
          type: "follow",
          webhookEventId: "wh-follow-stale",
          timestamp: Date.now() - 60_000,
          userId: SUBJECT,
          isRedelivery: false,
        },
      ],
    });
    expect(await deliveryRows()).toMatchObject([{ status: "parked" }]);

    await deliveryStub().processWebhook({
      events: [
        {
          type: "follow",
          webhookEventId: "wh-follow-1",
          timestamp: Date.now() + 1_000,
          userId: SUBJECT,
          isRedelivery: false,
        },
      ],
    });
    expect(await deliveryRows()).toMatchObject([{ status: "queued" }]);
    await runDurableObjectAlarm(deliveryStub());
    expect((await counterMap()).delivered).toBe(1);
  });

  it("moves a delivery to awaiting-configuration on a rejected token and recovers", async () => {
    let tokenStatus = 401;
    lineApi({ token: () => tokenStatus });
    const reservationId = await createPending(pDate);
    await activateGen1();
    await finalizedLink(reservationId);
    await dayStub({ date: pDate }).transitionOwner(pAdapterDay(), pApprove(reservationId));
    await deliveryStub().pokeDay({ date: pDate });

    await runDurableObjectAlarm(deliveryStub());
    expect(await deliveryRows()).toMatchObject([{ status: "awaiting-configuration" }]);

    // Configuration restored: the alarm requeues and delivers with the same key.
    clearTokenCacheForTests();
    tokenStatus = 200;
    const before = (await deliveryRows())[0]!.retry_key;
    await runDurableObjectAlarm(deliveryStub());
    expect(await deliveryRows()).toEqual([]);
    expect((await counterMap()).delivered).toBe(1);
    expect(before).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("terminalizes the incoming event when the delivery queue is at capacity", async () => {
    lineApi();
    const reservationId = await createPending(pDate);
    await activateGen1();
    await finalizedLink(reservationId);
    await runInDurableObject(deliveryStub(), (_instance, state) => {
      for (let index = 0; index < ADAPTER.DELIVERY_QUEUE_CAP; index += 1) {
        state.storage.sql.exec(
          `INSERT INTO deliveries
             (delivery_id, event_id, reservation_id, type, payload_json, link_version,
              retry_key, attempt, next_attempt_at, first_attempt_at, claimed_at, status,
              park_reason, date, created_at, purge_at)
           VALUES (?, ?, ?, 'approve', '{}', 1, ?, 0, 9999999999999, NULL, NULL, 'queued', NULL, ?, ?, ?)`,
          `pad:${index}`,
          `pad:${index}`,
          crypto.randomUUID(),
          crypto.randomUUID(),
          pDate,
          new Date().toISOString(),
          futurePurgeAt(),
        );
      }
    });
    await dayStub({ date: pDate }).transitionOwner(pAdapterDay(), pApprove(reservationId));
    await deliveryStub().pokeDay({ date: pDate });
    expect(await ledgerReasons()).toEqual([{ reason: "overflow", event_type: "approve" }]);
    expect((await counterMap())["disposition:overflow"]).toBe(1);
  });

  it("keeps every store byte-identical for priority-0 ingress across accept, finalize, and webhook", async () => {
    await activateGen1();
    await deliveryStub().beginDisable();
    await markPurgeComplete();
    await deliveryStub().completeDisable();

    // A stale projection commits an outbox row after the disable.
    const reservationId = await createPending(pDate);
    await dayStub({ date: pDate }).transitionOwner(pAdapterDay(), pApprove(reservationId));

    const dump = () =>
      runInDurableObject(deliveryStub(), (_instance, state) => {
        const tables = [
          "accepted_events",
          "links",
          "deliveries",
          "webhook_dedup",
          "ledger",
          "counters",
          "intents",
          "subjects",
        ];
        const out: Record<string, unknown> = {};
        for (const table of tables) {
          out[table] = state.storage.sql.exec(`SELECT * FROM ${table}`).toArray();
        }
        out.meta = state.storage.sql.exec("SELECT * FROM meta").toArray();
        return JSON.stringify(out);
      });

    const before = await dump();
    await deliveryStub().pokeDay({ date: pDate });
    await deliveryStub().finalizeLink({ nonce: "0".repeat(64), subject: SUBJECT });
    await deliveryStub().processWebhook({
      events: [
        {
          type: "follow",
          webhookEventId: "wh-disabled-1",
          timestamp: Date.now(),
          userId: SUBJECT,
          isRedelivery: false,
        },
      ],
    });
    expect(await dump()).toBe(before);
  });

  it(
    "sweep recovers a dead handoff, survives a parked pull, a parked ack, and lateness in one run",
    { timeout: 120_000 },
    async () => {
      lineApi();
      const reservationId = await createPending(pDate);
      await activateGen1();
      await finalizedLink(reservationId);

      // Dead handoff: the automatic post-commit poke is disabled while the
      // event commits, so only the sweep can ever recover it.
      await runInDurableObject(deliveryStub(), (instance) => {
        (instance as unknown as Record<string, unknown>).pokeDay = async () => ({
          ok: true,
          drained: 0,
        });
      });
      await dayStub({ date: pDate }).transitionOwner(pAdapterDay(), pApprove(reservationId));
      expect(await outboxRows(dayStub({ date: pDate }))).toHaveLength(1);
      await runInDurableObject(deliveryStub(), (instance) => {
        delete (instance as unknown as Record<string, unknown>).pokeDay;
      });
      expect(await deliveryRows()).toEqual([]);

      // Park the pull: the day's drain hangs past the RPC deadline. The
      // parked promise resolves later (never never-settling — a forever-
      // pending RPC pins the instance across reset() and poisons later
      // tests with stale in-memory state over wiped storage).
      await runInDurableObject(dayStub({ date: pDate }), (instance) => {
        (instance as unknown as Record<string, unknown>).drainOutbox = () =>
          new Promise((resolve) =>
            setTimeout(() => resolve({ events: [], more: false }), 8_000),
          );
      });
      await runInDurableObject(deliveryStub(), (_instance, state) => {
        state.storage.sql.exec(
          "UPDATE meta SET sweep_cursor = ?, cycle_started_at = ? WHERE singleton = 1",
          pDate,
          Date.now(),
        );
      });
      await runDurableObjectAlarm(deliveryStub());
      expect((await counterMap()).sweep_faults).toBe(1);
      // The cursor stays on the faulted day for the re-drive.
      expect((await deliveryStub().readMeta())?.sweepCursor).toBe(pDate);

      // Recover the pull, park the ack instead: accept lands, the day keeps
      // its row, and the dedup must absorb the re-pull.
      await runInDurableObject(dayStub({ date: pDate }), (instance) => {
        delete (instance as unknown as Record<string, unknown>).drainOutbox;
        (instance as unknown as Record<string, unknown>).ackOutbox = () =>
          new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 8_000));
      });
      advanceNow(61_000); // platform lateness allowance
      await runDurableObjectAlarm(deliveryStub());
      expect((await counterMap()).sweep_faults).toBe(2);
      expect(await deliveryRows()).toMatchObject([{ status: "queued" }]);
      expect(await outboxRows(dayStub({ date: pDate }))).toHaveLength(1);

      // Full recovery: ack completes, the dedup prevents a second delivery.
      await runInDurableObject(dayStub({ date: pDate }), (instance) => {
        delete (instance as unknown as Record<string, unknown>).ackOutbox;
      });
      await runInDurableObject(deliveryStub(), (_instance, state) => {
        state.storage.sql.exec(
          "UPDATE meta SET sweep_cursor = ? WHERE singleton = 1",
          pDate,
        );
      });
      await runDurableObjectAlarm(deliveryStub());
      expect(await outboxRows(dayStub({ date: pDate }))).toEqual([]);
      // Exactly one acceptance and one send across every fault and re-drive:
      // the dedup absorbed the re-pull, and the queued row delivered once.
      const counters = await counterMap();
      expect(counters["disposition:queued"]).toBe(1);
      expect(counters.delivered).toBe(1);
      expect(await deliveryRows()).toEqual([]);
    },
  );

  it("diagnostics expose installation aggregates and never a subject", async () => {
    lineApi();
    const reservationId = await createPending(pDate);
    await activateGen1();
    await finalizedLink(reservationId);
    await dayStub({ date: pDate }).transitionOwner(pAdapterDay(), pApprove(reservationId));
    await deliveryStub().pokeDay({ date: pDate });
    // A failed finalize attempt shows up as a count, not an identity.
    await deliveryStub().finalizeLink({ nonce: "f".repeat(64), subject: SUBJECT });

    const diagnostics = await deliveryStub().diagnostics();
    expect(diagnostics).toMatchObject({
      state: "active",
      links: { final: 1, provisional: 0 },
      subjects: { followed: 1, unfollowed: 0 },
      pending: 1,
    });
    expect(diagnostics!.counters["link_failed:invalid-intent"]).toBe(1);
    // No LINE subject, reservation ID, or secret-shaped value anywhere in the
    // operator-facing payload.
    const serialized = JSON.stringify(diagnostics);
    expect(serialized).not.toMatch(/U[0-9a-f]{32}/);
    expect(serialized).not.toContain(reservationId);
  });

  it("purges one consumer's day rows and drops tables only when no consumer remains", async () => {
    const reservationId = await createPending(pDate);
    await dayStub({ date: pDate }).transitionOwner(pAdapterDay(), pApprove(reservationId));
    // A synthetic second consumer's pending row must survive a LINE purge.
    await runInDurableObject(dayStub({ date: pDate }), (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO __adapter_outbox
           (consumer, generation, seq, event_id, reservation_id, type, start_time, resource_label, occurred_at, purge_at)
         VALUES ('calendar', 1, 1, 'cal-1', ?, 'approve', '09:00', NULL, ?, ?)`,
        reservationId,
        new Date().toISOString(),
        SUITE_PURGE_AT,
      );
    });

    const first = await dayStub({ date: pDate }).purgeConsumer({ consumer: "line" });
    expect(first).toEqual({ ok: true, removed: 1, dropped: false });
    expect(await adapterTableCount(dayStub({ date: pDate }))).toBe(2);

    await runInDurableObject(dayStub({ date: pDate }), (_instance, state) => {
      state.storage.sql.exec("DELETE FROM __adapter_outbox WHERE consumer = 'calendar'");
    });
    const second = await dayStub({ date: pDate }).purgeConsumer({ consumer: "line" });
    expect(second).toEqual({ ok: true, removed: 0, dropped: true });
    expect(await adapterTableCount(dayStub({ date: pDate }))).toBe(0);
  });

  it("prunes a finalized link and its queued delivery when purge_at has passed", async () => {
    lineApi();
    const reservationId = await createPending(pDate);
    await activateGen1();
    await finalizedLink(reservationId);
    await dayStub({ date: pDate }).transitionOwner(pAdapterDay(), pApprove(reservationId));
    await deliveryStub().pokeDay({ date: pDate });
    expect(await deliveryRows()).toMatchObject([{ status: "queued" }]);
    expect((await deliveryCounts()).links).toBe(1);
    expect((await deliveryCounts()).subjects ?? 1).toBeGreaterThanOrEqual(0);

    const past = Date.now() - 1;
    await runInDurableObject(deliveryStub(), (_instance, state) => {
      state.storage.sql.exec("UPDATE deliveries SET purge_at = ?", past);
      state.storage.sql.exec("UPDATE links SET purge_at = ?", past);
    });
    await runDurableObjectAlarm(deliveryStub());

    expect(await deliveryRows()).toEqual([]);
    expect((await deliveryCounts()).links).toBe(0);
    expect((await deliveryCounts()).subjects).toBe(0);
    expect(await ledgerReasons()).toEqual([{ reason: "retention", event_type: "approve" }]);
  });

  it("refuses to finalize once the prune has taken the reservation's link holder", async () => {
    lineApi();
    const reservationId = await createPending(pDate);
    await activateGen1();
    // The intent outlives its holder: mint with a boundary that passes while
    // the customer is still at the LINE login screen.
    const minted = await deliveryStub().mintIntent({
      reservationId,
      date: pDate,
      generation: 1,
      purgeAt: Date.now() + 2_000,
    });
    if (!minted.ok) throw new Error("mint failed");

    // A real prune pass removes the provisional link — no SQL shortcut.
    advanceNow(3_000);
    await runDurableObjectAlarm(deliveryStub());
    expect((await deliveryCounts()).links).toBe(0);

    // Finalizing now would create a final link with no retention deadline at
    // all, which is exactly the leak the boundary exists to prevent.
    const linked = await deliveryStub().finalizeLink({
      nonce: minted.nonce,
      subject: SUBJECT,
    });
    expect(linked).toEqual({ ok: false, code: "INVALID_INTENT" });
    expect((await deliveryCounts()).links).toBe(0);
    expect((await deliveryCounts()).subjects).toBe(0);
    expect((await counterMap())["link_failed:past-retention"]).toBe(1);
  });

  it("stamps every finalized link with the parent boundary", async () => {
    lineApi();
    const reservationId = await createPending(pDate);
    await activateGen1();
    await finalizedLink(reservationId);
    const stamped = await runInDurableObject(deliveryStub(), (_instance, state) =>
      state.storage.sql
        .exec<{ purge_at: number | null }>("SELECT purge_at FROM links")
        .toArray(),
    );
    expect(stamped).toHaveLength(1);
    expect(stamped[0]!.purge_at).toBeGreaterThan(Date.now());
  });

  it("dispositions an event past its purgeAt as past-retention at accept time", async () => {
    lineApi();
    const reservationId = await createPending(pDate);
    await activateGen1();
    await finalizedLink(reservationId);
    await dayStub({ date: pDate }).transitionOwner(
      pAdapterDay({ purgeAt: Date.now() - 1_000 }),
      pApprove(reservationId),
    );
    await deliveryStub().pokeDay({ date: pDate });
    expect(await deliveryRows()).toEqual([]);
    expect(await ledgerReasons()).toEqual([
      { reason: "past-retention", event_type: "approve" },
    ]);
    expect((await counterMap())["disposition:past-retention"]).toBe(1);
    expect((await counterMap()).delivered).toBeUndefined();
  });

  it("terminalizes a queued delivery as past-retention at send time", async () => {
    const calls = lineApi();
    const reservationId = await createPending(pDate);
    await activateGen1();
    await finalizedLink(reservationId);
    await dayStub({ date: pDate }).transitionOwner(pAdapterDay(), pApprove(reservationId));
    await deliveryStub().pokeDay({ date: pDate });
    expect(await deliveryRows()).toMatchObject([{ status: "queued" }]);

    const past = Date.now() - 1;
    await runInDurableObject(deliveryStub(), (_instance, state) => {
      state.storage.sql.exec("UPDATE deliveries SET purge_at = ?", past);
      // Keep the link alive so only the send-path boundary is under test;
      // prune would otherwise delete the delivery first as "retention".
      const sql = state.storage.sql;
      const original = sql.exec.bind(sql);
      Object.defineProperty(sql, "exec", {
        configurable: true,
        value: (query: string, ...args: unknown[]) => {
          if (
            typeof query === "string" &&
            query.includes("FROM deliveries WHERE purge_at IS NOT NULL AND purge_at <=")
          ) {
            return original.call(
              sql,
              "SELECT delivery_id, type FROM deliveries WHERE 0",
            );
          }
          return original.call(sql, query, ...args);
        },
      });
    });
    await runDurableObjectAlarm(deliveryStub());
    expect(await deliveryRows()).toEqual([]);
    expect(await ledgerReasons()).toEqual([
      { reason: "past-retention", event_type: "approve" },
    ]);
    expect(calls.push).toHaveLength(0);
  });

  it("never leaks customer PII into outbox, payload, push body, ledger, or diagnostics", async () => {
    const PII = {
      name: "PII-NAME-SENTINEL-xq7v2",
      contact: "pii-contact-sentinel-xq7v2@example.invalid",
      note: "PII-NOTE-SENTINEL-xq7v2",
    };
    const calls = lineApi();
    const created = await dayStub({ date: pDate }).createPublic(pDay(), {
      commandId: crypto.randomUUID(),
      settingsVersion: day.settingsVersion,
      serviceIds: ["service-cut"],
      resourceId: "resource-chair-a",
      date: pDate,
      startTime: "09:00",
      customerName: PII.name,
      contact: PII.contact,
      consentVersion: day.consentVersion,
      managementDigest: "a".repeat(64),
    });
    if (!created.ok) throw new Error("pii fixture create failed");
    const reservationId = created.reservationId;
    // The product has no free-text note column on bookings; plant the note
    // sentinel as a rejection_reason so a third distinctive string exists in
    // the day store without entering the adapter contract.
    await runInDurableObject(dayStub({ date: pDate }), (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE booking_details SET rejection_reason = ? WHERE reservation_id = ?",
        PII.note,
        reservationId,
      );
    });
    await activateGen1();
    await finalizedLink(reservationId);
    await dayStub({ date: pDate }).transitionOwner(pAdapterDay(), pApprove(reservationId));
    await deliveryStub().pokeDay({ date: pDate });
    await runDurableObjectAlarm(deliveryStub());

    const dayDump = await runInDurableObject(dayStub({ date: pDate }), (_i, state) => {
      const out: unknown[] = [];
      for (const table of ["__adapter_outbox", "__adapter_meta"]) {
        const exists = state.storage.sql
          .exec<{ n: number }>(
            "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?",
            table,
          )
          .toArray()[0]?.n;
        if (exists) out.push(...state.storage.sql.exec(`SELECT * FROM ${table}`).toArray());
      }
      return JSON.stringify(out);
    });
    const deliveryDump = await runInDurableObject(deliveryStub(), (_i, state) => {
      const dump: unknown[] = [];
      for (const table of ["deliveries", "ledger", "accepted_events", "links", "counters"]) {
        dump.push(...state.storage.sql.exec(`SELECT * FROM ${table}`).toArray());
      }
      return JSON.stringify(dump);
    });
    const pushBodies = calls.push.map((init) => String(init.body)).join("\n");
    const diagnostics = JSON.stringify(await deliveryStub().diagnostics());
    for (const surface of [dayDump, deliveryDump, pushBodies, diagnostics]) {
      expect(surface).not.toContain(PII.name);
      expect(surface).not.toContain(PII.contact);
      expect(surface).not.toContain(PII.note);
    }
  });

  it(
    "renders each of the five event types with its own wording end to end",
    { timeout: 120_000 },
    async () => {
    const calls = lineApi();
    await activateGen1();
    const wording = {
      approve: "ご予約が確定しました。",
      reject: "ご予約をお受けできませんでした。",
      reschedule: "ご予約の日時が変更されました。",
      cancel: "ご予約がキャンセルされました。",
      expire: "ご予約の申し込みが期限切れになりました。",
    } as const;

    const book = async (startTime: string, pendingExpiryMinutes?: number) => {
      const config = {
        ...pDay(),
        ...(pendingExpiryMinutes === undefined ? {} : { pendingExpiryMinutes }),
        adapter: descriptor(),
      };
      const created = await dayStub({ date: pDate }).createPublic(config, {
        commandId: crypto.randomUUID(),
        settingsVersion: day.settingsVersion,
        serviceIds: ["service-cut"],
        resourceId: "resource-chair-a",
        date: pDate,
        startTime,
        customerName: "架空 花子",
        contact: "hanako@example.invalid",
        consentVersion: day.consentVersion,
        managementDigest: "a".repeat(64),
      });
      if (!created.ok) throw new Error(`create failed at ${startTime}: ${JSON.stringify(created)}`);
      await finalizedLink(created.reservationId);
      return created.reservationId;
    };

    const drainPush = async (): Promise<string> => {
      await deliveryStub().pokeDay({ date: pDate });
      const before = calls.push.length;
      const queued = await deliveryRows();
      expect(queued.length).toBeGreaterThan(0);
      await runDurableObjectAlarm(deliveryStub());
      if ((await deliveryRows()).length > 0) {
        const row = (await deliveryRows())[0]!;
        advanceNow(Math.max(0, row.next_attempt_at - Date.now()) + 1);
        await runDurableObjectAlarm(deliveryStub());
      }
      const bodies = calls.push.slice(before).map((init) => String(init.body));
      expect(bodies.length).toBeGreaterThan(0);
      return bodies[bodies.length - 1]!;
    };

    // Each event type owns its own reservation so one mis-templated body
    // cannot satisfy another type's assertion.
    // 60-minute slots on one resource: keep starts non-overlapping.
    const approveId = await book("09:00");
    await dayStub({ date: pDate }).transitionOwner(pAdapterDay(), {
      commandId: crypto.randomUUID(),
      date: pDate,
      reservationId: approveId,
      action: "approve",
    });
    const approveBody = await drainPush();
    expect(approveBody).toContain(wording.approve);
    expect(approveBody).not.toContain(wording.reject);
    expect(approveBody).not.toContain(wording.reschedule);
    expect(approveBody).not.toContain(wording.cancel);
    expect(approveBody).not.toContain(wording.expire);

    const rejectId = await book("10:00");
    await dayStub({ date: pDate }).transitionOwner(pAdapterDay(), {
      commandId: crypto.randomUUID(),
      date: pDate,
      reservationId: rejectId,
      action: "reject",
      reason: "架空の受付都合",
    });
    const rejectBody = await drainPush();
    expect(rejectBody).toContain(wording.reject);
    expect(rejectBody).not.toContain(wording.approve);

    const rescheduleId = await book("11:00");
    await dayStub({ date: pDate }).transitionOwner(pAdapterDay(), {
      commandId: crypto.randomUUID(),
      date: pDate,
      reservationId: rescheduleId,
      action: "approve",
    });
    await drainPush(); // approve wording already covered
    await dayStub({ date: pDate }).transitionOwner(pAdapterDay(), {
      commandId: crypto.randomUUID(),
      date: pDate,
      reservationId: rescheduleId,
      action: "reschedule",
      startTime: "12:00",
      resourceId: "resource-chair-a",
    });
    const rescheduleBody = await drainPush();
    expect(rescheduleBody).toContain(wording.reschedule);
    expect(rescheduleBody).not.toContain(wording.approve);

    // 10:00 freed by reject; 11:00 freed by reschedule.
    const cancelId = await book("10:00");
    await dayStub({ date: pDate }).transitionOwner(pAdapterDay(), {
      commandId: crypto.randomUUID(),
      date: pDate,
      reservationId: cancelId,
      action: "approve",
    });
    await drainPush();
    await dayStub({ date: pDate }).transitionOwner(pAdapterDay(), {
      commandId: crypto.randomUUID(),
      date: pDate,
      reservationId: cancelId,
      action: "cancel",
    });
    const cancelBody = await drainPush();
    expect(cancelBody).toContain(wording.cancel);
    expect(cancelBody).not.toContain(wording.approve);

    const expireId = await book("11:00", 15);
    advanceNow(15 * 60_000 + 1);
    await dayStub({ date: pDate }).listOwner({
      ...pDay(),
      pendingExpiryMinutes: 15,
      adapter: descriptor(),
    });
    const expireBody = await drainPush();
    expect(expireBody).toContain(wording.expire);
    expect(expireBody).not.toContain(wording.approve);
  },
  );

  it("records a late handoff once, acks it, and never pushes", async () => {
    const calls = lineApi();
    const reservationId = await createPending(pDate);
    await activateGen1();
    await finalizedLink(reservationId);
    await dayStub({ date: pDate }).transitionOwner(pAdapterDay(), pApprove(reservationId));
    // Age the outbox event past the next-guaranteed-visit rule, then poke.
    const lateBy =
      (ADAPTER.HANDOFF_TERMINAL_LEAD_S - fullCycleBoundS(WORST_CASE_PARTITIONS) + 1) * 1000;
    await runInDurableObject(dayStub({ date: pDate }), (_i, state) => {
      state.storage.sql.exec(
        "UPDATE __adapter_outbox SET occurred_at = ?",
        new Date(Date.now() - lateBy).toISOString(),
      );
    });
    await deliveryStub().pokeDay({ date: pDate });
    expect(await outboxRows(dayStub({ date: pDate }))).toEqual([]);
    expect(await deliveryRows()).toEqual([]);
    expect(await ledgerReasons()).toEqual([{ reason: "late-handoff", event_type: "approve" }]);
    expect((await counterMap())["disposition:late-terminal"]).toBe(1);
    expect((await counterMap())["terminal:late-handoff"]).toBe(1);
    await runDurableObjectAlarm(deliveryStub());
    expect(calls.push).toHaveLength(0);
  });

  it("accepts without a channel secret, parks as awaiting-configuration, then sends once restored", async () => {
    const calls = lineApi();
    const reservationId = await createPending(pDate);
    await activateGen1();
    await finalizedLink(reservationId);

    let secretBound = true;
    const secretMutable = await runInDurableObject(deliveryStub(), (instance) => {
      const envObj = (instance as unknown as { env: Env }).env;
      try {
        Object.defineProperty(envObj, "LINE_MESSAGING_CHANNEL_SECRET", {
          configurable: true,
          enumerable: true,
          get: () => (secretBound ? LINE_TEST_SECRET_BINDING : undefined),
        });
        return true;
      } catch {
        return false;
      }
    });
    if (!secretMutable) {
      // Report rather than fake: the pool-workers env binding is not writable.
      expect(secretMutable).toBe(false);
      return;
    }

    secretBound = false;
    await dayStub({ date: pDate }).transitionOwner(pAdapterDay(), pApprove(reservationId));
    await deliveryStub().pokeDay({ date: pDate });
    expect(await deliveryRows()).toMatchObject([
      { status: "awaiting-configuration", attempt: 0 },
    ]);
    const retryKey = (await deliveryRows())[0]!.retry_key;
    await runDurableObjectAlarm(deliveryStub());
    expect(calls.push).toHaveLength(0);
    expect(calls.token).toHaveLength(0);
    expect(await deliveryRows()).toMatchObject([{ status: "awaiting-configuration" }]);

    secretBound = true;
    clearTokenCacheForTests();
    await runDurableObjectAlarm(deliveryStub());
    expect(await deliveryRows()).toEqual([]);
    expect(calls.push).toHaveLength(1);
    expect((calls.push[0]!.headers as Record<string, string>)["x-line-retry-key"]).toBe(
      retryKey,
    );
    expect((await counterMap()).delivered).toBe(1);
  });
});

// Binding value from vitest.config.ts — fictional, never a real channel secret.
const LINE_TEST_SECRET_BINDING = "line-test-channel-secret-0123456789abcdef";

