import {
  SELF,
  env,
  reset,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  DayConfig,
  DayCalendarProjectionResult,
  ReservationDay,
} from "../src/reservation-day.ts";
import type { CalendarAdapter } from "../src/calendar-adapter.ts";
import worker from "../src/worker.ts";

const nextOpenJstDate = (minimumOffset = 0) => {
  const now = Date.now() + 9 * 60 * 60 * 1000;
  for (let offset = minimumOffset; offset < 97; offset += 1) {
    const date = new Date(now + offset * 86_400_000).toISOString().slice(0, 10);
    if (new Date(`${date}T00:00:00.000Z`).getUTCDay() !== 0) return date;
  }
  throw new Error("open date not found");
};

const testDate = nextOpenJstDate(1);
const day: DayConfig = {
  date: testDate,
  resourceIds: ["resource-chair-a", "resource-chair-b"],
  startTimes: ["09:00", "10:00"],
  slotMinutes: 60,
  purgeAt: Date.parse(`${testDate}T15:00:00.000Z`) + 31 * 86_400_000,
};

const digest = "a".repeat(64);
const ownerToken = "owner-test-token-0123456789abcdef0123456789";
const ownerHeaders = { authorization: `Bearer ${ownerToken}` };

const liveSettings = () => ({
  locationName: "架空予約室 青空",
  timeZone: "Asia/Tokyo",
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
  resources: [
    { id: "resource-chair-a", label: "架空チェア A", active: true },
    { id: "resource-chair-b", label: "架空チェア B", active: true },
  ],
  opensAt: "09:00",
  closesAt: "13:00",
  startIntervalMinutes: 30,
  openWeekdays: [0, 1, 2, 3, 4, 5, 6],
  horizonDays: 60,
  retentionDays: 30,
  consentVersion: "consent-v2",
  operatorDisplayName: "架空予約室 運営者",
  operatorContact: "contact@example.invalid",
  privacyNotice: "予約受付に必要な情報だけを利用します。",
  termsNotice: "表示内容を確認してから予約を送信してください。",
  cancellationPolicy: "予約一覧からキャンセルできます。",
  sourceUrl: "https://github.com/public-fixture/salon-reservation",
  turnstileSiteKey: "public-site-key-fixture-7d2f4c90",
  allowedHostname: "example.test",
  themeId: "ink",
});

const stubFor = (date = day.date) =>
  env.RESERVATION_DAYS.getByName(
    `single-location:${date}`,
  ) as DurableObjectStub<ReservationDay>;

const persistedCounts = (stub = stubFor()) =>
  runInDurableObject(stub, (_instance, state) => {
    const hasSchema = state.storage.sql
      .exec<{ count: number }>(
        "SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'core_state'",
      )
      .one().count === 1;
    if (!hasSchema) return { state: 0, details: 0, receipts: 0, meta: 0 };
    return {
      state: state.storage.sql
        .exec<{ count: number }>("SELECT count(*) AS count FROM core_state")
        .one().count,
      details: state.storage.sql
        .exec<{ count: number }>("SELECT count(*) AS count FROM booking_details")
        .one().count,
      receipts: state.storage.sql
        .exec<{ count: number }>("SELECT count(*) AS count FROM adapter_receipts")
        .one().count,
      meta: state.storage.sql
        .exec<{ count: number }>("SELECT count(*) AS count FROM partition_meta")
        .one().count,
    };
  });

const tableNames = (stub = stubFor()) =>
  runInDurableObject(stub, (_instance, state) =>
    state.storage.sql
      .exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT GLOB '_cf_*' AND name NOT GLOB '__*' ORDER BY name",
      )
      .toArray()
      .map(({ name }) => name),
  );

const createInput = (overrides: Record<string, unknown> = {}) => ({
  commandId: crypto.randomUUID(),
  date: day.date,
  resourceId: "resource-chair-a",
  startTime: "09:00",
  customerName: "架空 花子",
  contact: "hanako@example.invalid",
  managementDigest: digest,
  ...overrides,
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await reset();
});

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "https://challenges.cloudflare.com/turnstile/v0/siteverify") {
        return Response.json({
          success: true,
          action: "reservation-create",
          hostname: "example.test",
        });
      }
      throw new Error("Unexpected outbound request");
    }),
  );
});

const jsonRequest = (
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
  method = "POST",
) =>
  SELF.fetch(`https://example.test${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      origin: "https://example.test",
      ...headers,
    },
    body: JSON.stringify(body),
  });

const publicCreateBody = async (
  overrides: Record<string, unknown> = {},
  managementKey = "A".repeat(43),
) => {
  const managementDigest = await crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(managementKey))
    .then((bytes) =>
      [...new Uint8Array(bytes)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join(""),
    );
  return {
    managementKey,
    body: {
      commandId: crypto.randomUUID(),
      settingsVersion: 2,
      serviceIds: ["service-cut", "service-color"],
      date: day.date,
      resourceId: "resource-chair-a",
      startTime: "09:00",
      customerName: "架空 花子",
      contact: "hanako@example.invalid",
      consentVersion: "consent-v2",
      managementDigest,
      turnstileToken: "turnstile-test-token",
      replayOnly: false,
      ...overrides,
    },
  };
};

const updateInstallation = (
  settings = liveSettings(),
  commandId = crypto.randomUUID(),
  expectedSettingsVersion = 1,
) =>
  jsonRequest(
    "/api/admin/setup",
    { commandId, expectedSettingsVersion, settings },
    ownerHeaders,
    "PUT",
  );

const setLive = (
  live = true,
  commandId = crypto.randomUUID(),
  expectedSettingsVersion = 2,
) =>
  jsonRequest(
    "/api/admin/setup/live",
    { commandId, expectedSettingsVersion, live },
    ownerHeaders,
  );

const enableLiveInstallation = async () => {
  const updated = await updateInstallation();
  expect(updated.status).toBe(200);
  const activated = await setLive();
  expect(activated.status).toBe(200);
};

const availabilityUrl = (
  serviceIds: string[] = ["service-cut", "service-color"],
  date = day.date,
) => {
  const query = new URLSearchParams({ date });
  for (const serviceId of serviceIds) query.append("serviceId", serviceId);
  return `https://example.test/api/availability?${query}`;
};

type ApiReservation = {
  reservationId: string;
  date: string;
  startTime: string;
  status: string;
  resourceLabel: string;
  services: Array<Record<string, unknown>>;
  serviceMinutes: number;
  cleanupMinutes: number;
  priceYen: number | null;
  rejectionReason?: string | null;
  allowedActions: string[];
};

type ApiMutation = {
  ok: true;
  operation: string;
  replayed: boolean;
  reservation?: ApiReservation;
  closureId?: string | null;
};

const acceptedPublicCreate = async (
  overrides: Record<string, unknown> = {},
  managementKey = "A".repeat(43),
) => {
  const fixture = await publicCreateBody(overrides, managementKey);
  const response = await jsonRequest("/api/reservations", fixture.body);
  expect(response.status).toBe(201);
  const result = await response.json<ApiMutation>();
  expect(result.reservation?.reservationId).toEqual(expect.any(String));
  return { ...fixture, response, result };
};

const acceptedOwnerCreate = async (
  overrides: Record<string, unknown> = {},
  managementKey = "A".repeat(43),
) => {
  const fixture = await publicCreateBody(overrides, managementKey);
  const {
    turnstileToken: _turnstileToken,
    replayOnly: _replayOnly,
    ...body
  } = fixture.body;
  const response = await jsonRequest(
    "/api/admin/reservations",
    body,
    ownerHeaders,
  );
  expect(response.status).toBe(201);
  const result = await response.json<ApiMutation>();
  expect(result.reservation?.reservationId).toEqual(expect.any(String));
  return { ...fixture, body, response, result };
};

