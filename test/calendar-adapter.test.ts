import { env, reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CALENDAR_ROW_CAP,
  CalendarAdapter,
  calendarIdentifiers,
  classifyGoogleResponse,
  clearGoogleTokenCacheForTests,
  escapeCalendarText,
  foldCalendarLine,
  googleEventBody,
  googleEventUrl,
  getGoogleAccessToken,
  parseCalendarFeedToken,
  parseGoogleCredentials,
  renderCalendar,
  requestGoogleAccessToken,
  sendGoogleMutation,
  type CalendarProjection,
  type GoogleCalendarCredentials,
} from "../src/calendar-adapter.ts";
import type { DayConfig, ReservationDay } from "../src/reservation-day.ts";
import { ADAPTER } from "../src/adapter-constants.ts";
import { lineDay, SUITE_NOW, SUITE_PURGE_AT, suiteDate } from "./line-helpers.ts";

const credentials: GoogleCalendarCredentials = {
  clientId: "fixture.apps.googleusercontent.com",
  clientSecret: "fixture-client-secret",
  refreshToken: "fixture-refresh-token",
  calendarId: "fixture+calendar@example.invalid",
};

const mockGoogleAuthSuccess = (expiresIn = 3_600): Response =>
  Response.json({
    access_token: "fixture-access-token",
    token_type: "Bearer",
    expires_in: expiresIn,
  });

const projection: CalendarProjection = {
  uid: "opaque@example.invalid",
  externalId: `sr${"a".repeat(64)}`,
  stampAt: "2026-08-13T00:00:00.678Z",
  startAt: "2026-08-13T01:00:00.000Z",
  endAt: "2026-08-13T02:00:00.000Z",
  serviceLabel: "架空カット,カラー;相談\\確認\n二行目",
  status: "tentative",
};

describe("calendar adapter pure contracts", () => {
  it("accepts only exact bounded optional secret shapes", () => {
    const token = "A".repeat(43);
    expect(parseCalendarFeedToken(token)).toBe(token);
    for (const value of [undefined, "", "A".repeat(42), "A".repeat(44), `${"A".repeat(42)}=`]) {
      expect(parseCalendarFeedToken(value)).toBeNull();
    }

    expect(parseGoogleCredentials(JSON.stringify(credentials))).toEqual(credentials);
    expect(
      parseGoogleCredentials(JSON.stringify({ ...credentials, unexpected: true })),
    ).toBeNull();
    expect(parseGoogleCredentials(JSON.stringify({ ...credentials, refreshToken: "" }))).toBeNull();
    expect(parseGoogleCredentials("not-json")).toBeNull();
  });

  it("derives stable non-reversible calendar identifiers", async () => {
    const reservationId = "00000000-0000-4000-8000-000000000001";
    const first = await calendarIdentifiers(reservationId);
    expect(await calendarIdentifiers(reservationId)).toEqual(first);
    expect(first.externalId).toMatch(/^sr[a-f0-9]{64}$/);
    expect(first.uid).toMatch(/^[a-f0-9]{64}@example\.invalid$/);
    expect(JSON.stringify(first)).not.toContain(reservationId);
    expect(await calendarIdentifiers("00000000-0000-4000-8000-000000000002")).not.toEqual(first);
  });

  it("escapes and folds RFC 5545 text on UTF-8 boundaries", () => {
    expect(escapeCalendarText("a\\b,c;d\r\ne")).toBe("a\\\\b\\,c\\;d\\ne");
    const folded = foldCalendarLine(`SUMMARY:${"架空予約".repeat(20)}`);
    const encoder = new TextEncoder();
    for (const line of folded.split("\r\n")) {
      expect(encoder.encode(line).byteLength).toBeLessThanOrEqual(75);
    }
    expect(folded).toContain("\r\n ");
  });

  it("renders a minimal deterministic CRLF calendar without private fields", () => {
    const body = renderCalendar([projection]);
    expect(body).toContain("BEGIN:VCALENDAR\r\n");
    expect(body).toContain("DTSTAMP:20260813T000000Z\r\n");
    expect(body).not.toContain(".678");
    expect(body).toContain("DTSTART:20260813T010000Z\r\n");
    expect(body).toContain("DTEND:20260813T020000Z\r\n");
    expect(body).toContain("STATUS:TENTATIVE\r\n");
    expect(body).toContain("SUMMARY:架空カット\\,カラー\\;相談\\\\確認\\n二行目");
    expect(body.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(body.replaceAll("\r\n", "")).not.toContain("\n");
    for (const forbidden of ["CUSTOMER", "ATTENDEE", "DESCRIPTION", "CONTACT", "URL:"]) {
      expect(body).not.toContain(forbidden);
    }
  });

  it("builds only fixed Google URLs and the allowlisted event body", () => {
    expect(googleEventUrl(credentials.calendarId)).toBe(
      "https://www.googleapis.com/calendar/v3/calendars/fixture%2Bcalendar%40example.invalid/events?sendUpdates=none",
    );
    expect(googleEventUrl(credentials.calendarId, projection.externalId)).toBe(
      `https://www.googleapis.com/calendar/v3/calendars/fixture%2Bcalendar%40example.invalid/events/${projection.externalId}?sendUpdates=none`,
    );
    expect(new URL(googleEventUrl("https://attacker.invalid/internal")).origin).toBe(
      "https://www.googleapis.com",
    );
    expect(googleEventBody(projection, true)).toEqual({
      id: projection.externalId,
      summary: projection.serviceLabel,
      status: "tentative",
      visibility: "private",
      transparency: "opaque",
      start: { dateTime: projection.startAt },
      end: { dateTime: projection.endAt },
    });
    expect(googleEventBody(projection, false)).not.toHaveProperty("id");
    for (const forbidden of ["attendees", "description", "location", "reminders", "extendedProperties"] ) {
      expect(googleEventBody(projection, true)).not.toHaveProperty(forbidden);
    }
  });

  it("classifies retryable quota failures separately from credentials and payloads", () => {
    expect(classifyGoogleResponse(204)).toBe("success");
    expect(classifyGoogleResponse(408)).toBe("retryable");
    expect(classifyGoogleResponse(429)).toBe("retryable");
    expect(classifyGoogleResponse(503)).toBe("retryable");
    expect(classifyGoogleResponse(403, ["rateLimitExceeded"])).toBe("retryable");
    expect(classifyGoogleResponse(403, ["forbidden"])).toBe("configuration");
    expect(classifyGoogleResponse(401)).toBe("configuration");
    expect(classifyGoogleResponse(400)).toBe("permanent");
  });

  it("exchanges refresh credentials only at the fixed token endpoint", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => mockGoogleAuthSuccess());
    const now = Date.parse("2026-08-13T00:00:00.000Z");
    await expect(requestGoogleAccessToken(credentials, fetcher, now)).resolves.toEqual({
      ok: true,
      accessToken: "fixture-access-token",
      expiresAt: now + 3_600_000,
    });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://oauth2.googleapis.com/token");
    expect(init).toMatchObject({ method: "POST", redirect: "manual" });
    expect(init.headers).toEqual({ "content-type": "application/x-www-form-urlencoded" });
    expect(String(init.body)).toBe(
      "client_id=fixture.apps.googleusercontent.com&client_secret=fixture-client-secret&refresh_token=fixture-refresh-token&grant_type=refresh_token",
    );
  });

  it("caches access tokens by credential fingerprint and rotates immediately", async () => {
    clearGoogleTokenCacheForTests();
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({
        access_token: `fixture-access-${fetcher.mock.calls.length}`,
        token_type: "Bearer",
        expires_in: 3600,
      }),
    );
    const now = Date.parse("2026-08-13T00:00:00.000Z");
    const first = await getGoogleAccessToken(credentials, fetcher, now);
    expect(await getGoogleAccessToken(credentials, fetcher, now + 1_000)).toEqual(first);
    expect(fetcher).toHaveBeenCalledOnce();

    const rotated = { ...credentials, refreshToken: "fixture-refresh-token-rotated" };
    expect(await getGoogleAccessToken(rotated, fetcher, now + 2_000)).toMatchObject({ ok: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("rejects redirects, oversized bodies, and malformed token schemas", async () => {
    const now = Date.parse("2026-08-13T00:00:00.000Z");
    const scenarios: Array<[Response, object]> = [
      [new Response(null, { status: 408 }), { ok: false, kind: "retryable", status: 408 }],
      [new Response(null, { status: 429 }), { ok: false, kind: "retryable", status: 429 }],
      [new Response(null, { status: 302 }), { ok: false, kind: "configuration", status: 302 }],
      [new Response("x".repeat(16 * 1024 + 1), { status: 200 }), { ok: false, kind: "protocol", status: 200 }],
      [Response.json({ token_type: "Bearer", expires_in: 3600 }), { ok: false, kind: "protocol", status: 200 }],
      [
        Response.json({ access_token: "fixture", token_type: "bearer", expires_in: 3600 }),
        { ok: false, kind: "protocol", status: 200 },
      ],
      [
        Response.json({ access_token: "fixture", token_type: "Bearer", expires_in: 0 }),
        { ok: false, kind: "protocol", status: 200 },
      ],
    ];
    for (const [response, expected] of scenarios) {
      await expect(
        requestGoogleAccessToken(credentials, vi.fn<typeof fetch>(async () => response), now),
      ).resolves.toEqual(expected);
    }
    await expect(
      requestGoogleAccessToken(
        credentials,
        vi.fn<typeof fetch>(async () => {
          throw new DOMException("timed out", "AbortError");
        }),
        now,
      ),
    ).resolves.toEqual({ ok: false, kind: "retryable", status: null });
  });

  it("keeps the OAuth deadline active while reading the response body", async () => {
    vi.useFakeTimers();
    try {
      let bodyController!: ReadableStreamDefaultController<Uint8Array>;
      let requestSignal: AbortSignal | null = null;
      const pending = requestGoogleAccessToken(
        credentials,
        vi.fn<typeof fetch>(async (_input, init) => {
          requestSignal = init?.signal ?? null;
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              bodyController = controller;
              requestSignal?.addEventListener("abort", () => {
                controller.error(new DOMException("timed out", "AbortError"));
              });
            },
          });
          return new Response(body, { status: 200 });
        }),
      );

      await vi.advanceTimersByTimeAsync(ADAPTER.OUTBOUND_TIMEOUT_MS);
      const aborted = requestSignal?.aborted ?? false;
      if (!aborted) bodyController.error(new Error("test cleanup"));
      expect(await pending).toEqual({ ok: false, kind: "retryable", status: null });
      expect(aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the Calendar API deadline active while reading an error body", async () => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    let bodyController!: ReadableStreamDefaultController<Uint8Array>;
    const fetcher = vi.fn<typeof fetch>(async (_input, init = {}) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          bodyController = controller;
          init.signal?.addEventListener("abort", () => {
            controller.error(new DOMException("timed out", "AbortError"));
          });
        },
      });
      return new Response(body, { status: 403 });
    });
    vi.stubGlobal("fetch", fetcher);

    const pending = sendGoogleMutation(
      credentials,
      "fixture-access-token",
      "upsert",
      projection,
      projection.externalId,
      Number.POSITIVE_INFINITY,
    );
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    const usesDeadline = timeout.mock.calls.some(
      ([milliseconds]) => milliseconds === ADAPTER.OUTBOUND_TIMEOUT_MS,
    );
    if (usesDeadline) deadline.abort();
    else bodyController.error(new Error("test cleanup"));

    expect(await pending).toEqual({ kind: "retryable", status: null });
    expect(usesDeadline).toBe(true);
  });
});

