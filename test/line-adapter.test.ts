import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ADAPTER, fullCycleBoundS, WORST_CASE_PARTITIONS } from "../src/adapter-constants.ts";
import {
  parseWebhookBody,
  verifyIdToken,
  verifyWebhookSignature,
  type LineFetch,
} from "../src/line-adapter.ts";
import worker from "../src/worker.ts";
import {
  createPendingReservation,
  deliveryStub,
  enableLineAdapter,
  identifiers,
  LINE_TEST_SECRET,
  lineDay,
  MANAGEMENT_KEY,
  signWebhookBody,
} from "./line-helpers.ts";

const NOW = Date.parse("2025-01-14T15:00:00.000Z");
const SUBJECT = `U${"a".repeat(32)}`;
const OTHER_SUBJECT = `U${"b".repeat(32)}`;

const encode = (value: string): Uint8Array => new TextEncoder().encode(value);

const verifyResponse = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });

const validClaims = (sub = SUBJECT) => ({
  iss: "https://access.line.me",
  sub,
  aud: identifiers.loginChannelId,
  exp: Math.floor(NOW / 1000) + 3600,
  iat: Math.floor(NOW / 1000),
});

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await reset();
});

describe("webhook signature verification", () => {
  const body = encode(JSON.stringify({ destination: "xxx", events: [] }));

  it("accepts exactly the HMAC of the raw bytes and rejects everything else", async () => {
    const valid = await signWebhookBody(LINE_TEST_SECRET, new TextDecoder().decode(body));
    expect(await verifyWebhookSignature(LINE_TEST_SECRET, valid, body)).toBe(true);
    expect(await verifyWebhookSignature("other-secret-0123456789abcdef000", valid, body)).toBe(
      false,
    );
    expect(
      await verifyWebhookSignature(LINE_TEST_SECRET, valid, encode("tampered")),
    ).toBe(false);
    expect(await verifyWebhookSignature(LINE_TEST_SECRET, null, body)).toBe(false);
    expect(await verifyWebhookSignature(LINE_TEST_SECRET, "not-base64!!", body)).toBe(false);
    expect(await verifyWebhookSignature(LINE_TEST_SECRET, "QUJD", body)).toBe(false);
    const oversized = new Uint8Array(ADAPTER.WEBHOOK_BODY_MAX_BYTES + 1);
    expect(await verifyWebhookSignature(LINE_TEST_SECRET, valid, oversized)).toBe(false);
  });
});

describe("webhook body parsing", () => {
  it("extracts follow and unfollow, counts the rest, refuses malformed bodies", () => {
    const parsed = parseWebhookBody(
      encode(
        JSON.stringify({
          destination: "Uxxx",
          events: [
            {
              type: "follow",
              webhookEventId: "01H0000000000000000000000A",
              timestamp: 1700000000000,
              source: { type: "user", userId: SUBJECT },
              deliveryContext: { isRedelivery: false },
            },
            {
              type: "message",
              webhookEventId: "01H0000000000000000000000B",
              timestamp: 1700000000001,
              source: { type: "user", userId: SUBJECT },
              message: { type: "text", text: "こんにちは" },
            },
            {
              type: "unfollow",
              webhookEventId: "01H0000000000000000000000C",
              timestamp: 1700000000002,
              source: { type: "user", userId: SUBJECT },
              deliveryContext: { isRedelivery: true },
            },
          ],
        }),
      ),
    );
    expect(parsed).toMatchObject({
      ignoredCount: 1,
      events: [
        { type: "follow", userId: SUBJECT, isRedelivery: false },
        { type: "unfollow", userId: SUBJECT, isRedelivery: true },
      ],
    });

    expect(parseWebhookBody(new Uint8Array([0xff, 0xfe, 0x00]))).toBeNull();
    expect(parseWebhookBody(encode("not json"))).toBeNull();
    expect(parseWebhookBody(encode(JSON.stringify({ events: "no" })))).toBeNull();
    expect(
      parseWebhookBody(
        encode(JSON.stringify({ events: [{ type: "follow" }] })),
      ),
    ).toBeNull();
    const tooMany = Array.from({ length: ADAPTER.WEBHOOK_EVENTS_MAX + 1 }, (_, i) => ({
      type: "message",
      webhookEventId: `E${i}`,
      timestamp: 1,
    }));
    expect(parseWebhookBody(encode(JSON.stringify({ events: tooMany })))).toBeNull();
  });
});