describe("ReservationDay storage boundary", () => {
  it("keeps an empty read-only day storage-free", async () => {
    const stub = stubFor();
    const result = await stub.availability(day);

    expect(result).toEqual({
      ok: true,
      pinned: false,
      capacityReached: false,
      resources: [
        { id: "resource-chair-a", startTimes: ["09:00", "10:00"] },
        { id: "resource-chair-b", startTimes: ["09:00", "10:00"] },
      ],
    });
    expect(await tableNames(stub)).toEqual([]);
  });

  it("commits state, private detail, and replay evidence together", async () => {
    const stub = stubFor();
    const input = createInput();
    const created = await stub.createPublic(day, input);

    expect(created).toMatchObject({
      ok: true,
      reservationId: expect.any(String),
      status: "active",
      replayed: false,
    });
    const counts = await runInDurableObject(stub, (_instance, state) => ({
      state: state.storage.sql
        .exec<{ count: number }>("SELECT count(*) AS count FROM core_state")
        .one().count,
      details: state.storage.sql
        .exec<{ count: number }>("SELECT count(*) AS count FROM booking_details")
        .one().count,
      receipts: state.storage.sql
        .exec<{ count: number }>("SELECT count(*) AS count FROM adapter_receipts")
        .one().count,
      operation: state.storage.sql
        .exec<{ operation: string }>("SELECT operation FROM adapter_receipts")
        .one().operation,
    }));
    expect(counts).toEqual({
      state: 1,
      details: 1,
      receipts: 1,
      operation: "public-create",
    });

    const replay = await stub.createPublic(day, input);
    expect(replay).toEqual({ ...created, replayed: true });
    expect(
      await runInDurableObject(stub, (_instance, state) =>
        state.storage.sql
          .exec<{ count: number }>("SELECT count(*) AS count FROM adapter_receipts")
          .one().count,
      ),
    ).toBe(1);
  });

  it("rolls back every value when one persistence statement fails", async () => {
    const stub = stubFor();
    expect(await stub.createPublic(day, createInput())).toMatchObject({ ok: true });
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(`
        CREATE TRIGGER force_receipt_failure
        BEFORE INSERT ON adapter_receipts
        BEGIN
          SELECT RAISE(ABORT, 'forced test failure');
        END
      `);
    });

    expect(
      await stub.createPublic(day, createInput({ startTime: "10:00" })),
    ).toEqual({
      ok: false,
      code: "TEMPORARILY_UNAVAILABLE",
    });
    const counts = await runInDurableObject(stub, (_instance, state) => ({
      state: state.storage.sql
        .exec<{ count: number }>("SELECT count(*) AS count FROM core_state")
        .one().count,
      details: state.storage.sql
        .exec<{ count: number }>("SELECT count(*) AS count FROM booking_details")
        .one().count,
      receipts: state.storage.sql
        .exec<{ count: number }>("SELECT count(*) AS count FROM adapter_receipts")
        .one().count,
      meta: state.storage.sql
        .exec<{ count: number }>("SELECT count(*) AS count FROM partition_meta")
        .one().count,
    }));
    expect(counts).toEqual({ state: 1, details: 1, receipts: 1, meta: 1 });
  });

  it("serializes a 50-way same-slot race with exactly one winner", async () => {
    const stub = stubFor();
    const results = await Promise.all(
      Array.from({ length: 50 }, () => stub.createPublic(day, createInput())),
    );

    expect(results.filter(({ ok }) => ok)).toHaveLength(1);
    expect(
      results.filter((result) => !result.ok && result.code === "UNAVAILABLE"),
    ).toHaveLength(49);
  });

  it("replays one create 100 times without another revision or row", async () => {
    const stub = stubFor();
    const input = createInput();
    const first = await stub.createPublic(day, input);
    expect(first.ok).toBe(true);

    const replays = await Promise.all(
      Array.from({ length: 100 }, () => stub.createPublic(day, input)),
    );
    expect(replays.every((result) => result.ok && result.replayed)).toBe(true);
    const snapshot = await runInDurableObject(stub, (_instance, state) => ({
      revision: JSON.parse(
        state.storage.sql
          .exec<{ state_json: string }>("SELECT state_json FROM core_state")
          .one().state_json,
      ).revision as number,
      details: state.storage.sql
        .exec<{ count: number }>("SELECT count(*) AS count FROM booking_details")
        .one().count,
      receipts: state.storage.sql
        .exec<{ count: number }>("SELECT count(*) AS count FROM adapter_receipts")
        .one().count,
    }));
    expect(snapshot).toEqual({ revision: 1, details: 1, receipts: 1 });
  });

  it("cancels with the plaintext key digest check and does not disclose failures", async () => {
    const managementKey = "A".repeat(43);
    const managementDigest = await crypto.subtle
      .digest("SHA-256", new TextEncoder().encode(managementKey))
      .then((bytes) =>
        [...new Uint8Array(bytes)]
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join(""),
      );
    const stub = stubFor();
    const created = await stub.createPublic(
      day,
      createInput({ managementDigest }),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const wrong = await stub.cancelPublic(day, {
      commandId: crypto.randomUUID(),
      date: day.date,
      reservationId: created.reservationId,
      managementKey: "B".repeat(43),
    });
    expect(wrong).toEqual({ ok: false, code: "NOT_FOUND_OR_UNAUTHORIZED" });

    const cancelInput = {
      commandId: crypto.randomUUID(),
      date: day.date,
      reservationId: created.reservationId,
      managementKey,
    };
    const cancelled = await stub.cancelPublic(day, cancelInput);
    expect(cancelled).toMatchObject({
      ok: true,
      reservationId: created.reservationId,
      status: "cancelled",
      replayed: false,
    });
    expect(await stub.cancelPublic(day, cancelInput)).toEqual({
      ...cancelled,
      replayed: true,
    });
    expect(await stub.availability(day)).toMatchObject({
      ok: true,
      resources: [
        { id: "resource-chair-a", startTimes: ["09:00", "10:00"] },
        { id: "resource-chair-b", startTimes: ["09:00", "10:00"] },
      ],
    });
  });

  it("fails closed on schedule drift or malformed persisted state", async () => {
    const stub = stubFor();
    expect(await stub.createPublic(day, createInput())).toMatchObject({ ok: true });
    expect(
      await stub.availability({ ...day, slotMinutes: 30 }),
    ).toEqual({ ok: false, code: "CONFIGURATION_CONFLICT" });

    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE core_state SET state_json = ? WHERE singleton = 1",
        '{"version":1,"revision":99,"reservations":[],"receipts":[]}',
      );
    });
    expect(await stub.availability(day)).toEqual({
      ok: false,
      code: "TEMPORARILY_UNAVAILABLE",
    });
  });

  it("deletes the complete partition and remains safe when cleanup repeats", async () => {
    const stub = stubFor();
    expect(await stub.createPublic(day, createInput())).toMatchObject({ ok: true });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await stub.availability(day)).toMatchObject({
      ok: true,
      capacityReached: false,
    });
    expect(await tableNames(stub)).toEqual([]);
    expect(await runDurableObjectAlarm(stub)).toBe(false);
  });

  it("completes a bounded 96-create lifecycle day in the target runtime", async () => {
    const managementKey = "C".repeat(43);
    const managementDigest = await crypto.subtle
      .digest("SHA-256", new TextEncoder().encode(managementKey))
      .then((bytes) =>
        [...new Uint8Array(bytes)]
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join(""),
      );
    const startTimes = Array.from({ length: 96 }, (_, index) => {
      const minute = index * 15;
      return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(
        minute % 60,
      ).padStart(2, "0")}`;
    });
    const maxDay: DayConfig = {
      date: day.date,
      resourceIds: ["resource-chair-a"],
      startTimes,
      slotMinutes: 15,
      purgeAt: day.purgeAt,
    };
    const stub = stubFor();
    const createdIds: string[] = [];
    for (const startTime of startTimes.slice(0, -1)) {
      const result = await stub.createPublic(
        maxDay,
        createInput({ startTime, managementDigest }),
      );
      expect(result.ok).toBe(true);
      if (result.ok) createdIds.push(result.reservationId);
    }

    const measured = await runInDurableObject(stub, async (instance) => {
      const input = createInput({
        startTime: startTimes.at(-1),
        managementDigest,
      });
      const createStart = performance.now();
      const create = await instance.createPublic(maxDay, input);
      const createMilliseconds = performance.now() - createStart;
      const replayStart = performance.now();
      const replay = await instance.createPublic(maxDay, input);
      const replayMilliseconds = performance.now() - replayStart;
      const listStart = performance.now();
      const list = await instance.listOwner(maxDay);
      const listMilliseconds = performance.now() - listStart;
      return {
        create,
        replay,
        list,
        milliseconds: [
          createMilliseconds,
          replayMilliseconds,
          listMilliseconds,
        ],
      };
    });
    expect(measured.create.ok).toBe(true);
    expect(measured.replay).toMatchObject({ ok: true, replayed: true });
    expect(measured.list).toMatchObject({ ok: true });
    expect(measured.milliseconds.every(Number.isFinite)).toBe(true);
    if (measured.create.ok) createdIds.push(measured.create.reservationId);

    for (const reservationId of createdIds.slice(0, -1)) {
      expect(
        await stub.cancelPublic(maxDay, {
          commandId: crypto.randomUUID(),
          date: maxDay.date,
          reservationId,
          managementKey,
        }),
      ).toMatchObject({ ok: true });
    }
    const lastReservationId = createdIds.at(-1);
    expect(lastReservationId).toBeTypeOf("string");
    if (lastReservationId === undefined) return;
    const lastCancel = await runInDurableObject(stub, async (instance) => {
      const started = performance.now();
      const result = await instance.cancelPublic(maxDay, {
        commandId: crypto.randomUUID(),
        date: maxDay.date,
        reservationId: lastReservationId,
        managementKey,
      });
      return { result, milliseconds: performance.now() - started };
    });
    expect(lastCancel.result).toMatchObject({ ok: true });
    expect(Number.isFinite(lastCancel.milliseconds)).toBe(true);
    expect(
      await stub.createPublic(
        maxDay,
        createInput({ startTime: "00:00", managementDigest }),
      ),
    ).toEqual({ ok: false, code: "CAPACITY_REACHED" });

    const meta = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ accepted_creates: number; accepted_mutations: number }>(
          "SELECT accepted_creates, accepted_mutations FROM partition_meta",
        )
        .one(),
    );
    expect(meta).toEqual({ accepted_creates: 96, accepted_mutations: 96 });

    // Every slot is free again, yet the day's cumulative acceptance budget is
    // spent: the projection must say which limit was hit instead of offering
    // a bookable grid it would refuse.
    const exhausted = await stub.availability(maxDay);
    expect(exhausted).toMatchObject({ ok: true, capacityReached: true });
    if (!("resources" in exhausted)) {
      throw new Error("availability response does not contain resources");
    }
    expect(
      exhausted.resources.every(({ startTimes: offered }) => offered.length === 0),
    ).toBe(true);
  });
});

describe("Worker HTTP trust boundary", () => {
  it("projects public settings and authoritative multi-service availability totals", async () => {
    expect((await updateInstallation()).status).toBe(200);

    const configResponse = await SELF.fetch("https://example.test/api/config");
    expect(configResponse.status).toBe(200);
    const config = await configResponse.json<Record<string, unknown>>();
    expect(config).toMatchObject({
      mode: "demo",
      settingsVersion: 2,
      locationName: "架空予約室 青空",
      timeZone: "Asia/Tokyo",
      services: [
        {
          id: "service-cut",
          durationMinutes: 45,
          cleanupMinutes: 15,
          priceYen: 4_000,
        },
        {
          id: "service-color",
          durationMinutes: 60,
          cleanupMinutes: 0,
          priceYen: 6_000,
        },
      ],
      schedule: {
        opensAt: "09:00",
        closesAt: "13:00",
        startIntervalMinutes: 30,
        horizonDays: 60,
      },
      privacyNotice: liveSettings().privacyNotice,
      termsNotice: liveSettings().termsNotice,
      cancellationPolicy: liveSettings().cancellationPolicy,
    });
    expect(configResponse.headers.get("cache-control")).toBe("no-store");
    expect(JSON.stringify(config)).not.toMatch(
      /retention|secret|token|allowedHostname/i,
    );

    const availabilityResponse = await SELF.fetch(availabilityUrl());
    expect(availabilityResponse.status).toBe(200);
    const availability =
      await availabilityResponse.json<Record<string, unknown>>();
    expect(availability).toMatchObject({
      date: day.date,
      settingsVersion: 2,
      serviceIds: ["service-cut", "service-color"],
      serviceMinutes: 105,
      cleanupMinutes: 15,
      occupiedMinutes: 120,
      priceYen: 10_000,
      resources: [
        {
          id: "resource-chair-a",
          label: "架空チェア A",
          startTimes: ["09:00", "09:30", "10:00", "10:30", "11:00"],
        },
      ],
    });
    expect(availabilityResponse.headers.get("cache-control")).toBe("no-store");
    expect(JSON.stringify(availability)).not.toMatch(
      /customer|contact|reservationId|digest|receipt|actor/i,
    );
  });

  it("books, safely replays, refuses a wrong key, and cancels", async () => {
    await enableLiveInstallation();
    const { managementKey, body } = await publicCreateBody();
    const createdResponse = await jsonRequest("/api/reservations", body);
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json<{
      operation: string;
      replayed: boolean;
      reservation: {
        reservationId: string;
        status: string;
        serviceMinutes: number;
        cleanupMinutes: number;
        priceYen: number;
      };
    }>();
    expect(created).toMatchObject({
      operation: "create",
      replayed: false,
      reservation: {
        status: "pending",
        serviceMinutes: 105,
        cleanupMinutes: 15,
        priceYen: 10_000,
      },
    });
    expect(created.replayed).toBe(false);
    expect(JSON.stringify(created)).not.toContain(managementKey);
    expect(JSON.stringify(created)).not.toContain(body.managementDigest);
    const siteverifyCall = vi.mocked(fetch).mock.calls[0];
    expect(siteverifyCall?.[0]).toBe(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    );
    const siteverifyBody = JSON.parse(
      (siteverifyCall?.[1] as RequestInit | undefined)?.body as string,
    );
    expect(siteverifyBody).toMatchObject({ response: body.turnstileToken });
    expect(siteverifyBody.idempotency_key).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );

    const replayResponse = await jsonRequest("/api/reservations", {
      ...body,
      turnstileToken: "turnstile-retry-token",
    });
    expect(replayResponse.status).toBe(201);
    expect(await replayResponse.json()).toEqual({ ...created, replayed: true });

    const wrongResponse = await jsonRequest(
      `/api/reservations/${created.reservation.reservationId}/cancel`,
      {
        commandId: crypto.randomUUID(),
        date: day.date,
        managementKey: "B".repeat(43),
      },
    );
    expect(wrongResponse.status).toBe(404);
    expect(await wrongResponse.json()).toEqual({
      ok: false,
      error: {
        code: "NOT_FOUND_OR_UNAUTHORIZED",
        message: "予約情報または管理キーを確認できませんでした。",
      },
    });

    const cancelledResponse = await jsonRequest(
      `/api/reservations/${created.reservation.reservationId}/cancel`,
      {
        commandId: crypto.randomUUID(),
        date: day.date,
        managementKey,
      },
    );
    expect(cancelledResponse.status).toBe(200);
    expect(await cancelledResponse.json()).toMatchObject({
      operation: "cancel",
      reservation: {
        reservationId: created.reservation.reservationId,
        status: "cancelled",
      },
    });
  });

  it("does not let one validated Turnstile token authorize another command", async () => {
    await enableLiveInstallation();
    // Models the real endpoint: a token is single-use, except that repeating the
    // validation with the idempotency key it was first seen with replays the
    // original verdict. A different command derives a different key, so reusing
    // one token across commands is a genuine duplicate.
    const consumedTokens = new Map<string, string | undefined>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const verification = JSON.parse(init?.body as string) as {
          response: string;
          idempotency_key?: string;
        };
        const firstKey = consumedTokens.get(verification.response);
        if (
          consumedTokens.has(verification.response) &&
          firstKey !== verification.idempotency_key
        ) {
          return Response.json({
            success: false,
            "error-codes": ["timeout-or-duplicate"],
          });
        }
        consumedTokens.set(verification.response, verification.idempotency_key);
        return Response.json({
          success: true,
          action: "reservation-create",
          hostname: "example.test",
        });
      }),
    );
    const { body } = await publicCreateBody();
    expect((await jsonRequest("/api/reservations", body)).status).toBe(201);
    expect(
      (
        await jsonRequest("/api/reservations", {
          ...body,
          commandId: crypto.randomUUID(),
          startTime: "11:00",
        })
      ).status,
    ).toBe(403);
    expect(await persistedCounts()).toEqual({
      state: 1,
      details: 1,
      receipts: 1,
      meta: 1,
    });
  });

  it("rejects forged authority, cross-origin, non-JSON, oversized, and unknown input before storage", async () => {
    await enableLiveInstallation();
    const { body } = await publicCreateBody();
    const attempts = [
      jsonRequest("/api/reservations", { ...body, actor: { capabilities: ["reservation:create"] } }),
      jsonRequest("/api/reservations", { ...body, turnstileIdempotencyKey: crypto.randomUUID() }),
      jsonRequest("/api/reservations", {
        ...body,
        serviceMinutes: 1,
        cleanupMinutes: 0,
        priceYen: 1,
      }),
      SELF.fetch("https://example.test/api/reservations", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://attacker.invalid",
        },
        body: JSON.stringify(body),
      }),
      SELF.fetch("https://example.test/api/reservations", {
        method: "POST",
        headers: {
          "content-type": "text/plain",
          origin: "https://example.test",
        },
        body: JSON.stringify(body),
      }),
      SELF.fetch("https://example.test/api/reservations", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://example.test",
        },
        body: JSON.stringify({ ...body, contact: "x".repeat(17_000) }),
      }),
    ];
    const responses = await Promise.all(attempts);
    expect(responses.map(({ status }) => status)).toEqual([
      400,
      400,
      400,
      403,
      400,
      413,
    ]);
    expect(await persistedCounts()).toEqual({
      state: 0,
      details: 0,
      receipts: 0,
      meta: 0,
    });
  });

  it("fails closed when Turnstile refuses or its verifier is unavailable", async () => {
    await enableLiveInstallation();
    const { body } = await publicCreateBody();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ success: false })),
    );
    expect((await jsonRequest("/api/reservations", body)).status).toBe(403);
    expect(await persistedCounts()).toEqual({
      state: 0,
      details: 0,
      receipts: 0,
      meta: 0,
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    expect((await jsonRequest("/api/reservations", body)).status).toBe(503);
    expect(await persistedCounts()).toEqual({
      state: 0,
      details: 0,
      receipts: 0,
      meta: 0,
    });
  });

  it("retries Siteverify only for provider failure and separates it from an invalid proof", async () => {
    await enableLiveInstallation();
    const { body } = await publicCreateBody();
    const accepted = {
      success: true,
      action: "reservation-create",
      hostname: "example.test",
    };
    const cases: Array<{
      label: string;
      reply: () => Response;
      status: number;
      calls: number;
    }> = [
      {
        label: "invalid proof is terminal",
        reply: () =>
          Response.json({
            success: false,
            "error-codes": ["invalid-input-response"],
          }),
        status: 403,
        calls: 1,
      },
      {
        label: "a spent token is terminal",
        reply: () =>
          Response.json({
            success: false,
            "error-codes": ["timeout-or-duplicate"],
          }),
        status: 403,
        calls: 1,
      },
      {
        label: "internal-error is retried, then fails closed",
        reply: () =>
          Response.json({ success: false, "error-codes": ["internal-error"] }),
        status: 503,
        calls: 2,
      },
      {
        label: "a provider 5xx is retried, then fails closed",
        reply: () => Response.json({ success: false }, { status: 500 }),
        status: 503,
        calls: 2,
      },
      {
        label: "a rejected request is not retried",
        reply: () => Response.json({ success: false }, { status: 400 }),
        status: 503,
        calls: 1,
      },
      {
        label: "a malformed body is not retried",
        reply: () =>
          new Response("not json", {
            headers: { "content-type": "application/json" },
          }),
        status: 503,
        calls: 1,
      },
      {
        label: "an unexpected action is refused",
        reply: () => Response.json({ ...accepted, action: "login" }),
        status: 403,
        calls: 1,
      },
      {
        label: "an unexpected hostname is refused",
        reply: () =>
          Response.json({ ...accepted, hostname: "attacker.invalid" }),
        status: 403,
        calls: 1,
      },
    ];

    for (const { label, reply, status, calls } of cases) {
      const stub = vi.fn(async () => reply());
      vi.stubGlobal("fetch", stub);
      const response = await jsonRequest("/api/reservations", {
        ...body,
        commandId: crypto.randomUUID(),
      });
      expect(response.status, label).toBe(status);
      expect(stub.mock.calls.length, label).toBe(calls);
    }

    expect(await persistedCounts()).toEqual({
      state: 0,
      details: 0,
      receipts: 0,
      meta: 0,
    });
  });

  it("aborts a hanging Siteverify request and retries it with the same idempotency key", async () => {
    await enableLiveInstallation();
    const { body } = await publicCreateBody();
    const keys: Array<string | undefined> = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        const verification = JSON.parse(init?.body as string) as {
          idempotency_key?: string;
        };
        keys.push(verification.idempotency_key);
        if (keys.length === 1) {
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new Error("aborted")),
            );
          });
        }
        return Promise.resolve(
          Response.json({
            success: true,
            action: "reservation-create",
            hostname: "example.test",
          }),
        );
      }),
    );

    expect((await jsonRequest("/api/reservations", body)).status).toBe(201);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);

    const logged = warn.mock.calls.map(([line]) => String(line)).join("\n");
    expect(logged).toContain("turnstile.siteverify");
    for (const secretValue of [
      body.turnstileToken,
      body.managementDigest,
      body.customerName,
      body.contact,
      keys[0] as string,
      "turnstile-test-secret",
    ]) {
      expect(logged).not.toContain(secretValue);
    }
  });

  it("binds the Siteverify idempotency key to the exact proof, not just the command", async () => {
    await enableLiveInstallation();
    const { body } = await publicCreateBody();
    const seen: Array<{ token: string; key?: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const verification = JSON.parse(init?.body as string) as {
          response: string;
          idempotency_key?: string;
        };
        seen.push({ token: verification.response, key: verification.idempotency_key });
        return Response.json({
          success: false,
          "error-codes": ["invalid-input-response"],
        });
      }),
    );

    const commandId = crypto.randomUUID();
    await jsonRequest("/api/reservations", { ...body, commandId });
    await jsonRequest("/api/reservations", { ...body, commandId });
    await jsonRequest("/api/reservations", {
      ...body,
      commandId,
      turnstileToken: "turnstile-second-token",
    });
    await jsonRequest("/api/reservations", {
      ...body,
      commandId: crypto.randomUUID(),
    });
    await jsonRequest("/api/reservations", {
      ...body,
      commandId,
      date: nextOpenJstDate(4),
    });

    expect(seen).toHaveLength(5);
    // Same command, same token, same day replay the same validation.
    expect(seen[0]?.key).toBe(seen[1]?.key);
    // A fresh challenge under the same command is a different validation.
    expect(seen[2]?.key).not.toBe(seen[0]?.key);
    // A different command is a different validation.
    expect(seen[3]?.key).not.toBe(seen[0]?.key);
    // Each day is its own Durable Object and dedupes commandId only inside
    // itself, so one solved challenge must not be replayable onto another day.
    expect(seen[4]?.key).not.toBe(seen[0]?.key);
  });

  it("authenticates the owner and derives schedule, create, and transition authority server-side", async () => {
    await enableLiveInstallation();
    const schedulePath = `/api/admin/schedule?startDate=${day.date}&days=1`;
    expect(
      (await SELF.fetch(`https://example.test${schedulePath}`)).status,
    ).toBe(401);
    expect(
      (
        await SELF.fetch(`https://example.test${schedulePath}`, {
          headers: { authorization: "Bearer wrong-token" },
        })
      ).status,
    ).toBe(401);

    const { body } = await publicCreateBody();
    const ownerBody = { ...body };
    delete (ownerBody as Partial<typeof body>).turnstileToken;
    delete (ownerBody as Partial<typeof body>).replayOnly;
    const createdResponse = await jsonRequest(
      "/api/admin/reservations",
      ownerBody,
      ownerHeaders,
    );
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json<{
      reservation: { reservationId: string };
    }>();

    const listResponse = await SELF.fetch(
      `https://example.test${schedulePath}`,
      { headers: ownerHeaders },
    );
    expect(listResponse.status).toBe(200);
    expect(await listResponse.json()).toMatchObject({
      startDate: day.date,
      days: 1,
      boards: [
        {
          date: day.date,
          reservations: [
            {
              reservationId: created.reservation.reservationId,
              status: "approved",
              customerName: body.customerName,
              contact: body.contact,
            },
          ],
        },
      ],
    });
    expect(listResponse.headers.get("cache-control")).toBe("no-store");

    const cancelResponse = await jsonRequest(
      `/api/admin/reservations/${created.reservation.reservationId}/transition`,
      { commandId: crypto.randomUUID(), date: day.date, action: "cancel" },
      ownerHeaders,
    );
    expect(cancelResponse.status).toBe(200);
    expect(await cancelResponse.json()).toMatchObject({
      operation: "cancel",
      reservation: { status: "cancelled" },
    });
  });

  it("invalidates the previous owner token when the secret rotates", async () => {
    const rotatedToken = "rotated-owner-token-0123456789abcdef0123456789";
    const rotatedEnv = Object.create(env) as Env;
    Object.defineProperty(rotatedEnv, "OWNER_TOKEN", { value: rotatedToken });
    const request = (token: string) =>
      new Request(
        "https://example.test/api/admin/setup",
        { headers: { authorization: `Bearer ${token}` } },
      );

    expect((await worker.fetch(request(ownerToken), rotatedEnv)).status).toBe(401);
    expect((await worker.fetch(request(rotatedToken), rotatedEnv)).status).toBe(200);
  });

  it("returns stable method, route, date, and owner-auth errors without private detail", async () => {
    await enableLiveInstallation();
    const responses = await Promise.all([
      SELF.fetch("https://example.test/api/config", { method: "POST" }),
      SELF.fetch("https://example.test/api/unknown"),
      SELF.fetch(
        "https://example.test/api/availability?date=2026-02-30&serviceId=service-cut",
      ),
      jsonRequest(
        "/api/admin/reservations",
        {
          ...(await publicCreateBody()).body,
          role: "owner",
        },
        { authorization: `Bearer ${ownerToken}` },
      ),
    ]);
    expect(responses.map(({ status }) => status)).toEqual([405, 404, 400, 400]);
    for (const response of responses) {
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(JSON.stringify(await response.json())).not.toMatch(
        /hanako@example|owner-test-token|turnstile-test-secret/,
      );
    }
  });

  it("abuse-limits repeated owner authentication failures", async () => {
    const responses = [];
    for (let attempt = 0; attempt < 12; attempt += 1) {
      responses.push(
        await SELF.fetch(
          "https://example.test/api/admin/setup",
          {
            headers: {
              authorization: "Bearer definitely-wrong-owner-token",
              "cf-connecting-ip": "192.0.2.44",
            },
          },
        ),
      );
    }
    expect(responses.some(({ status }) => status === 429)).toBe(true);
    expect(
      responses
        .filter(({ status }) => status === 401)
        .every(
          (response) => response.headers.get("www-authenticate") === "Bearer",
        ),
    ).toBe(true);
  });
});