describe("calendar projection and feed authority", () => {
  const feedToken = "A".repeat(43);
  const adapterStub = () =>
    env.CALENDAR_ADAPTER.getByName(
      "installation",
    ) as DurableObjectStub<CalendarAdapter>;
  const dayStub = (date: string) =>
    env.RESERVATION_DAYS.getByName(
      `single-location:${date}`,
    ) as DurableObjectStub<ReservationDay>;

  const configFor = async (date = suiteDate(1)): Promise<DayConfig> => {
    const calendarAdapter = await adapterStub().descriptor();
    if (calendarAdapter === null) throw new Error("calendar fixture did not activate");
    return { ...lineDay, date, purgeAt: SUITE_PURGE_AT, calendarAdapter };
  };

  const createInput = (date: string, startTime = "09:00") => ({
    commandId: crypto.randomUUID(),
    settingsVersion: lineDay.settingsVersion,
    serviceIds: ["service-cut"],
    resourceId: "resource-chair-a",
    date,
    startTime,
    customerName: "架空 花子",
    contact: "hanako@example.invalid",
    consentVersion: lineDay.consentVersion,
    managementDigest: "a".repeat(64),
  });

  const fillGoogleMutationQueue = (
    { operation = "upsert", status = "failed" }: {
      operation?: "upsert" | "delete";
      status?: "awaiting-configuration" | "failed";
    } = {},
  ) =>
    runInDurableObject(adapterStub(), (_instance, state) => {
      state.storage.sql.exec(
        `WITH RECURSIVE rows(value) AS (
           VALUES(1) UNION ALL SELECT value + 1 FROM rows WHERE value < ?
         )
         INSERT INTO google_mutations
           (reservation_id, external_id, operation, payload_json, desired_version, generation,
            attempt, next_attempt_at, first_attempt_at, claimed_at, claimed_version, status,
            created_at, purge_at)
         SELECT printf('10000000-0000-4000-8000-%012d', value), printf('sr%064x', value),
                ?, NULL, 1, 1, 0, NULL, NULL, NULL, NULL, ?,
                '2020-01-01T00:00:00.000Z', ? FROM rows`,
        CALENDAR_ROW_CAP,
        operation,
        status,
        SUITE_PURGE_AT,
      );
    });

  beforeEach(() => {
    clearGoogleTokenCacheForTests();
    vi.useFakeTimers({ toFake: ["Date"], now: SUITE_NOW });
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await reset();
  });

  it("deduplicates lifecycle events and converges on one stable feed UID", async () => {
    const config = await configFor();
    const day = dayStub(config.date);
    const created = await day.createPublic(config, createInput(config.date));
    expect(created).toMatchObject({ ok: true, status: "pending" });
    if (!created.ok) throw new Error("fixture create failed");
    await adapterStub().pokeDay({ date: config.date });
    await adapterStub().pokeDay({ date: config.date });

    const pending = await adapterStub().feed({ token: feedToken });
    expect(pending.ok).toBe(true);
    if (!pending.ok) throw new Error("feed fixture failed");
    expect(pending.body.match(/BEGIN:VEVENT/g)).toHaveLength(1);
    expect(pending.body).toContain("STATUS:TENTATIVE");
    expect(pending.body).toContain("SUMMARY:架空カット");
    expect(pending.body).not.toContain(created.reservationId);
    const uid = pending.body.replace(/\r\n /g, "").match(/UID:([^\r]+)/)?.[1];
    expect(uid).toMatch(/^[a-f0-9]{64}@example\.invalid$/);

    expect(
      await day.transitionOwner(config, {
        commandId: crypto.randomUUID(),
        date: config.date,
        reservationId: created.reservationId,
        action: "approve",
      }),
    ).toMatchObject({ ok: true, status: "approved" });
    await adapterStub().pokeDay({ date: config.date });
    const approved = await adapterStub().feed({ token: feedToken });
    expect(approved).toMatchObject({ ok: true });
    if (!approved.ok) throw new Error("feed fixture failed");
    expect(approved.body.replace(/\r\n /g, "")).toContain(`UID:${uid}`);
    expect(approved.body).toContain("STATUS:CONFIRMED");

    expect(
      await day.transitionOwner(config, {
        commandId: crypto.randomUUID(),
        date: config.date,
        reservationId: created.reservationId,
        action: "reschedule",
        resourceId: "resource-chair-a",
        startTime: "11:00",
      }),
    ).toMatchObject({ ok: true, startTime: "11:00" });
    await adapterStub().pokeDay({ date: config.date });
    const moved = await adapterStub().feed({ token: feedToken });
    if (!moved.ok) throw new Error("feed fixture failed");
    expect(moved.body.replace(/\r\n /g, "")).toContain(`UID:${uid}`);
    expect(moved.body).toContain(
      `DTSTART:${new Date(`${config.date}T11:00:00+09:00`)
        .toISOString()
        .replace(/[-:]/g, "")
        .replace(".000", "")}`,
    );

    expect(
      await day.transitionOwner(config, {
        commandId: crypto.randomUUID(),
        date: config.date,
        reservationId: created.reservationId,
        action: "cancel",
      }),
    ).toMatchObject({ ok: true, status: "cancelled" });
    await adapterStub().pokeDay({ date: config.date });
    const removed = await adapterStub().feed({ token: feedToken });
    if (!removed.ok) throw new Error("feed fixture failed");
    expect(removed.body).not.toContain("BEGIN:VEVENT");

    const diagnostics = await adapterStub().diagnostics();
    expect(diagnostics).toMatchObject({ projectionCount: 0 });
    const accepted = await runInDurableObject(adapterStub(), (_instance, state) =>
      state.storage.sql
        .exec<{ n: number }>("SELECT COUNT(*) AS n FROM accepted_events")
        .one().n,
    );
    expect(accepted).toBe(4);
  });

  it("rejects an old-generation event when activation changes during identifier hashing", async () => {
    const config = await configFor(suiteDate(24));
    const day = dayStub(config.date);
    const calendarNamespace = env.CALENDAR_ADAPTER;
    await runInDurableObject(day, (instance) => {
      Object.defineProperty((instance as unknown as { env: Env }).env, "CALENDAR_ADAPTER", {
        configurable: true,
        value: undefined,
      });
    });
    expect(await day.createPublic(config, createInput(config.date))).toMatchObject({ ok: true });
    await runInDurableObject(day, (instance) => {
      Object.defineProperty((instance as unknown as { env: Env }).env, "CALENDAR_ADAPTER", {
        configurable: true,
        value: calendarNamespace,
      });
    });

    await expect(
      runInDurableObject(adapterStub(), (instance, state) => {
        const digest = crypto.subtle.digest.bind(crypto.subtle);
        let firstDigest = true;
        vi.spyOn(crypto.subtle, "digest").mockImplementation((algorithm, data) => {
          if (firstDigest) {
            firstDigest = false;
            state.storage.sql.exec(
              "UPDATE meta SET generation = 2, high_water = 2 WHERE singleton = 1",
            );
          }
          return digest(algorithm, data);
        });
        return instance.pokeDay({ date: config.date });
      }),
    ).resolves.toEqual({ ok: true, drained: 1 });
    expect(await adapterStub().diagnostics()).toMatchObject({
      generation: 2,
      projectionCount: 0,
      counters: { "disposition:stale-generation": 1 },
    });
  });

  it("orders events and exposes only an aggregate feed-auth failure count", async () => {
    expect(await adapterStub().feed({ token: "C".repeat(43) })).toEqual({ ok: false });
    const config = await configFor(suiteDate(2));
    const day = dayStub(config.date);
    for (const startTime of ["11:00", "09:00"]) {
      expect(await day.createPublic(config, createInput(config.date, startTime))).toMatchObject({
        ok: true,
      });
    }
    await adapterStub().pokeDay({ date: config.date });

    expect(await adapterStub().feed({ token: "B".repeat(43) })).toEqual({ ok: false });
    expect(await adapterStub().feed({ token: "bad" })).toEqual({ ok: false });
    const valid = await adapterStub().feed({ token: feedToken });
    if (!valid.ok) throw new Error("feed fixture failed");
    const date = config.date.replaceAll("-", "");
    expect(valid.body.indexOf(`DTSTART:${date}T000000Z\r\n`)).toBeLessThan(
      valid.body.indexOf(`DTSTART:${date}T020000Z\r\n`),
    );
    expect(await adapterStub().diagnostics()).toMatchObject({
      counters: { feed_auth_failed: 3 },
    });
  });

  it("keeps feed bytes stable across unchanged reads", async () => {
    const config = await configFor(suiteDate(18));
    expect(
      await dayStub(config.date).createPublic(config, createInput(config.date)),
    ).toMatchObject({ ok: true });
    await adapterStub().pokeDay({ date: config.date });
    const first = await adapterStub().feed({ token: feedToken });
    vi.setSystemTime(SUITE_NOW + 60_000);
    const second = await adapterStub().feed({ token: feedToken });
    expect(second).toEqual(first);
  });

  it("drains every event from one bounded multi-batch handoff", async () => {
    const config = await configFor(suiteDate(17));
    const adapter = adapterStub();
    const day = dayStub(config.date);
    const calendarNamespace = env.CALENDAR_ADAPTER;
    await runInDurableObject(day, (instance) => {
      Object.defineProperty((instance as unknown as { env: Env }).env, "CALENDAR_ADAPTER", {
        configurable: true,
        value: undefined,
      });
    });
    expect(await day.createPublic(config, createInput(config.date))).toMatchObject({ ok: true });
    await runInDurableObject(day, (instance, state) => {
      Object.defineProperty((instance as unknown as { env: Env }).env, "CALENDAR_ADAPTER", {
        configurable: true,
        value: calendarNamespace,
      });
      for (let seq = 2; seq <= ADAPTER.OUTBOX_DRAIN_BATCH + 1; seq += 1) {
        state.storage.sql.exec(
          `INSERT INTO __adapter_outbox
             (consumer, generation, seq, event_id, reservation_id, type, start_time, end_time,
              service_label, reservation_status, occurred_at, purge_at)
           VALUES ('calendar', 1, ?, ?, ?, 'create', '09:00', '10:00',
                   '架空カット', 'pending', ?, ?)`,
          seq,
          `${config.date}#${seq}`,
          `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
          new Date().toISOString(),
          config.purgeAt,
        );
      }
      state.storage.sql.exec(
        "UPDATE __adapter_meta SET event_seq = ? WHERE consumer = 'calendar' AND generation = 1",
        ADAPTER.OUTBOX_DRAIN_BATCH + 1,
      );
    });

    await expect(adapter.pokeDay({ date: config.date })).resolves.toEqual({
      ok: true,
      drained: ADAPTER.OUTBOX_DRAIN_BATCH + 1,
    });
    await expect(day.drainOutbox({ consumer: "calendar" })).resolves.toEqual({
      events: [],
      more: false,
    });
  });

  it("recovers a lost post-commit poke from the bounded active sweep", async () => {
    const config = await configFor(suiteDate(16));
    const adapter = adapterStub();
    const day = dayStub(config.date);
    const calendarNamespace = env.CALENDAR_ADAPTER;
    expect(
      await runInDurableObject(day, (instance) => {
        try {
          Object.defineProperty((instance as unknown as { env: Env }).env, "CALENDAR_ADAPTER", {
            configurable: true,
            value: undefined,
          });
          return true;
        } catch {
          return false;
        }
      }),
    ).toBe(true);
    expect(await day.createPublic(config, createInput(config.date))).toMatchObject({ ok: true });
    await runInDurableObject(day, (instance) => {
      Object.defineProperty((instance as unknown as { env: Env }).env, "CALENDAR_ADAPTER", {
        configurable: true,
        value: calendarNamespace,
      });
    });
    expect(await adapter.diagnostics()).toMatchObject({ projectionCount: 0 });
    await runInDurableObject(adapter, (_instance, state) => {
      state.storage.sql.exec("UPDATE meta SET sweep_cursor = ? WHERE singleton = 1", config.date);
    });
    await runDurableObjectAlarm(adapter);
    expect(await adapter.diagnostics()).toMatchObject({ projectionCount: 1 });
  });

  it("recovers descriptor-timeout mutations from the durable calendar outbox", async () => {
    const config = await configFor(suiteDate(17));
    const adapter = adapterStub();
    const day = dayStub(config.date);
    const calendarNamespace = env.CALENDAR_ADAPTER;
    await runInDurableObject(day, (instance) => {
      Object.defineProperty((instance as unknown as { env: Env }).env, "CALENDAR_ADAPTER", {
        configurable: true,
        value: undefined,
      });
    });

    const created = await day.createPublic(config, createInput(config.date));
    expect(created).toMatchObject({ ok: true, status: "pending" });
    if (!created.ok) throw new Error("fixture create failed");
    expect(
      await day.transitionOwner(
        {
          ...config,
          calendarAdapter: undefined,
          calendarRecovery: {
            leaseIssuedAt: SUITE_NOW,
            leaseNotAfter: SUITE_NOW + ADAPTER.DESCRIPTOR_LEASE_WINDOW_S * 1_000,
          },
        },
        {
          commandId: crypto.randomUUID(),
          date: config.date,
          reservationId: created.reservationId,
          action: "approve",
        },
      ),
    ).toMatchObject({ ok: true, status: "approved" });

    await runInDurableObject(day, (instance) => {
      Object.defineProperty((instance as unknown as { env: Env }).env, "CALENDAR_ADAPTER", {
        configurable: true,
        value: calendarNamespace,
      });
    });

    expect(
      await runInDurableObject(day, (_instance, state) =>
        state.storage.sql
          .exec<{ generation: number; seq: number }>(
            `SELECT generation, seq FROM __adapter_outbox
             WHERE consumer = 'calendar' ORDER BY seq`,
          )
          .toArray(),
      ),
    ).toEqual([
      { generation: 1, seq: 1 },
      { generation: 0, seq: 2 },
    ]);

    await expect(
      runInDurableObject(adapter, (instance, state) => {
        const digest = crypto.subtle.digest.bind(crypto.subtle);
        let firstDigest = true;
        vi.spyOn(crypto.subtle, "digest").mockImplementation((algorithm, data) => {
          if (firstDigest) {
            firstDigest = false;
            state.storage.sql.exec(
              "UPDATE meta SET generation = 2, high_water = 2 WHERE singleton = 1",
            );
          }
          return digest(algorithm, data);
        });
        return instance.pokeDay({ date: config.date });
      }),
    ).resolves.toEqual({ ok: true, drained: 0 });
    expect(await day.drainOutbox({ consumer: "calendar" })).toMatchObject({
      events: [{ generation: 0 }, { generation: 1 }],
    });
    await expect(adapter.pokeDay({ date: config.date })).resolves.toEqual({ ok: true, drained: 2 });
    expect(
      await runInDurableObject(adapter, (_instance, state) =>
        state.storage.sql
          .exec<{ event_key: string }>(
            "SELECT event_key FROM accepted_events WHERE event_key LIKE '0:%'",
          )
          .one().event_key,
      ),
    ).toBe(`0:${config.date}#2`);
    const feed = await adapter.feed({ token: feedToken });
    expect(feed.ok && feed.body).toContain("STATUS:CONFIRMED");
  });

  it("keeps authoritative reconciliation ahead of a delayed older event", async () => {
    const config = await configFor(suiteDate(19));
    const adapter = adapterStub();
    const day = dayStub(config.date);
    const calendarNamespace = env.CALENDAR_ADAPTER;
    await runInDurableObject(day, (instance) => {
      Object.defineProperty((instance as unknown as { env: Env }).env, "CALENDAR_ADAPTER", {
        configurable: true,
        value: undefined,
      });
    });

    const created = await day.createPublic(config, createInput(config.date));
    expect(created).toMatchObject({ ok: true, status: "pending" });
    if (!created.ok) throw new Error("fixture create failed");
    const delayed = await day.drainOutbox({ consumer: "calendar", limit: 1 });
    expect(delayed).toMatchObject({ events: [{ seq: 1, type: "create" }], more: false });
    const stale = delayed.events[0];
    if (stale === undefined) throw new Error("fixture stale event missing");
    await day.ackOutbox({
      consumer: "calendar",
      events: delayed.events.map(({ generation, eventId }) => ({ generation, eventId })),
    });

    expect(
      await day.transitionOwner(config, {
        commandId: crypto.randomUUID(),
        date: config.date,
        reservationId: created.reservationId,
        action: "reject",
        reason: "架空の受付都合",
      }),
    ).toMatchObject({ ok: true, status: "rejected" });
    const rejected = await day.drainOutbox({ consumer: "calendar", limit: 1 });
    expect(rejected).toMatchObject({ events: [{ seq: 2, type: "reject" }], more: false });
    await day.ackOutbox({
      consumer: "calendar",
      events: rejected.events.map(({ generation, eventId }) => ({ generation, eventId })),
    });

    const authoritative = await day.calendarProjection(config);
    expect(authoritative).toMatchObject({ ok: true, events: [] });
    await adapter.reconcileDay(authoritative);
    await runInDurableObject(day, (instance, state) => {
      Object.defineProperty((instance as unknown as { env: Env }).env, "CALENDAR_ADAPTER", {
        configurable: true,
        value: calendarNamespace,
      });
      state.storage.sql.exec(
        `INSERT INTO __adapter_outbox
           (consumer, generation, seq, event_id, reservation_id, type, start_time, end_time,
            service_label, reservation_status, occurred_at, purge_at)
         VALUES ('calendar', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        stale.generation,
        stale.seq,
        stale.eventId,
        stale.reservationId,
        stale.type,
        stale.startTime,
        stale.endTime,
        stale.serviceLabel,
        stale.reservationStatus,
        stale.occurredAt,
        stale.purgeAt,
      );
    });

    await adapter.pokeDay({ date: config.date });
    expect(await adapter.diagnostics()).toMatchObject({ projectionCount: 0 });
  });

  it("keeps a newer accepted event ahead of an older reconciliation", async () => {
    const config = await configFor(suiteDate(20));
    const adapter = adapterStub();
    const day = dayStub(config.date);
    const calendarNamespace = env.CALENDAR_ADAPTER;
    await runInDurableObject(day, (instance) => {
      Object.defineProperty((instance as unknown as { env: Env }).env, "CALENDAR_ADAPTER", {
        configurable: true,
        value: undefined,
      });
    });

    const created = await day.createPublic(config, createInput(config.date));
    expect(created).toMatchObject({ ok: true, status: "pending" });
    if (!created.ok) throw new Error("fixture create failed");
    const stale = await day.calendarProjection(config);
    expect(stale).toMatchObject({
      ok: true,
      watermark: { generation: 1, seq: 1 },
      events: [{ reservationId: created.reservationId, status: "pending" }],
    });
    expect(
      await day.transitionOwner(config, {
        commandId: crypto.randomUUID(),
        date: config.date,
        reservationId: created.reservationId,
        action: "reject",
        reason: "架空の受付都合",
      }),
    ).toMatchObject({ ok: true, status: "rejected" });
    await runInDurableObject(day, (instance) => {
      Object.defineProperty((instance as unknown as { env: Env }).env, "CALENDAR_ADAPTER", {
        configurable: true,
        value: calendarNamespace,
      });
    });

    await expect(adapter.pokeDay({ date: config.date })).resolves.toEqual({ ok: true, drained: 2 });
    expect(await adapter.diagnostics()).toMatchObject({ projectionCount: 0 });
    await adapter.reconcileDay(stale);
    expect(await adapter.diagnostics()).toMatchObject({ projectionCount: 0 });
  });

  it("rejects past-retention events and caps new projections", async () => {
    const config = await configFor(suiteDate(3));
    const calendarNamespace = env.CALENDAR_ADAPTER;
    const adapter = adapterStub();
    const day = dayStub(config.date);
    const calendarNamespaceRemoved = await runInDurableObject(day, (instance) => {
      const objectEnv = (instance as unknown as { env: Env }).env;
      try {
        Object.defineProperty(objectEnv, "CALENDAR_ADAPTER", {
          configurable: true,
          value: undefined,
        });
        return true;
      } catch {
        return false;
      }
    });
    expect(calendarNamespaceRemoved).toBe(true);
    const expired = await day.createPublic(config, createInput(config.date));
    expect(expired).toMatchObject({ ok: true });
    await runInDurableObject(day, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE __adapter_outbox SET purge_at = ? WHERE consumer = 'calendar'",
        SUITE_NOW - 1,
      );
    });
    await runInDurableObject(day, (instance) => {
      Object.defineProperty((instance as unknown as { env: Env }).env, "CALENDAR_ADAPTER", {
        configurable: true,
        value: calendarNamespace,
      });
    });
    await adapter.pokeDay({ date: config.date });
    expect(await adapter.diagnostics()).toMatchObject({
      projectionCount: 0,
      counters: { "disposition:past-retention": 1 },
    });

    await runInDurableObject(adapter, (_instance, state) => {
      state.storage.sql.exec(`
        WITH RECURSIVE rows(value) AS (
          VALUES(1) UNION ALL SELECT value + 1 FROM rows WHERE value < 2000
        )
        INSERT INTO projections
          (reservation_id, external_id, uid, date, stamp_at, start_at, end_at,
           service_label, status, purge_at)
        SELECT printf('00000000-0000-4000-8000-%012d', value),
               printf('sr%064x', value), printf('%064x@example.invalid', value),
               '2099-01-01', '2026-08-13T00:00:00.000Z',
               '2099-01-01T00:00:00.000Z', '2099-01-01T01:00:00.000Z',
               '架空サービス', 'tentative', ?
        FROM rows
      `, SUITE_PURGE_AT);
    });
    const overflowDate = suiteDate(4);
    const overflowConfig = { ...config, date: overflowDate };
    const overflowDay = dayStub(overflowDate);
    expect(
      await overflowDay.createPublic(overflowConfig, createInput(overflowDate)),
    ).toMatchObject({ ok: true });
    await adapter.pokeDay({ date: overflowDate });
    expect(await adapter.diagnostics()).toMatchObject({
      projectionCount: 2000,
      counters: { "disposition:overflow": 1 },
    });

    const reconciled = await adapter.reconcileDay({
      ok: true,
      date: suiteDate(5),
      purgeAt: SUITE_PURGE_AT,
      watermark: { generation: config.calendarAdapter?.generation ?? 1, seq: 0 },
      events: [
        {
          reservationId: "00000000-0000-4000-8000-999999999999",
          stampAt: "2026-08-13T00:00:00.000Z",
          startTime: "09:00",
          endTime: "10:00",
          serviceLabel: "架空カット",
          status: "pending",
        },
      ],
    });
    expect(reconciled).toMatchObject({ projected: 0 });
    expect(await adapter.diagnostics()).toMatchObject({
      projectionCount: 2000,
      counters: { "disposition:overflow": 2 },
    });
  });

  it("prunes expired local calendar state during normal feed operation", async () => {
    const config = await configFor(suiteDate(6));
    const adapter = adapterStub();
    expect(
      await dayStub(config.date).createPublic(config, createInput(config.date)),
    ).toMatchObject({ ok: true });
    await adapter.pokeDay({ date: config.date });
    const authoritative = await dayStub(config.date).calendarProjection(config);
    expect(authoritative).toMatchObject({ ok: true });
    await adapter.reconcileDay(authoritative);
    await runInDurableObject(adapter, (_instance, state) => {
      state.storage.sql.exec("UPDATE accepted_events SET purge_at = ?", SUITE_NOW);
      state.storage.sql.exec("UPDATE projections SET purge_at = ?", SUITE_NOW);
      state.storage.sql.exec("UPDATE google_mutations SET purge_at = ?", SUITE_NOW);
      state.storage.sql.exec("UPDATE projection_watermarks SET purge_at = ?", SUITE_NOW);
      state.storage.sql.exec(
        "INSERT INTO ledger (reason, operation, http_status, occurred_at) VALUES ('old', 'lifecycle', NULL, ?)",
        new Date(SUITE_NOW - ADAPTER.LEDGER_TTL_S * 1_000 - 1).toISOString(),
      );
    });

    const feed = await adapter.feed({ token: feedToken });
    expect(feed).toMatchObject({ ok: true });
    if (!feed.ok) throw new Error("feed fixture failed");
    expect(feed.body).not.toContain("BEGIN:VEVENT");
    expect(await adapter.diagnostics()).toMatchObject({
      projectionCount: 0,
      pendingCount: 0,
      counters: { retention_cleanup_unresolved: 1 },
      ledger: [
        { reason: "past-retention", operation: "delete" },
        { reason: "past-retention", operation: "upsert" },
      ],
    });
    const retained = await runInDurableObject(adapter, (_instance, state) => ({
      accepted: state.storage.sql
        .exec<{ n: number }>("SELECT COUNT(*) AS n FROM accepted_events")
        .one().n,
      watermarks: state.storage.sql
        .exec<{ n: number }>("SELECT COUNT(*) AS n FROM projection_watermarks")
        .one().n,
    }));
    expect(retained).toEqual({ accepted: 0, watermarks: 0 });
  });

  it("deletes Google events before pruning retained projections", async () => {
    const calendarMethods: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init = {}) => {
        if (String(input) === "https://oauth2.googleapis.com/token") {
          return mockGoogleAuthSuccess();
        }
        calendarMethods.push(init.method ?? "GET");
        return new Response(null, { status: 200 });
      }),
    );
    const config = await configFor(suiteDate(6));
    const adapter = adapterStub();
    expect(
      await dayStub(config.date).createPublic(config, createInput(config.date)),
    ).toMatchObject({ ok: true });
    await adapter.pokeDay({ date: config.date });
    await runDurableObjectAlarm(adapter);
    expect(calendarMethods).toEqual(["PUT"]);

    const purgeAt = SUITE_NOW + ADAPTER.HANDOFF_TERMINAL_LEAD_S * 1_000;
    await runInDurableObject(adapter, (_instance, state) => {
      state.storage.sql.exec("UPDATE accepted_events SET purge_at = ?", purgeAt);
      state.storage.sql.exec("UPDATE projections SET purge_at = ?", purgeAt);
      state.storage.sql.exec("UPDATE projection_watermarks SET purge_at = ?", purgeAt);
    });
    await runDurableObjectAlarm(adapter);

    expect(calendarMethods).toEqual(["PUT", "DELETE"]);
    const beforePurge = await adapter.feed({ token: feedToken });
    expect(beforePurge.ok && beforePurge.body).toContain("BEGIN:VEVENT");
    expect(await adapter.diagnostics()).toMatchObject({
      projectionCount: 1,
      pendingCount: 0,
    });

    let googleSecret = JSON.stringify(credentials);
    await runInDurableObject(adapter, (instance) => {
      Object.defineProperty(
        (instance as unknown as { env: Env }).env,
        "GOOGLE_CALENDAR_CREDENTIALS",
        {
          configurable: true,
          get: () => googleSecret,
        },
      );
    });
    googleSecret = JSON.stringify({
      ...credentials,
      refreshToken: "fixture-refresh-token-after-cleanup",
    });
    await runDurableObjectAlarm(adapter);
    expect(calendarMethods).toEqual(["PUT", "DELETE"]);

    vi.setSystemTime(purgeAt);
    const afterPurge = await adapter.feed({ token: feedToken });
    expect(afterPurge.ok && afterPurge.body).not.toContain("BEGIN:VEVENT");
    expect(await adapter.diagnostics()).toMatchObject({
      projectionCount: 0,
      pendingCount: 0,
      counters: expect.not.objectContaining({ retention_cleanup_unresolved: expect.anything() }),
    });
  });

  it("preserves live dedup evidence and leaves new adapter work pending at the cap", async () => {
    const config = await configFor(suiteDate(7));
    const adapter = adapterStub();
    const day = dayStub(config.date);
    await fillGoogleMutationQueue({ status: "awaiting-configuration" });

    const created = await day.createPublic(config, createInput(config.date));
    expect(created).toMatchObject({ ok: true });
    if (!created.ok) throw new Error("fixture create failed");
    await adapter.pokeDay({ date: config.date });

    await runInDurableObject(adapter, (_instance, state) => {
      state.storage.sql.exec(
        `WITH RECURSIVE rows(value) AS (
           VALUES(1) UNION ALL SELECT value + 1 FROM rows WHERE value < ?
         )
         INSERT INTO accepted_events
           (event_key, reservation_id, generation, seq, accepted_at, purge_at)
         SELECT printf('seed:%d', value),
                printf('20000000-0000-4000-8000-%012d', value), 1, 1,
                '2020-01-01T00:00:00.000Z', ? FROM rows`,
        ADAPTER.WEBHOOK_DEDUP_CAP - 1,
        SUITE_PURGE_AT,
      );
    });
    await runInDurableObject(day, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO __adapter_outbox
           (consumer, generation, seq, event_id, reservation_id, type, start_time, end_time,
            service_label, reservation_status, occurred_at, purge_at)
         VALUES ('calendar', 1, 1, ?, ?, 'create', '09:00', '10:00',
                 '架空カット', 'pending', ?, ?)`,
        `${config.date}#1`,
        created.reservationId,
        new Date().toISOString(),
        config.purgeAt,
      );
    });
    await expect(adapter.pokeDay({ date: config.date })).resolves.toEqual({
      ok: true,
      drained: 0,
    });
    await expect(day.drainOutbox({ consumer: "calendar" })).resolves.toEqual({
      events: [],
      more: false,
    });

    await runInDurableObject(day, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO __adapter_outbox
           (consumer, generation, seq, event_id, reservation_id, type, start_time, end_time,
            service_label, reservation_status, occurred_at, purge_at)
         VALUES ('calendar', 1, 2, ?, '00000000-0000-4000-8000-999999999999',
                 'create', '11:00', '12:00', '架空カラー', 'pending', ?, ?)`,
        `${config.date}#2`,
        new Date().toISOString(),
        config.purgeAt,
      );
      state.storage.sql.exec(
        "UPDATE __adapter_meta SET event_seq = 2 WHERE consumer = 'calendar' AND generation = 1",
      );
    });
    await expect(adapter.pokeDay({ date: config.date })).resolves.toEqual({
      ok: true,
      drained: 0,
    });
    await expect(day.drainOutbox({ consumer: "calendar" })).resolves.toMatchObject({
      events: [{ eventId: `${config.date}#2` }],
      more: false,
    });

    const counts = await runInDurableObject(adapter, (_instance, state) => ({
      accepted: state.storage.sql
        .exec<{ n: number }>("SELECT COUNT(*) AS n FROM accepted_events")
        .one().n,
      mutations: state.storage.sql
        .exec<{ n: number }>("SELECT COUNT(*) AS n FROM google_mutations")
        .one().n,
      projections: state.storage.sql
        .exec<{ n: number }>("SELECT COUNT(*) AS n FROM projections")
        .one().n,
    }));
    expect(counts).toEqual({
      accepted: ADAPTER.WEBHOOK_DEDUP_CAP,
      mutations: CALENDAR_ROW_CAP,
      projections: 1,
    });
    expect(await adapter.diagnostics()).toMatchObject({
      projectionCount: 1,
      counters: { accepted_overflow: 1, mutation_overflow: 1 },
      ledger: expect.arrayContaining([
        expect.objectContaining({ reason: "overflow", operation: "accept" }),
        expect.objectContaining({ reason: "overflow", operation: "upsert" }),
      ]),
    });
  });

  it("reclaims a failed upsert for newer Google work at capacity", async () => {
    const config = await configFor(suiteDate(21));
    const adapter = adapterStub();
    const day = dayStub(config.date);
    await fillGoogleMutationQueue();

    const created = await day.createOwner(config, createInput(config.date));
    expect(created).toMatchObject({ ok: true, status: "approved" });
    if (!created.ok) throw new Error("fixture create failed");
    await expect(adapter.pokeDay({ date: config.date })).resolves.toMatchObject({ ok: true });
    expect(
      await runInDurableObject(adapter, (_instance, state) => ({
        total: state.storage.sql
          .exec<{ n: number }>("SELECT COUNT(*) AS n FROM google_mutations")
          .one().n,
        operation: state.storage.sql
          .exec<{ operation: string }>(
            "SELECT operation FROM google_mutations WHERE reservation_id = ?",
            created.reservationId,
          )
          .one().operation,
      })),
    ).toEqual({ total: CALENDAR_ROW_CAP, operation: "upsert" });
    expect(await adapter.diagnostics()).toMatchObject({
      failedCount: CALENDAR_ROW_CAP - 1,
    });
  });

  it("removes the ICS projection while its Google delete waits for capacity", async () => {
    const config = await configFor(suiteDate(22));
    const adapter = adapterStub();
    const day = dayStub(config.date);
    const created = await day.createOwner(config, createInput(config.date));
    expect(created).toMatchObject({ ok: true, status: "approved" });
    if (!created.ok) throw new Error("fixture create failed");
    await adapter.pokeDay({ date: config.date });

    await runInDurableObject(adapter, (_instance, state) => {
      state.storage.sql.exec(
        "DELETE FROM google_mutations WHERE reservation_id = ?",
        created.reservationId,
      );
    });
    await runInDurableObject(day, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO __adapter_outbox
           (consumer, generation, seq, event_id, reservation_id, type, start_time, end_time,
            service_label, reservation_status, occurred_at, purge_at)
         VALUES ('calendar', 1, 2, ?, ?, 'cancel', '09:00', '10:00',
                 '架空カット', 'cancelled', ?, ?)`,
        `${config.date}#2`,
        created.reservationId,
        new Date().toISOString(),
        config.purgeAt,
      );
      state.storage.sql.exec(
        "UPDATE __adapter_meta SET event_seq = 2 WHERE consumer = 'calendar' AND generation = 1",
      );
    });
    await fillGoogleMutationQueue({
      operation: "delete",
      status: "awaiting-configuration",
    });

    await expect(adapter.pokeDay({ date: config.date })).resolves.toEqual({
      ok: true,
      drained: 0,
    });
    expect(
      await runInDurableObject(adapter, (_instance, state) => ({
        projection: state.storage.sql
          .exec<{ n: number }>(
            "SELECT COUNT(*) AS n FROM projections WHERE reservation_id = ?",
            created.reservationId,
          )
          .one().n,
        mutation: state.storage.sql
          .exec<{ n: number }>(
            "SELECT COUNT(*) AS n FROM google_mutations WHERE reservation_id = ?",
            created.reservationId,
          )
          .one().n,
      })),
    ).toEqual({ projection: 0, mutation: 0 });
    await expect(day.drainOutbox({ consumer: "calendar" })).resolves.toMatchObject({
      events: [{ reservationId: created.reservationId, reservationStatus: "cancelled" }],
    });
    await runInDurableObject(adapter, (_instance, state) => {
      state.storage.sql.exec(
        `DELETE FROM google_mutations WHERE reservation_id = (
           SELECT reservation_id FROM google_mutations ORDER BY reservation_id LIMIT 1
         )`,
      );
    });
    await expect(adapter.pokeDay({ date: config.date })).resolves.toEqual({
      ok: true,
      drained: 1,
    });
    expect(
      await runInDurableObject(adapter, (_instance, state) => ({
        projection: state.storage.sql
          .exec<{ n: number }>(
            "SELECT COUNT(*) AS n FROM projections WHERE reservation_id = ?",
            created.reservationId,
          )
          .one().n,
        mutation: state.storage.sql
          .exec<{ operation: string }>(
            "SELECT operation FROM google_mutations WHERE reservation_id = ?",
            created.reservationId,
          )
          .toArray()[0]?.operation ?? null,
      })),
    ).toEqual({ projection: 0, mutation: "delete" });
    await expect(day.drainOutbox({ consumer: "calendar" })).resolves.toEqual({
      events: [],
      more: false,
    });
  });

  it("defers a whole reconciliation date until every required delete fits", async () => {
    const config = await configFor(suiteDate(23));
    const adapter = adapterStub();
    const day = dayStub(config.date);
    const removed = await day.createOwner(config, createInput(config.date));
    const retained = await day.createOwner(config, createInput(config.date, "11:00"));
    expect(removed).toMatchObject({ ok: true, status: "approved" });
    expect(retained).toMatchObject({ ok: true, status: "approved" });
    if (!removed.ok || !retained.ok) throw new Error("fixture create failed");
    await adapter.pokeDay({ date: config.date });
    const authoritative = await day.calendarProjection(config);
    expect(authoritative).toMatchObject({ ok: true, events: expect.any(Array) });
    if (!authoritative.ok) throw new Error("fixture projection failed");
    const retainedEvent = authoritative.events.find(
      ({ reservationId }) => reservationId === retained.reservationId,
    );
    if (retainedEvent === undefined) throw new Error("fixture retained event missing");
    const replacement = {
      ...authoritative,
      events: [{ ...retainedEvent, serviceLabel: "架空の変更後サービス" }],
    };
    await runInDurableObject(adapter, (_instance, state) => {
      state.storage.sql.exec(
        "DELETE FROM google_mutations WHERE reservation_id IN (?, ?)",
        removed.reservationId,
        retained.reservationId,
      );
    });
    await fillGoogleMutationQueue({
      operation: "delete",
      status: "awaiting-configuration",
    });

    await expect(adapter.reconcileDay(replacement)).resolves.toEqual({
      ok: true,
      projected: 0,
      removed: 0,
      deferred: true,
    });
    expect(
      await runInDurableObject(adapter, (_instance, state) => ({
        removed: state.storage.sql
          .exec<{ n: number }>(
            "SELECT COUNT(*) AS n FROM projections WHERE reservation_id = ?",
            removed.reservationId,
          )
          .one().n,
        retained: state.storage.sql
          .exec<{ service_label: string }>(
            "SELECT service_label FROM projections WHERE reservation_id = ?",
            retained.reservationId,
          )
          .one().service_label,
      })),
    ).toEqual({ removed: 1, retained: "架空カット" });

    await runInDurableObject(adapter, (_instance, state) => {
      state.storage.sql.exec(
        `DELETE FROM google_mutations WHERE reservation_id IN (
           SELECT reservation_id FROM google_mutations ORDER BY reservation_id LIMIT 2
         )`,
      );
    });
    await expect(adapter.reconcileDay(replacement)).resolves.toEqual({
      ok: true,
      projected: 1,
      removed: 1,
    });
    expect(
      await runInDurableObject(adapter, (_instance, state) => ({
        removed: state.storage.sql
          .exec<{ operation: string }>(
            "SELECT operation FROM google_mutations WHERE reservation_id = ?",
            removed.reservationId,
          )
          .one().operation,
        retained: state.storage.sql
          .exec<{ operation: string }>(
            "SELECT operation FROM google_mutations WHERE reservation_id = ?",
            retained.reservationId,
          )
          .one().operation,
      })),
    ).toEqual({ removed: "delete", retained: "upsert" });
  });

  it("defers a whole reconciliation date when a required upsert cannot fit", async () => {
    const config = await configFor(suiteDate(23));
    const adapter = adapterStub();
    const day = dayStub(config.date);
    const created = await day.createOwner(config, createInput(config.date));
    expect(created).toMatchObject({ ok: true, status: "approved" });
    if (!created.ok) throw new Error("fixture create failed");
    await adapter.pokeDay({ date: config.date });
    const authoritative = await day.calendarProjection(config);
    if (!authoritative.ok) throw new Error("fixture projection failed");
    const replacement = {
      ...authoritative,
      watermark: { ...authoritative.watermark, seq: authoritative.watermark.seq + 1 },
      events: authoritative.events.map((event) => ({
        ...event,
        serviceLabel: "架空の変更後サービス",
      })),
    };
    await runInDurableObject(adapter, (_instance, state) => {
      state.storage.sql.exec(
        "DELETE FROM google_mutations WHERE reservation_id = ?",
        created.reservationId,
      );
    });
    await fillGoogleMutationQueue({
      operation: "delete",
      status: "awaiting-configuration",
    });

    await expect(adapter.reconcileDay(replacement)).resolves.toEqual({
      ok: true,
      projected: 0,
      removed: 0,
      deferred: true,
    });
    expect(
      await runInDurableObject(adapter, (_instance, state) => ({
        label: state.storage.sql
          .exec<{ service_label: string }>(
            "SELECT service_label FROM projections WHERE reservation_id = ?",
            created.reservationId,
          )
          .one().service_label,
        watermark: state.storage.sql
          .exec<{ seq: number }>(
            "SELECT seq FROM projection_watermarks WHERE date = ?",
            config.date,
          )
          .one().seq,
      })),
    ).toEqual({ label: "架空カット", watermark: authoritative.watermark.seq });

    await runInDurableObject(adapter, (_instance, state) => {
      state.storage.sql.exec(
        `DELETE FROM google_mutations WHERE reservation_id = (
           SELECT reservation_id FROM google_mutations ORDER BY reservation_id LIMIT 1
         )`,
      );
    });
    await expect(adapter.reconcileDay(replacement)).resolves.toEqual({
      ok: true,
      projected: 1,
      removed: 0,
    });
    expect(
      await runInDurableObject(adapter, (_instance, state) =>
        state.storage.sql
          .exec<{ operation: string }>(
            "SELECT operation FROM google_mutations WHERE reservation_id = ?",
            created.reservationId,
          )
          .one().operation,
      ),
    ).toBe("upsert");
  });

  it("reclaims failed upserts for required Google deletes", async () => {
    const config = await configFor(suiteDate(24));
    const adapter = adapterStub();
    const day = dayStub(config.date);
    const created = await day.createOwner(config, createInput(config.date));
    expect(created).toMatchObject({ ok: true, status: "approved" });
    if (!created.ok) throw new Error("fixture create failed");
    await adapter.pokeDay({ date: config.date });
    await runInDurableObject(adapter, (_instance, state) => {
      state.storage.sql.exec(
        "DELETE FROM google_mutations WHERE reservation_id = ?",
        created.reservationId,
      );
    });
    await fillGoogleMutationQueue();

    await expect(
      adapter.reconcileDay({
        ok: true,
        date: config.date,
        purgeAt: config.purgeAt,
        watermark: { generation: 1, seq: 2 },
        events: [],
      }),
    ).resolves.toEqual({ ok: true, projected: 0, removed: 1 });
    expect(
      await runInDurableObject(adapter, (_instance, state) => ({
        total: state.storage.sql
          .exec<{ n: number }>("SELECT COUNT(*) AS n FROM google_mutations")
          .one().n,
        operation: state.storage.sql
          .exec<{ operation: string }>(
            "SELECT operation FROM google_mutations WHERE reservation_id = ?",
            created.reservationId,
          )
          .one().operation,
      })),
    ).toEqual({ total: CALENDAR_ROW_CAP, operation: "delete" });
    expect(await adapter.diagnostics()).toMatchObject({
      projectionCount: 0,
      failedCount: CALENDAR_ROW_CAP - 1,
    });
  });

  it("converges create, update, and delete on one stable Google event", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    let updateCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init = {}) => {
        const url = String(input);
        calls.push({ url, init });
        if (url === "https://oauth2.googleapis.com/token") {
          return mockGoogleAuthSuccess();
        }
        if (init.method === "PUT") {
          updateCalls += 1;
          return new Response(null, { status: updateCalls === 1 ? 404 : 200 });
        }
        if (init.method === "POST") return new Response(null, { status: 200 });
        if (init.method === "DELETE") return new Response(null, { status: 410 });
        throw new Error(`unexpected Google request: ${init.method} ${url}`);
      }),
    );

    const config = await configFor(suiteDate(5));
    const day = dayStub(config.date);
    const created = await day.createPublic(config, createInput(config.date));
    if (!created.ok) throw new Error("fixture create failed");
    await adapterStub().pokeDay({ date: config.date });
    await runDurableObjectAlarm(adapterStub());

    expect(calls.map(({ init }) => init.method)).toEqual(["POST", "PUT", "POST"]);
    const update = calls[1] as { url: string; init: RequestInit };
    const insert = calls[2] as { url: string; init: RequestInit };
    expect(update.url).toMatch(
      /^https:\/\/www\.googleapis\.com\/calendar\/v3\/calendars\/fixture%2Bcalendar%40example\.invalid\/events\/sr[a-f0-9]{64}\?sendUpdates=none$/,
    );
    expect(insert.url).toBe(
      "https://www.googleapis.com/calendar/v3/calendars/fixture%2Bcalendar%40example.invalid/events?sendUpdates=none",
    );
    expect(update.init).toMatchObject({ method: "PUT", redirect: "manual" });
    expect(insert.init).toMatchObject({ method: "POST", redirect: "manual" });
    const updateBody = JSON.parse(String(update.init.body)) as Record<string, unknown>;
    const insertBody = JSON.parse(String(insert.init.body)) as Record<string, unknown>;
    expect(updateBody).not.toHaveProperty("id");
    expect(insertBody.id).toMatch(/^sr[a-f0-9]{64}$/);
    expect(JSON.stringify(insertBody)).not.toContain(created.reservationId);

    expect(
      await day.transitionOwner(config, {
        commandId: crypto.randomUUID(),
        date: config.date,
        reservationId: created.reservationId,
        action: "approve",
      }),
    ).toMatchObject({ ok: true });
    await adapterStub().pokeDay({ date: config.date });
    await runDurableObjectAlarm(adapterStub());
    expect(calls.at(-1)?.init.method).toBe("PUT");

    expect(
      await day.transitionOwner(config, {
        commandId: crypto.randomUUID(),
        date: config.date,
        reservationId: created.reservationId,
        action: "cancel",
      }),
    ).toMatchObject({ ok: true });
    await adapterStub().pokeDay({ date: config.date });
    await runDurableObjectAlarm(adapterStub());
    expect(calls.at(-1)?.init.method).toBe("DELETE");
    expect(calls.filter(({ url }) => url === "https://oauth2.googleapis.com/token")).toHaveLength(1);
    expect(await adapterStub().diagnostics()).toMatchObject({ pendingCount: 0, failedCount: 0 });
  });

  it("retries an uncertain insert as update and handles insert 409 without duplication", async () => {
    let calendarCall = 0;
    const methods: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init = {}) => {
        if (String(input) === "https://oauth2.googleapis.com/token") {
          return mockGoogleAuthSuccess();
        }
        methods.push(String(init.method));
        calendarCall += 1;
        if (calendarCall === 1) return new Response(null, { status: 404 });
        if (calendarCall === 2) throw new TypeError("response lost");
        return new Response(null, { status: 200 });
      }),
    );
    const config = await configFor(suiteDate(6));
    const created = await dayStub(config.date).createPublic(config, createInput(config.date));
    expect(created).toMatchObject({ ok: true });
    await adapterStub().pokeDay({ date: config.date });
    await runDurableObjectAlarm(adapterStub());
    expect(methods).toEqual(["PUT", "POST"]);
    expect(await adapterStub().diagnostics()).toMatchObject({ pendingCount: 1 });

    vi.setSystemTime(SUITE_NOW + 60_000);
    await runDurableObjectAlarm(adapterStub());
    expect(methods).toEqual(["PUT", "POST", "PUT"]);
    expect(await adapterStub().diagnostics()).toMatchObject({ pendingCount: 0 });

    await reset();
    clearGoogleTokenCacheForTests();
    vi.setSystemTime(SUITE_NOW);
    calendarCall = 0;
    methods.length = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init = {}) => {
        if (String(input) === "https://oauth2.googleapis.com/token") {
          return mockGoogleAuthSuccess();
        }
        methods.push(String(init.method));
        calendarCall += 1;
        return new Response(null, {
          status: calendarCall === 1 ? 404 : calendarCall === 2 ? 409 : 200,
        });
      }),
    );
    const secondConfig = await configFor(suiteDate(7));
    expect(
      await dayStub(secondConfig.date).createPublic(secondConfig, createInput(secondConfig.date)),
    ).toMatchObject({ ok: true });
    await adapterStub().pokeDay({ date: secondConfig.date });
    await runDurableObjectAlarm(adapterStub());
    expect(methods).toEqual(["PUT", "POST", "PUT"]);
    expect(await adapterStub().diagnostics()).toMatchObject({ pendingCount: 0 });
  });

  it.each([404, 410])("treats delete %s as reconciled absence", async (deleteStatus) => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init = {}) => {
        if (String(input) === "https://oauth2.googleapis.com/token") {
          return mockGoogleAuthSuccess();
        }
        return new Response(null, {
          status: init.method === "DELETE" ? deleteStatus : 200,
        });
      }),
    );
    const config = await configFor(suiteDate(14));
    const day = dayStub(config.date);
    const created = await day.createOwner(config, createInput(config.date));
    expect(created).toMatchObject({ ok: true, status: "approved" });
    if (!created.ok) throw new Error("fixture create failed");
    await adapterStub().pokeDay({ date: config.date });
    await runDurableObjectAlarm(adapterStub());
    expect(
      await day.transitionOwner(config, {
        commandId: crypto.randomUUID(),
        date: config.date,
        reservationId: created.reservationId,
        action: "cancel",
      }),
    ).toMatchObject({ ok: true });
    await adapterStub().pokeDay({ date: config.date });
    await runDurableObjectAlarm(adapterStub());
    expect(await adapterStub().diagnostics()).toMatchObject({ pendingCount: 0, failedCount: 0 });
  });

  it("requeues a retained failed delete during reconciliation", async () => {
    const methods: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init = {}) => {
        if (String(input) === "https://oauth2.googleapis.com/token") {
          return mockGoogleAuthSuccess();
        }
        methods.push(String(init.method));
        return new Response(null, { status: 204 });
      }),
    );
    const config = await configFor(suiteDate(21));
    const day = dayStub(config.date);
    const created = await day.createOwner(config, createInput(config.date));
    expect(created).toMatchObject({ ok: true, status: "approved" });
    if (!created.ok) throw new Error("fixture create failed");
    await adapterStub().pokeDay({ date: config.date });
    expect(
      await day.transitionOwner(config, {
        commandId: crypto.randomUUID(),
        date: config.date,
        reservationId: created.reservationId,
        action: "cancel",
      }),
    ).toMatchObject({ ok: true });
    await adapterStub().pokeDay({ date: config.date });
    const authoritative = await day.calendarProjection(config);
    expect(authoritative).toMatchObject({ ok: true, events: [] });

    for (const status of ["failed", "awaiting-configuration"] as const) {
      const before = await runInDurableObject(adapterStub(), (_instance, state) => {
        state.storage.sql.exec(
          `UPDATE google_mutations SET status = ?, attempt = 7, next_attempt_at = NULL
           WHERE reservation_id = ?`,
          status,
          created.reservationId,
        );
        return state.storage.sql
          .exec<{ desired_version: number }>(
            "SELECT desired_version FROM google_mutations WHERE reservation_id = ?",
            created.reservationId,
          )
          .one().desired_version;
      });
      await adapterStub().reconcileDay(authoritative);
      await adapterStub().finishReconcile({ nextCursor: null });
      await expect(
        runInDurableObject(adapterStub(), (_instance, state) =>
          state.storage.sql
            .exec<{ attempt: number; desired_version: number; status: string }>(
              `SELECT attempt, desired_version, status FROM google_mutations
               WHERE reservation_id = ?`,
              created.reservationId,
            )
            .one(),
        ),
      ).resolves.toEqual({ attempt: 0, desired_version: before + 1, status: "queued" });
    }

    await runDurableObjectAlarm(adapterStub());
    expect(methods).toEqual(["DELETE"]);
    expect(await adapterStub().diagnostics()).toMatchObject({ pendingCount: 0, failedCount: 0 });
  });

  it.each([
    [429, null, "queued", "retry"],
    [503, null, "queued", "retry"],
    [403, { error: { errors: [{ reason: "rateLimitExceeded" }] } }, "queued", "retry"],
    [403, { error: { errors: [{ reason: "forbidden" }] } }, "awaiting-configuration", "configuration"],
    [400, { error: { errors: [{ reason: "invalid" }] } }, "failed", "permanent"],
  ] as const)(
    "classifies Google status %s as %s state",
    async (status, responseBody, expectedState, expectedCounter) => {
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(async (input, init = {}) => {
          if (String(input) === "https://oauth2.googleapis.com/token") {
            return mockGoogleAuthSuccess();
          }
          if (init.method === "PUT") {
            return responseBody === null
              ? new Response(null, { status })
              : Response.json(responseBody, { status });
          }
          throw new Error("unexpected request");
        }),
      );
      const config = await configFor(suiteDate(8));
      expect(
        await dayStub(config.date).createPublic(config, createInput(config.date)),
      ).toMatchObject({ ok: true });
      await adapterStub().pokeDay({ date: config.date });
      await runDurableObjectAlarm(adapterStub());
      const state = await runInDurableObject(adapterStub(), (_instance, durableState) =>
        durableState.storage.sql
          .exec<{ status: string }>("SELECT status FROM google_mutations")
          .one().status,
      );
      expect(state).toBe(expectedState);
      expect(await adapterStub().diagnostics()).toMatchObject({
        counters: { [`delivery:${expectedCounter}`]: 1 },
      });
    },
  );

  it("parks the whole queue after shared token rejection until credentials rotate", async () => {
    let authorized = false;
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      if (String(input) === "https://oauth2.googleapis.com/token") {
        return authorized
          ? mockGoogleAuthSuccess()
          : Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      return new Response(null, { status: 200 });
    });
    vi.stubGlobal("fetch", fetcher);
    const config = await configFor(suiteDate(9));
    for (const startTime of ["09:00", "11:00"]) {
      expect(
        await dayStub(config.date).createPublic(config, createInput(config.date, startTime)),
      ).toMatchObject({ ok: true });
    }
    await adapterStub().pokeDay({ date: config.date });
    await runDurableObjectAlarm(adapterStub());
    expect(fetcher).toHaveBeenCalledOnce();
    expect(await adapterStub().diagnostics()).toMatchObject({ pendingCount: 2 });
    const states = await runInDurableObject(adapterStub(), (_instance, durableState) =>
      durableState.storage.sql
        .exec<{ status: string }>("SELECT status FROM google_mutations")
        .toArray()
        .map(({ status }) => status),
    );
    expect(states).toEqual(["awaiting-configuration", "awaiting-configuration"]);
    expect(await adapterStub().diagnostics()).toMatchObject({
      counters: { "delivery:configuration": 1 },
    });
    expect(
      await dayStub(config.date).createPublic(config, createInput(config.date, "12:00")),
    ).toMatchObject({ ok: true });
    await adapterStub().pokeDay({ date: config.date });
    expect(
      await runInDurableObject(adapterStub(), (_instance, durableState) =>
        durableState.storage.sql
          .exec<{ status: string }>("SELECT status FROM google_mutations")
          .toArray()
          .map(({ status }) => status),
      ),
    ).toEqual([
      "awaiting-configuration",
      "awaiting-configuration",
      "awaiting-configuration",
    ]);
    await runDurableObjectAlarm(adapterStub());
    expect(fetcher).toHaveBeenCalledOnce();

    let googleSecret = JSON.stringify(credentials);
    await runInDurableObject(adapterStub(), (instance) => {
      Object.defineProperty(
        (instance as unknown as { env: Env }).env,
        "GOOGLE_CALENDAR_CREDENTIALS",
        {
          configurable: true,
          get: () => googleSecret,
        },
      );
    });
    googleSecret = JSON.stringify({
      ...credentials,
      refreshToken: "fixture-refresh-token-rotated",
    });
    authorized = true;
    await runDurableObjectAlarm(adapterStub());
    expect(await adapterStub().diagnostics()).toMatchObject({ pendingCount: 0 });
    expect(fetcher).toHaveBeenCalledTimes(5);
  });

  it("stops the current batch after shared Calendar authorization rejection", async () => {
    let calendarCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input) => {
        if (String(input) === "https://oauth2.googleapis.com/token") {
          return mockGoogleAuthSuccess();
        }
        calendarCalls += 1;
        return Response.json(
          { error: { errors: [{ reason: "forbidden" }] } },
          { status: 403 },
        );
      }),
    );
    const config = await configFor(suiteDate(9));
    for (const startTime of ["09:00", "11:00"]) {
      expect(
        await dayStub(config.date).createPublic(config, createInput(config.date, startTime)),
      ).toMatchObject({ ok: true });
    }
    await adapterStub().pokeDay({ date: config.date });
    await runDurableObjectAlarm(adapterStub());

    expect(calendarCalls).toBe(1);
    expect(
      await runInDurableObject(adapterStub(), (_instance, state) =>
        state.storage.sql
          .exec<{ status: string }>("SELECT status FROM google_mutations")
          .toArray()
          .map(({ status }) => status),
      ),
    ).toEqual(["awaiting-configuration", "awaiting-configuration"]);
  });

  it("parks the queue when the target Google calendar is missing", async () => {
    const calendarMethods: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init = {}) => {
        if (String(input) === "https://oauth2.googleapis.com/token") {
          return mockGoogleAuthSuccess();
        }
        calendarMethods.push(init.method ?? "GET");
        return new Response(null, { status: 404 });
      }),
    );
    const config = await configFor(suiteDate(9));
    for (const startTime of ["09:00", "11:00"]) {
      expect(
        await dayStub(config.date).createPublic(config, createInput(config.date, startTime)),
      ).toMatchObject({ ok: true });
    }
    await adapterStub().pokeDay({ date: config.date });
    await runDurableObjectAlarm(adapterStub());

    expect(calendarMethods).toEqual(["PUT", "POST"]);
    expect(
      await runInDurableObject(adapterStub(), (_instance, state) =>
        state.storage.sql
          .exec<{ status: string }>("SELECT status FROM google_mutations")
          .toArray()
          .map(({ status }) => status),
      ),
    ).toEqual(["awaiting-configuration", "awaiting-configuration"]);
  });

  it("does not start a Google request after the caller crosses retention", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    vi.setSystemTime(SUITE_NOW + 2);

    for (const operation of ["upsert", "delete"] as const) {
      await expect(
        sendGoogleMutation(
          credentials,
          "fixture-access-token",
          operation,
          operation === "upsert" ? projection : null,
          projection.externalId,
          SUITE_NOW + 1,
        ),
      ).resolves.toEqual({ kind: "expired", status: null });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not start a fallback Google insert after retention", async () => {
    let allowUpdate!: (response: Response) => void;
    const updateResponse = new Promise<Response>((resolve) => {
      allowUpdate = resolve;
    });
    let calendarCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input) => {
        if (String(input) === "https://oauth2.googleapis.com/token") {
          return mockGoogleAuthSuccess();
        }
        calendarCalls += 1;
        return calendarCalls === 1 ? updateResponse : new Response(null, { status: 200 });
      }),
    );
    const config = await configFor(suiteDate(9));
    expect(await dayStub(config.date).createPublic(config, createInput(config.date))).toMatchObject({
      ok: true,
    });
    await adapterStub().pokeDay({ date: config.date });
    await runInDurableObject(adapterStub(), (_instance, state) => {
      state.storage.sql.exec("UPDATE google_mutations SET purge_at = ?", SUITE_NOW + 1);
    });

    let now = SUITE_NOW;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const alarm = runDurableObjectAlarm(adapterStub());
    await vi.waitFor(() => expect(calendarCalls).toBe(1));
    now = SUITE_NOW + 2;
    allowUpdate(new Response(null, { status: 404 }));
    await alarm;

    expect(calendarCalls).toBe(1);
    expect(await adapterStub().diagnostics()).toMatchObject({
      pendingCount: 0,
      ledger: expect.arrayContaining([
        expect.objectContaining({ reason: "past-retention", operation: "upsert" }),
      ]),
    });
  });

  it("bounds retry exhaustion and recovers an expired send claim", async () => {
    let calendarCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input) => {
        if (String(input) === "https://oauth2.googleapis.com/token") {
          return mockGoogleAuthSuccess(86_400);
        }
        calendarCalls += 1;
        return new Response(null, { status: 503 });
      }),
    );
    const config = await configFor(suiteDate(10));
    expect(
      await dayStub(config.date).createPublic(config, createInput(config.date)),
    ).toMatchObject({ ok: true });
    await adapterStub().pokeDay({ date: config.date });
    for (const offset of ADAPTER.RETRY_OFFSETS_S) {
      vi.setSystemTime(SUITE_NOW + offset * 1_000);
      await runDurableObjectAlarm(adapterStub());
    }
    expect(calendarCalls).toBe(ADAPTER.RETRY_OFFSETS_S.length);
    expect(await adapterStub().diagnostics()).toMatchObject({
      pendingCount: 0,
      failedCount: 1,
      counters: { "delivery:retry-exhausted": 1 },
      ledger: [{ reason: "retry-exhausted", operation: "upsert", httpStatus: 503 }],
    });

    await reset();
    clearGoogleTokenCacheForTests();
    vi.setSystemTime(SUITE_NOW);
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input) =>
        String(input) === "https://oauth2.googleapis.com/token"
          ? mockGoogleAuthSuccess()
          : new Response(null, { status: 200 }),
      ),
    );
    const recoveryConfig = await configFor(suiteDate(11));
    expect(
      await dayStub(recoveryConfig.date).createPublic(
        recoveryConfig,
        createInput(recoveryConfig.date),
      ),
    ).toMatchObject({ ok: true });
    await adapterStub().pokeDay({ date: recoveryConfig.date });
    await runInDurableObject(adapterStub(), (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE google_mutations SET status = 'sending', claimed_at = ?,
                claimed_version = desired_version`,
        SUITE_NOW - ADAPTER.SEND_CLAIM_LEASE_S * 1_000 - 1,
      );
    });
    await runDurableObjectAlarm(adapterStub());
    expect(await adapterStub().diagnostics()).toMatchObject({ pendingCount: 0, failedCount: 0 });
  });

  it("drops work at retention and ignores a stale in-flight success", async () => {
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    const expiredConfig = await configFor(suiteDate(12));
    expect(
      await dayStub(expiredConfig.date).createPublic(
        expiredConfig,
        createInput(expiredConfig.date),
      ),
    ).toMatchObject({ ok: true });
    await adapterStub().pokeDay({ date: expiredConfig.date });
    await runInDurableObject(adapterStub(), (_instance, state) => {
      state.storage.sql.exec("UPDATE google_mutations SET purge_at = ?", SUITE_NOW);
    });
    await runDurableObjectAlarm(adapterStub());
    expect(fetcher).not.toHaveBeenCalled();
    expect(await adapterStub().diagnostics()).toMatchObject({
      pendingCount: 0,
      ledger: [{ reason: "past-retention", operation: "upsert" }],
    });

    await reset();
    clearGoogleTokenCacheForTests();
    vi.setSystemTime(SUITE_NOW);
    let calendarCalls = 0;
    let allowCompletion!: (response: Response) => void;
    const firstResponse = new Promise<Response>((resolve) => {
      allowCompletion = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input) => {
        if (String(input) === "https://oauth2.googleapis.com/token") {
          return mockGoogleAuthSuccess();
        }
        calendarCalls += 1;
        if (calendarCalls === 1) return firstResponse;
        return new Response(null, { status: 503 });
      }),
    );
    const raceConfig = await configFor(suiteDate(13));
    const raceDay = dayStub(raceConfig.date);
    const created = await raceDay.createPublic(raceConfig, createInput(raceConfig.date));
    expect(created).toMatchObject({ ok: true });
    if (!created.ok) throw new Error("fixture create failed");
    await adapterStub().pokeDay({ date: raceConfig.date });
    const alarm = runDurableObjectAlarm(adapterStub());
    await vi.waitFor(() => expect(calendarCalls).toBe(1));
    expect(
      await raceDay.transitionOwner(raceConfig, {
        commandId: crypto.randomUUID(),
        date: raceConfig.date,
        reservationId: created.reservationId,
        action: "approve",
      }),
    ).toMatchObject({ ok: true, status: "approved" });
    await adapterStub().pokeDay({ date: raceConfig.date });
    allowCompletion(new Response(null, { status: 200 }));
    await alarm;
    const raced = await runInDurableObject(adapterStub(), (_instance, state) => {
      const row = state.storage.sql
        .exec<{ payload_json: string | null; status: string }>(
          "SELECT payload_json, status FROM google_mutations",
        )
        .one();
      return {
        status: row.status,
        payload: JSON.parse(row.payload_json ?? "null") as CalendarProjection,
      };
    });
    expect(raced).toMatchObject({ status: "queued", payload: { status: "confirmed" } });
  });

  it("refreshes retention time before every Google claim", async () => {
    let calendarCalls = 0;
    let allowFirst!: (response: Response) => void;
    const firstResponse = new Promise<Response>((resolve) => {
      allowFirst = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input) => {
        if (String(input) === "https://oauth2.googleapis.com/token") {
          return mockGoogleAuthSuccess();
        }
        calendarCalls += 1;
        return calendarCalls === 1 ? firstResponse : new Response(null, { status: 200 });
      }),
    );
    const config = await configFor(suiteDate(20));
    const day = dayStub(config.date);
    const first = await day.createOwner(config, createInput(config.date));
    const second = await day.createOwner(config, createInput(config.date, "11:00"));
    expect(first).toMatchObject({ ok: true, status: "approved" });
    expect(second).toMatchObject({ ok: true, status: "approved" });
    if (!first.ok || !second.ok) throw new Error("fixture create failed");
    await adapterStub().pokeDay({ date: config.date });
    await runInDurableObject(adapterStub(), (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE google_mutations SET created_at = ?, next_attempt_at = ?, purge_at = ?
         WHERE reservation_id = ?`,
        "2020-01-01T00:00:00.000Z",
        SUITE_NOW,
        SUITE_PURGE_AT,
        first.reservationId,
      );
      state.storage.sql.exec(
        `UPDATE google_mutations SET created_at = ?, next_attempt_at = ?, purge_at = ?
         WHERE reservation_id = ?`,
        "2020-01-02T00:00:00.000Z",
        SUITE_NOW,
        SUITE_NOW + 1,
        second.reservationId,
      );
    });

    let now = SUITE_NOW;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const alarm = runDurableObjectAlarm(adapterStub());
    await vi.waitFor(() => expect(calendarCalls).toBe(1));
    now = SUITE_NOW + 2;
    allowFirst(new Response(null, { status: 200 }));
    await alarm;

    expect(calendarCalls).toBe(1);
    expect(await adapterStub().diagnostics()).toMatchObject({
      pendingCount: 0,
      ledger: expect.arrayContaining([
        expect.objectContaining({ reason: "past-retention", operation: "upsert" }),
      ]),
    });
  });

  it("bounds a stalled Calendar sweep RPC and retries the same day", async () => {
    const adapter = adapterStub();
    const reservationDays = env.RESERVATION_DAYS;
    const config = await configFor(suiteDate(25));
    await runInDurableObject(adapter, (_instance, state) => {
      state.storage.sql.exec("UPDATE meta SET sweep_cursor = ? WHERE singleton = 1", config.date);
    });
    try {
      let release!: (result: { events: []; more: false }) => void;
      const blocked = new Promise<{ events: []; more: false }>((resolve) => {
        release = resolve;
      });
      const released = new Promise<void>((resolve) => {
        setTimeout(() => {
          release({ events: [], more: false });
          resolve();
        }, ADAPTER.SWEEP_RPC_DEADLINE_MS + 100);
      });
      await runInDurableObject(adapter, (instance) => {
        Object.defineProperty((instance as unknown as { env: Env }).env, "RESERVATION_DAYS", {
          configurable: true,
          value: {
            getByName: (name: string) =>
              name === `single-location:${config.date}`
                ? { drainOutbox: () => blocked }
                : reservationDays.getByName(name),
          },
        });
      });

      await runDurableObjectAlarm(adapter);
      await released;
      expect(await adapter.diagnostics()).toMatchObject({
        state: "active",
        sweepCursor: config.date,
        counters: { sweep_faults: 1 },
      });
    } finally {
      await runInDurableObject(adapter, (instance) => {
        Object.defineProperty((instance as unknown as { env: Env }).env, "RESERVATION_DAYS", {
          configurable: true,
          value: reservationDays,
        });
      });
    }
  }, ADAPTER.SWEEP_RPC_DEADLINE_MS + 10_000);

  it("limits an active sweep to one drain round per batch slot", async () => {
    const adapter = adapterStub();
    const reservationDays = env.RESERVATION_DAYS;
    const config = await configFor(suiteDate(25));
    await runInDurableObject(adapter, (_instance, state) => {
      state.storage.sql.exec("UPDATE meta SET sweep_cursor = ? WHERE singleton = 1", config.date);
    });
    let drains = 0;
    await runInDurableObject(adapter, (instance) => {
      Object.defineProperty((instance as unknown as { env: Env }).env, "RESERVATION_DAYS", {
        configurable: true,
        value: {
          getByName: () => ({
            drainOutbox: async () => {
              drains += 1;
              return { events: [], more: true };
            },
          }),
        },
      });
    });

    try {
      await runDurableObjectAlarm(adapter);
      expect(drains).toBe(ADAPTER.SWEEP_DAY_BATCH);
      expect(await adapter.diagnostics()).toMatchObject({ sweepCursor: config.date });
    } finally {
      await runInDurableObject(adapter, (instance) => {
        Object.defineProperty((instance as unknown as { env: Env }).env, "RESERVATION_DAYS", {
          configurable: true,
          value: reservationDays,
        });
      });
    }
  });

  it("does not advance an active sweep after deactivation resets its cursor", async () => {
    const adapter = adapterStub();
    const reservationDays = env.RESERVATION_DAYS;
    let feedSecret: string | undefined = feedToken;
    await runInDurableObject(adapter, (instance) => {
      Object.defineProperties((instance as unknown as { env: Env }).env, {
        CALENDAR_FEED_TOKEN: {
          configurable: true,
          get: () => feedSecret,
        },
        GOOGLE_CALENDAR_CREDENTIALS: {
          configurable: true,
          value: undefined,
        },
      });
    });
    const descriptor = await adapter.descriptor();
    if (descriptor === null) throw new Error("calendar fixture did not activate");
    const date = suiteDate(26);
    await runInDurableObject(adapter, (_instance, state) => {
      state.storage.sql.exec("UPDATE meta SET sweep_cursor = ? WHERE singleton = 1", date);
    });

    let drainStarted = false;
    let release!: (result: { events: []; more: false }) => void;
    const blocked = new Promise<{ events: []; more: false }>((resolve) => {
      release = resolve;
    });
    await runInDurableObject(adapter, (instance) => {
      Object.defineProperty((instance as unknown as { env: Env }).env, "RESERVATION_DAYS", {
        configurable: true,
        value: {
          getByName: (name: string) =>
            name === `single-location:${date}`
              ? {
                  drainOutbox: () => {
                    drainStarted = true;
                    return blocked;
                  },
                }
              : reservationDays.getByName(name),
        },
      });
    });

    const alarm = runDurableObjectAlarm(adapter);
    await vi.waitFor(() => expect(drainStarted).toBe(true));
    feedSecret = undefined;
    await expect(adapter.descriptor()).resolves.toBeNull();
    release({ events: [], more: false });
    await alarm;

    expect(await adapter.diagnostics()).toMatchObject({
      state: "deactivating",
      generation: descriptor.generation,
      sweepCursor: null,
    });
  });

  it("preserves a reactivated generation while the final purge is in flight", async () => {
    const adapter = adapterStub();
    const reservationDays = env.RESERVATION_DAYS;
    const calendarNamespace = env.CALENDAR_ADAPTER;
    let feedSecret: string | undefined = feedToken;
    await runInDurableObject(adapter, (instance) => {
      Object.defineProperties((instance as unknown as { env: Env }).env, {
        CALENDAR_FEED_TOKEN: {
          configurable: true,
          get: () => feedSecret,
        },
        GOOGLE_CALENDAR_CREDENTIALS: {
          configurable: true,
          value: undefined,
        },
      });
    });
    const afterLease = SUITE_NOW + (ADAPTER.FINAL_PASS_LEASE_WAIT_S + 1) * 1_000;
    const finalDate = new Date(
      afterLease + 9 * 60 * 60 * 1_000 + ADAPTER.SWEEP_FUTURE_DAYS * 86_400_000,
    )
      .toISOString()
      .slice(0, 10);
    const config = await configFor(finalDate);
    const day = dayStub(config.date);
    const first = await day.createPublic(config, createInput(config.date));
    expect(first).toMatchObject({ ok: true });
    await adapter.pokeDay({ date: config.date });

    feedSecret = undefined;
    expect(await adapter.descriptor()).toBeNull();
    vi.setSystemTime(afterLease);
    await runInDurableObject(adapter, (_instance, state) => {
      state.storage.sql.exec("UPDATE meta SET sweep_cursor = ? WHERE singleton = 1", finalDate);
    });
    let allowPurge!: () => void;
    const purgeGate = new Promise<void>((resolve) => {
      allowPurge = resolve;
    });
    let purgeCalls = 0;
    await runInDurableObject(adapter, (instance) => {
      Object.defineProperty((instance as unknown as { env: Env }).env, "RESERVATION_DAYS", {
        configurable: true,
        value: {
          getByName: (name: string) => {
            const target = reservationDays.getByName(name) as DurableObjectStub<ReservationDay>;
            return {
              purgeConsumer: async (input: {
                consumer: "calendar";
                throughGeneration?: number;
              }) => {
                purgeCalls += 1;
                await purgeGate;
                return target.purgeConsumer(input);
              },
            };
          },
        },
      });
    });

    const alarm = runDurableObjectAlarm(adapter);
    await vi.waitFor(() => expect(purgeCalls).toBe(1));
    feedSecret = "B".repeat(43);
    const reactivated = await adapter.descriptor();
    expect(reactivated).toMatchObject({ generation: 2, phase: "active" });
    if (reactivated === null) throw new Error("fixture reactivation failed");
    await runInDurableObject(day, (instance) => {
      Object.defineProperty((instance as unknown as { env: Env }).env, "CALENDAR_ADAPTER", {
        configurable: true,
        value: { getByName: () => ({ pokeDay: async () => ({ ok: true, drained: 0 }) }) },
      });
    });
    const second = await day.createPublic(
      { ...config, calendarAdapter: reactivated },
      createInput(config.date, "11:00"),
    );
    expect(second).toMatchObject({ ok: true });
    if (!second.ok) throw new Error("fixture create failed");
    allowPurge();
    await alarm;

    expect(await adapter.diagnostics()).toMatchObject({
      state: "active",
      generation: 2,
      projectionCount: 1,
    });
    expect(await day.drainOutbox({ consumer: "calendar" })).toMatchObject({
      events: [{ generation: 2, reservationId: second.reservationId }],
    });
    await runInDurableObject(adapter, (instance) => {
      Object.defineProperty((instance as unknown as { env: Env }).env, "RESERVATION_DAYS", {
        configurable: true,
        value: reservationDays,
      });
    });
    await runInDurableObject(day, (instance) => {
      Object.defineProperty((instance as unknown as { env: Env }).env, "CALENDAR_ADAPTER", {
        configurable: true,
        value: calendarNamespace,
      });
    });
  });

  it("retries purge faults, disables after the lease, and re-enables above high-water", async () => {
    const adapter = adapterStub();
    const reservationDays = env.RESERVATION_DAYS;
    let feedSecret: string | undefined = feedToken;
    let googleSecret: string | undefined = JSON.stringify(credentials);
    const mutable = await runInDurableObject(adapter, (instance) => {
      const objectEnv = (instance as unknown as { env: Env }).env;
      try {
        Object.defineProperties(objectEnv, {
          CALENDAR_FEED_TOKEN: {
            configurable: true,
            get: () => feedSecret,
          },
          GOOGLE_CALENDAR_CREDENTIALS: {
            configurable: true,
            get: () => googleSecret,
          },
        });
        return true;
      } catch {
        return false;
      }
    });
    expect(mutable).toBe(true);

    const config = await configFor(suiteDate(15));
    expect(config.calendarAdapter).toMatchObject({ generation: 1, phase: "active" });
    const day = dayStub(config.date);
    const created = await day.createPublic(config, createInput(config.date));
    expect(created).toMatchObject({ ok: true });
    if (!created.ok) throw new Error("fixture create failed");
    await adapter.pokeDay({ date: config.date });
    expect(await adapter.diagnostics()).toMatchObject({
      state: "active",
      generation: 1,
      projectionCount: 1,
      pendingCount: 1,
    });

    googleSecret = JSON.stringify({
      ...credentials,
      refreshToken: "fixture-refresh-token-rotated",
    });
    expect(await adapter.descriptor()).toMatchObject({ generation: 1 });
    const rotated = await runInDurableObject(adapter, (_instance, state) =>
      state.storage.sql
        .exec<{ desired_version: number }>(
          "SELECT desired_version FROM google_mutations",
        )
        .one().desired_version,
    );
    expect(rotated).toBe(2);

    await runInDurableObject(adapter, (_instance, state) => {
      state.storage.sql.exec("UPDATE meta SET sweep_cursor = ? WHERE singleton = 1", config.date);
    });

    feedSecret = undefined;
    googleSecret = undefined;
    expect(await adapter.descriptor()).toBeNull();
    expect(await adapter.hasDisclosure()).toBe(true);
    expect(await adapter.diagnostics()).toMatchObject({
      state: "deactivating",
      generation: 1,
      sweepCursor: null,
    });

    // A request that received generation 1 before disable may still commit
    // during its 30-second lease; the post-lease sweep must remove that row.
    const leased = await day.createPublic(config, createInput(config.date, "11:00"));
    expect(leased).toMatchObject({ ok: true });
    if (!leased.ok) throw new Error("fixture create failed");
    const calendarRowsBefore = await runInDurableObject(day, (_instance, state) =>
      state.storage.sql
        .exec<{ n: number }>(
          "SELECT COUNT(*) AS n FROM __adapter_outbox WHERE consumer = 'calendar'",
        )
        .one().n,
    );
    expect(calendarRowsBefore).toBe(1);

    vi.setSystemTime(SUITE_NOW + (ADAPTER.FINAL_PASS_LEASE_WAIT_S + 1) * 1_000);
    await runInDurableObject(adapter, (_instance, state) => {
      state.storage.sql.exec("UPDATE meta SET sweep_cursor = ? WHERE singleton = 1", config.date);
    });
    await runInDurableObject(adapter, (instance) => {
      Object.defineProperty((instance as unknown as { env: Env }).env, "RESERVATION_DAYS", {
        configurable: true,
        value: {
          getByName: (name: string) =>
            name === `single-location:${config.date}`
              ? {
                  purgeConsumer: async () => {
                    throw new Error("fixture purge fault");
                  },
                }
              : reservationDays.getByName(name),
        },
      });
    });
    await runDurableObjectAlarm(adapter);
    expect(await adapter.diagnostics()).toMatchObject({
      state: "deactivating",
      sweepCursor: config.date,
      counters: { sweep_faults: 1 },
    });
    await runInDurableObject(adapter, (instance) => {
      Object.defineProperty((instance as unknown as { env: Env }).env, "RESERVATION_DAYS", {
        configurable: true,
        value: reservationDays,
      });
    });
    await runDurableObjectAlarm(adapter);
    expect(
      await runInDurableObject(day, (_instance, state) =>
        state.storage.sql
          .exec<{ n: number }>(
            "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name GLOB '__adapter*'",
          )
          .one().n,
      ),
    ).toBe(0);

    const finalDate = new Date(
      SUITE_NOW + (ADAPTER.FINAL_PASS_LEASE_WAIT_S + 1) * 1_000 +
        9 * 60 * 60 * 1_000 +
        ADAPTER.SWEEP_FUTURE_DAYS * 86_400_000,
    )
      .toISOString()
      .slice(0, 10);
    await runInDurableObject(adapter, (_instance, state) => {
      state.storage.sql.exec("UPDATE meta SET sweep_cursor = ? WHERE singleton = 1", finalDate);
    });
    await runDurableObjectAlarm(adapter);
    expect(await adapter.diagnostics()).toMatchObject({
      state: "disabled",
      generation: 1,
      projectionCount: 0,
      pendingCount: 0,
      failedCount: 0,
      counters: {},
      ledger: [],
    });
    expect(await adapter.hasDisclosure()).toBe(false);
    expect(
      await runInDurableObject(adapter, (_instance, state) => state.storage.getAlarm()),
    ).toBeNull();

    expect(
      await day.transitionOwner(
        {
          ...config,
          calendarAdapter: undefined,
          calendarRecovery: {
            leaseIssuedAt: SUITE_NOW,
            leaseNotAfter: SUITE_NOW + ADAPTER.DESCRIPTOR_LEASE_WINDOW_S * 1_000,
          },
        },
        {
          commandId: crypto.randomUUID(),
          date: config.date,
          reservationId: created.reservationId,
          action: "approve",
        },
      ),
    ).toMatchObject({ ok: true, status: "approved" });
    expect(
      await day.transitionOwner(config, {
        commandId: crypto.randomUUID(),
        date: config.date,
        reservationId: leased.reservationId,
        action: "approve",
      }),
    ).toMatchObject({ ok: true, status: "approved" });
    expect(
      await runInDurableObject(day, (_instance, state) =>
        state.storage.sql
          .exec<{ n: number }>(
            "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name GLOB '__adapter*'",
          )
          .one().n,
      ),
    ).toBe(0);

    feedSecret = "C".repeat(43);
    expect(await adapter.descriptor()).toMatchObject({ generation: 2, phase: "active" });
    expect(await adapter.diagnostics()).toMatchObject({ state: "active", generation: 2 });
  });
});
