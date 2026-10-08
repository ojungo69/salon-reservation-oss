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
});
