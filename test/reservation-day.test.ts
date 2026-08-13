import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DayConfig, ReservationDay } from "../src/reservation-day.ts";

type Service = {
  id: string;
  label: string;
  category: string | null;
  durationMinutes: number;
  cleanupMinutes: number;
  priceYen: number | null;
  eligibleResourceIds: string[];
  active: boolean;
};

type TargetDayConfig = DayConfig & {
  settingsVersion: number;
  resources: Array<{ id: string; label: string; active: boolean }>;
  services: Service[];
  opensAt: string;
  closesAt: string;
  startIntervalMinutes: number;
  consentVersion: string;
};

type TargetCreateInput = {
  commandId: string;
  settingsVersion: number;
  serviceIds: string[];
  resourceId: string;
  date: string;
  startTime: string;
  customerName: string;
  contact: string;
  consentVersion: string;
  managementDigest: string;
};

type TargetReservationDay = ReservationDay & {
  availability(
    config: TargetDayConfig,
    serviceIds: string[],
    reservationId?: string,
  ): Promise<unknown>;
  transitionOwner(
    config: TargetDayConfig,
    input: Record<string, unknown>,
  ): Promise<unknown>;
  createClosure(
    config: TargetDayConfig,
    input: Record<string, unknown>,
  ): Promise<unknown>;
  removeClosure(
    config: TargetDayConfig,
    input: Record<string, unknown>,
  ): Promise<unknown>;
};

const startTimes = [
  "09:00",
  "09:30",
  "10:00",
  "10:30",
  "11:00",
  "11:30",
  "12:00",
];

const day: TargetDayConfig = {
  date: "2025-01-15",
  settingsVersion: 7,
  resourceIds: ["resource-chair-a", "resource-chair-b"],
  resources: [
    { id: "resource-chair-a", label: "架空チェア A", active: true },
    { id: "resource-chair-b", label: "架空チェア B", active: true },
  ],
  services: [
    {
      id: "service-cut",
      label: "架空カット",
      category: "ヘア",
      durationMinutes: 45,
      cleanupMinutes: 15,
      priceYen: 4_000,
      eligibleResourceIds: ["resource-chair-a", "resource-chair-b"],
      active: true,
    },
    {
      id: "service-color",
      label: "架空カラー",
      category: "ヘア",
      durationMinutes: 60,
      cleanupMinutes: 0,
      priceYen: 6_000,
      eligibleResourceIds: ["resource-chair-a"],
      active: true,
    },
  ],
  opensAt: "09:00",
  closesAt: "13:00",
  startIntervalMinutes: 30,
  startTimes,
  slotMinutes: 60,
  consentVersion: "consent-v2",
  purgeAt: Date.parse("2100-01-01T00:00:00.000Z"),
};

const combinedSnapshot = {
  settingsVersion: 7,
  services: [
    {
      id: "service-cut",
      label: "架空カット",
      durationMinutes: 45,
      cleanupMinutes: 15,
      priceYen: 4_000,
    },
    {
      id: "service-color",
      label: "架空カラー",
      durationMinutes: 60,
      cleanupMinutes: 0,
      priceYen: 6_000,
    },
  ],
  serviceMinutes: 105,
  cleanupMinutes: 15,
  occupiedMinutes: 120,
  priceYen: 10_000,
  resourceId: "resource-chair-a",
  resourceLabel: "架空チェア A",
  consentVersion: "consent-v2",
};

const singleSnapshot = {
  settingsVersion: 7,
  services: [
    {
      id: "service-cut",
      label: "架空カット",
      durationMinutes: 45,
      cleanupMinutes: 15,
      priceYen: 4_000,
    },
  ],
  serviceMinutes: 45,
  cleanupMinutes: 15,
  occupiedMinutes: 60,
  priceYen: 4_000,
  resourceId: "resource-chair-a",
  resourceLabel: "架空チェア A",
  consentVersion: "consent-v2",
};

const configFor = (date: string): TargetDayConfig => ({ ...day, date });

const stubFor = (config = day) =>
  env.RESERVATION_DAYS.getByName(
    `single-location:${config.date}`,
  ) as unknown as DurableObjectStub<TargetReservationDay>;

const createInput = (
  config = day,
  overrides: Partial<TargetCreateInput> = {},
): TargetCreateInput => ({
  commandId: crypto.randomUUID(),
  settingsVersion: config.settingsVersion,
  serviceIds: ["service-cut", "service-color"],
  resourceId: "resource-chair-a",
  date: config.date,
  startTime: "09:00",
  customerName: "架空 花子",
  contact: "hanako@example.invalid",
  consentVersion: config.consentVersion,
  managementDigest: "a".repeat(64),
  ...overrides,
});