describe("ID-token verification", () => {
  const fetcherReturning = (response: Response): { calls: number; fetcher: LineFetch } => {
    const state = { calls: 0 };
    return {
      get calls() {
        return state.calls;
      },
      fetcher: (input, init) => {
        state.calls += 1;
        expect(input).toBe("https://api.line.me/oauth2/v2.1/verify");
        expect(init.method).toBe("POST");
        expect(init.redirect).toBe("manual");
        return Promise.resolve(response);
      },
    };
  };

  const token = "aaaa.bbbb.cccc";

  it("keeps sub and only sub from a valid response", async () => {
    const { fetcher } = fetcherReturning(
      verifyResponse({
        ...validClaims(),
        nonce: "n",
        name: "架空 花子",
        picture: "https://profile.example/x",
        email: "hanako@example.invalid",
        amr: ["linesso"],
      }),
    );
    expect(await verifyIdToken(token, identifiers.loginChannelId, fetcher)).toEqual({
      ok: true,
      sub: SUBJECT,
    });
  });

  it("refuses malformed tokens before any network call", async () => {
    const probe = fetcherReturning(verifyResponse({}));
    expect(await verifyIdToken("", identifiers.loginChannelId, probe.fetcher)).toEqual({
      ok: false,
      code: "INVALID_TOKEN",
    });
    expect(
      await verifyIdToken("no-dots-here", identifiers.loginChannelId, probe.fetcher),
    ).toEqual({ ok: false, code: "INVALID_TOKEN" });
    expect(
      await verifyIdToken(
        `${"a".repeat(ADAPTER.ID_TOKEN_MAX_BYTES)}.b.c`,
        identifiers.loginChannelId,
        probe.fetcher,
      ),
    ).toEqual({ ok: false, code: "INVALID_TOKEN" });
    expect(probe.calls).toBe(0);
  });

  it("maps provider statuses: 400 invalid, 3xx protocol, 5xx unavailable", async () => {
    const cases: Array<[Response, string]> = [
      [verifyResponse({ error: "invalid_request" }, 400), "INVALID_TOKEN"],
      [
        new Response(null, { status: 302, headers: { location: "https://evil.example/" } }),
        "PROTOCOL_ERROR",
      ],
      [verifyResponse({}, 500), "PROVIDER_UNAVAILABLE"],
    ];
    for (const [response, code] of cases) {
      const { fetcher } = fetcherReturning(response);
      expect(await verifyIdToken(token, identifiers.loginChannelId, fetcher)).toEqual({
        ok: false,
        code,
      });
    }
  });

  it("rejects wrong issuer, audience, expiry, shape, and oversized bodies", async () => {
    const bad = [
      { ...validClaims(), iss: "https://accounts.example" },
      { ...validClaims(), aud: "9999999999" },
      { ...validClaims(), exp: Math.floor(NOW / 1000) - 3600 },
      { ...validClaims(), sub: "not-a-user-id" },
      { ...validClaims(), name: "x".repeat(1001) },
      [1, 2, 3],
    ];
    for (const payload of bad) {
      const { fetcher } = fetcherReturning(verifyResponse(payload));
      expect(await verifyIdToken(token, identifiers.loginChannelId, fetcher)).toEqual({
        ok: false,
        code: "PROTOCOL_ERROR",
      });
    }
    const { fetcher } = fetcherReturning(
      new Response(`{"pad": "${"x".repeat(ADAPTER.VERIFY_RESPONSE_MAX_BYTES)}"}`, {
        status: 200,
      }),
    );
    expect(await verifyIdToken(token, identifiers.loginChannelId, fetcher)).toEqual({
      ok: false,
      code: "PROTOCOL_ERROR",
    });
  });
});

