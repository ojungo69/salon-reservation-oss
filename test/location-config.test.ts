import { env, reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { InstallationConfig } from "../src/installation-config.ts";
import { identifiers, SUITE_NOW } from "./line-helpers.ts";

const config = () => env.INSTALLATION_CONFIG.getByName("installation") as DurableObjectStub<InstallationConfig>;
const runtime = {
  ownerSecretPresent: true,
  ownerAuthenticated: true,
  turnstileSecretPresent: true,
  lineSecretPresent: true,
  hostname: "booking.salon.example",
};

const create = (locationId: string, locationName = "サロン B") =>
  config().createLocation({ commandId: crypto.randomUUID(), locationId, locationName }, null);

const tables = () => runInDurableObject(config(), (_instance, state) =>
  state.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB '__*' ORDER BY name").toArray().map(({ name }) => name));

const protect = async (locationId = "default") => {
  const state = await config().getState(locationId);
  const current = state.settingsVersions.find(({ version }) => version === state.activeSettingsVersion);
  if (current === undefined) throw new Error("fixture settings missing");
  const result = await config().executeCommand({ type: "settings.update", commandId: crypto.randomUUID(), expectedSettingsVersion: state.activeSettingsVersion,
    settings: { ...current.settings, allowedHostname: runtime.hostname, turnstileSiteKey: "browser-test-site-key-0000000000000000" } }, runtime, locationId);
  if (!result.ok) throw new Error("fixture protection failed");
};

const line = (locationId: string, operation: "line.enable" | "line.disable", expectedLifecycleVersion: number, realm = identifiers) =>
  config().executeLineCommand({ operation, commandId: crypto.randomUUID(), expectedLifecycleVersion,
    ...(operation === "line.disable" ? {} : { identifiers: realm }) }, runtime, locationId);

afterEach(async () => { vi.useRealTimers(); await reset(); });

const addStaff = async (role: "owner" | "staff", digest = "a".repeat(64)) => {
  const result = await config().executeRosterCommand({ operation: "staff.create", displayName: "担当者", role, credentialDigest: digest, dryRun: false }, null);
  if (!result.ok || "dryRun" in result) throw new Error("fixture staff creation failed");
  return result.member;
};

describe("location configuration authority", () => {
  it("creates an isolated demo location while retaining exact default state and a stable create receipt", async () => {
    const original = await config().getState();
    const input = { commandId: crypto.randomUUID(), locationId: "salon-b", locationName: "サロン B" };
    expect(await config().createLocation(input, null)).toEqual({ ok: true, location: { id: "salon-b", label: "サロン B" }, replayed: false });
    expect(await config().getState()).toEqual(original);
    const added = await config().getState("salon-b");
    expect(added.mode).toBe("demo");
    expect(added.settingsVersions[0]?.settings.locationName).toBe("サロン B");
    const changed = await config().executeCommand({
      type: "settings.update",
      commandId: crypto.randomUUID(),
      expectedSettingsVersion: 1,
      settings: { ...added.settingsVersions[0]?.settings, locationName: "サロン B 改称" },
    }, runtime, "salon-b");
    expect(changed.ok).toBe(true);
    expect(await config().getState()).toEqual(original);
    expect(await config().createLocation(input, null)).toEqual({ ok: true, location: { id: "salon-b", label: "サロン B" }, replayed: true });
    expect(await config().listLocations(runtime)).toEqual([
      { id: "default", label: original.settingsVersions[0]?.settings.locationName, bookable: false },
      { id: "salon-b", label: "サロン B 改称", bookable: false },
    ]);
  });
  it("refuses unknown state/context without creating location or integration tables", async () => {
    await config().getState();
    expect(await tables()).toEqual([]);
    await expect((async () => await config().getState("missing"))()).rejects.toThrow("LOCATION_NOT_FOUND");
    await expect((async () => await config().getContext("missing"))()).rejects.toThrow("LOCATION_NOT_FOUND");
    expect(await tables()).toEqual([]);
    expect((await config().listLocations(runtime))).toHaveLength(1);
  });
  it("refuses duplicate IDs and changed command replay, and admits only one last-slot contender", async () => {
    const first = { commandId: crypto.randomUUID(), locationId: "salon-b", locationName: "サロン B" };
    expect((await config().createLocation(first, null)).ok).toBe(true);
    expect(await config().createLocation({ ...first, commandId: crypto.randomUUID() }, null)).toEqual({ ok: false, code: "LOCATION_EXISTS" });
    expect(await config().createLocation({ ...first, locationName: "別の名称" }, null)).toEqual({ ok: false, code: "IDEMPOTENCY_CONFLICT" });
    expect((await create("salon-c")).ok).toBe(true);
    const results = await Promise.all([create("salon-d"), create("salon-e")]);
    expect(results.filter(({ ok }) => ok)).toHaveLength(1);
    expect(results.filter(({ ok }) => !ok)).toEqual([{ ok: false, code: "LOCATION_LIMIT_REACHED" }]);
    expect(await config().listLocations(runtime)).toHaveLength(4);
  });

  it("checks current owner authority before any location write", async () => {
    const staff = await addStaff("staff");
    const firstOwner = await addStaff("owner", "b".repeat(64));
    const leavingOwner = await addStaff("owner", "c".repeat(64));
    const input = { commandId: crypto.randomUUID(), locationId: "salon-b", locationName: "サロン B" };
    expect(await config().createLocation(input, staff.id)).toEqual({ ok: false, code: "UNAUTHORIZED" });
    expect((await config().executeRosterCommand({ operation: "staff.deactivate", staffId: leavingOwner.id }, firstOwner.id)).ok).toBe(true);
    expect(await config().createLocation(input, leavingOwner.id)).toEqual({ ok: false, code: "UNAUTHORIZED" });
    expect(await tables()).toEqual(["__staff_roster"]);
    expect((await config().createLocation(input, firstOwner.id)).ok).toBe(true);
  });
  it("keeps legacy staff default-only and supports a current scoped directory without altering actor projection", async () => {
    await create("salon-b");
    const staff = await addStaff("staff");
    const actor = { staffId: staff.id, role: "staff" };
    expect(await config().resolveActor("a".repeat(64))).toEqual(actor);
    expect(await config().resolveActor("a".repeat(64), "default")).toEqual(actor);
    expect(await config().resolveActor("a".repeat(64), "salon-b")).toBeNull();
    expect(await config().listStaffLocationScopes(null)).toEqual([{ staffId: staff.id, scopeVersion: 0, locationIds: ["default"] }]);
    expect(await config().setStaffLocationScope({ staffId: staff.id, expectedScopeVersion: 0, locationIds: ["salon-b"] }, null)).toEqual({ ok: true, scope: { staffId: staff.id, scopeVersion: 1, locationIds: ["salon-b"] } });
    expect(await config().resolveActor("a".repeat(64))).toEqual(actor);
    expect(await config().resolveActor("a".repeat(64), "default")).toBeNull();
    expect(await config().resolveActor("a".repeat(64), "salon-b")).toEqual(actor);
    expect(await config().listLocations(runtime, staff.id)).toEqual([{ id: "salon-b", label: "サロン B", bookable: false }]);
    expect((await config().setStaffLocationScope({ staffId: staff.id, expectedScopeVersion: 1, locationIds: [] }, null)).ok).toBe(true);
    expect(await config().listLocations(runtime, staff.id)).toEqual([]);
    expect(await config().resolveActor("a".repeat(64), "salon-b")).toBeNull();
  });
  it("creates a staff credential and its intended scope atomically, including a no-write dry run", async () => {
    await create("salon-b");
    const input = { operation: "staff.create", displayName: "B 担当", role: "staff", credentialDigest: "b".repeat(64), dryRun: false };
    expect(await config().executeRosterCommand(input, null, ["missing"])).toEqual({ ok: false, code: "BAD_REQUEST" });
    expect(await config().listRoster()).toEqual([]);
    expect(await config().executeRosterCommand({ ...input, dryRun: true }, null, ["salon-b"])).toEqual({ ok: true, dryRun: true, wouldBeFirstMember: true });
    expect(await config().listRoster()).toEqual([]);
    const result = await config().executeRosterCommand(input, null, ["salon-b"]);
    if (!result.ok || "dryRun" in result) throw new Error("scoped staff creation failed");
    expect(await config().listStaffLocationScopes(null)).toEqual([{ staffId: result.member.id, scopeVersion: 1, locationIds: ["salon-b"] }]);
    expect(await config().resolveActor("b".repeat(64), "default")).toBeNull();
    expect(await config().resolveActor("b".repeat(64), "salon-b")).toEqual({ staffId: result.member.id, role: "staff" });
  });
  it("refuses stale or invalid grants, keeps owners global, and persists revocation across restart", async () => {
    await create("salon-b");
    const staff = await addStaff("staff");
    const owner = await addStaff("owner", "b".repeat(64));
    const otherOwner = await addStaff("owner", "c".repeat(64));
    const input = { staffId: staff.id, expectedScopeVersion: 0, locationIds: ["salon-b"] };
    for (const locationIds of [["missing"], ["default", "default"], ["Default"], ["a", "b", "c", "d", "e"]]) {
      expect(await config().setStaffLocationScope({ ...input, locationIds }, null)).toEqual({ ok: false, code: "BAD_REQUEST" });
    }
    expect((await config().setStaffLocationScope(input, owner.id)).ok).toBe(true);
    expect(await config().setStaffLocationScope(input, owner.id)).toEqual({ ok: false, code: "VERSION_CONFLICT" });
    expect(await config().setStaffLocationScope({ ...input, staffId: owner.id }, null)).toEqual({ ok: false, code: "STAFF_UNAVAILABLE" });
    expect(await config().resolveActor("b".repeat(64), "salon-b")).toEqual({ staffId: owner.id, role: "owner" });
    expect((await config().executeRosterCommand({ operation: "staff.deactivate", staffId: otherOwner.id }, owner.id)).ok).toBe(true);
    expect(await config().setStaffLocationScope({ ...input, expectedScopeVersion: 1, locationIds: ["default"] }, otherOwner.id)).toEqual({ ok: false, code: "UNAUTHORIZED" });
    expect((await config().setStaffLocationScope({ ...input, expectedScopeVersion: 1, locationIds: [] }, null)).ok).toBe(true);
    await expect(runInDurableObject(config(), (_instance, state) => state.abort("location scope restart"))).rejects.toThrow("location scope restart");
    expect(await config().resolveActor("a".repeat(64), "salon-b")).toBeNull();
    expect(await config().resolveActor("a".repeat(64), "default")).toBeNull();
    expect(await config().listLocations(runtime, staff.id)).toEqual([]);
    expect((await config().listLocations(runtime, owner.id)).map(({ id }) => id)).toEqual(["default", "salon-b"]);
  });

  it("rolls the roster back exactly if the initial scope write fails", async () => {
    await create("salon-b");
    const existing = await addStaff("staff");
    await config().setStaffLocationScope({ staffId: existing.id, expectedScopeVersion: 0, locationIds: ["salon-b"] }, null);
    const before = await config().listRoster();
    const beforeScopes = await config().listStaffLocationScopes(null);
    await runInDurableObject(config(), (_instance, state) => {
      state.storage.sql.exec("CREATE TRIGGER fail_new_scope BEFORE INSERT ON __staff_location_scopes BEGIN SELECT RAISE(ABORT, 'scope fixture failure'); END");
    });
    const input = { operation: "staff.create", displayName: "追加担当", role: "staff", credentialDigest: "d".repeat(64), dryRun: false };
    await expect((async () => await config().executeRosterCommand(input, null, ["salon-b"]))()).rejects.toThrow("scope fixture failure");
    expect(await config().listRoster()).toEqual(before);
    expect(await config().listStaffLocationScopes(null)).toEqual(beforeScopes);
    expect(await config().resolveActor("d".repeat(64))).toBeNull();
    await runInDurableObject(config(), (_instance, state) => { state.storage.sql.exec("DROP TRIGGER fail_new_scope"); });
    expect((await config().executeRosterCommand(input, null, ["salon-b"])).ok).toBe(true);
  });
  it("keeps named calendars off until configured and stores independent versioned feed digests", async () => {
    const original = await config().getState();
    await create("salon-b");
    const off = { version: 0, activationVersion: 0, googleEnabled: false, calendarId: null, feedEnabled: false, feedTokenDigest: null };
    expect(await config().getCalendarContext("salon-b")).toEqual(off);
    expect(await tables()).toEqual(["__location_states"]);
    expect(await config().setCalendarSettings({ expectedVersion: 0, googleEnabled: false, calendarId: null, feedEnabled: true }, null, "salon-b")).toEqual({ ok: false, code: "CALENDAR_NOT_CONFIGURED" });
    expect(await config().setCalendarFeedDigest({ expectedVersion: 0, feedTokenDigest: "d".repeat(64) }, null, "salon-b")).toEqual({ ok: true, context: { ...off, version: 1, feedTokenDigest: "d".repeat(64) } });
    const desired = { expectedVersion: 1, googleEnabled: true, calendarId: "named-calendar@example.invalid", feedEnabled: true };
    expect(await config().setCalendarSettings(desired, null, "salon-b")).toEqual({ ok: true, context: { version: 2, activationVersion: 2, googleEnabled: true, calendarId: "named-calendar@example.invalid", feedEnabled: true, feedTokenDigest: "d".repeat(64) } });
    expect(await config().setCalendarSettings(desired, null, "salon-b")).toEqual({ ok: false, code: "VERSION_CONFLICT" });
    expect(await config().setCalendarSettings({ ...desired, expectedVersion: 2, googleEnabled: false, calendarId: "changed-calendar@example.invalid" }, null, "salon-b")).toEqual({ ok: false, code: "CALENDAR_TARGET_IMMUTABLE" });
    expect((await config().setCalendarFeedDigest({ expectedVersion: 2, feedTokenDigest: "e".repeat(64) }, null, "salon-b")).ok).toBe(true);
    expect((await config().getCalendarContext("salon-b")).version).toBe(3);
    expect(await config().getState()).toEqual(original);
  });
  it("isolates named calendar owners, feed versions and immutable target claims", async () => {
    await create("salon-b");
    await create("salon-c", "サロン C");
    const staff = await addStaff("staff");
    const settings = { expectedVersion: 0, googleEnabled: true, calendarId: "shared-target@example.invalid", feedEnabled: false };
    expect(await config().setCalendarSettings(settings, staff.id, "salon-b")).toEqual({ ok: false, code: "UNAUTHORIZED" });
    expect(await config().setCalendarFeedDigest({ expectedVersion: 0, feedTokenDigest: "f".repeat(64) }, staff.id, "salon-b")).toEqual({ ok: false, code: "UNAUTHORIZED" });
    expect(await config().setCalendarSettings({ ...settings, calendarId: "fixture+calendar@example.invalid" }, null, "salon-b")).toEqual({ ok: false, code: "CALENDAR_TARGET_CONFLICT" });
    const claims = await Promise.all([config().setCalendarSettings(settings, null, "salon-b"), config().setCalendarSettings(settings, null, "salon-c")]);
    expect(claims.filter(({ ok }) => ok)).toHaveLength(1);
    expect(claims.filter(({ ok }) => !ok)).toEqual([{ ok: false, code: "CALENDAR_TARGET_CONFLICT" }]);
    const beforeC = await config().getCalendarContext("salon-c");
    const beforeB = await config().getCalendarContext("salon-b");
    expect((await config().setCalendarFeedDigest({ expectedVersion: beforeB.version, feedTokenDigest: "f".repeat(64) }, null, "salon-b")).ok).toBe(true);
    expect(await config().getCalendarContext("salon-c")).toEqual(beforeC);
    expect(await config().setCalendarSettings(settings, null, "default")).toEqual({ ok: false, code: "BAD_REQUEST" });
    expect(await config().setCalendarSettings(settings, null, "missing")).toEqual({ ok: false, code: "LOCATION_NOT_FOUND" });
  });

  it("refuses missing Google credentials without converting retained named settings into off", async () => {
    await create("salon-b");
    const settings = { expectedVersion: 0, googleEnabled: true, calendarId: "named-calendar@example.invalid", feedEnabled: false };
    expect((await config().setCalendarSettings(settings, null, "salon-b")).ok).toBe(true);
    const before = await config().getCalendarContext("salon-b");
    await runInDurableObject(config(), (instance) => {
      const bindings = Reflect.get(instance, "env");
      Object.defineProperty(instance, "env", { configurable: true, value: { ...bindings, GOOGLE_CALENDAR_CREDENTIALS: undefined } });
    });
    expect(await config().setCalendarSettings({ ...settings, expectedVersion: 1 }, null, "salon-b")).toEqual({ ok: false, code: "CALENDAR_NOT_CONFIGURED" });
    expect(await config().getCalendarContext("salon-b")).toEqual(before);
  });
  it("rejects primary aliases while allowing an independent named feed", async () => {
    await create("salon-b");
    const settings = { expectedVersion: 0, googleEnabled: true, calendarId: "primary", feedEnabled: false };
    expect(await config().setCalendarSettings(settings, null, "salon-b")).toEqual({ ok: false, code: "BAD_REQUEST" });
    expect(await config().setCalendarSettings({ ...settings, calendarId: "PRIMARY" }, null, "salon-b")).toEqual({ ok: false, code: "BAD_REQUEST" });
    await runInDurableObject(config(), (instance) => {
      const bindings = Reflect.get(instance, "env");
      const credentials = JSON.parse(bindings.GOOGLE_CALENDAR_CREDENTIALS);
      Object.defineProperty(instance, "env", { configurable: true, value: { ...bindings, GOOGLE_CALENDAR_CREDENTIALS: JSON.stringify({ ...credentials, calendarId: "primary" }) } });
    });
    expect(await config().setCalendarSettings({ ...settings, calendarId: "named-calendar@example.invalid" }, null, "salon-b")).toEqual({ ok: false, code: "CALENDAR_TARGET_CONFLICT" });
    await config().setCalendarFeedDigest({ expectedVersion: 0, feedTokenDigest: "e".repeat(64) }, null, "salon-b");
    expect((await config().setCalendarSettings({ expectedVersion: 1, googleEnabled: false, calendarId: null, feedEnabled: true }, null, "salon-b")).ok).toBe(true);
    expect((await config().getCalendarContext("salon-b")).feedEnabled).toBe(true);
  });
  it("enables only the selected location LINE actor and preserves the default state and capability", async () => {
    const original = await config().getContext();
    await create("salon-b");
    await protect("salon-b");
    expect(await line("salon-b", "line.enable", 0)).toMatchObject({ ok: true, lifecycleVersion: 1 });
    expect(await config().lineAdapterStatus("salon-b")).toMatchObject({ phase: "active", active: { ...identifiers, generation: 1 } });
    expect(await config().lineAdapterStatus()).toMatchObject({ phase: "disabled", lifecycleVersion: 0 });
    expect(await config().getContext()).toEqual(original);
    expect((await config().getContext("salon-b")).line).toMatchObject({ phase: "active", generation: 1 });
    expect(await config().getLineWebhookTargets()).toEqual(["salon-b"]);
    expect(await env.ADAPTER_DELIVERY.getByName("location:salon-b").readMeta()).toMatchObject({ state: "active", generation: 1 });
  });
  it("fences concurrent enabling realms before either actor becomes active, then recovers after restart", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(SUITE_NOW);
    await create("salon-b"); await create("salon-c");
    await protect("salon-b"); await protect("salon-c");
    await runInDurableObject(config(), (instance) => {
      const bindings = Reflect.get(instance, "env");
      Object.defineProperty(instance, "env", { configurable: true, value: { ...bindings, ADAPTER_DELIVERY: {
        getByName: (name: string) => {
          const stub = env.ADAPTER_DELIVERY.getByName(name);
          return { readMeta: () => stub.readMeta(), activate: async () => ({ ok: false, code: "STALE_GENERATION" }) };
        },
      } } });
    });
    const outcomes = await Promise.all([
      line("salon-b", "line.enable", 0),
      line("salon-c", "line.enable", 0, { ...identifiers, messagingChannelId: "9876543211" }),
    ]);
    expect(outcomes.filter(({ ok }) => ok)).toHaveLength(1);
    expect(outcomes.filter(({ ok }) => !ok)).toEqual([{ ok: false, code: "PHASE_CONFLICT" }]);
    const winner = outcomes[0].ok ? "salon-b" : "salon-c";
    expect((await config().lineAdapterStatus(winner)).phase).toBe("activating");
    expect(await config().getLineWebhookTargets()).toEqual([]);
    await expect(runInDurableObject(config(), (_instance, state) => state.abort("line coordinator restart"))).rejects.toThrow("line coordinator restart");
    await runDurableObjectAlarm(config());
    expect((await config().lineAdapterStatus(winner)).phase).toBe("active");
    expect(await config().getLineWebhookTargets()).toEqual([winner]);
    expect(await runInDurableObject(config(), (_instance, state) => state.storage.getAlarm())).toBeNull();
  });

  it("does not hold the alarm scheduling lane while a different location actor is stalled", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(SUITE_NOW);
    await create("salon-b"); await create("salon-c");
    await protect("salon-b"); await protect("salon-c");
    const blocked = Promise.withResolvers<null>();
    await runInDurableObject(config(), (instance) => {
      const bindings = Reflect.get(instance, "env");
      Object.defineProperty(instance, "env", { configurable: true, value: { ...bindings, ADAPTER_DELIVERY: {
        getByName: (name: string) => {
          const stub = env.ADAPTER_DELIVERY.getByName(name);
          return name === "location:salon-b"
            ? { readMeta: () => blocked.promise, activate: (input: Parameters<typeof stub.activate>[0]) => stub.activate(input) }
            : stub;
        },
      } } });
    });
    let firstSettled = false;
    const first = (async () => { const result = await line("salon-b", "line.enable", 0); firstSettled = true; return result; })();
    await expect.poll(async () => (await config().lineAdapterStatus("salon-b")).phase).toBe("activating");
    try {
      expect((await line("salon-c", "line.enable", 0)).ok).toBe(true);
      expect((await config().lineAdapterStatus("salon-c")).phase).toBe("active");
      expect(firstSettled).toBe(false);
    } finally {
      blocked.resolve(null);
      await first;
    }
    expect((await config().lineAdapterStatus("salon-b")).phase).toBe("active");
    expect(await runInDurableObject(config(), (_instance, state) => state.storage.getAlarm())).toBeNull();
  });

  it("recovers its scheduling queue after a failed prearm without accepting the command", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(SUITE_NOW);
    await create("salon-b");
    await runInDurableObject(config(), (_instance, state) => {
      const original = state.storage.setAlarm.bind(state.storage);
      let fail = true;
      Object.defineProperty(state.storage, "setAlarm", { configurable: true, value: async (...args: Parameters<typeof original>) => {
        if (fail) { fail = false; throw new Error("alarm fixture failure"); }
        return original(...args);
      } });
    });
    const command = { operation: "line.settings", commandId: crypto.randomUUID(), expectedLifecycleVersion: 0, identifiers };
    await expect((async () => await config().executeLineCommand(command, runtime, "salon-b"))()).rejects.toThrow("alarm fixture failure");
    expect((await config().lineAdapterStatus("salon-b")).lifecycleVersion).toBe(0);
    expect(await tables()).toEqual(["__location_states"]);
    expect((await config().executeLineCommand(command, runtime, "salon-b")).ok).toBe(true);
    expect((await config().executeLineCommand(command, runtime, "salon-b")).replayed).toBe(true);
    expect(await line("salon-b", "line.disable", 1)).toEqual({ ok: false, code: "PHASE_CONFLICT" });
    expect(await runInDurableObject(config(), (_instance, state) => state.storage.getAlarm())).toBeNull();
    await runInDurableObject(config(), (_instance, state) => { Reflect.deleteProperty(state.storage, "setAlarm"); });
  });
  it("preserves an earlier recovery alarm and draining webhook target while a peer is enabling", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(SUITE_NOW);
    await create("salon-b"); await create("salon-c");
    await protect("salon-b"); await protect("salon-c");
    await line("salon-b", "line.enable", 0);
    const stop = Promise.withResolvers<void>();
    const start = Promise.withResolvers<null>();
    await runInDurableObject(config(), (instance) => {
      const bindings = Reflect.get(instance, "env");
      Object.defineProperty(instance, "env", { configurable: true, value: { ...bindings, ADAPTER_DELIVERY: {
        getByName: (name: string) => {
          const stub = env.ADAPTER_DELIVERY.getByName(name);
          if (name === "location:salon-b") return { beginDisable: async () => { await stop.promise; throw new Error("disable fixture unavailable"); } };
          return { readMeta: () => start.promise, activate: (input: Parameters<typeof stub.activate>[0]) => stub.activate(input) };
        },
      } } });
    });
    const stopping = (async () => await line("salon-b", "line.disable", 1))();
    await expect.poll(async () => (await config().lineAdapterStatus("salon-b")).phase).toBe("deactivating");
    const starting = (async () => await line("salon-c", "line.enable", 0))();
    await expect.poll(async () => (await config().lineAdapterStatus("salon-c")).phase).toBe("activating");
    try {
      const early = await runInDurableObject(config(), (_instance, state) => state.storage.getAlarm());
      expect(early).toBe(SUITE_NOW + 5_000);
      stop.resolve();
      expect((await stopping).ok).toBe(true);
      expect(await runInDurableObject(config(), (_instance, state) => state.storage.getAlarm())).toBe(early);
      expect(await env.ADAPTER_DELIVERY.getByName("location:salon-b").readMeta()).toMatchObject({ state: "active" });
      expect(await config().getLineWebhookTargets()).toEqual(["salon-b"]);
    } finally {
      stop.resolve(); start.resolve(null);
      await stopping; await starting;
    }
    await runInDurableObject(config(), (instance) => {
      const bindings = Reflect.get(instance, "env");
      Object.defineProperty(instance, "env", { configurable: true, value: { ...bindings, ADAPTER_DELIVERY: env.ADAPTER_DELIVERY } });
    });
    vi.setSystemTime(SUITE_NOW + 5_000);
    await runDurableObjectAlarm(config());
    expect(await runInDurableObject(config(), (_instance, state) => state.storage.getAlarm())).toBe(SUITE_NOW + 65_000);
    vi.setSystemTime(SUITE_NOW + 65_000);
    await runInDurableObject(env.ADAPTER_DELIVERY.getByName("location:salon-b"), (_instance, state) => {
      state.storage.sql.exec("UPDATE meta SET purge_completed_at = ? WHERE singleton = 1", Date.now());
    });
    await runDurableObjectAlarm(config());
    expect((await config().lineAdapterStatus("salon-b")).phase).toBe("disabled");
    expect((await config().lineAdapterStatus("salon-c")).phase).toBe("active");
    expect(await config().getLineWebhookTargets()).toEqual(["salon-c"]);
    expect(await runInDurableObject(config(), (_instance, state) => state.storage.getAlarm())).toBeNull();
  });
  it("advances the calendar activation epoch only when all-off becomes enabled", async () => {
    await create("salon-b");
    expect(await config().getCalendarContext("salon-b")).toMatchObject({ version: 0, activationVersion: 0 });
    expect(await config().setCalendarFeedDigest({ expectedVersion: 0, feedTokenDigest: "a".repeat(64) }, null, "salon-b")).toMatchObject({ ok: true, context: { version: 1, activationVersion: 0 } });
    expect(await config().setCalendarSettings({ expectedVersion: 1, googleEnabled: false, feedEnabled: true, calendarId: null }, null, "salon-b")).toMatchObject({ ok: true, context: { version: 2, activationVersion: 2 } });
    expect(await config().setCalendarFeedDigest({ expectedVersion: 2, feedTokenDigest: "b".repeat(64) }, null, "salon-b")).toMatchObject({ ok: true, context: { version: 3, activationVersion: 2 } });
    const settings = { googleEnabled: true, feedEnabled: true, calendarId: "epoch-calendar@example.invalid" };
    expect(await config().setCalendarSettings({ ...settings, expectedVersion: 3 }, null, "salon-b")).toMatchObject({ ok: true, context: { version: 4, activationVersion: 2 } });
    expect(await config().setCalendarSettings({ ...settings, expectedVersion: 4, googleEnabled: false }, null, "salon-b")).toMatchObject({ ok: true, context: { version: 5, activationVersion: 2 } });
    expect(await config().setCalendarSettings({ ...settings, expectedVersion: 5, feedEnabled: false }, null, "salon-b")).toMatchObject({ ok: true, context: { version: 6, activationVersion: 2 } });
    const off = { ...settings, googleEnabled: false, feedEnabled: false };
    expect(await config().setCalendarSettings({ ...off, expectedVersion: 6 }, null, "salon-b")).toMatchObject({ ok: true, context: { version: 7, activationVersion: 2 } });
    expect(await config().setCalendarFeedDigest({ expectedVersion: 7, feedTokenDigest: "c".repeat(64) }, null, "salon-b")).toMatchObject({ ok: true, context: { version: 8, activationVersion: 2 } });
    expect(await config().setCalendarSettings({ ...off, expectedVersion: 8, feedEnabled: true }, null, "salon-b")).toMatchObject({ ok: true, context: { version: 9, activationVersion: 9 } });
    const accepted = await config().getCalendarContext("salon-b");
    expect(await config().setCalendarSettings({ ...off, expectedVersion: 8 }, null, "salon-b")).toEqual({ ok: false, code: "VERSION_CONFLICT" });
    expect(await config().getCalendarContext("salon-b")).toEqual(accepted);
  });
  it("refuses corrupt persisted calendar epochs without repairing them", async () => {
    await create("salon-b");
    await config().setCalendarFeedDigest({ expectedVersion: 0, feedTokenDigest: "a".repeat(64) }, null, "salon-b");
    await config().setCalendarSettings({ expectedVersion: 1, googleEnabled: false, feedEnabled: true, calendarId: null }, null, "salon-b");
    for (const invalid of [0, -1, 2.5, 3, Number.MAX_SAFE_INTEGER + 1, "invalid"]) {
      await runInDurableObject(config(), (_instance, state) => {
        state.storage.sql.exec("UPDATE __location_calendar_settings SET activation_version = ? WHERE location_id = 'salon-b'", invalid);
      });
      await expect((async () => await config().getCalendarContext("salon-b"))()).rejects.toThrow("Invalid installation storage");
      expect(await runInDurableObject(config(), (_instance, state) => state.storage.sql.exec("SELECT version, activation_version FROM __location_calendar_settings WHERE location_id = 'salon-b'").one())).toEqual({ version: 2, activation_version: invalid });
    }
    await runInDurableObject(config(), (_instance, state) => { state.storage.sql.exec("UPDATE __location_calendar_settings SET activation_version = 2 WHERE location_id = 'salon-b'"); });
    expect(await config().getCalendarContext("salon-b")).toMatchObject({ version: 2, activationVersion: 2 });
  });

  it("fails closed on unpublished named rows missing the epoch column without altering them or default state", async () => {
    const original = await config().getState();
    await create("salon-b");
    const before = await runInDurableObject(config(), (_instance, state) => {
      state.storage.sql.exec(`CREATE TABLE __location_calendar_settings (
        location_id TEXT PRIMARY KEY, version INTEGER NOT NULL, google_enabled INTEGER NOT NULL,
        calendar_id TEXT UNIQUE, feed_enabled INTEGER NOT NULL, feed_token_digest TEXT
      )`);
      state.storage.sql.exec("INSERT INTO __location_calendar_settings VALUES ('salon-b', 2, 0, NULL, 0, NULL)");
      return { columns: state.storage.sql.exec("PRAGMA table_info('__location_calendar_settings')").toArray(), rows: state.storage.sql.exec("SELECT * FROM __location_calendar_settings").toArray() };
    });
    await expect((async () => await config().getCalendarContext("salon-b"))()).rejects.toThrow("activation_version");
    await expect((async () => await config().setCalendarFeedDigest({ expectedVersion: 2, feedTokenDigest: "a".repeat(64) }, null, "salon-b"))()).rejects.toThrow("activation_version");
    const after = await runInDurableObject(config(), (_instance, state) => ({ columns: state.storage.sql.exec("PRAGMA table_info('__location_calendar_settings')").toArray(), rows: state.storage.sql.exec("SELECT * FROM __location_calendar_settings").toArray() }));
    expect(after).toEqual(before);
    expect(await config().getState()).toEqual(original);
  });

  it("does not spend calendar epochs on stale owners, concurrent losers or version overflow", async () => {
    await create("salon-b");
    const owner = await addStaff("owner", "a".repeat(64));
    const revoked = await addStaff("owner", "b".repeat(64));
    await config().setCalendarFeedDigest({ expectedVersion: 0, feedTokenDigest: "a".repeat(64) }, null, "salon-b");
    await config().executeRosterCommand({ operation: "staff.deactivate", staffId: revoked.id }, owner.id);
    const enable = { expectedVersion: 1, googleEnabled: false, feedEnabled: true, calendarId: null };
    expect(await config().setCalendarSettings(enable, revoked.id, "salon-b")).toEqual({ ok: false, code: "UNAUTHORIZED" });
    expect(await config().getCalendarContext("salon-b")).toMatchObject({ version: 1, activationVersion: 0 });
    const results = await Promise.all([config().setCalendarSettings(enable, owner.id, "salon-b"), config().setCalendarSettings(enable, null, "salon-b")]);
    expect(results.filter(({ ok }) => ok)).toEqual([{ ok: true, context: { version: 2, activationVersion: 2, googleEnabled: false, feedEnabled: true, calendarId: null, feedTokenDigest: "a".repeat(64) } }]);
    expect(results.filter(({ ok }) => !ok)).toEqual([{ ok: false, code: "VERSION_CONFLICT" }]);
    await runInDurableObject(config(), (_instance, state) => { state.storage.sql.exec("UPDATE __location_calendar_settings SET version = ?, feed_enabled = 0 WHERE location_id = 'salon-b'", Number.MAX_SAFE_INTEGER); });
    const before = await config().getCalendarContext("salon-b");
    expect(before).toMatchObject({ version: Number.MAX_SAFE_INTEGER, activationVersion: 2, feedEnabled: false });
    expect(await config().setCalendarSettings({ ...enable, expectedVersion: Number.MAX_SAFE_INTEGER }, null, "salon-b")).toEqual({ ok: false, code: "VERSION_CONFLICT" });
    expect(await config().setCalendarFeedDigest({ expectedVersion: Number.MAX_SAFE_INTEGER, feedTokenDigest: "b".repeat(64) }, null, "salon-b")).toEqual({ ok: false, code: "VERSION_CONFLICT" });
    expect(await config().getCalendarContext("salon-b")).toEqual(before);
  });
});