const callTarget = (
  stub: DurableObjectStub<TargetReservationDay>,
  method: "transitionOwner" | "createClosure" | "removeClosure",
  ...args: unknown[]
): Promise<unknown> =>
  runInDurableObject(stub, async (instance) => {
    const operation = (instance as unknown as Record<string, unknown>)[method];
    if (typeof operation !== "function") {
      return { ok: false, code: "NOT_IMPLEMENTED", method };
    }
    try {
      return await Reflect.apply(operation, instance, args);
    } catch (error) {
      return {
        ok: false,
        code: "UNEXPECTED_ERROR",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  });

const reservationIdOf = (result: unknown): string => {
  if (
    typeof result === "object" &&
    result !== null &&
    "reservationId" in result &&
    typeof result.reservationId === "string"
  ) {
    return result.reservationId;
  }
  return "00000000-0000-4000-8000-000000000000";
};

const startsFor = (result: unknown, resourceId: string): string[] => {
  if (typeof result !== "object" || result === null || !("resources" in result)) {
    return [];
  }
  const resources = result.resources;
  if (!Array.isArray(resources)) return [];
  const resource = resources.find(
    (candidate): candidate is { id: string; startTimes: string[] } =>
      typeof candidate === "object" &&
      candidate !== null &&
      "id" in candidate &&
      candidate.id === resourceId &&
      "startTimes" in candidate &&
      Array.isArray(candidate.startTimes),
  );
  return resource?.startTimes ?? [];
};

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2025-01-14T15:00:00.000Z"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

describe("T007 ReservationDay v0.2 runtime contract", () => {
  it("pins the settings version and stores an immutable pending booking snapshot", async () => {
    const stub = stubFor();
    const created = await stub.createPublic(day, createInput());

    expect(created).toMatchObject({
      ok: true,
      status: "pending",
      replayed: false,
      snapshot: combinedSnapshot,
    });

    const driftedDay: TargetDayConfig = {
      ...day,
      settingsVersion: 8,
      resources: day.resources.map((resource) => ({
        ...resource,
        label: `${resource.label} 改定後`,
      })),
      services: day.services.map((service) => ({
        ...service,
        label: `${service.label} 改定後`,
        priceYen: 99_999,
      })),
    };
    const projection = await stub.listOwner(driftedDay);
    expect(projection).toMatchObject({
      ok: true,
      settingsVersion: 7,
      reservations: [
        {
          reservationId: reservationIdOf(created),
          status: "pending",
          resourceId: "resource-chair-a",
          resourceLabel: "架空チェア A",
          startTime: "09:00",
          customerName: "架空 花子",
          contact: "hanako@example.invalid",
          snapshot: combinedSnapshot,
        },
      ],
    });
  });

  it("accepts the current consent version on a day pinned to its prior schedule", async () => {
    const stub = stubFor();
    expect(await stub.createPublic(day, createInput())).toMatchObject({ ok: true });

    const currentConfig: TargetDayConfig = {
      ...day,
      settingsVersion: 8,
      consentVersion: "consent-v3",
      services: day.services.map((service) => ({
        ...service,
        label: `${service.label} 改定後`,
        priceYen: 99_999,
      })),
    };
    const input = createInput(currentConfig, {
      settingsVersion: 7,
      serviceIds: ["service-cut"],
      startTime: "11:00",
      consentVersion: "consent-v3",
    });

    const created = await stub.createPublic(currentConfig, input);
    expect(created).toMatchObject({
      ok: true,
      replayed: false,
      snapshot: {
        settingsVersion: 7,
        services: [
          {
            id: "service-cut",
            label: "架空カット",
            durationMinutes: 45,
            cleanupMinutes: 15,
            priceYen: 4_000,
          },
        ],
        consentVersion: "consent-v3",
      },
    });
    expect(await stub.createPublic(currentConfig, input)).toMatchObject({
      ok: true,
      reservationId: reservationIdOf(created),
      replayed: true,
    });

    const newerConfig: TargetDayConfig = {
      ...currentConfig,
      settingsVersion: 9,
      consentVersion: "consent-v4",
    };
    expect(await stub.createPublic(newerConfig, input)).toMatchObject({
      ok: true,
      reservationId: reservationIdOf(created),
      replayed: true,
    });
    expect(
      await stub.createPublic(
        newerConfig,
        createInput(newerConfig, {
          settingsVersion: 7,
          serviceIds: ["service-cut"],
          resourceId: "resource-chair-b",
          startTime: "11:00",
          consentVersion: "consent-v2",
        }),
      ),
    ).toEqual({ ok: false, code: "CONFIGURATION_CONFLICT" });
  });

  it("recovers cleanly when first-time schema initialization fails", async () => {
    const bootstrapDay = configFor("2025-01-16");
    const stub = stubFor(bootstrapDay);
    const first = await runInDurableObject(stub, async (instance, state) => {
      const sql = state.storage.sql;
      const originalExec = sql.exec.bind(sql);
      const descriptor = Object.getOwnPropertyDescriptor(sql, "exec");
      let injected = false;
      Object.defineProperty(sql, "exec", {
        configurable: true,
        value: (...args: Parameters<typeof sql.exec>) => {
          if (
            !injected &&
            args[0].includes("CREATE TABLE IF NOT EXISTS booking_details")
          ) {
            injected = true;
            throw new Error("forced schema bootstrap failure");
          }
          return originalExec(...args);
        },
      });
      try {
        return await instance.createPublic(bootstrapDay, createInput(bootstrapDay));
      } finally {
        if (descriptor === undefined) Reflect.deleteProperty(sql, "exec");
        else Object.defineProperty(sql, "exec", descriptor);
      }
    });

    expect(first).toEqual({ ok: false, code: "TEMPORARILY_UNAVAILABLE" });
    expect(
      await runInDurableObject(stub, (_instance, state) =>
        state.storage.sql
          .exec<{ name: string }>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT GLOB '_cf_*' AND name NOT GLOB '__*' ORDER BY name",
          )
          .toArray()
          .map(({ name }) => name),
      ),
    ).toEqual([]);
    expect(
      await stub.createPublic(bootstrapDay, createInput(bootstrapDay)),
    ).toMatchObject({ ok: true, replayed: false });
  });

  it("applies approve, reject, cancel, complete, and no-show with the required capacity effect", async () => {
    const scenarios = [
      { action: "approve", status: "approved", publicCreate: true, releases: false },
      { action: "reject", status: "rejected", publicCreate: true, releases: true },
      { action: "cancel", status: "cancelled", publicCreate: false, releases: true },
      { action: "complete", status: "completed", publicCreate: false, releases: false },
      { action: "no_show", status: "no_show", publicCreate: false, releases: false },
    ] as const;

    for (const [index, scenario] of scenarios.entries()) {
      const config = configFor(`2025-01-${String(16 + index).padStart(2, "0")}`);
      const stub = stubFor(config);
      const input = createInput(config, { serviceIds: ["service-cut"] });
      const created = scenario.publicCreate
        ? await stub.createPublic(config, input)
        : await stub.createOwner(config, input);
      expect(created).toMatchObject({ ok: true });

      if (scenario.action === "complete" || scenario.action === "no_show") {
        vi.mocked(Date.now).mockReturnValue(Date.parse(`${config.date}T15:00:00.000Z`));
      }

      const command = {
        commandId: crypto.randomUUID(),
        date: config.date,
        reservationId: reservationIdOf(created),
        action: scenario.action,
        ...(scenario.action === "reject" ? { reason: "架空の受付都合" } : {}),
      };
      const transitioned = await callTarget(
        stub,
        "transitionOwner",
        config,
        command,
      );
      expect(transitioned).toMatchObject({
        ok: true,
        status: scenario.status,
        replayed: false,
      });

      const replay = await callTarget(stub, "transitionOwner", config, command);
      expect(replay).toMatchObject({
        ok: true,
        status: scenario.status,
        replayed: true,
      });
      const projection = await stub.listOwner(config);
      expect(projection).toMatchObject({
        ok: true,
        reservations: [
          {
            reservationId: reservationIdOf(created),
            status: scenario.status,
            snapshot: singleSnapshot,
            ...(scenario.action === "reject"
              ? { rejectionReason: "架空の受付都合" }
              : {}),
          },
        ],
      });
      const availability = await stub.availability(config, ["service-cut"]);
      expect(startsFor(availability, "resource-chair-a").includes("09:00")).toBe(
        scenario.releases,
      );
      if (["rejected", "cancelled", "completed", "no_show"].includes(scenario.status)) {
        expect(
          await stub.availability(
            config,
            ["service-cut"],
            reservationIdOf(created),
          ),
        ).toEqual({ ok: false, code: "NOT_FOUND_OR_UNAUTHORIZED" });
      }
    }
  });

  it("accepts only the canonical all-resource business-day closure", async () => {
    const stub = stubFor();
    const nonCanonical = await callTarget(
      stub,
      "createClosure",
      day,
      {
        commandId: crypto.randomUUID(),
        date: day.date,
        resourceId: null,
        startTime: "10:00",
        endTime: "11:00",
        label: "架空の全体休止",
      },
    );
    expect(nonCanonical).toEqual({ ok: false, code: "BAD_REQUEST" });

    const command = {
      commandId: crypto.randomUUID(),
      date: day.date,
      resourceId: null,
      startTime: "09:00",
      endTime: "13:00",
      label: "架空の全日休業",
    };
    expect(await callTarget(stub, "createClosure", day, command)).toMatchObject({
      ok: true,
      replayed: false,
    });
    expect(await callTarget(stub, "createClosure", day, command)).toMatchObject({
      ok: true,
      replayed: true,
    });
    const availability = await stub.availability(day, ["service-cut"]);
    expect(startsFor(availability, "resource-chair-a")).toEqual([]);
    expect(startsFor(availability, "resource-chair-b")).toEqual([]);
  });

  it("uses half-open overlap rules for resource closures and active bookings", async () => {
    const stub = stubFor();
    expect(
      await callTarget(
        stub,
        "createClosure",
        day,
        {
          commandId: crypto.randomUUID(),
          date: day.date,
          resourceId: "resource-chair-a",
          startTime: "10:00",
          endTime: "11:00",
          label: "架空チェア A の整備",
        },
      ),
    ).toMatchObject({ ok: true });

    const availability = await stub.availability(day, ["service-cut"]);
    expect(startsFor(availability, "resource-chair-a")).toEqual([
      "09:00",
      "11:00",
      "11:30",
      "12:00",
    ]);
    expect(startsFor(availability, "resource-chair-b")).toEqual(startTimes);

    expect(
      await stub.createPublic(
        day,
        createInput(day, {
          serviceIds: ["service-cut"],
          startTime: "09:30",
        }),
      ),
    ).toEqual({ ok: false, code: "UNAVAILABLE" });
    expect(
      await stub.createPublic(
        day,
        createInput(day, { serviceIds: ["service-cut"], startTime: "09:00" }),
      ),
    ).toMatchObject({ ok: true, status: "pending" });
    expect(
      await callTarget(
        stub,
        "createClosure",
        day,
        {
          commandId: crypto.randomUUID(),
          date: day.date,
          resourceId: "resource-chair-a",
          startTime: "09:30",
          endTime: "10:30",
          label: "既存予約と重なる整備",
        },
      ),
    ).toEqual({ ok: false, code: "UNAVAILABLE" });
  });

  it("reschedules within one day atomically while preserving reference, ownership, and snapshot", async () => {
    const stub = stubFor();
    const created = await stub.createPublic(
      day,
      createInput(day, { serviceIds: ["service-cut"] }),
    );
    expect(created).toMatchObject({ ok: true });
    const command = {
      commandId: crypto.randomUUID(),
      date: day.date,
      reservationId: reservationIdOf(created),
      action: "reschedule",
      resourceId: "resource-chair-b",
      startTime: "11:00",
    };

    expect(await callTarget(stub, "transitionOwner", day, command)).toMatchObject({
      ok: true,
      reservationId: reservationIdOf(created),
      resourceId: "resource-chair-b",
      startTime: "11:00",
      status: "pending",
      replayed: false,
    });
    expect(await callTarget(stub, "transitionOwner", day, command)).toMatchObject({
      ok: true,
      reservationId: reservationIdOf(created),
      replayed: true,
    });
    expect(await stub.listOwner(day)).toMatchObject({
      ok: true,
      reservations: [
        {
          reservationId: reservationIdOf(created),
          resourceId: "resource-chair-b",
          startTime: "11:00",
          status: "pending",
          customerName: "架空 花子",
          contact: "hanako@example.invalid",
          snapshot: singleSnapshot,
        },
      ],
    });
    const availability = await stub.availability(day, ["service-cut"]);
    expect(startsFor(availability, "resource-chair-a")).toContain("09:00");
    expect(startsFor(availability, "resource-chair-b")).not.toContain("11:00");
  });

  it("offers a same-resource partially overlapping start only to the reservation being moved", async () => {
    const stub = stubFor();
    const created = await stub.createPublic(day, createInput(day));
    expect(created).toMatchObject({ ok: true, startTime: "09:00" });
    const reservationId = reservationIdOf(created);

    expect(
      await stub.availability(day, ["service-cut"], reservationId),
    ).toEqual({ ok: false, code: "BAD_REQUEST" });
    const serviceIds = ["service-color", "service-cut"];
    const publicAvailability = await stub.availability(day, serviceIds);
    expect(startsFor(publicAvailability, "resource-chair-a")).not.toContain("09:30");

    const rescheduleAvailability = await stub.availability(
      day,
      serviceIds,
      reservationId,
    );
    expect(startsFor(rescheduleAvailability, "resource-chair-a")).not.toContain("09:00");
    expect(startsFor(rescheduleAvailability, "resource-chair-a")).toContain("09:30");
    expect(
      await callTarget(stub, "transitionOwner", day, {
        commandId: crypto.randomUUID(),
        date: day.date,
        reservationId,
        action: "reschedule",
        resourceId: "resource-chair-a",
        startTime: "09:30",
      }),
    ).toMatchObject({
      ok: true,
      reservationId,
      resourceId: "resource-chair-a",
      startTime: "09:30",
    });
  });

  it("rejects elapsed and past-day starts while replaying an accepted create", async () => {
    const sameDay = configFor("2025-01-15");
    const now = vi.mocked(Date.now);
    now.mockReturnValue(Date.parse(`${sameDay.date}T00:00:00.000Z`));
    try {
      const stub = stubFor(sameDay);
      const acceptedInput = createInput(sameDay, {
        serviceIds: ["service-cut"],
        startTime: "11:00",
      });
      const accepted = await stub.createPublic(sameDay, acceptedInput);
      const owner = await stub.createOwner(
        sameDay,
        createInput(sameDay, {
          serviceIds: ["service-cut"],
          resourceId: "resource-chair-b",
          startTime: "12:00",
        }),
      );
      const acceptedReschedule = {
        commandId: crypto.randomUUID(),
        date: sameDay.date,
        reservationId: reservationIdOf(owner),
        action: "reschedule",
        resourceId: "resource-chair-b",
        startTime: "11:00",
      };
      expect(
        await callTarget(stub, "transitionOwner", sameDay, acceptedReschedule),
      ).toMatchObject({ ok: true, replayed: false, startTime: "11:00" });

      now.mockReturnValue(Date.parse(`${sameDay.date}T01:30:00.000Z`));
      const availability = await stub.availability(sameDay, ["service-cut"]);
      expect(startsFor(availability, "resource-chair-a")).toEqual(["12:00"]);
      expect(startsFor(availability, "resource-chair-b")).toEqual(["12:00"]);

      expect(
        await stub.createPublic(
          sameDay,
          createInput(sameDay, { serviceIds: ["service-cut"], startTime: "09:00" }),
        ),
      ).toEqual({ ok: false, code: "UNAVAILABLE" });
      expect(
        await stub.createOwner(
          sameDay,
          createInput(sameDay, {
            serviceIds: ["service-cut"],
            resourceId: "resource-chair-b",
            startTime: "09:00",
          }),
        ),
      ).toEqual({ ok: false, code: "UNAVAILABLE" });
      expect(
        await callTarget(stub, "transitionOwner", sameDay, {
          commandId: crypto.randomUUID(),
          date: sameDay.date,
          reservationId: reservationIdOf(owner),
          action: "reschedule",
          resourceId: "resource-chair-a",
          startTime: "10:00",
        }),
      ).toEqual({ ok: false, code: "UNAVAILABLE" });
      expect(await stub.listOwner(sameDay)).toMatchObject({
        reservations: expect.arrayContaining([
          expect.objectContaining({
            reservationId: reservationIdOf(owner),
            resourceId: "resource-chair-b",
            startTime: "11:00",
          }),
        ]),
      });

      now.mockReturnValue(Date.parse(`${sameDay.date}T15:30:00.000Z`));
      const pastAvailability = await stub.availability(sameDay, ["service-cut"]);
      expect(
        pastAvailability.ok && pastAvailability.resources.every(({ startTimes }) => startTimes.length === 0),
      ).toBe(true);
      expect(
        await callTarget(stub, "transitionOwner", sameDay, {
          commandId: crypto.randomUUID(),
          date: sameDay.date,
          reservationId: reservationIdOf(owner),
          action: "reschedule",
          resourceId: "resource-chair-a",
          startTime: "11:00",
        }),
      ).toEqual({ ok: false, code: "UNAVAILABLE" });
      expect(
        await callTarget(stub, "transitionOwner", sameDay, acceptedReschedule),
      ).toMatchObject({ ok: true, replayed: true, startTime: "11:00" });
      expect(await stub.createPublic(sameDay, acceptedInput)).toMatchObject({
        ok: true,
        reservationId: reservationIdOf(accepted),
        replayed: true,
      });
    } finally {
      now.mockReturnValue(Date.parse("2025-01-14T15:00:00.000Z"));
    }
  });

  it("keeps the original interval on a reschedule conflict or persistence failure", async () => {
    const conflictDay = configFor("2025-01-21");
    const conflictStub = stubFor(conflictDay);
    const source = await conflictStub.createPublic(
      conflictDay,
      createInput(conflictDay, { serviceIds: ["service-cut"] }),
    );
    await conflictStub.createPublic(
      conflictDay,
      createInput(conflictDay, {
        serviceIds: ["service-cut"],
        resourceId: "resource-chair-b",
        startTime: "11:00",
      }),
    );
    expect(
      await callTarget(
        conflictStub,
        "transitionOwner",
        conflictDay,
        {
          commandId: crypto.randomUUID(),
          date: conflictDay.date,
          reservationId: reservationIdOf(source),
          action: "reschedule",
          resourceId: "resource-chair-b",
          startTime: "11:00",
        },
      ),
    ).toEqual({ ok: false, code: "UNAVAILABLE" });
    expect(await conflictStub.listOwner(conflictDay)).toMatchObject({
      ok: true,
      reservations: expect.arrayContaining([
        expect.objectContaining({
          reservationId: reservationIdOf(source),
          resourceId: "resource-chair-a",
          startTime: "09:00",
        }),
      ]),
    });

    const rollbackDay = configFor("2025-01-22");
    const rollbackStub = stubFor(rollbackDay);
    const rollbackSource = await rollbackStub.createPublic(
      rollbackDay,
      createInput(rollbackDay, { serviceIds: ["service-cut"] }),
    );
    await runInDurableObject(rollbackStub, (_instance, state) => {
      state.storage.sql.exec(`
        CREATE TRIGGER force_reschedule_receipt_failure
        BEFORE INSERT ON adapter_receipts
        BEGIN
          SELECT RAISE(ABORT, 'forced test failure');
        END
      `);
    });
    expect(
      await callTarget(
        rollbackStub,
        "transitionOwner",
        rollbackDay,
        {
          commandId: crypto.randomUUID(),
          date: rollbackDay.date,
          reservationId: reservationIdOf(rollbackSource),
          action: "reschedule",
          resourceId: "resource-chair-b",
          startTime: "11:00",
        },
      ),
    ).toEqual({ ok: false, code: "TEMPORARILY_UNAVAILABLE" });
    expect(await rollbackStub.listOwner(rollbackDay)).toMatchObject({
      ok: true,
      reservations: [
        expect.objectContaining({
          reservationId: reservationIdOf(rollbackSource),
          resourceId: "resource-chair-a",
          startTime: "09:00",
        }),
      ],
    });
  });

  it("serializes an exact 50-way same-capacity race with one pending winner", async () => {
    const stub = stubFor();
    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        stub.createPublic(
          day,
          createInput(day, { serviceIds: ["service-cut"] }),
        ),
      ),
    );

    expect(results).toHaveLength(50);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(
      results.filter((result) => !result.ok && result.code === "UNAVAILABLE"),
    ).toHaveLength(49);
    expect(results.find((result) => result.ok)).toMatchObject({
      status: "pending",
      snapshot: singleSnapshot,
    });
  });

  it("returns a bounded projection at the 96-create and 192-mutation ceiling", async () => {
    const resources = Array.from({ length: 8 }, (_, index) => ({
      id: `resource-${index + 1}`,
      label: `架空リソース ${index + 1}`,
      active: true,
    }));
    const maxStartTimes = Array.from({ length: 12 }, (_, index) => {
      const minute = 9 * 60 + index * 15;
      return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(
        minute % 60,
      ).padStart(2, "0")}`;
    });
    const maxDay: TargetDayConfig = {
      ...day,
      date: "2025-01-23",
      settingsVersion: 9,
      resourceIds: resources.map(({ id }) => id),
      resources,
      services: [
        {
          id: "service-short",
          label: "架空ショート枠",
          category: null,
          durationMinutes: 15,
          cleanupMinutes: 0,
          priceYen: 1_000,
          eligibleResourceIds: resources.map(({ id }) => id),
          active: true,
        },
      ],
      opensAt: "09:00",
      closesAt: "12:00",
      startIntervalMinutes: 15,
      startTimes: maxStartTimes,
      slotMinutes: 15,
      consentVersion: "consent-max",
    };
    const stub = stubFor(maxDay);
    const creates = await Promise.all(
      resources.flatMap((resource, resourceIndex) =>
        maxStartTimes.map((startTime, timeIndex) =>
          stub.createPublic(
            maxDay,
            createInput(maxDay, {
              serviceIds: ["service-short"],
              resourceId: resource.id,
              startTime,
              customerName: `架空 顧客 ${resourceIndex}-${timeIndex}`,
              contact: `guest-${resourceIndex}-${timeIndex}@example.invalid`,
              consentVersion: "consent-max",
            }),
          ),
        ),
      ),
    );
    expect(creates).toHaveLength(96);
    expect(creates.filter((result) => result.ok)).toHaveLength(96);

    expect(
      await callTarget(stub, "transitionOwner", maxDay, {
        commandId: crypto.randomUUID(),
        date: maxDay.date,
        reservationId: reservationIdOf(creates[95]),
        action: "cancel",
      }),
    ).toMatchObject({ ok: true, status: "cancelled" });
    expect(
      await stub.availability(
        maxDay,
        ["service-short"],
        reservationIdOf(creates[95]),
      ),
    ).toEqual({ ok: false, code: "NOT_FOUND_OR_UNAUTHORIZED" });
    const rescheduleAvailability = await stub.availability(
      maxDay,
      ["service-short"],
      reservationIdOf(creates[0]),
    );
    expect(rescheduleAvailability).toMatchObject({
      ok: true,
      capacityReached: true,
    });
    expect(startsFor(rescheduleAvailability, "resource-8")).toContain("11:45");
    expect(
      await callTarget(stub, "transitionOwner", maxDay, {
        commandId: crypto.randomUUID(),
        date: maxDay.date,
        reservationId: reservationIdOf(creates[0]),
        action: "reschedule",
        resourceId: "resource-8",
        startTime: "11:45",
      }),
    ).toMatchObject({ ok: true, startTime: "11:45" });

    const approvals = await Promise.all(
      creates.slice(0, -1).map((created) =>
        callTarget(
          stub,
          "transitionOwner",
          maxDay,
          {
            commandId: crypto.randomUUID(),
            date: maxDay.date,
            reservationId: reservationIdOf(created),
            action: "approve",
          },
        ),
      ),
    );
    expect(approvals.every((result) =>
      typeof result === "object" && result !== null && "ok" in result && result.ok === true,
    )).toBe(true);

    const terminalActions = await Promise.all(
      creates.slice(0, -2).map((created) =>
        callTarget(
          stub,
          "transitionOwner",
          maxDay,
          {
            commandId: crypto.randomUUID(),
            date: maxDay.date,
            reservationId: reservationIdOf(created),
            action: "cancel",
          },
        ),
      ),
    );
    expect(terminalActions).toHaveLength(94);
    expect(terminalActions.every((result) =>
      typeof result === "object" && result !== null && "ok" in result && result.ok === true,
    )).toBe(true);

    expect(
      await callTarget(stub, "transitionOwner", maxDay, {
        commandId: crypto.randomUUID(),
        date: maxDay.date,
        reservationId: reservationIdOf(creates[94]),
        action: "reschedule",
        resourceId: "resource-1",
        startTime: "09:00",
      }),
    ).toMatchObject({ ok: true, startTime: "09:00" });
    expect(
      await stub.availability(
        maxDay,
        ["service-short"],
        reservationIdOf(creates[94]),
      ),
    ).toEqual({ ok: false, code: "CAPACITY_REACHED" });

    expect(
      await callTarget(
        stub,
        "transitionOwner",
        maxDay,
        {
          commandId: crypto.randomUUID(),
          date: maxDay.date,
          reservationId: reservationIdOf(creates[0]),
          action: "approve",
        },
      ),
    ).toEqual({ ok: false, code: "CAPACITY_REACHED" });

    const projection = await stub.listOwner(maxDay);
    expect(projection).toMatchObject({
      ok: true,
      settingsVersion: 9,
      closures: [],
    });
    expect(projection.ok && projection.reservations).toHaveLength(96);
    expect(
      projection.ok &&
        projection.reservations.filter(({ status }) => status === "cancelled"),
    ).toHaveLength(95);
    expect(
      projection.ok &&
        projection.reservations.filter(({ status }) => status === "approved"),
    ).toHaveLength(1);
    expect(
      await stub.createPublic(
        maxDay,
        createInput(maxDay, {
          serviceIds: ["service-short"],
          resourceId: "resource-1",
          startTime: "09:00",
          consentVersion: "consent-max",
        }),
      ),
    ).toEqual({ ok: false, code: "CAPACITY_REACHED" });
  });

  it("fails closed on every corrupted persisted structure and round-trips valid rows", async () => {
    const corruptDay = configFor("2025-01-17");
    const stub = stubFor(corruptDay);
    expect(
      await stub.createPublic(corruptDay, createInput(corruptDay)),
    ).toMatchObject({ ok: true, replayed: false });
    expect(
      await callTarget(stub, "createClosure", corruptDay, {
        commandId: crypto.randomUUID(),
        date: corruptDay.date,
        resourceId: "resource-chair-b",
        startTime: "11:00",
        endTime: "12:00",
        label: "架空の設備点検",
      }),
    ).toMatchObject({ ok: true, replayed: false });

    const healthy = await stub.listOwner(corruptDay);
    expect(healthy).toMatchObject({ ok: true });

    const original = await runInDurableObject(stub, (_instance, state) => {
      const detail = state.storage.sql
        .exec<{
          snapshot_json: string;
          reschedule_history_json: string;
          created_at: string;
          outcome_at: string | null;
        }>(
          "SELECT snapshot_json, reschedule_history_json, created_at, outcome_at FROM booking_details",
        )
        .toArray()[0];
      const meta = state.storage.sql
        .exec<{ date: string; schedule_json: string; accepted_mutations: number }>(
          "SELECT date, schedule_json, accepted_mutations FROM partition_meta WHERE singleton = 1",
        )
        .toArray()[0];
      const closure = state.storage.sql
        .exec<{ created_at: string }>("SELECT created_at FROM closures")
        .toArray()[0];
      if (detail === undefined || meta === undefined || closure === undefined) {
        throw new Error("missing baseline rows");
      }
      return { detail, meta, closure };
    });

    const snapshot = JSON.parse(original.detail.snapshot_json) as {
      services: Array<Record<string, unknown>>;
      serviceMinutes: number;
    };
    const withServices = (services: unknown): string =>
      JSON.stringify({ ...snapshot, services });
    const validHistory = [
      {
        from: { resourceId: "resource-chair-a", startTime: "09:00" },
        to: { resourceId: "resource-chair-b", startTime: "10:00" },
      },
    ];

    const corruptions: Array<[string, string, unknown[]]> = [
      [
        "snapshot service element with a non-string identifier",
        "UPDATE booking_details SET snapshot_json = ?",
        [withServices(snapshot.services.map((service, index) => (index === 0 ? { ...service, id: 7 } : service)))],
      ],
      [
        "snapshot service element with an out-of-range price",
        "UPDATE booking_details SET snapshot_json = ?",
        [withServices(snapshot.services.map((service, index) => (index === 0 ? { ...service, priceYen: -1 } : service)))],
      ],
      [
        "snapshot service element carrying an unexpected key",
        "UPDATE booking_details SET snapshot_json = ?",
        [withServices(snapshot.services.map((service, index) => (index === 0 ? { ...service, note: "x" } : service)))],
      ],
      [
        "snapshot aggregate that disagrees with its service list",
        "UPDATE booking_details SET snapshot_json = ?",
        [JSON.stringify({ ...snapshot, serviceMinutes: snapshot.serviceMinutes + 5 })],
      ],
      [
        "reschedule history entry missing a field",
        "UPDATE booking_details SET reschedule_history_json = ?",
        [JSON.stringify([{ from: { resourceId: "resource-chair-a" }, to: validHistory[0]?.to }])],
      ],
      [
        "reschedule history entry with an invalid start time",
        "UPDATE booking_details SET reschedule_history_json = ?",
        [JSON.stringify([{ ...validHistory[0], to: { resourceId: "resource-chair-b", startTime: "25:00" } }])],
      ],
      [
        "booking timestamp that is not a canonical instant",
        "UPDATE booking_details SET created_at = ?",
        ["2025-01-14T15:00:00Z"],
      ],
      [
        "booking outcome timestamp that is not a canonical instant",
        "UPDATE booking_details SET outcome_at = ?",
        ["yesterday"],
      ],
      // A negative accepted_mutations value cannot be injected here: the
      // partition_meta CHECK constraint rejects it before #readMeta ever sees the
      // row. The matching guard in #readMeta is defense in depth for a database
      // whose constraints were not applied, so it has no reachable test.
      [
        "calendar-invalid partition date",
        "UPDATE partition_meta SET date = ? WHERE singleton = 1",
        ["2025-02-30"],
      ],
      [
        "calendar-invalid date inside the stored schedule",
        "UPDATE partition_meta SET schedule_json = ? WHERE singleton = 1",
        [original.meta.schedule_json.replace(corruptDay.date, "2025-02-30")],
      ],
      [
        "stored schedule date disagreeing with the partition date column",
        "UPDATE partition_meta SET schedule_json = ? WHERE singleton = 1",
        [original.meta.schedule_json.replace(corruptDay.date, "2025-01-18")],
      ],
      [
        "closure timestamp that is not a canonical instant",
        "UPDATE closures SET created_at = ?",
        ["2025-01-14"],
      ],
    ];

    for (const [label, statement, parameters] of corruptions) {
      await runInDurableObject(stub, (_instance, state) => {
        state.storage.sql.exec(statement, ...parameters);
      });
      expect(await stub.listOwner(corruptDay), label).toEqual({
        ok: false,
        code: "TEMPORARILY_UNAVAILABLE",
      });
      await runInDurableObject(stub, (_instance, state) => {
        state.storage.sql.exec(
          `UPDATE booking_details
             SET snapshot_json = ?, reschedule_history_json = ?, created_at = ?, outcome_at = ?`,
          original.detail.snapshot_json,
          original.detail.reschedule_history_json,
          original.detail.created_at,
          original.detail.outcome_at,
        );
        state.storage.sql.exec(
          `UPDATE partition_meta
             SET date = ?, schedule_json = ?, accepted_mutations = ?
           WHERE singleton = 1`,
          original.meta.date,
          original.meta.schedule_json,
          original.meta.accepted_mutations,
        );
        state.storage.sql.exec(
          "UPDATE closures SET created_at = ?",
          original.closure.created_at,
        );
      });
    }

    expect(await stub.listOwner(corruptDay)).toEqual(healthy);

    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE booking_details SET reschedule_history_json = ?",
        JSON.stringify(validHistory),
      );
    });
    expect(await stub.listOwner(corruptDay)).toMatchObject({
      ok: true,
      reservations: [{ rescheduleHistory: validHistory }],
    });
  });
});

describe("S2 calendar outbox substrate", () => {
  const descriptor = (consumer: "line" | "calendar", expired = false) => ({
    consumer,
    generation: 1,
    phase: "active" as const,
    leaseIssuedAt: Date.now() - 1_000,
    leaseNotAfter: Date.now() + (expired ? -1 : 30_000),
  });

  const configured = (
    config: TargetDayConfig,
    options: { line?: boolean; calendar?: boolean; expiredCalendar?: boolean } = {},
  ) =>
    ({
      ...config,
      ...(options.line ? { adapter: descriptor("line") } : {}),
      ...(options.calendar
        ? { calendarAdapter: descriptor("calendar", options.expiredCalendar) }
        : {}),
    }) as TargetDayConfig;

  const call = <T>(
    stub: DurableObjectStub<TargetReservationDay>,
    method: string,
    ...args: unknown[]
  ): Promise<T | { ok: false; code: "NOT_IMPLEMENTED" | "UNEXPECTED_ERROR"; detail?: string }> =>
    runInDurableObject(stub, async (instance) => {
      const operation = (instance as unknown as Record<string, unknown>)[method];
      if (typeof operation !== "function") return { ok: false, code: "NOT_IMPLEMENTED" };
      try {
        return (await Reflect.apply(operation, instance, args)) as T;
      } catch (error) {
        return {
          ok: false,
          code: "UNEXPECTED_ERROR",
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    });

  it("emits calendar create independently and projects only schedule facts", async () => {
    const stub = stubFor();
    const calendarDay = configured(day, { line: true, calendar: true });
    const withoutAdapters = await stub.availability(day, ["service-cut"]);
    const withAdapters = await stub.availability(calendarDay, ["service-cut"]);
    expect(JSON.stringify(withAdapters)).toBe(JSON.stringify(withoutAdapters));

    const created = await stub.createPublic(
      calendarDay,
      createInput(calendarDay, { serviceIds: ["service-cut"] }),
    );
    expect(created).toMatchObject({ ok: true, status: "pending" });

    const calendar = await call<{ events: Array<Record<string, unknown>> }>(
      stub,
      "drainOutbox",
      { consumer: "calendar" },
    );
    const line = await call<{ events: Array<Record<string, unknown>> }>(
      stub,
      "drainOutbox",
      { consumer: "line" },
    );
    expect(calendar).toMatchObject({
      events: [
        {
          type: "create",
          reservationId: reservationIdOf(created),
          startTime: "09:00",
          endTime: "10:00",
          serviceLabel: "架空カット",
          reservationStatus: "pending",
        },
      ],
    });
    expect(line).toMatchObject({ events: [] });

    const projection = await call<Record<string, unknown>>(
      stub,
      "calendarProjection",
      calendarDay,
    );
    expect(projection).toEqual({
      ok: true,
      date: day.date,
      purgeAt: day.purgeAt,
      events: [
        {
          reservationId: reservationIdOf(created),
          stampAt: expect.any(String),
          startTime: "09:00",
          endTime: "10:00",
          serviceLabel: "架空カット",
          status: "pending",
        },
      ],
    });
    const bytes = JSON.stringify(projection);
    expect(bytes).not.toContain("架空 花子");
    expect(bytes).not.toContain("hanako@example.invalid");
    expect(bytes).not.toContain("managementDigest");
  });

  it("keeps completed and no-show schedule facts without emitting a calendar mutation", async () => {
    for (const [index, action] of (["complete", "no_show"] as const).entries()) {
      const calendarDay = configured(configFor(`2025-01-${25 + index}`), { calendar: true });
      const stub = stubFor(calendarDay);
      const created = await stub.createOwner(
        calendarDay,
        createInput(calendarDay, { serviceIds: ["service-cut"] }),
      );
      expect(created).toMatchObject({ ok: true, status: "approved" });
      const initial = await stub.drainOutbox({ consumer: "calendar" });
      await stub.ackOutbox({
        consumer: "calendar",
        events: initial.events.map(({ generation, eventId }) => ({ generation, eventId })),
      });

      vi.mocked(Date.now).mockReturnValue(Date.parse(`${calendarDay.date}T15:00:00.000Z`));
      expect(
        await stub.transitionOwner(calendarDay, {
          commandId: crypto.randomUUID(),
          date: calendarDay.date,
          reservationId: reservationIdOf(created),
          action,
        }),
      ).toMatchObject({ ok: true, status: action === "complete" ? "completed" : "no_show" });
      await expect(stub.drainOutbox({ consumer: "calendar" })).resolves.toEqual({
        events: [],
        more: false,
      });
      await expect(stub.calendarProjection(calendarDay)).resolves.toMatchObject({
        ok: true,
        events: [
          {
            reservationId: reservationIdOf(created),
            stampAt: expect.any(String),
            status: "approved",
          },
        ],
      });
    }
  });

  it("adds calendar columns to a released LINE outbox without losing its row", async () => {
    const stub = stubFor();
    const created = await stub.createPublic(day, createInput(day, { serviceIds: ["service-cut"] }));
    expect(created).toMatchObject({ ok: true });
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(`
        CREATE TABLE __adapter_meta (
          consumer TEXT NOT NULL,
          generation INTEGER NOT NULL,
          event_seq INTEGER NOT NULL,
          PRIMARY KEY (consumer, generation)
        )
      `);
      state.storage.sql.exec(`
        CREATE TABLE __adapter_outbox (
          consumer TEXT NOT NULL,
          generation INTEGER NOT NULL,
          seq INTEGER NOT NULL,
          event_id TEXT NOT NULL,
          reservation_id TEXT NOT NULL,
          type TEXT NOT NULL,
          start_time TEXT NOT NULL,
          service_label TEXT NOT NULL,
          occurred_at TEXT NOT NULL,
          purge_at INTEGER NOT NULL,
          PRIMARY KEY (consumer, generation, seq)
        )
      `);
      state.storage.sql.exec(
        `INSERT INTO __adapter_meta (consumer, generation, event_seq) VALUES ('line', 1, 1)`,
      );
      state.storage.sql.exec(
        `INSERT INTO __adapter_outbox
           (consumer, generation, seq, event_id, reservation_id, type, start_time,
            service_label, occurred_at, purge_at)
         VALUES ('line', 1, 1, ?, ?, 'approve', '09:00', '架空カット', ?, ?)`,
        `${day.date}#1`,
        reservationIdOf(created),
        new Date().toISOString(),
        day.purgeAt,
      );
    });

    await expect(stub.drainOutbox({ consumer: "line" })).resolves.toMatchObject({
      events: [{ endTime: null, reservationStatus: null }],
      more: false,
    });
    expect(
      await call(stub, "transitionOwner", configured(day, { calendar: true }), {
        commandId: crypto.randomUUID(),
        date: day.date,
        reservationId: reservationIdOf(created),
        action: "approve",
      }),
    ).toMatchObject({ ok: true, status: "approved" });

    const migrated = await runInDurableObject(stub, (_instance, state) => ({
      columns: state.storage.sql
        .exec<{ name: string }>("PRAGMA table_info('__adapter_outbox')")
        .toArray()
        .map(({ name }) => name),
      lineRows: state.storage.sql
        .exec<{ end_time: string | null; reservation_status: string | null }>(
          `SELECT end_time, reservation_status FROM __adapter_outbox
           WHERE consumer = 'line'`,
        )
        .toArray(),
    }));
    expect(migrated.columns).toEqual(expect.arrayContaining(["end_time", "reservation_status"]));
    expect(migrated.lineRows).toEqual([{ end_time: null, reservation_status: null }]);
  });

  it("commits a booking under an expired optional calendar lease", async () => {
    const stub = stubFor();
    const stale = configured(day, { calendar: true, expiredCalendar: true });
    const created = await stub.createPublic(
      stale,
      createInput(stale, { serviceIds: ["service-cut"] }),
    );
    expect(created).toMatchObject({ ok: true, status: "pending" });
    expect(startsFor(await stub.availability(day, ["service-cut"]), "resource-chair-a")).not.toContain(
      "09:00",
    );
    await expect(stub.drainOutbox({ consumer: "calendar" })).resolves.toEqual({
      events: [],
      more: false,
    });
    await expect(stub.calendarProjection(day)).resolves.toMatchObject({
      ok: true,
      events: [{ reservationId: reservationIdOf(created), status: "pending" }],
    });
  });
});