describe("constants inequalities (T033)", () => {
  it("keeps the timing model consistent", () => {
    const retryTotal = ADAPTER.RETRY_OFFSETS_S[ADAPTER.RETRY_OFFSETS_S.length - 1] as number;
    expect(retryTotal).toBeLessThan(ADAPTER.RETRY_KEY_VALIDITY_S);
    expect(ADAPTER.TOKEN_CACHE_TTL_S).toBeLessThan(900);
    expect(fullCycleBoundS(WORST_CASE_PARTITIONS)).toBeLessThan(
      ADAPTER.HANDOFF_TERMINAL_LEAD_S,
    );
    expect(ADAPTER.FINAL_PASS_LEASE_WAIT_S).toBeGreaterThanOrEqual(
      2 * ADAPTER.DESCRIPTOR_LEASE_WINDOW_S,
    );
    for (const [name, value] of Object.entries(ADAPTER)) {
      if (typeof value === "number") {
        expect(value, name).toBeGreaterThan(0);
      }
    }
  });
});

describe("link flow over HTTP", () => {
  const post = (path: string, body: unknown) =>
    worker.fetch(
      new Request(`https://example.test${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://example.test",
        },
        body: JSON.stringify(body),
      }),
      env,
    );

  // This pool-workers version exports no fetchMock, so the worker's outbound
  // fetch is stubbed at the global (same isolate as the imported worker).
  const interceptVerify = (payload: unknown, status = 200) => {
    vi.stubGlobal("fetch", (input: string | URL | Request) => {
      const target = typeof input === "string" ? input : new URL(String(input)).href;
      expect(target).toBe("https://api.line.me/oauth2/v2.1/verify");
      return Promise.resolve(
        new Response(JSON.stringify(payload), {
          status,
          headers: { "content-type": "application/json" },
        }),
      );
    });
  };

  const mintIntent = async (reservationId: string): Promise<string> => {
    const response = await post(`/api/reservations/${reservationId}/line/link-intent`, {
      date: lineDay.date,
      managementKey: MANAGEMENT_KEY,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { nonce: string; liffId: string };
    expect(body.liffId).toBe(identifiers.liffId);
    return body.nonce;
  };

  it("hides every link surface while the adapter is inactive", async () => {
    const reservationId = await createPendingReservation();
    const intent = await post(`/api/reservations/${reservationId}/line/link-intent`, {
      date: lineDay.date,
      managementKey: MANAGEMENT_KEY,
    });
    expect(intent.status).toBe(404);
    const link = await post("/api/adapters/line/link", { nonce: "0".repeat(32), idToken: "a.b.c" });
    expect(link.status).toBe(404);
    const webhook = await post("/api/adapters/line/webhook", { events: [] });
    expect(webhook.status).toBe(404);
  });

  it("links with intent + verified token, replays same-subject, surfaces conflicts", async () => {
    await enableLineAdapter();
    const reservationId = await createPendingReservation();

    // Wrong management key never reaches intent minting.
    const denied = await post(`/api/reservations/${reservationId}/line/link-intent`, {
      date: lineDay.date,
      managementKey: "X".repeat(43),
    });
    expect(denied.status).toBe(404);

    const nonce = await mintIntent(reservationId);

    // A captured token without a live intent is useless.
    const noIntent = await post("/api/adapters/line/link", {
      nonce: "0".repeat(32),
      idToken: "aaaa.bbbb.cccc",
    });
    expect(noIntent.status).toBe(404);

    interceptVerify(validClaims());
    const linked = await post("/api/adapters/line/link", {
      nonce,
      idToken: "aaaa.bbbb.cccc",
    });
    expect(linked.status).toBe(200);
    expect(await linked.json()).toMatchObject({ linked: true, replayed: false });

    // The nonce is consumed inside the completing transaction.
    const reuse = await post("/api/adapters/line/link", {
      nonce,
      idToken: "aaaa.bbbb.cccc",
    });
    expect(reuse.status).toBe(404);

    // Same subject again: no-op replay. Different subject: surfaced conflict.
    const secondNonce = await mintIntent(reservationId);
    interceptVerify(validClaims());
    const replayed = await post("/api/adapters/line/link", {
      nonce: secondNonce,
      idToken: "aaaa.bbbb.cccc",
    });
    expect(replayed.status).toBe(200);
    expect(await replayed.json()).toMatchObject({ replayed: true });

    const thirdNonce = await mintIntent(reservationId);
    interceptVerify(validClaims(OTHER_SUBJECT));
    const conflicted = await post("/api/adapters/line/link", {
      nonce: thirdNonce,
      idToken: "aaaa.bbbb.cccc",
    });
    expect(conflicted.status).toBe(409);
    expect(((await conflicted.json()) as { error: { code: string } }).error.code).toBe(
      "LINE_LINK_CONFLICT",
    );

    // Status shows presence only; unlink needs the same proof and works.
    const status = await post(`/api/reservations/${reservationId}/line/status`, {
      date: lineDay.date,
      managementKey: MANAGEMENT_KEY,
    });
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({ linked: "final" });

    const unlinked = await post(`/api/reservations/${reservationId}/line/unlink`, {
      date: lineDay.date,
      managementKey: MANAGEMENT_KEY,
    });
    expect(unlinked.status).toBe(200);
    expect(await unlinked.json()).toMatchObject({ unlinked: true });

    const gone = await post(`/api/reservations/${reservationId}/line/status`, {
      date: lineDay.date,
      managementKey: MANAGEMENT_KEY,
    });
    expect(gone.status).toBe(404);
  });

  it("refuses an invalid provider verdict without touching the link", async () => {
    await enableLineAdapter();
    const reservationId = await createPendingReservation();
    const nonce = await mintIntent(reservationId);
    interceptVerify({ error: "invalid_request" }, 400);
    const response = await post("/api/adapters/line/link", {
      nonce,
      idToken: "aaaa.bbbb.cccc",
    });
    expect(response.status).toBe(401);
    const status = await post(`/api/reservations/${reservationId}/line/status`, {
      date: lineDay.date,
      managementKey: MANAGEMENT_KEY,
    });
    // The provisional holder from the intent is still there, never finalized.
    expect(await status.json()).toEqual({ linked: "provisional" });
  });

  it("verifies, dedups, and orders webhook deliveries", async () => {
    await enableLineAdapter();
    const payload = JSON.stringify({
      destination: "U0",
      events: [
        {
          type: "follow",
          webhookEventId: "01WEBHOOK0000000000000000A",
          timestamp: 1700000000000,
          source: { type: "user", userId: SUBJECT },
          deliveryContext: { isRedelivery: false },
        },
      ],
    });
    const signature = await signWebhookBody(LINE_TEST_SECRET, payload);
    const send = (body: string, sig: string) =>
      worker.fetch(
        new Request("https://example.test/api/adapters/line/webhook", {
          method: "POST",
          headers: { "content-type": "application/json", "x-line-signature": sig },
          body,
        }),
        env,
      );

    expect((await send(payload, signature)).status).toBe(200);
    const subjects = await runInDurableObject(deliveryStub(), (_i, state) =>
      state.storage.sql
        .exec<{ subject: string; followed: number }>(
          "SELECT subject, followed FROM subjects",
        )
        .toArray(),
    );
    expect(subjects).toEqual([{ subject: SUBJECT, followed: 1 }]);

    // Duplicate delivery: acknowledged, not re-applied.
    expect((await send(payload, signature)).status).toBe(200);
    const dedup = await runInDurableObject(deliveryStub(), (_i, state) =>
      state.storage.sql
        .exec<{ n: number }>("SELECT COUNT(*) AS n FROM webhook_dedup")
        .toArray()[0],
    );
    expect(dedup).toEqual({ n: 1 });

    // Invalid signature: refused and counted.
    expect((await send(payload, "A".repeat(44))).status).toBe(403);
    const sigfail = await runInDurableObject(deliveryStub(), (_i, state) =>
      state.storage.sql
        .exec<{ value: number }>("SELECT value FROM counters WHERE name = 'sigfail'")
        .toArray()[0],
    );
    expect(sigfail).toEqual({ value: 1 });

    // Oversized body is refused before any HMAC work.
    const huge = "x".repeat(ADAPTER.WEBHOOK_BODY_MAX_BYTES + 1);
    expect((await send(huge, signature)).status).toBe(413);
  });
});