describe("T016 public booking API", () => {
  it("rejects a stale settings version without creating a reservation", async () => {
    await enableLiveInstallation();
    const { body } = await publicCreateBody({ settingsVersion: 1 });

    const response = await jsonRequest("/api/reservations", body);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: "CONFIGURATION_CONFLICT" },
    });

    const schedule = await SELF.fetch(
      `https://example.test/api/admin/schedule?startDate=${day.date}&days=1`,
      { headers: ownerHeaders },
    );
    expect(schedule.status).toBe(200);
    expect(await schedule.json()).toMatchObject({
      boards: [{ reservations: [] }],
    });
  });

  it("rechecks an occupied review selection before the second create", async () => {
    await enableLiveInstallation();
    await acceptedPublicCreate();
    const stale = await publicCreateBody(
      { commandId: crypto.randomUUID() },
      "B".repeat(43),
    );

    const response = await jsonRequest("/api/reservations", stale.body);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: "UNAVAILABLE" },
    });

    const availability = await SELF.fetch(availabilityUrl());
    expect(availability.status).toBe(200);
    const projection = await availability.json<{
      resources: Array<{ id: string; startTimes: string[] }>;
    }>();
    expect(
      projection.resources.find(({ id }) => id === "resource-chair-a")
        ?.startTimes,
    ).not.toContain("09:00");
  });

  it("caps public availability at four distinct services", async () => {
    const settings = liveSettings();
    settings.services.push(
      {
        ...settings.services[0]!,
        id: "service-three",
        label: "架空サービス 3",
      },
      {
        ...settings.services[0]!,
        id: "service-four",
        label: "架空サービス 4",
      },
      {
        ...settings.services[0]!,
        id: "service-five",
        label: "架空サービス 5",
      },
    );
    expect((await updateInstallation(settings)).status).toBe(200);
    const response = await SELF.fetch(
      availabilityUrl([
        "service-cut",
        "service-color",
        "service-three",
        "service-four",
        "service-five",
      ]),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: "BAD_REQUEST" },
    });
  });
});

describe("T024 customer status and cancellation API", () => {
  it("loads all 16 bounded browser-owned records before applying the public status limit", async () => {
    const responses = [];
    for (let attempt = 0; attempt < 24; attempt += 1) {
      responses.push(
        await jsonRequest(
          `/api/reservations/${crypto.randomUUID()}/status`,
          { date: day.date, managementKey: "A".repeat(43) },
        ),
      );
    }

    expect(responses.slice(0, 16).every(({ status }) => status === 404)).toBe(true);
    expect(responses.slice(16).some(({ status }) => status === 429)).toBe(true);
  });

  it("requires a management proof and returns only the proven safe projection", async () => {
    await enableLiveInstallation();
    const created = await acceptedPublicCreate();
    const reservationId = created.result.reservation?.reservationId as string;

    const missingProof = await jsonRequest(
      `/api/reservations/${reservationId}/status`,
      { date: day.date },
    );
    expect(missingProof.status).toBe(400);

    const crossOrigin = await SELF.fetch(
      `https://example.test/api/reservations/${reservationId}/status`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://attacker.invalid",
        },
        body: JSON.stringify({
          date: day.date,
          managementKey: created.managementKey,
        }),
      },
    );
    expect(crossOrigin.status).toBe(403);

    const response = await jsonRequest(
      `/api/reservations/${reservationId}/status`,
      { date: day.date, managementKey: created.managementKey },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const status = await response.json<ApiReservation>();
    expect(status).toMatchObject({
      reservationId,
      status: "pending",
      resourceLabel: "架空チェア A",
      serviceMinutes: 105,
      cleanupMinutes: 15,
      priceYen: 10_000,
      allowedActions: ["cancel"],
    });
    expect(JSON.stringify(status)).not.toMatch(
      /customerName|contact|management|digest|owner/i,
    );
  });

  it("uses one non-disclosing response for a wrong proof and an unknown reference", async () => {
    await enableLiveInstallation();
    const created = await acceptedPublicCreate();
    const reservationId = created.result.reservation?.reservationId as string;
    const proof = { date: day.date, managementKey: "B".repeat(43) };

    const wrongProof = await jsonRequest(
      `/api/reservations/${reservationId}/status`,
      proof,
    );
    const unknownReference = await jsonRequest(
      `/api/reservations/${crypto.randomUUID()}/status`,
      proof,
    );
    expect(wrongProof.status).toBe(404);
    expect(unknownReference.status).toBe(404);
    expect(await wrongProof.clone().json()).toEqual(
      await unknownReference.clone().json(),
    );
    expect(await wrongProof.json()).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND_OR_UNAUTHORIZED" },
    });
  });

  it("projects a rejected terminal state and refuses a new cancellation", async () => {
    await enableLiveInstallation();
    const created = await acceptedPublicCreate();
    const reservationId = created.result.reservation?.reservationId as string;
    const transition = await jsonRequest(
      `/api/admin/reservations/${reservationId}/transition`,
      {
        commandId: crypto.randomUUID(),
        date: day.date,
        action: "reject",
        reason: "架空の受付都合",
      },
      ownerHeaders,
    );
    expect(transition.status).toBe(200);

    const statusResponse = await jsonRequest(
      `/api/reservations/${reservationId}/status`,
      { date: day.date, managementKey: created.managementKey },
    );
    expect(statusResponse.status).toBe(200);
    expect(await statusResponse.json()).toMatchObject({
      reservationId,
      status: "rejected",
      rejectionReason: "架空の受付都合",
      allowedActions: [],
    });

    const cancel = await jsonRequest(
      `/api/reservations/${reservationId}/cancel`,
      {
        commandId: crypto.randomUUID(),
        date: day.date,
        managementKey: created.managementKey,
      },
    );
    expect(cancel.status).toBe(404);
    expect(await cancel.json()).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND_OR_UNAUTHORIZED" },
    });
  });

  it("replays an accepted customer cancellation without releasing capacity twice", async () => {
    await enableLiveInstallation();
    const created = await acceptedPublicCreate();
    const reservationId = created.result.reservation?.reservationId as string;
    const command = {
      commandId: crypto.randomUUID(),
      date: day.date,
      managementKey: created.managementKey,
    };

    const first = await jsonRequest(
      `/api/reservations/${reservationId}/cancel`,
      command,
    );
    expect(first.status).toBe(200);
    const accepted = await first.json<ApiMutation>();
    expect(accepted).toMatchObject({
      operation: "cancel",
      replayed: false,
      reservation: { reservationId, status: "cancelled" },
    });

    const replay = await jsonRequest(
      `/api/reservations/${reservationId}/cancel`,
      command,
    );
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ ...accepted, replayed: true });

    const status = await jsonRequest(
      `/api/reservations/${reservationId}/status`,
      { date: day.date, managementKey: created.managementKey },
    );
    expect(await status.json()).toMatchObject({
      status: "cancelled",
      allowedActions: [],
    });
    const availability = await SELF.fetch(availabilityUrl());
    const projection = await availability.json<{
      resources: Array<{ id: string; startTimes: string[] }>;
    }>();
    expect(
      projection.resources.find(({ id }) => id === "resource-chair-a")
        ?.startTimes,
    ).toContain("09:00");
  });
});