describe("T012 pending expiry", () => {
  const EXPIRY_MINUTES = 15;
  const START = Date.parse("2025-01-14T15:00:00.000Z");
  const DEADLINE = START + EXPIRY_MINUTES * 60_000;
  const expiring: TargetDayConfig = { ...day, pendingExpiryMinutes: EXPIRY_MINUTES };

  const managementKey = "k".repeat(43);
  const digestOf = async (value: string): Promise<string> =>
    [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");

  beforeEach(() => {
    // The outer hook mocks Date.now only, which leaves `new Date()` -- the
    // clock that writes created_at -- on the real time. The deadline compares
    // the two, so both have to come from the same fake clock.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(START);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const statusOf = (result: unknown): string =>
    typeof result === "object" && result !== null && "status" in result
      ? String(result.status)
      : "";

  it("releases the slot an abandoned pending booking was holding", async () => {
    const stub = stubFor();
    const created = await stub.createPublic(expiring, createInput(expiring));
    const reservationId = reservationIdOf(created);
    expect(statusOf(created)).toBe("pending");
    expect(
      startsFor(await stub.availability(expiring, ["service-cut", "service-color"]), "resource-chair-a"),
    ).not.toContain("09:00");

    vi.setSystemTime(DEADLINE);

    expect(
      startsFor(await stub.availability(expiring, ["service-cut", "service-color"]), "resource-chair-a"),
    ).toContain("09:00");
    expect(await stub.listOwner(expiring)).toMatchObject({
      ok: true,
      reservations: [{ reservationId, status: "expired", outcomeAt: new Date(DEADLINE).toISOString() }],
    });
    // The slot is genuinely free, not merely displayed as free.
    expect(
      await stub.createPublic(expiring, createInput(expiring, { startTime: "09:00" })),
    ).toMatchObject({ ok: true, status: "pending" });
  });

  it("expires every booking that is due, and leaves the rest alone", async () => {
    const stub = stubFor();
    const first = reservationIdOf(await stub.createPublic(expiring, createInput(expiring)));
    const second = reservationIdOf(
      await stub.createPublic(
        expiring,
        createInput(expiring, { resourceId: "resource-chair-b", serviceIds: ["service-cut"] }),
      ),
    );

    vi.setSystemTime(START + 10 * 60_000);
    const late = reservationIdOf(
      await stub.createPublic(
        expiring,
        createInput(expiring, { startTime: "11:00", serviceIds: ["service-cut"] }),
      ),
    );
    const approved = reservationIdOf(
      await stub.createOwner(
        expiring,
        createInput(expiring, { startTime: "12:00", serviceIds: ["service-cut"] }),
      ),
    );

    vi.setSystemTime(DEADLINE);
    const projection = await stub.listOwner(expiring);
    const byId = new Map(
      (projection as { reservations: Array<{ reservationId: string; status: string }> }).reservations
        .map((reservation) => [reservation.reservationId, reservation.status] as const),
    );
    expect(byId.get(first)).toBe("expired");
    expect(byId.get(second)).toBe("expired");
    expect(byId.get(late)).toBe("pending");
    expect(byId.get(approved)).toBe("approved");
  });

  it("expires exactly at the deadline millisecond and not before it", async () => {
    const stub = stubFor();
    await stub.createPublic(expiring, createInput(expiring));

    vi.setSystemTime(DEADLINE - 1);
    expect(await stub.listOwner(expiring)).toMatchObject({
      ok: true,
      reservations: [{ status: "pending", expiresAt: new Date(DEADLINE).toISOString() }],
    });

    vi.setSystemTime(DEADLINE);
    expect(await stub.listOwner(expiring)).toMatchObject({
      ok: true,
      reservations: [{ status: "expired" }],
    });
  });

  it("resolves approve, reject and cancel racing the deadline to one outcome", async () => {
    for (const action of ["approve", "reject", "cancel"] as const) {
      const config = configFor("2025-01-15");
      const target: TargetDayConfig = { ...config, pendingExpiryMinutes: EXPIRY_MINUTES };
      const stub = stubFor(target);
      vi.setSystemTime(START);
      const reservationId = reservationIdOf(
        await stub.createPublic(target, createInput(target)),
      );

      vi.setSystemTime(DEADLINE);
      expect(
        await callTarget(stub, "transitionOwner", target, {
          commandId: crypto.randomUUID(),
          date: target.date,
          reservationId,
          action,
          ...(action === "reject" ? { reason: "架空の理由" } : {}),
        }),
      ).toEqual({ ok: false, code: "NOT_FOUND_OR_UNAUTHORIZED" });
      expect(await stub.listOwner(target)).toMatchObject({
        ok: true,
        reservations: [{ reservationId, status: "expired" }],
      });
      await reset();
    }
  });

  it("refuses a customer cancellation after the deadline and keeps the expiry", async () => {
    const stub = stubFor();
    const reservationId = reservationIdOf(
      await stub.createPublic(
        expiring,
        createInput(expiring, { managementDigest: await digestOf(managementKey) }),
      ),
    );

    vi.setSystemTime(DEADLINE);
    expect(
      await stub.cancelPublic(expiring, {
        commandId: crypto.randomUUID(),
        date: expiring.date,
        reservationId,
        managementKey,
      }),
    ).toEqual({ ok: false, code: "NOT_FOUND_OR_UNAUTHORIZED" });
    expect(await stub.statusPublic(expiring, {
      date: expiring.date,
      reservationId,
      managementKey,
    })).toMatchObject({ ok: true, status: "expired", allowedActions: [] });
  });

  it("keeps a replayed create and a replayed cancel answering as they first did", async () => {
    const stub = stubFor();
    const createCommandId = crypto.randomUUID();
    const input = createInput(expiring, {
      commandId: createCommandId,
      managementDigest: await digestOf(managementKey),
    });
    const created = await stub.createPublic(expiring, input);
    expect(statusOf(created)).toBe("pending");

    const other = reservationIdOf(
      await stub.createPublic(
        expiring,
        createInput(expiring, {
          resourceId: "resource-chair-b",
          serviceIds: ["service-cut"],
          managementDigest: await digestOf(managementKey),
        }),
      ),
    );
    const cancelCommandId = crypto.randomUUID();
    const cancelled = await stub.cancelPublic(expiring, {
      commandId: cancelCommandId,
      date: expiring.date,
      reservationId: other,
      managementKey,
    });
    expect(statusOf(cancelled)).toBe("cancelled");

    vi.setSystemTime(DEADLINE);
    expect(await stub.createPublic(expiring, input)).toEqual({
      ...(created as Record<string, unknown>),
      replayed: true,
    });
    expect(
      await stub.cancelPublic(expiring, {
        commandId: cancelCommandId,
        date: expiring.date,
        reservationId: other,
        managementKey,
      }),
    ).toEqual({ ...(cancelled as Record<string, unknown>), replayed: true });
  });

  it("keeps the expiry across a restart of the object", async () => {
    const stub = stubFor();
    const reservationId = reservationIdOf(await stub.createPublic(expiring, createInput(expiring)));

    vi.setSystemTime(DEADLINE);
    expect(await stub.listOwner(expiring)).toMatchObject({
      ok: true,
      reservations: [{ status: "expired" }],
    });

    // A second entry into the object reads the row back rather than recomputing
    // it, so a status that only existed in memory would show up here.
    const reentered = stubFor();
    expect(await reentered.listOwner(expiring)).toMatchObject({
      ok: true,
      reservations: [{ reservationId, status: "expired" }],
    });
    const detail = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ status: string; created_at: string; outcome_at: string | null }>(
          "SELECT status, created_at, outcome_at FROM booking_details WHERE reservation_id = ?",
          reservationId,
        )
        .toArray()[0],
    );
    expect(detail).toEqual({
      status: "expired",
      created_at: new Date(START).toISOString(),
      outcome_at: new Date(DEADLINE).toISOString(),
    });
  });

  it("never expires anything when the lifetime is not configured", async () => {
    const stub = stubFor();
    const reservationId = reservationIdOf(await stub.createPublic(day, createInput()));

    vi.setSystemTime(START + 400 * 24 * 60 * 60_000);
    expect(await stub.listOwner(day)).toMatchObject({
      ok: true,
      reservations: [{ reservationId, status: "pending" }],
    });
    expect(await stub.listOwner(day)).not.toMatchObject({
      reservations: [{ expiresAt: expect.anything() }],
    });
  });

  it("refuses a lifetime outside the supported range", async () => {
    const stub = stubFor();
    for (const pendingExpiryMinutes of [14, 10081, 0, -15, 1.5]) {
      expect(
        await stub.availability({ ...expiring, pendingExpiryMinutes }, ["service-cut"]),
      ).toEqual({ ok: false, code: "CONFIGURATION_CONFLICT" });
    }
  });
});
