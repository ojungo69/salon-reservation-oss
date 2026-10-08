import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

import type { InstallationConfig } from "../src/installation-config.ts";

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

afterEach(async () => { await reset(); });

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
    const off = { version: 0, googleEnabled: false, calendarId: null, feedEnabled: false, feedTokenDigest: null };
    expect(await config().getCalendarContext("salon-b")).toEqual(off);
    expect(await tables()).toEqual(["__location_states"]);
    expect(await config().setCalendarSettings({ expectedVersion: 0, googleEnabled: false, calendarId: null, feedEnabled: true }, null, "salon-b")).toEqual({ ok: false, code: "CALENDAR_NOT_CONFIGURED" });
    expect(await config().setCalendarFeedDigest({ expectedVersion: 0, feedTokenDigest: "d".repeat(64) }, null, "salon-b")).toEqual({ ok: true, context: { ...off, version: 1, feedTokenDigest: "d".repeat(64) } });
    const desired = { expectedVersion: 1, googleEnabled: true, calendarId: "named-calendar@example.invalid", feedEnabled: true };
    expect(await config().setCalendarSettings(desired, null, "salon-b")).toEqual({ ok: true, context: { version: 2, googleEnabled: true, calendarId: "named-calendar@example.invalid", feedEnabled: true, feedTokenDigest: "d".repeat(64) } });
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
});