describe("T029 operator schedule API", () => {
  it("returns only a bounded one-day or seven-day schedule", async () => {
    await enableLiveInstallation();
    const week = await SELF.fetch(
      `https://example.test/api/admin/schedule?startDate=${day.date}&days=7`,
      { headers: ownerHeaders },
    );
    expect(week.status).toBe(200);
    expect(week.headers.get("cache-control")).toBe("no-store");
    const weekBody = await week.json<{
      startDate: string;
      days: number;
      boards: Array<{ date: string }>;
    }>();
    expect(weekBody).toMatchObject({
      startDate: day.date,
      days: 7,
      boards: expect.arrayContaining([
        expect.objectContaining({ date: day.date }),
      ]),
    });
    expect(weekBody.boards).toHaveLength(7);

    const unbounded = await SELF.fetch(
      `https://example.test/api/admin/schedule?startDate=${day.date}&days=8`,
      { headers: ownerHeaders },
    );
    expect(unbounded.status).toBe(400);
  });

  it("derives attention and applies approval and rejection exactly once", async () => {
    await enableLiveInstallation();
    const first = await acceptedPublicCreate(
      { serviceIds: ["service-cut"] },
      "A".repeat(43),
    );
    const second = await acceptedPublicCreate(
      {
        commandId: crypto.randomUUID(),
        serviceIds: ["service-cut"],
        startTime: "11:00",
      },
      "B".repeat(43),
    );
    const firstId = first.result.reservation?.reservationId as string;
    const secondId = second.result.reservation?.reservationId as string;
    const scheduleUrl = `https://example.test/api/admin/schedule?startDate=${day.date}&days=1`;

    const pendingSchedule = await SELF.fetch(scheduleUrl, {
      headers: ownerHeaders,
    });
    expect(pendingSchedule.status).toBe(200);
    expect(pendingSchedule.headers.get("cache-control")).toBe("no-store");
    expect(await pendingSchedule.json()).toMatchObject({
      attentionCount: 2,
      boards: [
        {
          reservations: expect.arrayContaining([
            expect.objectContaining({ reservationId: firstId, status: "pending" }),
            expect.objectContaining({ reservationId: secondId, status: "pending" }),
          ]),
        },
      ],
    });

    const approve = await jsonRequest(
      `/api/admin/reservations/${firstId}/transition`,
      { commandId: crypto.randomUUID(), date: day.date, action: "approve" },
      ownerHeaders,
    );
    expect(approve.status).toBe(200);
    expect(await approve.json()).toMatchObject({
      operation: "approve",
      reservation: { status: "approved" },
    });

    const rejectCommand = {
      commandId: crypto.randomUUID(),
      date: day.date,
      action: "reject",
      reason: "架空の受付都合",
    };
    const rejected = await jsonRequest(
      `/api/admin/reservations/${secondId}/transition`,
      rejectCommand,
      ownerHeaders,
    );
    expect(rejected.status).toBe(200);
    const rejectedBody = await rejected.json<ApiMutation>();
    expect(rejectedBody).toMatchObject({
      operation: "reject",
      replayed: false,
      reservation: {
        status: "rejected",
        rejectionReason: "架空の受付都合",
      },
    });
    const replay = await jsonRequest(
      `/api/admin/reservations/${secondId}/transition`,
      rejectCommand,
      ownerHeaders,
    );
    expect(await replay.json()).toEqual({ ...rejectedBody, replayed: true });

    const settledSchedule = await SELF.fetch(scheduleUrl, {
      headers: ownerHeaders,
    });
    expect(await settledSchedule.json()).toMatchObject({ attentionCount: 0 });
  });

  it("creates and removes a resource closure through the shared availability boundary", async () => {
    await enableLiveInstallation();
    const command = {
      commandId: crypto.randomUUID(),
      date: day.date,
      resourceId: "resource-chair-b",
      startTime: "10:00",
      endTime: "11:00",
      label: "架空チェア B の整備",
    };
    const created = await jsonRequest(
      "/api/admin/closures",
      command,
      ownerHeaders,
    );
    expect(created.status).toBe(201);
    const createdBody = await created.json<ApiMutation>();
    expect(createdBody).toMatchObject({
      operation: "closure_create",
      replayed: false,
      closureId: expect.any(String),
    });

    const unavailable = await SELF.fetch(
      availabilityUrl(["service-cut"]),
    );
    const unavailableBody = await unavailable.json<{
      resources: Array<{ id: string; startTimes: string[] }>;
    }>();
    expect(
      unavailableBody.resources.find(({ id }) => id === "resource-chair-a")
        ?.startTimes,
    ).toContain("10:00");
    expect(
      unavailableBody.resources.find(({ id }) => id === "resource-chair-b")
        ?.startTimes,
    ).not.toContain("10:00");

    const removeCommand = { commandId: crypto.randomUUID(), date: day.date };
    const removed = await jsonRequest(
      `/api/admin/closures/${createdBody.closureId}/remove`,
      removeCommand,
      ownerHeaders,
    );
    expect(removed.status).toBe(200);
    const removedBody = await removed.json<ApiMutation>();
    expect(removedBody).toMatchObject({
      operation: "closure_remove",
      replayed: false,
    });
    const replay = await jsonRequest(
      `/api/admin/closures/${createdBody.closureId}/remove`,
      removeCommand,
      ownerHeaders,
    );
    expect(await replay.json()).toEqual({ ...removedBody, replayed: true });
    const available = await SELF.fetch(availabilityUrl(["service-cut"]));
    const availableBody = await available.json<{
      resources: Array<{ id: string; startTimes: string[] }>;
    }>();
    expect(
      availableBody.resources.find(({ id }) => id === "resource-chair-b")
        ?.startTimes,
    ).toContain("10:00");
  });

  it("requires one authenticated reservation reference for bounded reschedule availability", async () => {
    await enableLiveInstallation();
    const created = await acceptedOwnerCreate({ serviceIds: ["service-cut"] });
    const reservationId = created.result.reservation?.reservationId as string;
    const query = new URLSearchParams({
      date: day.date,
      serviceId: "service-cut",
      reservationId,
    });
    const url = `https://example.test/api/admin/availability?${query}`;

    const unauthenticated = await SELF.fetch(url);
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get("www-authenticate")).toBe("Bearer");

    const invalidQueries = [
      new URLSearchParams({ date: day.date, serviceId: "service-cut" }),
      new URLSearchParams({
        date: day.date,
        serviceId: "service-cut",
        reservationId: "not-a-uuid",
      }),
      new URLSearchParams([
        ["date", day.date],
        ["serviceId", "service-cut"],
        ["reservationId", reservationId],
        ["reservationId", reservationId],
      ]),
      new URLSearchParams({
        date: day.date,
        serviceId: "service-cut",
        reservationId,
        unexpected: "value",
      }),
    ];
    const invalid = await Promise.all(
      invalidQueries.map((candidate) =>
        SELF.fetch(`https://example.test/api/admin/availability?${candidate}`, {
          headers: ownerHeaders,
        }),
      ),
    );
    expect(invalid.map(({ status }) => status)).toEqual([400, 400, 400, 400]);

    const available = await SELF.fetch(url, { headers: ownerHeaders });
    expect(available.status).toBe(200);
    const body = await available.json<{
      capacityReached: boolean;
      resources: Array<{ id: string; startTimes: string[] }>;
    }>();
    expect(body).toMatchObject({
      capacityReached: false,
      resources: expect.arrayContaining([
        expect.objectContaining({
          id: "resource-chair-a",
          startTimes: expect.arrayContaining(["09:30"]),
        }),
      ]),
    });
    expect(body.resources.find(({ id }) => id === "resource-chair-a")?.startTimes)
      .not.toContain("09:00");

    const cancelled = await jsonRequest(
      `/api/admin/reservations/${reservationId}/transition`,
      { commandId: crypto.randomUUID(), date: day.date, action: "cancel" },
      ownerHeaders,
    );
    expect(cancelled.status).toBe(200);
    const inactive = await SELF.fetch(url, { headers: ownerHeaders });
    expect(inactive.status).toBe(404);
    expect(await inactive.json()).toMatchObject({
      error: { code: "NOT_FOUND_OR_UNAUTHORIZED" },
    });
  });

  it("owner-creates an approved booking and reschedules it without changing ownership", async () => {
    await enableLiveInstallation();
    const created = await acceptedOwnerCreate({ serviceIds: ["service-cut"] });
    const reservationId = created.result.reservation?.reservationId as string;
    expect(created.result).toMatchObject({
      operation: "create",
      reservation: { reservationId, status: "approved", priceYen: 4_000 },
    });

    const command = {
      commandId: crypto.randomUUID(),
      date: day.date,
      action: "reschedule",
      resourceId: "resource-chair-b",
      startTime: "11:00",
    };
    const moved = await jsonRequest(
      `/api/admin/reservations/${reservationId}/transition`,
      command,
      ownerHeaders,
    );
    expect(moved.status).toBe(200);
    const movedBody = await moved.json<ApiMutation>();
    expect(movedBody).toMatchObject({
      operation: "reschedule",
      replayed: false,
      reservation: {
        reservationId,
        status: "approved",
        startTime: "11:00",
        resourceLabel: "架空チェア B",
        serviceMinutes: 45,
        cleanupMinutes: 15,
        priceYen: 4_000,
      },
    });
    const replay = await jsonRequest(
      `/api/admin/reservations/${reservationId}/transition`,
      command,
      ownerHeaders,
    );
    expect(await replay.json()).toEqual({ ...movedBody, replayed: true });

    const schedule = await SELF.fetch(
      `https://example.test/api/admin/schedule?startDate=${day.date}&days=1`,
      { headers: ownerHeaders },
    );
    expect(schedule.status).toBe(200);
    expect(await schedule.json()).toMatchObject({
      boards: [
        {
          reservations: [
            {
              reservationId,
              rescheduleHistory: [
                {
                  from: { resourceId: "resource-chair-a", startTime: "09:00" },
                  to: { resourceId: "resource-chair-b", startTime: "11:00" },
                },
              ],
            },
          ],
        },
      ],
    });

    const status = await jsonRequest(
      `/api/reservations/${reservationId}/status`,
      { date: day.date, managementKey: created.managementKey },
    );
    expect(await status.json()).toMatchObject({
      reservationId,
      startTime: "11:00",
      status: "approved",
    });
  });

  it("serializes two concurrent reschedules into one remaining capacity", async () => {
    await enableLiveInstallation();
    const first = await acceptedOwnerCreate({ serviceIds: ["service-cut"] });
    const second = await acceptedOwnerCreate(
      {
        commandId: crypto.randomUUID(),
        serviceIds: ["service-cut"],
        resourceId: "resource-chair-b",
      },
      "B".repeat(43),
    );
    const ids = [
      first.result.reservation?.reservationId as string,
      second.result.reservation?.reservationId as string,
    ];
    const responses = await Promise.all(
      ids.map((reservationId) =>
        jsonRequest(
          `/api/admin/reservations/${reservationId}/transition`,
          {
            commandId: crypto.randomUUID(),
            date: day.date,
            action: "reschedule",
            resourceId: "resource-chair-a",
            startTime: "11:00",
          },
          ownerHeaders,
        ),
      ),
    );
    expect(responses.map(({ status }) => status).sort()).toEqual([200, 409]);
    const loser = responses.find(({ status }) => status === 409);
    expect(await loser?.json()).toMatchObject({
      ok: false,
      error: { code: "UNAVAILABLE" },
    });

    const schedule = await SELF.fetch(
      `https://example.test/api/admin/schedule?startDate=${day.date}&days=1`,
      { headers: ownerHeaders },
    );
    const scheduleBody = await schedule.json<{
      boards: Array<{ reservations: ApiReservation[] }>;
    }>();
    const reservations = scheduleBody.boards[0]?.reservations ?? [];
    expect(reservations).toHaveLength(2);
    expect(
      reservations.filter(
        ({ startTime, resourceLabel }) =>
          startTime === "11:00" && resourceLabel === "架空チェア A",
      ),
    ).toHaveLength(1);
    expect(reservations.every(({ reservationId }) => ids.includes(reservationId))).toBe(
      true,
    );
  });

});

describe("current settings and existing partitions", () => {
  it("rejects elapsed and past-day starts across public and owner paths while replaying receipts", async () => {
    // Fake the Date class itself, not just Date.now: the worker stamps
    // createdAt via `new Date()`, and a spy on Date.now leaves those stamps
    // on the real clock, so pending-expiry deadlines drift against the
    // mocked clock (red between 00:00 and 10:30 JST, green after).
    vi.useFakeTimers({ toFake: ["Date"], now: Date.parse(`${day.date}T00:00:00.000Z`) });
    try {
      await enableLiveInstallation();
      const accepted = await acceptedPublicCreate({
        serviceIds: ["service-cut"],
        startTime: "11:00",
      });
      const owner = await acceptedOwnerCreate(
        {
          serviceIds: ["service-cut"],
          resourceId: "resource-chair-b",
          startTime: "12:00",
        },
        "B".repeat(43),
      );
      const ownerReservationId = owner.result.reservation?.reservationId as string;
      const acceptedReschedule = {
        commandId: crypto.randomUUID(),
        date: day.date,
        action: "reschedule",
        resourceId: "resource-chair-b",
        startTime: "11:00",
      };
      const firstReschedule = await jsonRequest(
        `/api/admin/reservations/${ownerReservationId}/transition`,
        acceptedReschedule,
        ownerHeaders,
      );
      expect(firstReschedule.status).toBe(200);
      expect(await firstReschedule.json()).toMatchObject({ replayed: false });

      vi.setSystemTime(Date.parse(`${day.date}T01:30:00.000Z`));
      const ownerUrl = `https://example.test/api/admin/availability?${new URLSearchParams({
        date: day.date,
        serviceId: "service-cut",
        reservationId: ownerReservationId,
      })}`;
      const [publicAvailability, ownerAvailability] = await Promise.all([
        SELF.fetch(availabilityUrl(["service-cut"])),
        SELF.fetch(ownerUrl, { headers: ownerHeaders }),
      ]);
      expect([publicAvailability.status, ownerAvailability.status]).toEqual([200, 200]);
      expect(await publicAvailability.json()).toMatchObject({
        resources: [
          { id: "resource-chair-a", startTimes: ["12:00"] },
          { id: "resource-chair-b", startTimes: ["12:00"] },
        ],
      });
      expect(await ownerAvailability.json()).toMatchObject({
        pinned: true,
        resources: [
          { id: "resource-chair-a", startTimes: ["12:00"] },
          { id: "resource-chair-b", startTimes: ["11:30", "12:00"] },
        ],
      });

      const { body: publicBody } = await publicCreateBody({
        serviceIds: ["service-cut"],
        startTime: "09:00",
      });
      const { body: ownerBody } = await publicCreateBody({
        serviceIds: ["service-cut"],
        resourceId: "resource-chair-b",
        startTime: "09:00",
      });
      const {
        turnstileToken: _turnstileToken,
        replayOnly: _replayOnly,
        ...ownerCreateBody
      } = ownerBody;
      const publicCreate = await jsonRequest("/api/reservations", publicBody);
      const ownerCreate = await jsonRequest(
        "/api/admin/reservations",
        ownerCreateBody,
        ownerHeaders,
      );
      expect([publicCreate.status, ownerCreate.status]).toEqual([409, 409]);
      expect(await publicCreate.json()).toMatchObject({ error: { code: "UNAVAILABLE" } });
      expect(await ownerCreate.json()).toMatchObject({ error: { code: "UNAVAILABLE" } });

      const reschedule = await jsonRequest(
        `/api/admin/reservations/${ownerReservationId}/transition`,
        {
          commandId: crypto.randomUUID(),
          date: day.date,
          action: "reschedule",
          resourceId: "resource-chair-a",
          startTime: "10:00",
        },
        ownerHeaders,
      );
      expect(reschedule.status).toBe(409);
      expect(await reschedule.json()).toMatchObject({ error: { code: "UNAVAILABLE" } });
      const ownerStatus = await jsonRequest(
        `/api/reservations/${ownerReservationId}/status`,
        { date: day.date, managementKey: owner.managementKey },
      );
      expect(await ownerStatus.json()).toMatchObject({ startTime: "11:00" });

      vi.setSystemTime(Date.parse(`${day.date}T15:30:00.000Z`));
      const pastOwnerAvailability = await SELF.fetch(ownerUrl, { headers: ownerHeaders });
      expect(pastOwnerAvailability.status).toBe(200);
      expect(
        (await pastOwnerAvailability.json<{ resources: Array<{ startTimes: string[] }> }>())
          .resources.every(({ startTimes }) => startTimes.length === 0),
      ).toBe(true);
      const pastReschedule = await jsonRequest(
        `/api/admin/reservations/${ownerReservationId}/transition`,
        {
          commandId: crypto.randomUUID(),
          date: day.date,
          action: "reschedule",
          resourceId: "resource-chair-a",
          startTime: "11:00",
        },
        ownerHeaders,
      );
      expect(pastReschedule.status).toBe(409);
      expect(await pastReschedule.json()).toMatchObject({ error: { code: "UNAVAILABLE" } });
      const replayedReschedule = await jsonRequest(
        `/api/admin/reservations/${ownerReservationId}/transition`,
        acceptedReschedule,
        ownerHeaders,
      );
      expect(replayedReschedule.status).toBe(200);
      expect(await replayedReschedule.json()).toMatchObject({ replayed: true });
      const replay = await jsonRequest("/api/reservations", {
        ...accepted.body,
        replayOnly: true,
      });
      expect(replay.status).toBe(201);
      expect(await replay.json()).toMatchObject({
        replayed: true,
        reservation: { reservationId: accepted.result.reservation?.reservationId },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("hides a disabled pinned resource from public availability but preserves owner rescheduling", async () => {
    await enableLiveInstallation();
    const accepted = await acceptedPublicCreate({ serviceIds: ["service-cut"] });
    const reservationId = accepted.result.reservation?.reservationId as string;
    const changed = liveSettings();
    changed.resources = changed.resources.map((resource) =>
      resource.id === "resource-chair-a" ? { ...resource, active: false } : resource,
    );
    changed.services = changed.services.map((service) => ({
      ...service,
      eligibleResourceIds: ["resource-chair-b"],
    }));
    expect(
      (await updateInstallation(changed, crypto.randomUUID(), 2)).status,
    ).toBe(200);

    const { body: publicBody } = await publicCreateBody({
      resourceId: "resource-chair-a",
      settingsVersion: 3,
    });
    const { turnstileToken: _turnstileToken, replayOnly: _replayOnly, ...ownerBody } = publicBody;
    const ownerUrl = `https://example.test/api/admin/availability?${new URLSearchParams({
      date: day.date,
      serviceId: "service-cut",
      reservationId,
    })}`;
    const [publicAvailability, ownerAvailability, publicCreate, ownerCreate] = await Promise.all([
      SELF.fetch(availabilityUrl(["service-cut"])),
      SELF.fetch(ownerUrl, { headers: ownerHeaders }),
      jsonRequest("/api/reservations", publicBody),
      jsonRequest("/api/admin/reservations", ownerBody, ownerHeaders),
    ]);

    expect(publicAvailability.status).toBe(200);
    expect(
      (await publicAvailability.json<{ resources: Array<{ id: string }> }>()).resources.map(
        ({ id }) => id,
      ),
    ).toEqual(["resource-chair-b"]);
    expect(ownerAvailability.status).toBe(200);
    expect(
      (await ownerAvailability.json<{ resources: Array<{ id: string }> }>()).resources.map(
        ({ id }) => id,
      ),
    ).toEqual(["resource-chair-a", "resource-chair-b"]);
    expect([publicCreate.status, ownerCreate.status]).toEqual([400, 400]);
  });

  it("fails closed for fresh capacity after active catalog identifiers change while keeping proof and replay", async () => {
    await enableLiveInstallation();
    const accepted = await acceptedPublicCreate();
    const reservationId = accepted.result.reservation?.reservationId as string;
    const replaced = liveSettings();
    replaced.services = replaced.services.map((service) => ({
      ...service,
      id: `${service.id}-v2`,
    }));
    expect(
      (await updateInstallation(replaced, crypto.randomUUID(), 2)).status,
    ).toBe(200);

    const [oldCatalog, newCatalog, status, replay] = await Promise.all([
      SELF.fetch(availabilityUrl(["service-cut"])),
      SELF.fetch(availabilityUrl(["service-cut-v2"])),
      jsonRequest(`/api/reservations/${reservationId}/status`, {
        date: day.date,
        managementKey: accepted.managementKey,
      }),
      jsonRequest("/api/reservations", { ...accepted.body, replayOnly: true }),
    ]);

    expect([oldCatalog.status, newCatalog.status]).toEqual([400, 400]);
    expect(status.status).toBe(200);
    expect(replay.status).toBe(201);
    expect(await replay.json()).toMatchObject({
      replayed: true,
      reservation: { reservationId },
    });
  });

  it("replays an accepted create after a horizon shrink without admitting a new command", async () => {
    await enableLiveInstallation();
    const date = nextOpenJstDate(7);
    const accepted = await publicCreateBody({ date });
    const first = await jsonRequest("/api/reservations", accepted.body);
    expect(first.status).toBe(201);
    const firstBody = await first.json<ApiMutation>();

    const shrunken = liveSettings();
    shrunken.horizonDays = 1;
    expect(
      (await updateInstallation(shrunken, crypto.randomUUID(), 2)).status,
    ).toBe(200);

    const replay = await jsonRequest("/api/reservations", {
      ...accepted.body,
      replayOnly: true,
    });
    const fresh = await jsonRequest("/api/reservations", {
      ...accepted.body,
      commandId: crypto.randomUUID(),
    });

    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual({ ...firstBody, replayed: true });
    expect(fresh.status).toBe(400);
  });

  it("keeps an existing future reservation reachable after a horizon shrink while refusing new bookings", async () => {
    await enableLiveInstallation();
    const date = nextOpenJstDate(7);
    const created = await acceptedPublicCreate({ date });
    const reservationId = created.result.reservation?.reservationId as string;
    const shrunken = liveSettings();
    shrunken.horizonDays = 1;
    expect(
      (await updateInstallation(shrunken, crypto.randomUUID(), 2)).status,
    ).toBe(200);

    const rejectedCreate = await publicCreateBody({ date });
    const [status, schedule, availability, create] = await Promise.all([
      jsonRequest(`/api/reservations/${reservationId}/status`, {
        date,
        managementKey: created.managementKey,
      }),
      SELF.fetch(`https://example.test/api/admin/schedule?startDate=${date}&days=1`, {
        headers: ownerHeaders,
      }),
      SELF.fetch(availabilityUrl(["service-cut"], date)),
      jsonRequest("/api/reservations", rejectedCreate.body),
    ]);

    expect([status.status, schedule.status]).toEqual([200, 200]);
    expect([availability.status, create.status]).toEqual([400, 400]);
  });

  it(
    "lets an owner read pinned reschedule availability after the current horizon and weekday shrink",
    async () => {
      await enableLiveInstallation();
      const date = nextOpenJstDate(7);
      const accepted = await acceptedPublicCreate({
        date,
        serviceIds: ["service-cut"],
      });
      const reservationId = accepted.result.reservation?.reservationId as string;
      const shrunken = liveSettings();
      shrunken.horizonDays = 1;
      shrunken.openWeekdays = [0];
      expect(
        (await updateInstallation(shrunken, crypto.randomUUID(), 2)).status,
      ).toBe(200);

      const query = new URLSearchParams({
        date,
        serviceId: "service-cut",
        reservationId,
      });
      const ownerUrl = `https://example.test/api/admin/availability?${query}`;
      const unauthenticated = await SELF.fetch(ownerUrl);
      expect(unauthenticated.status).toBe(401);
      expect(unauthenticated.headers.get("www-authenticate")).toBe("Bearer");

      const [ownerAvailability, publicAvailability, freshCreate] = await Promise.all([
        SELF.fetch(ownerUrl, { headers: ownerHeaders }),
        SELF.fetch(availabilityUrl(["service-cut"], date)),
        publicCreateBody({ date }).then(({ body }) =>
          jsonRequest("/api/reservations", body),
        ),
      ]);

      expect(ownerAvailability.status).toBe(200);
      expect(await ownerAvailability.json()).toMatchObject({
        date,
        settingsVersion: 2,
        serviceIds: ["service-cut"],
        services: [
          {
            id: "service-cut",
            label: "架空カット",
            durationMinutes: 45,
            cleanupMinutes: 15,
            priceYen: 4_000,
          },
        ],
        resources: [
          {
            id: "resource-chair-a",
            label: "架空チェア A",
            startTimes: expect.any(Array),
          },
          {
            id: "resource-chair-b",
            label: "架空チェア B",
            startTimes: expect.arrayContaining(["09:00"]),
          },
        ],
      });
      expect([publicAvailability.status, freshCreate.status]).toEqual([400, 400]);
    },
  );

  it("keeps setup's maximum accepted capacity configuration available", async () => {
    const settings = liveSettings();
    settings.resources = [
      { id: "resource-chair-a", label: "架空チェア A", active: true },
      { id: "resource-chair-b", label: "架空チェア B", active: true },
      { id: "resource-chair-c", label: "架空チェア C", active: true },
      { id: "resource-chair-d", label: "架空チェア D", active: true },
    ];
    settings.services = settings.services.map((service) => ({
      ...service,
      durationMinutes: 240,
      cleanupMinutes: 0,
      eligibleResourceIds: settings.resources.map(({ id }) => id),
    }));
    settings.opensAt = "09:00";
    settings.closesAt = "17:00";
    settings.startIntervalMinutes = 15;
    expect((await updateInstallation(settings)).status).toBe(200);

    const availability = await SELF.fetch(availabilityUrl(["service-cut"]));
    expect(availability.status).toBe(200);
    const body = await availability.json<{
      resources: Array<{ startTimes: string[] }>;
    }>();
    expect(body.resources).toHaveLength(4);
    expect(body.resources.every(({ startTimes }) => startTimes.length === 17)).toBe(
      true,
    );
  });

  it("keeps an existing past reservation reachable after a retention shrink", async () => {
    await enableLiveInstallation();
    // Not today: the fixture books 09:00, and the day object refuses a start
    // time that has already elapsed, so booking today fails from 09:00 JST
    // onwards. The reservation is made past by the Date fake below, not by
    // the calendar. Offset 2 is a date no other test in this file touches.
    const date = nextOpenJstDate(2);
    const created = await acceptedPublicCreate({ date });
    const reservationId = created.result.reservation?.reservationId as string;
    const shrunken = liveSettings();
    shrunken.retentionDays = 1;
    expect(
      (await updateInstallation(shrunken, crypto.randomUUID(), 2)).status,
    ).toBe(200);

    // Same reasoning as the fake above: `new Date()` stamps must follow the
    // mocked clock, so fake the Date class rather than spying on Date.now.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.parse(`${date}T15:00:00.000Z`) + 86_400_000 });
    try {
      const [status, schedule] = await Promise.all([
        jsonRequest(`/api/reservations/${reservationId}/status`, {
          date,
          managementKey: created.managementKey,
        }),
        SELF.fetch(
          `https://example.test/api/admin/schedule?startDate=${date}&days=1`,
          { headers: ownerHeaders },
        ),
      ]);

      expect([status.status, schedule.status]).toEqual([200, 200]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("T035 guided setup API", () => {
  it("rejects every cross-origin owner mutation", async () => {
    const fixture = await publicCreateBody();
    const {
      turnstileToken: _turnstileToken,
      replayOnly: _replayOnly,
      ...ownerBody
    } = fixture.body;
    const crossOrigin = (path: string, body: unknown, method = "POST") =>
      SELF.fetch(`https://example.test${path}`, {
        method,
        headers: {
          authorization: `Bearer ${ownerToken}`,
          "content-type": "application/json",
          origin: "https://attacker.invalid",
        },
        body: JSON.stringify(body),
      });
    const responses = await Promise.all([
      crossOrigin("/api/admin/reservations", ownerBody),
      crossOrigin(
        `/api/admin/reservations/${crypto.randomUUID()}/transition`,
        { commandId: crypto.randomUUID(), date: day.date, action: "cancel" },
      ),
      crossOrigin("/api/admin/closures", {
        commandId: crypto.randomUUID(),
        date: day.date,
        resourceId: "resource-chair-a",
        startTime: "09:00",
        endTime: "10:00",
        label: "架空の休止",
      }),
      crossOrigin(
        "/api/admin/setup",
        {
          commandId: crypto.randomUUID(),
          expectedSettingsVersion: 1,
          settings: liveSettings(),
        },
        "PUT",
      ),
    ]);
    expect(responses.map(({ status }) => status)).toEqual([403, 403, 403, 403]);
  });

  it("rejects a setup body over 16 KiB before changing settings", async () => {
    const oversized = liveSettings();
    oversized.privacyNotice = "あ".repeat(17_000);
    const oversizedResponse = await updateInstallation(oversized);
    expect(oversizedResponse.status).toBe(413);
    const current = await SELF.fetch("https://example.test/api/admin/setup", {
      headers: ownerHeaders,
    });
    expect(await current.json()).toMatchObject({ settingsVersion: 1 });
  });

  it("reads the demo settings without exposing credentials", async () => {
    const unauthenticated = await SELF.fetch(
      "https://example.test/api/admin/setup",
    );
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get("www-authenticate")).toBe("Bearer");

    const response = await SELF.fetch("https://example.test/api/admin/setup", {
      headers: ownerHeaders,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const setup = await response.json<Record<string, unknown>>();
    expect(setup).toMatchObject({
      mode: "demo",
      settingsVersion: 1,
      replayed: false,
      readiness: { ready: false },
    });
    expect(JSON.stringify(setup)).not.toMatch(
      /owner-test-token|turnstile-test-secret|managementKey|customer/i,
    );
  });

  it("resolves customer screen settings defaults and round-trips stored values", async () => {
    expect((await updateInstallation()).status).toBe(200);

    const setupDefaults = await SELF.fetch("https://example.test/api/admin/setup", {
      headers: ownerHeaders,
    });
    const setupBody = await setupDefaults.json<{ settings: Record<string, unknown> }>();
    expect(setupBody.settings.exposeResourceChoice).toBe(true);
    expect(Object.hasOwn(setupBody.settings, "availabilityNotice")).toBe(false);

    const configDefaults = await SELF.fetch("https://example.test/api/config");
    expect(await configDefaults.json()).toMatchObject({
      availabilityNotice: null,
      exposeResourceChoice: true,
    });

    const withPair = {
      ...liveSettings(),
      availabilityNotice: "  本日は短縮営業です  ",
      exposeResourceChoice: false,
    };
    const updated = await updateInstallation(withPair, crypto.randomUUID(), 2);
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({ settingsVersion: 3 });

    const config = await SELF.fetch("https://example.test/api/config");
    expect(await config.json()).toMatchObject({
      availabilityNotice: "本日は短縮営業です",
      exposeResourceChoice: false,
    });

    const oversizedPair = { ...liveSettings(), availabilityNotice: "あ".repeat(201) };
    const rejected = await updateInstallation(oversizedPair, crypto.randomUUID(), 3);
    expect(rejected.status).toBe(400);
    const current = await SELF.fetch("https://example.test/api/admin/setup", {
      headers: ownerHeaders,
    });
    expect(await current.json()).toMatchObject({
      settingsVersion: 3,
      settings: { availabilityNotice: "本日は短縮営業です", exposeResourceChoice: false },
    });
  });

  it("updates once, replays before version checking, and rejects both command and version conflicts", async () => {
    const commandId = crypto.randomUUID();
    const first = await updateInstallation(liveSettings(), commandId);
    expect(first.status).toBe(200);
    const accepted = await first.json<Record<string, unknown>>();
    expect(accepted).toMatchObject({
      settingsVersion: 2,
      replayed: false,
      readiness: { ready: true, blockers: [] },
    });

    const replay = await updateInstallation(liveSettings(), commandId);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ ...accepted, replayed: true });

    const changed = liveSettings();
    changed.locationName = "別の架空予約室";
    const commandConflict = await updateInstallation(changed, commandId);
    expect(commandConflict.status).toBe(409);
    expect(await commandConflict.json()).toMatchObject({
      ok: false,
      error: { code: "IDEMPOTENCY_CONFLICT" },
    });

    const versionConflict = await updateInstallation(
      changed,
      crypto.randomUUID(),
      1,
    );
    expect(versionConflict.status).toBe(409);
    expect(await versionConflict.json()).toMatchObject({
      ok: false,
      error: { code: "CONFIGURATION_CONFLICT" },
    });
    const current = await SELF.fetch("https://example.test/api/admin/setup", {
      headers: ownerHeaders,
    });
    expect(await current.json()).toMatchObject({
      settingsVersion: 2,
      settings: { locationName: "架空予約室 青空" },
    });
  });

  it("keeps placeholder legal copy in demo mode", async () => {
    const settings = liveSettings();
    settings.privacyNotice = "設定してください";
    const updated = await updateInstallation(settings);
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({
      mode: "demo",
      readiness: {
        ready: false,
        identity: false,
        blockers: ["identity"],
      },
    });

    const activation = await setLive();
    expect(activation.status).toBe(409);
    expect(await activation.json()).toMatchObject({
      ok: false,
      error: { code: "NOT_LIVE" },
    });
    const config = await SELF.fetch("https://example.test/api/config");
    expect(await config.json()).toMatchObject({ mode: "demo" });
  });

  it("fails closed in demo, accepts after the live latch, and closes again explicitly", async () => {
    expect((await updateInstallation()).status).toBe(200);
    const fixture = await publicCreateBody();

    const demo = await jsonRequest("/api/reservations", fixture.body);
    expect(demo.status).toBe(403);
    expect(await demo.json()).toMatchObject({
      ok: false,
      error: { code: "NOT_LIVE" },
    });
    const {
      turnstileToken: _turnstileToken,
      replayOnly: _replayOnly,
      ...ownerBody
    } = fixture.body;
    const demoOwnerCreate = await jsonRequest(
      "/api/admin/reservations",
      ownerBody,
      ownerHeaders,
    );
    expect(demoOwnerCreate.status).toBe(403);
    expect(await persistedCounts()).toEqual({
      state: 0,
      details: 0,
      receipts: 0,
      meta: 0,
    });
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();

    const activated = await setLive();
    expect(activated.status).toBe(200);
    expect(await activated.json()).toMatchObject({
      mode: "live",
      readiness: { ready: true },
    });
    expect((await jsonRequest("/api/reservations", fixture.body)).status).toBe(201);

    const disabled = await setLive(false);
    expect(disabled.status).toBe(200);
    expect(await disabled.json()).toMatchObject({ mode: "demo" });
    const another = await publicCreateBody({
      commandId: crypto.randomUUID(),
      startTime: "11:00",
    });
    expect((await jsonRequest("/api/reservations", another.body)).status).toBe(
      403,
    );
  });

  it("keeps proof status and cancellation available after returning the installation to demo", async () => {
    await enableLiveInstallation();
    const created = await acceptedPublicCreate({}, "C".repeat(43));
    const reservationId = created.result.reservation?.reservationId as string;
    expect((await setLive(false, crypto.randomUUID(), 2)).status).toBe(200);
    const fresh = await publicCreateBody(
      { commandId: crypto.randomUUID(), startTime: "11:00" },
      "D".repeat(43),
    );

    const status = await jsonRequest(`/api/reservations/${reservationId}/status`, {
      date: day.date,
      managementKey: created.managementKey,
    });
    const replay = await jsonRequest("/api/reservations", {
      ...created.body,
      replayOnly: true,
    });
    const freshReplay = await jsonRequest("/api/reservations", {
      ...fresh.body,
      replayOnly: true,
    });
    const create = await jsonRequest("/api/reservations", fresh.body);
    const cancel = await jsonRequest(`/api/reservations/${reservationId}/cancel`, {
      commandId: crypto.randomUUID(),
      date: day.date,
      managementKey: created.managementKey,
    });

    expect(status.status).toBe(200);
    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual({ ...created.result, replayed: true });
    expect(freshReplay.status).not.toBe(201);
    expect(create.status).toBe(403);
    expect(cancel.status).toBe(200);
    expect(await cancel.json()).toMatchObject({ reservation: { status: "cancelled" } });
  });

  it("keeps proof status and cancellation available after the Turnstile secret disappears", async () => {
    await enableLiveInstallation();
    const created = await acceptedPublicCreate({}, "C".repeat(43));
    const reservationId = created.result.reservation?.reservationId as string;
    const secretlessEnv = Object.create(env) as Env;
    Object.defineProperty(secretlessEnv, "TURNSTILE_SECRET", { value: undefined });
    const request = (path: string, body: Record<string, unknown>) =>
      new Request(`https://example.test${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://example.test",
        },
        body: JSON.stringify(body),
      });
    const fresh = await publicCreateBody(
      { commandId: crypto.randomUUID(), startTime: "11:00" },
      "D".repeat(43),
    );

    const status = await worker.fetch(
      request(`/api/reservations/${reservationId}/status`, {
        date: day.date,
        managementKey: created.managementKey,
      }),
      secretlessEnv,
    );
    const replay = await worker.fetch(
      request("/api/reservations", { ...created.body, replayOnly: true }),
      secretlessEnv,
    );
    const freshReplay = await worker.fetch(
      request("/api/reservations", { ...fresh.body, replayOnly: true }),
      secretlessEnv,
    );
    const create = await worker.fetch(
      request("/api/reservations", fresh.body),
      secretlessEnv,
    );
    const cancel = await worker.fetch(
      request(`/api/reservations/${reservationId}/cancel`, {
        commandId: crypto.randomUUID(),
        date: day.date,
        managementKey: created.managementKey,
      }),
      secretlessEnv,
    );

    expect(status.status).toBe(200);
    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual({ ...created.result, replayed: true });
    expect(freshReplay.status).not.toBe(201);
    expect(create.status).toBe(403);
    expect(cancel.status).toBe(200);
    expect(await cancel.json()).toMatchObject({ reservation: { status: "cancelled" } });
  });

  it("keeps stored live mode but refuses mutations after the Turnstile secret disappears", async () => {
    await enableLiveInstallation();
    const secretlessEnv = Object.create(env) as Env;
    Object.defineProperty(secretlessEnv, "TURNSTILE_SECRET", {
      value: undefined,
    });
    const fixture = await publicCreateBody();
    const response = await worker.fetch(
      new Request("https://example.test/api/reservations", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://example.test",
        },
        body: JSON.stringify(fixture.body),
      }),
      secretlessEnv,
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();

    const setup = await worker.fetch(
      new Request("https://example.test/api/admin/setup", {
        headers: ownerHeaders,
      }),
      secretlessEnv,
    );
    expect(setup.status).toBe(200);
    expect(await setup.json()).toMatchObject({
      mode: "live",
      readiness: {
        ready: false,
        protection: false,
        blockers: expect.arrayContaining(["protection"]),
      },
    });
  });

  it("projects missing runtime secrets as demo and restores live after each secret returns", async () => {
    await enableLiveInstallation();
    const createRequest = (body: Record<string, unknown>) =>
      new Request("https://example.test/api/reservations", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://example.test",
        },
        body: JSON.stringify(body),
      });

    for (const [secretName, startTime, managementKey] of [
      ["OWNER_TOKEN", "09:00", "A".repeat(43)],
      ["TURNSTILE_SECRET", "11:00", "B".repeat(43)],
    ] as const) {
      const fixture = await publicCreateBody({ startTime }, managementKey);
      const secretlessEnv = Object.create(env) as Env;
      Object.defineProperty(secretlessEnv, secretName, { value: undefined });
      const callsBefore = vi.mocked(fetch).mock.calls.length;

      const unavailableConfig = await worker.fetch(
        new Request("https://example.test/api/config"),
        secretlessEnv,
      );
      expect(unavailableConfig.status).toBe(200);
      expect(await unavailableConfig.json()).toMatchObject({ mode: "demo" });

      const blocked = await worker.fetch(
        createRequest(fixture.body),
        secretlessEnv,
      );
      expect(blocked.status).toBe(403);
      expect(await blocked.json()).toMatchObject({
        ok: false,
        error: { code: "PROTECTION_REFUSED" },
      });
      expect(vi.mocked(fetch).mock.calls).toHaveLength(callsBefore);

      const restoredConfig = await worker.fetch(
        new Request("https://example.test/api/config"),
        env,
      );
      expect(restoredConfig.status).toBe(200);
      expect(await restoredConfig.json()).toMatchObject({ mode: "live" });
      expect((await worker.fetch(createRequest(fixture.body), env)).status).toBe(201);
    }
  });

  it("treats whitespace and control characters in runtime secrets as unavailable", async () => {
    await enableLiveInstallation();

    for (const [index, [secretName, value]] of [
      ["OWNER_TOKEN", `${ownerToken.slice(0, 16)} ${ownerToken.slice(16)}`],
      ["OWNER_TOKEN", `${ownerToken.slice(0, 16)}\u0001${ownerToken.slice(16)}`],
      ["TURNSTILE_SECRET", "turnstile-secret-0123456789 abcdef"],
      ["TURNSTILE_SECRET", "turnstile-secret-0123456789\u0001abcdef"],
    ].entries()) {
      const invalidEnv = Object.create(env) as Env;
      Object.defineProperty(invalidEnv, secretName, { value });
      const fixture = await publicCreateBody();
      const callsBefore = vi.mocked(fetch).mock.calls.length;

      const config = await worker.fetch(
        new Request("https://example.test/api/config"),
        invalidEnv,
      );
      expect(await config.json()).toMatchObject({ mode: "demo" });

      const create = await worker.fetch(
        new Request("https://example.test/api/reservations", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "https://example.test",
            "cf-connecting-ip": `192.0.2.${10 + index}`,
          },
          body: JSON.stringify(fixture.body),
        }),
        invalidEnv,
      );
      expect(create.status).toBe(403);
      expect(await create.json()).toMatchObject({
        ok: false,
        error: { code: "PROTECTION_REFUSED" },
      });
      expect(vi.mocked(fetch).mock.calls).toHaveLength(callsBefore);

      if (secretName === "OWNER_TOKEN") {
        const setup = await worker.fetch(
          new Request("https://example.test/api/admin/setup", {
            headers: {
              ...ownerHeaders,
              "cf-connecting-ip": `192.0.2.${20 + index}`,
            },
          }),
          invalidEnv,
        );
        expect(setup.status).toBe(503);
      } else {
        const setup = await worker.fetch(
          new Request("https://example.test/api/admin/setup", {
            headers: ownerHeaders,
          }),
          invalidEnv,
        );
        expect(await setup.json()).toMatchObject({
          readiness: {
            ready: false,
            protection: false,
            blockers: expect.arrayContaining(["protection"]),
          },
        });
      }
    }
  });

  it("refuses Cloudflare's published Turnstile test secrets for live readiness", async () => {
    expect((await updateInstallation()).status).toBe(200);
    for (const testSecret of [
      "1x0000000000000000000000000000000AA",
      "2x0000000000000000000000000000000AA",
      "3x0000000000000000000000000000000AA",
    ]) {
      const testEnv = Object.create(env) as Env;
      Object.defineProperty(testEnv, "TURNSTILE_SECRET", { value: testSecret });
      const response = await worker.fetch(
        new Request("https://example.test/api/admin/setup/live", {
          method: "POST",
          headers: {
            authorization: `Bearer ${ownerToken}`,
            "content-type": "application/json",
            origin: "https://example.test",
          },
          body: JSON.stringify({
            commandId: crypto.randomUUID(),
            expectedSettingsVersion: 2,
            live: true,
          }),
        }),
        testEnv,
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        ok: false,
        error: { code: "NOT_LIVE" },
      });
    }
  });

  it("treats the published owner placeholder as an unavailable secret", async () => {
    const placeholder = "replace-with-at-least-32-random-characters";
    const placeholderEnv = Object.create(env) as Env;
    Object.defineProperty(placeholderEnv, "OWNER_TOKEN", { value: placeholder });
    const response = await worker.fetch(
      new Request("https://example.test/api/admin/setup", {
        headers: { authorization: `Bearer ${placeholder}` },
      }),
      placeholderEnv,
    );
    expect(response.status).toBe(503);
  });

  it("returns one no-store secret-free installation receipt", async () => {
    await enableLiveInstallation();
    const response = await SELF.fetch(
      "https://example.test/api/admin/installation-receipt",
      { headers: ownerHeaders },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const receipt = await response.json<Record<string, unknown>>();
    expect(Object.keys(receipt).sort()).toEqual([
      "applicationVersion",
      "consentPolicy",
      "createdAt",
      "dayPartitionPolicy",
      "guidance",
      "mode",
      "readiness",
      "resourceKinds",
      "settingsDigest",
      "settingsEffectiveAt",
      "settingsVersion",
    ]);
    expect(receipt).toMatchObject({
      applicationVersion: "0.2.0",
      settingsVersion: 2,
      settingsEffectiveAt: expect.any(String),
      dayPartitionPolicy: "pinned_until_purge",
      consentPolicy: "current_at_acceptance",
      mode: "live",
      readiness: { ready: true },
      settingsDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      resourceKinds: expect.any(Array),
      guidance: expect.any(Object),
    });
    expect(new Set(receipt.resourceKinds as string[]).size).toBe(
      (receipt.resourceKinds as string[]).length,
    );
    expect(JSON.stringify(receipt)).not.toMatch(
      /owner-test-token|turnstile-test-secret|managementKey|customer/i,
    );
  });

  it("keeps public config byte-identical and avoids calendar RPC", async () => {
    const noCalendarEnv = Object.create(env) as Env;
    Object.defineProperty(noCalendarEnv, "CALENDAR_FEED_TOKEN", { value: undefined });
    Object.defineProperty(noCalendarEnv, "GOOGLE_CALENDAR_CREDENTIALS", { value: undefined });
    let namespaceReads = 0;
    const configuredEnv = Object.create(env) as Env;
    Object.defineProperty(configuredEnv, "CALENDAR_ADAPTER", {
      get: () => {
        namespaceReads += 1;
        throw new Error("calendar namespace must stay untouched");
      },
    });

    const baseline = await worker.fetch(
      new Request("https://example.test/api/config"),
      noCalendarEnv,
    );
    const configured = await worker.fetch(
      new Request("https://example.test/api/config"),
      configuredEnv,
    );
    expect(configured.status).toBe(200);
    expect(await configured.text()).toBe(await baseline.text());
    expect(namespaceReads).toBe(0);
  });

  it("serves only the exact capability-authenticated no-store calendar feed", async () => {
    const token = "A".repeat(43);
    const valid = await SELF.fetch(
      `https://example.test/api/adapters/calendar/feed.ics?token=${token}`,
    );
    expect(valid.status).toBe(200);
    expect(valid.headers.get("content-type")).toBe("text/calendar; charset=utf-8");
    expect(valid.headers.get("cache-control")).toBe("private, no-store");
    expect(valid.headers.get("x-content-type-options")).toBe("nosniff");
    const body = await valid.text();
    expect(body).toContain("BEGIN:VCALENDAR\r\n");
    expect(body).not.toMatch(/customer|contact|management|reservationId|calendarId/i);

    const failures = await Promise.all(
      [
        "/api/adapters/calendar/feed.ics",
        "/api/adapters/calendar/feed.ics?token=bad",
        `/api/adapters/calendar/feed.ics?token=${"B".repeat(43)}`,
        `/api/adapters/calendar/feed.ics?token=${token}&extra=1`,
        `/api/adapters/calendar/feed.ics?token=${token}&token=${token}`,
      ].map((path) => SELF.fetch(`https://example.test${path}`)),
    );
    failures.push(
      await SELF.fetch(
        `https://example.test/api/adapters/calendar/feed.ics?token=${token}`,
        { method: "POST" },
      ),
    );
    const signatures = await Promise.all(
      failures.map(async (response) => ({
        status: response.status,
        contentType: response.headers.get("content-type"),
        body: await response.text(),
      })),
    );
    expect(new Set(signatures.map(JSON.stringify))).toHaveLength(1);
    expect(signatures[0]?.status).toBe(404);

    const noCalendarEnv = Object.create(env) as Env;
    Object.defineProperty(noCalendarEnv, "CALENDAR_FEED_TOKEN", { value: undefined });
    const absent = await worker.fetch(
      new Request(`https://example.test/api/adapters/calendar/feed.ics?token=${token}`),
      noCalendarEnv,
    );
    expect({
      status: absent.status,
      contentType: absent.headers.get("content-type"),
      body: await absent.text(),
    }).toEqual(signatures[0]);

    let limitedNamespaceReads = 0;
    const limitedEnv = Object.create(env) as Env;
    Object.defineProperty(limitedEnv, "PUBLIC_RATE_LIMITER", {
      value: { limit: async () => ({ success: false }) },
    });
    Object.defineProperty(limitedEnv, "CALENDAR_ADAPTER", {
      get: () => {
        limitedNamespaceReads += 1;
        throw new Error("limited feed must not reach calendar authority");
      },
    });
    const limited = await worker.fetch(
      new Request(`https://example.test/api/adapters/calendar/feed.ics?token=${token}`),
      limitedEnv,
    );
    expect({
      status: limited.status,
      contentType: limited.headers.get("content-type"),
      body: await limited.text(),
    }).toEqual(signatures[0]);
    expect(limitedNamespaceReads).toBe(0);

    let secretValue = token;
    const calendar = env.CALENDAR_ADAPTER.getByName(
      "installation",
    ) as DurableObjectStub<CalendarAdapter>;
    const mutable = await runInDurableObject(calendar, (instance) => {
      const objectEnv = (instance as unknown as { env: Env }).env;
      try {
        Object.defineProperty(objectEnv, "CALENDAR_FEED_TOKEN", {
          configurable: true,
          get: () => secretValue,
        });
        return true;
      } catch {
        return false;
      }
    });
    expect(mutable).toBe(true);
    secretValue = "C".repeat(43);
    const rotatedEnv = Object.create(env) as Env;
    Object.defineProperty(rotatedEnv, "CALENDAR_FEED_TOKEN", { value: secretValue });
    const former = await worker.fetch(
      new Request(`https://example.test/api/adapters/calendar/feed.ics?token=${token}`),
      rotatedEnv,
    );
    const rotated = await worker.fetch(
      new Request(`https://example.test/api/adapters/calendar/feed.ics?token=${secretValue}`),
      rotatedEnv,
    );
    expect(former.status).toBe(404);
    expect(rotated.status).toBe(200);
    secretValue = token;
  });

  it("rate-limits public availability before calendar authority work", async () => {
    let namespaceReads = 0;
    const limitedEnv = Object.create(env) as Env;
    Object.defineProperty(limitedEnv, "PUBLIC_RATE_LIMITER", {
      value: { limit: async () => ({ success: false }) },
    });
    Object.defineProperty(limitedEnv, "CALENDAR_ADAPTER", {
      get: () => {
        namespaceReads += 1;
        throw new Error("limited availability must not reach calendar authority");
      },
    });
    const response = await worker.fetch(new Request(availabilityUrl()), limitedEnv);
    expect(response.status).toBe(429);
    expect(namespaceReads).toBe(0);
  });

  it("fails open when the optional calendar descriptor stalls", async () => {
    await enableLiveInstallation();
    let releaseDescriptor!: (value: null) => void;
    const descriptor = new Promise<null>((resolve) => {
      releaseDescriptor = resolve;
    });
    const stalledEnv = Object.create(env) as Env;
    Object.defineProperty(stalledEnv, "CALENDAR_FEED_TOKEN", { value: "A".repeat(43) });
    Object.defineProperty(stalledEnv, "GOOGLE_CALENDAR_CREDENTIALS", { value: undefined });
    Object.defineProperty(stalledEnv, "CALENDAR_ADAPTER", {
      value: {
        getByName: () => ({ descriptor: () => descriptor }),
      },
    });

    const responsePromise = worker.fetch(new Request(availabilityUrl()), stalledEnv);
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      responsePromise.then(() => "response" as const),
      new Promise<"stalled">((resolve) => {
        watchdog = setTimeout(() => resolve("stalled"), 1_000);
      }),
    ]);
    clearTimeout(watchdog);
    releaseDescriptor(null);
    const response = await responsePromise;

    expect(outcome).toBe("response");
    expect(response.status).toBe(200);
  });

  it("records durable recovery when a descriptor stalls during a committed mutation", async () => {
    await enableLiveInstallation();
    const fixture = await publicCreateBody();
    const dayObject = stubFor();
    const calendarNamespace = env.CALENDAR_ADAPTER;
    await runInDurableObject(dayObject, (instance) => {
      Object.defineProperty((instance as unknown as { env: Env }).env, "CALENDAR_ADAPTER", {
        configurable: true,
        value: undefined,
      });
    });
    let releaseDescriptor!: (value: null) => void;
    const descriptor = new Promise<null>((resolve) => {
      releaseDescriptor = resolve;
    });
    const stalledEnv = Object.create(env) as Env;
    Object.defineProperty(stalledEnv, "CALENDAR_FEED_TOKEN", { value: "A".repeat(43) });
    Object.defineProperty(stalledEnv, "GOOGLE_CALENDAR_CREDENTIALS", { value: undefined });
    Object.defineProperty(stalledEnv, "CALENDAR_ADAPTER", {
      value: { getByName: () => ({ descriptor: () => descriptor }) },
    });

    let response: Response;
    try {
      response = await worker.fetch(
        new Request("https://example.test/api/reservations", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "https://example.test",
          },
          body: JSON.stringify(fixture.body),
        }),
        stalledEnv,
      );
    } finally {
      releaseDescriptor(null);
      await runInDurableObject(dayObject, (instance) => {
        Object.defineProperty((instance as unknown as { env: Env }).env, "CALENDAR_ADAPTER", {
          configurable: true,
          value: calendarNamespace,
        });
      });
    }

    expect(response.status).toBe(201);
    expect(
      await runInDurableObject(dayObject, (_instance, state) =>
        state.storage.sql
          .exec<{ generation: number }>(
            "SELECT generation FROM __adapter_outbox WHERE consumer = 'calendar'",
          )
          .one().generation,
      ),
    ).toBe(0);
  });

  it("conservatively discloses residual calendar state when its lookup cannot run", async () => {
    let namespaceReads = 0;
    const limitedEnv = Object.create(env) as Env;
    Object.defineProperty(limitedEnv, "CALENDAR_FEED_TOKEN", { value: undefined });
    Object.defineProperty(limitedEnv, "GOOGLE_CALENDAR_CREDENTIALS", { value: undefined });
    Object.defineProperty(limitedEnv, "PUBLIC_RATE_LIMITER", {
      value: { limit: async () => ({ success: false }) },
    });
    Object.defineProperty(limitedEnv, "CALENDAR_ADAPTER", {
      get: () => {
        namespaceReads += 1;
        throw new Error("limited privacy request must not reach calendar authority");
      },
    });
    const response = await worker.fetch(new Request("https://example.test/privacy"), limitedEnv);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("カレンダー連携を利用する場合");
    expect(namespaceReads).toBe(0);

    const unavailableEnv = Object.create(limitedEnv) as Env;
    Object.defineProperty(unavailableEnv, "PUBLIC_RATE_LIMITER", {
      value: { limit: async () => ({ success: true }) },
    });
    const unavailable = await worker.fetch(
      new Request("https://example.test/privacy"),
      unavailableEnv,
    );
    expect(await unavailable.text()).toContain("カレンダー連携を利用する場合");
    expect(namespaceReads).toBe(1);

    let releaseDisclosure!: (value: false) => void;
    const disclosure = new Promise<false>((resolve) => {
      releaseDisclosure = resolve;
    });
    const stalledEnv = Object.create(unavailableEnv) as Env;
    Object.defineProperty(stalledEnv, "CALENDAR_ADAPTER", {
      value: { getByName: () => ({ hasDisclosure: () => disclosure }) },
    });
    const responsePromise = worker.fetch(
      new Request("https://example.test/privacy"),
      stalledEnv,
    );
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      responsePromise.then(() => "response" as const),
      new Promise<"stalled">((resolve) => {
        watchdog = setTimeout(() => resolve("stalled"), 1_000);
      }),
    ]);
    clearTimeout(watchdog);
    releaseDisclosure(false);
    const stalled = await responsePromise;

    expect(outcome).toBe("response");
    expect(await stalled.text()).toContain("カレンダー連携を利用する場合");
  });

  it("keeps reservation and availability JSON identical through Google retry and terminal failure", async () => {
    await enableLiveInstallation();
    await acceptedPublicCreate({ serviceIds: ["service-cut"] });
    const availability = availabilityUrl(["service-cut"]);
    const schedule = `https://example.test/api/admin/schedule?startDate=${day.date}&days=1`;
    const snapshot = async () => {
      const [publicResponse, ownerResponse] = await Promise.all([
        SELF.fetch(availability),
        SELF.fetch(schedule, { headers: ownerHeaders }),
      ]);
      expect(publicResponse.status).toBe(200);
      expect(ownerResponse.status).toBe(200);
      return [await publicResponse.text(), await ownerResponse.text()];
    };
    const before = await snapshot();

    let calendarStatus = 503;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input) => {
        const url = String(input);
        if (url === "https://oauth2.googleapis.com/token") {
          return Response.json({
            access_token: "fixture-access-token",
            token_type: "Bearer",
            expires_in: 3600,
          });
        }
        if (url.startsWith("https://www.googleapis.com/calendar/v3/")) {
          return new Response(null, { status: calendarStatus });
        }
        throw new Error(`unexpected outbound request: ${url}`);
      }),
    );
    const calendar = env.CALENDAR_ADAPTER.getByName(
      "installation",
    ) as DurableObjectStub<CalendarAdapter>;
    await calendar.pokeDay({ date: day.date });
    await runDurableObjectAlarm(calendar);
    expect(await snapshot()).toEqual(before);
    expect(await calendar.diagnostics()).toMatchObject({ pendingCount: 1, failedCount: 0 });

    calendarStatus = 400;
    await runInDurableObject(calendar, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE google_mutations SET next_attempt_at = ? WHERE status = 'queued'",
        Date.now(),
      );
    });
    await runDurableObjectAlarm(calendar);
    expect(await snapshot()).toEqual(before);
    expect(await calendar.diagnostics()).toMatchObject({ pendingCount: 0, failedCount: 1 });
  });

  it("gates and redacts calendar status for every independent mode", async () => {
    const fixtureGoogle = JSON.stringify({
      clientId: "fixture.apps.googleusercontent.com",
      clientSecret: "fixture-client-secret",
      refreshToken: "fixture-refresh-token",
      calendarId: "fixture+calendar@example.invalid",
    });
    let authorityFeed: string | undefined;
    let authorityGoogle: string | undefined;
    const calendar = env.CALENDAR_ADAPTER.getByName(
      "installation",
    ) as DurableObjectStub<CalendarAdapter>;
    expect(
      await runInDurableObject(calendar, (instance) => {
        const objectEnv = (instance as unknown as { env: Env }).env;
        try {
          Object.defineProperties(objectEnv, {
            CALENDAR_FEED_TOKEN: { configurable: true, get: () => authorityFeed },
            GOOGLE_CALENDAR_CREDENTIALS: {
              configurable: true,
              get: () => authorityGoogle,
            },
          });
          return true;
        } catch {
          return false;
        }
      }),
    ).toBe(true);
    const noCalendarEnv = Object.create(env) as Env;
    Object.defineProperty(noCalendarEnv, "CALENDAR_FEED_TOKEN", { value: undefined });
    Object.defineProperty(noCalendarEnv, "GOOGLE_CALENDAR_CREDENTIALS", { value: undefined });
    const request = new Request("https://example.test/api/admin/calendar/status", {
      headers: ownerHeaders,
    });
    const off = await worker.fetch(request, noCalendarEnv);
    expect(off.status).toBe(200);
    expect(await off.json()).toEqual({
      ok: true,
      modes: {
        ics: { configured: false, active: false },
        google: { configured: false, active: false },
      },
      authority: null,
    });

    authorityFeed = "A".repeat(43);
    authorityGoogle = fixtureGoogle;

    const unauthorized = await SELF.fetch(
      "https://example.test/api/admin/calendar/status",
    );
    expect(unauthorized.status).toBe(401);
    const limitedEnv = Object.create(env) as Env;
    Object.defineProperty(limitedEnv, "OWNER_RATE_LIMITER", {
      value: { limit: async () => ({ success: false }) },
    });
    expect(
      (
        await worker.fetch(
          new Request("https://example.test/api/admin/calendar/status", {
            headers: ownerHeaders,
          }),
          limitedEnv,
        )
      ).status,
    ).toBe(429);
    const active = await SELF.fetch(
      "https://example.test/api/admin/calendar/status",
      { headers: ownerHeaders },
    );
    expect(active.status).toBe(200);
    const body = await active.json<Record<string, unknown>>();
    expect(body).toMatchObject({
      ok: true,
      modes: {
        ics: { configured: true, active: true },
        google: { configured: true, active: true },
      },
      authority: {
        state: "active",
        generation: 1,
        projectionCount: 0,
        pendingCount: 0,
        failedCount: 0,
      },
    });
    expect(JSON.stringify(body)).not.toMatch(
      /AAAAAAAA|fixture-access|fixture-refresh|fixture-client-secret|example\.invalid|reservationId|externalId|authorization/i,
    );

    for (const [feed, google] of [
      [true, false],
      [false, true],
    ] as const) {
      const mode = Object.create(env) as Env;
      Object.defineProperty(mode, "CALENDAR_FEED_TOKEN", {
        value: feed ? "A".repeat(43) : undefined,
      });
      Object.defineProperty(mode, "GOOGLE_CALENDAR_CREDENTIALS", {
        value: google ? fixtureGoogle : undefined,
      });
      const response = await worker.fetch(
        new Request("https://example.test/api/admin/calendar/status", {
          headers: ownerHeaders,
        }),
        mode,
      );
      expect(await response.json()).toMatchObject({
        modes: {
          ics: { configured: feed, active: feed },
          google: { configured: google, active: google },
        },
      });
    }

    authorityFeed = undefined;
    authorityGoogle = undefined;
    const configuredEnv = Object.create(env) as Env;
    Object.defineProperty(configuredEnv, "CALENDAR_FEED_TOKEN", { value: "A".repeat(43) });
    Object.defineProperty(configuredEnv, "GOOGLE_CALENDAR_CREDENTIALS", {
      value: fixtureGoogle,
    });
    const configuredButInactive = await worker.fetch(
      new Request("https://example.test/api/admin/calendar/status", {
        headers: ownerHeaders,
      }),
      configuredEnv,
    );
    expect(await configuredButInactive.json()).toMatchObject({
      modes: {
        ics: { configured: true, active: false },
        google: { configured: true, active: false },
      },
      authority: { state: "deactivating" },
    });
    authorityFeed = "A".repeat(43);
    authorityGoogle = fixtureGoogle;
  });

  it("reconciles at most seven authoritative days with a canonical cursor", async () => {
    await enableLiveInstallation();
    await acceptedPublicCreate({ serviceIds: ["service-cut"] });
    const response = await jsonRequest(
      "/api/admin/calendar/reconcile",
      { cursor: day.date },
      ownerHeaders,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      processedDates: 7,
      projected: 1,
      removed: 0,
      nextCursor: expect.any(String),
    });
    const replay = await jsonRequest(
      "/api/admin/calendar/reconcile",
      { cursor: day.date },
      ownerHeaders,
    );
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      ok: true,
      processedDates: 7,
      projected: 1,
      removed: 0,
    });

    for (const [body, status] of [
      [{ cursor: "2026-02-30" }, 400],
      [{ cursor: day.date, unknown: true }, 400],
    ] as const) {
      expect(
        (
          await jsonRequest(
            "/api/admin/calendar/reconcile",
            body,
            ownerHeaders,
          )
        ).status,
      ).toBe(status);
    }
    expect(
      (
        await SELF.fetch("https://example.test/api/admin/calendar/reconcile", {
          method: "POST",
          headers: {
            ...ownerHeaders,
            "content-type": "application/json",
            origin: "https://attacker.invalid",
          },
          body: JSON.stringify({ cursor: day.date }),
        })
      ).status,
    ).toBe(403);

    const off = Object.create(env) as Env;
    Object.defineProperty(off, "CALENDAR_FEED_TOKEN", { value: undefined });
    Object.defineProperty(off, "GOOGLE_CALENDAR_CREDENTIALS", { value: undefined });
    const notConfigured = await worker.fetch(
      new Request("https://example.test/api/admin/calendar/reconcile", {
        method: "POST",
        headers: {
          ...ownerHeaders,
          "content-type": "application/json",
          origin: "https://example.test",
        },
        body: "{}",
      }),
      off,
    );
    expect(notConfigured.status).toBe(409);
  });

  it("keeps a deferred reconciliation date as the next cursor", async () => {
    await enableLiveInstallation();
    const deferredDate = new Date(Date.parse(`${day.date}T00:00:00.000Z`) + 2 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const reconcileDay = vi.fn(async (projection: DayCalendarProjectionResult) => ({
      ok: true as const,
      projected: 0,
      removed: 0,
      ...(projection.date === deferredDate ? { deferred: true as const } : {}),
    }));
    const finishReconcile = vi.fn(async () => ({ ok: true as const }));
    const authority = {
      descriptor: async () => ({
        consumer: "calendar" as const,
        generation: 1,
        phase: "active" as const,
        leaseIssuedAt: Date.now(),
        leaseNotAfter: Date.now() + 30_000,
      }),
      reconcileDay,
      finishReconcile,
    };
    const deferredEnv = Object.create(env) as Env;
    Object.defineProperty(deferredEnv, "CALENDAR_FEED_TOKEN", { value: "A".repeat(43) });
    Object.defineProperty(deferredEnv, "GOOGLE_CALENDAR_CREDENTIALS", { value: undefined });
    Object.defineProperty(deferredEnv, "CALENDAR_ADAPTER", {
      value: { getByName: () => authority },
    });

    const response = await worker.fetch(
      new Request("https://example.test/api/admin/calendar/reconcile", {
        method: "POST",
        headers: {
          ...ownerHeaders,
          "content-type": "application/json",
          origin: "https://example.test",
        },
        body: JSON.stringify({ cursor: day.date }),
      }),
      deferredEnv,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      processedDates: 2,
      projected: 0,
      removed: 0,
      nextCursor: deferredDate,
    });
    expect(reconcileDay).toHaveBeenCalledTimes(3);
    expect(finishReconcile).toHaveBeenCalledWith({ nextCursor: deferredDate });
  });

  it("applies pending expiry while reconciling an authoritative day", async () => {
    await enableLiveInstallation();
    const created = await acceptedPublicCreate({ serviceIds: ["service-cut"] });
    const reservationId = created.result.reservation?.reservationId;
    expect(reservationId).toEqual(expect.any(String));
    const calendar = env.CALENDAR_ADAPTER.getByName(
      "installation",
    ) as DurableObjectStub<CalendarAdapter>;
    await calendar.pokeDay({ date: day.date });
    await runInDurableObject(stubFor(day.date), (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE booking_details SET created_at = ? WHERE reservation_id = ?",
        new Date(Date.now() - 8 * 24 * 60 * 60 * 1_000).toISOString(),
        reservationId,
      );
    });
    const reconciled = await jsonRequest(
      "/api/admin/calendar/reconcile",
      { cursor: day.date },
      ownerHeaders,
    );
    expect(reconciled.status).toBe(200);
    const schedule = await SELF.fetch(
      `https://example.test/api/admin/schedule?startDate=${day.date}&days=1`,
      { headers: ownerHeaders },
    );
    expect(await schedule.json()).toMatchObject({
      boards: [{ reservations: [{ reservationId, status: "expired" }] }],
    });
    const feed = await SELF.fetch(
      `https://example.test/api/adapters/calendar/feed.ics?token=${"A".repeat(43)}`,
    );
    expect(await feed.text()).not.toContain("BEGIN:VEVENT");
  });

  it("keeps the calendar privacy disclosure through cleanup and removes it after purge", async () => {
    const token = "A".repeat(43);
    let feedSecret: string | undefined;
    let googleSecret: string | undefined;
    const calendar = env.CALENDAR_ADAPTER.getByName(
      "installation",
    ) as DurableObjectStub<CalendarAdapter>;
    expect(
      await runInDurableObject(calendar, (instance) => {
        const objectEnv = (instance as unknown as { env: Env }).env;
        try {
          Object.defineProperties(objectEnv, {
            CALENDAR_FEED_TOKEN: { configurable: true, get: () => feedSecret },
            GOOGLE_CALENDAR_CREDENTIALS: { configurable: true, get: () => googleSecret },
          });
          return true;
        } catch {
          return false;
        }
      }),
    ).toBe(true);
    const modeEnv = (feed: string | undefined) => {
      const value = Object.create(env) as Env;
      Object.defineProperty(value, "CALENDAR_FEED_TOKEN", { value: feed });
      Object.defineProperty(value, "GOOGLE_CALENDAR_CREDENTIALS", { value: undefined });
      return value;
    };

    const baselineResponse = await worker.fetch(
      new Request("https://example.test/privacy"),
      modeEnv(undefined),
    );
    const baseline = await baselineResponse.text();
    expect(baseline).not.toContain("カレンダー連携を利用する場合");
    expect(baseline).not.toContain("有効な任意連携がある場合");

    feedSecret = token;
    expect(await calendar.descriptor()).toMatchObject({ consumer: "calendar", phase: "active" });
    const active = await worker.fetch(
      new Request("https://example.test/privacy"),
      modeEnv(token),
    );
    expect(active.headers.get("cache-control")).toBe("no-store");
    const activeBody = await active.text();
    expect(activeBody).toContain("カレンダー連携を利用する場合");
    expect(activeBody).toContain("予定の重複を防ぐ復元不能な識別子、予定作成時刻だけ");
    expect(activeBody).toContain("専用 URL を知る人は予定を閲覧できます");

    feedSecret = undefined;
    const residual = await worker.fetch(
      new Request("https://example.test/privacy"),
      modeEnv(undefined),
    );
    expect(await residual.text()).toContain("安全な削除処理が終わるまでこの案内を表示");

    await runInDurableObject(calendar, (_instance, state) => {
      state.storage.sql.exec("DELETE FROM accepted_events");
      state.storage.sql.exec("DELETE FROM projections");
      state.storage.sql.exec("DELETE FROM google_mutations");
      state.storage.sql.exec("UPDATE meta SET state = 'disabled' WHERE singleton = 1");
    });
    const purged = await worker.fetch(
      new Request("https://example.test/privacy"),
      modeEnv(undefined),
    );
    expect(await purged.text()).toBe(baseline);
    feedSecret = token;
  });
});
