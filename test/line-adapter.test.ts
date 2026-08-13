import { env, reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ADAPTER, fullCycleBoundS, WORST_CASE_PARTITIONS } from "../src/adapter-constants.ts";
import {
  clearTokenCacheForTests,
  mintChannelToken,
  parseWebhookBody,
  pushMessage,
  serializeMessageV1,
  verifyIdToken,
  verifyWebhookSignature,
  type LineFetch,
  type MessageFragment,
} from "../src/line-adapter.ts";
import worker from "../src/worker.ts";
import {
  createPendingReservation,
  deliveryStub,
  enableLineAdapter,
  identifiers,
  installationStub,
  LINE_TEST_SECRET,
  lineDay,
  MANAGEMENT_KEY,
  signWebhookBody,
  suiteDate,
  SUITE_NOW,
  testRuntime,
} from "./line-helpers.ts";

// Suite clock derived from the real wall clock (~1 year ahead) before fake
// timers install — alarms stay future-dated and tests drive them explicitly.
const NOW = SUITE_NOW;
const SUBJECT = `U${"a".repeat(32)}`;
const OTHER_SUBJECT = `U${"b".repeat(32)}`;
const ADAPTER_DELIVERY_BINDING = env.ADAPTER_DELIVERY;

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
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
});

afterEach(async () => {
  Object.defineProperty(env, "ADAPTER_DELIVERY", {
    configurable: true,
    value: ADAPTER_DELIVERY_BINDING,
  });
  vi.useRealTimers();
  vi.restoreAllMocks();
  // restoreAllMocks does not undo stubGlobal — fetch stubs must not leak.
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
    // Non-canonical base64 padding (atob accepts it; re-encode rejects it).
    if (valid.endsWith("=") && !valid.endsWith("==")) {
      // Flip to a double-pad spelling of the same payload when single-pad.
      const stripped = valid.replace(/=+$/, "");
      const alt = stripped + "==";
      if (alt !== valid) {
        expect(await verifyWebhookSignature(LINE_TEST_SECRET, alt, body)).toBe(false);
      }
    }
    // A known non-canonical form: standard alphabet with whitespace is already
    // refused; padding-bit variants that atob forgives but btoa rewrites.
    const decoded = atob(valid);
    // Corrupt the last character before padding so re-encoding diverges while
    // length/charset stay base64-shaped when possible.
    const nonCanonical = valid.slice(0, -1) + (valid.endsWith("A") ? "B" : "A");
    if (nonCanonical !== valid && /^[A-Za-z0-9+/]+={0,2}$/.test(nonCanonical)) {
      // May fail for different reasons; the property under test is rejection.
      expect(await verifyWebhookSignature(LINE_TEST_SECRET, nonCanonical, body)).toBe(false);
    }
    void decoded;
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
    // Non-user sources on follow/unfollow are ignored (not acted on). A user
    // follow/unfollow missing a boolean isRedelivery refuses the whole body.
    expect(
      parseWebhookBody(
        encode(
          JSON.stringify({
            events: [
              {
                type: "follow",
                webhookEventId: "01H0000000000000000000000D",
                timestamp: 1,
                source: { type: "group", groupId: "Cgroup" },
                deliveryContext: { isRedelivery: false },
              },
            ],
          }),
        ),
      ),
    ).toMatchObject({ events: [], ignoredCount: 1 });
    expect(
      parseWebhookBody(
        encode(
          JSON.stringify({
            events: [
              {
                type: "follow",
                webhookEventId: "01H0000000000000000000000E",
                timestamp: 1,
                source: { type: "user", userId: SUBJECT },
                deliveryContext: { isRedelivery: "false" },
              },
            ],
          }),
        ),
      ),
    ).toBeNull();
    expect(
      parseWebhookBody(
        encode(
          JSON.stringify({
            events: [
              {
                type: "unfollow",
                webhookEventId: "01H0000000000000000000000F",
                timestamp: 1,
                source: { type: "user", userId: SUBJECT },
              },
            ],
          }),
        ),
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
      { ...validClaims(), auth_time: -1 },
      { ...validClaims(), auth_time: 1.5 },
      { ...validClaims(), amr: Array.from({ length: 17 }, () => "x") },
      { ...validClaims(), amr: ["y".repeat(65)] },
      { ...validClaims(), amr: [1] },
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

  it("accepts well-formed auth_time and amr then discards them", async () => {
    const { fetcher } = fetcherReturning(
      verifyResponse({
        ...validClaims(),
        auth_time: Math.floor(NOW / 1000) - 10,
        amr: ["linesso", "pwd"],
      }),
    );
    expect(await verifyIdToken(token, identifiers.loginChannelId, fetcher)).toEqual({
      ok: true,
      sub: SUBJECT,
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

describe("lifecycle coordinator recovery", () => {
  it("re-arms activation after exhausting stale-generation retries", async () => {
    const authority = {
      readMeta: () => Promise.resolve(null),
      activate: () =>
        Promise.resolve({ ok: false as const, code: "STALE_GENERATION" as const }),
    };
    await runInDurableObject(installationStub(), (instance) => {
      const runtimeEnv = (instance as unknown as { env: Env }).env;
      Object.defineProperty(runtimeEnv, "ADAPTER_DELIVERY", {
        configurable: true,
        value: { getByName: () => authority },
      });
    });

    await enableLineAdapter();
    await expect(
      installationStub().lineAdapterStatus().then(({ phase }) => phase),
    ).resolves.toBe("activating");

    // The command's pre-armed alarm drives a second exhausted retry cycle.
    vi.setSystemTime(Date.now() + ADAPTER.SAGA_REDRIVE_DELAY_S * 1000 + 1);
    await runDurableObjectAlarm(installationStub());
    const alarm = await runInDurableObject(installationStub(), (_instance, state) =>
      state.storage.getAlarm(),
    );
    expect(alarm).not.toBeNull();
  });
});

describe("privacy page state rule", () => {
  // Both public privacy paths share the state-aware Worker handler.
  const fetchPrivacy = async (customEnv: Env = env): Promise<Response> =>
    worker.fetch(new Request("https://example.test/privacy"), customEnv);

  it("serves the asset unchanged until the adapter exists, then discloses per state", async () => {
    const baselineResponse = await fetchPrivacy();
    expect(baselineResponse.status).toBe(200);
    // Without a LINE disclosure the assets response is returned unchanged —
    // including whatever cache-control the asset itself carries.
    const baselineCache = baselineResponse.headers.get("cache-control");
    const baseline = await baselineResponse.text();
    expect(baseline).not.toContain("LINE 連携を利用する場合");
    // The operational-records wording lives only inside the injected disclosure.
    expect(baseline).not.toContain("個人を特定しない運用記録");
    expect(baseline).toContain("<!-- adapter-disclosure-slot -->");

    // Before activation, /privacy.html remains the same disclosure-free asset.
    const htmlPath = await worker.fetch(
      new Request("https://example.test/privacy.html"),
      env,
    );
    expect(await htmlPath.text()).not.toContain("LINE 連携を利用する場合");

    await enableLineAdapter();
    const activeResponse = await fetchPrivacy();
    expect(activeResponse.headers.get("cache-control")).toBe("no-store");
    const active = await activeResponse.text();
    expect(active).toContain("LINE 連携を利用する場合");
    const activeHtmlPath = await worker.fetch(
      new Request("https://example.test/privacy.html"),
      env,
    );
    expect(await activeHtmlPath.text()).toContain("LINE 連携を利用する場合");
    // Injected disclosure carries the operational-records paragraph.
    expect(active).toContain("個人を特定しない");


    // Missing secret (state active, binding absent): still rendered — data
    // may still be held.
    const noSecretEnv = Object.create(env) as Env;
    Object.defineProperty(noSecretEnv, "LINE_MESSAGING_CHANNEL_SECRET", {
      value: undefined,
    });
    const degraded = await (await fetchPrivacy(noSecretEnv)).text();
    expect(degraded).toContain("LINE 連携を利用する場合");

    // Post-purge: the section is gone and the body is byte-identical to the
    // never-configured baseline (the state rule, not a diff, decides).
    const disable = await installationStub().executeLineCommand(
      {
        operation: "line.disable",
        commandId: crypto.randomUUID(),
        expectedLifecycleVersion: 2,
      },
      testRuntime(),
    );
    expect(disable).toMatchObject({ ok: true, phase: "deactivating" });
    const deactivating = await (await fetchPrivacy()).text();
    expect(deactivating).toContain("LINE 連携を利用する場合");

    await runInDurableObject(deliveryStub(), (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE meta SET purge_completed_at = ? WHERE singleton = 1",
        Date.now(),
      );
    });
    await deliveryStub().completeDisable();
    // Drive the coordinator past its lease wait so the phase flips.
    vi.setSystemTime(Date.now() + 61_000);
    await runDurableObjectAlarm(installationStub());
    const afterResponse = await fetchPrivacy();
    expect(afterResponse.headers.get("cache-control")).toBe(baselineCache);
    const after = await afterResponse.text();
    expect(after).toBe(baseline);
  });
});

describe("message templates and the v1 serializer (FR-009)", () => {
  const fragment = (type: MessageFragment["type"]): MessageFragment => ({
    v: 1,
    type,
    date: suiteDate(1),
    startTime: "09:00",
    serviceLabel: "カット、カラー",
  });

  it("renders all five events with only time, service label, and state", () => {
    const wording = {
      approve: "ご予約が確定しました。",
      reject: "ご予約をお受けできませんでした。",
      reschedule: "ご予約の日時が変更されました。",
      cancel: "ご予約がキャンセルされました。",
      expire: "ご予約の申し込みが期限切れになりました。",
    } as const;
    for (const type of ["approve", "reject", "reschedule", "cancel", "expire"] as const) {
      const messages = serializeMessageV1(fragment(type));
      expect(messages).toHaveLength(1);
      const message = messages[0]!;
      expect(Object.keys(message).sort()).toEqual(["text", "type"]);
      expect(message.type).toBe("text");
      expect(message.text).toContain(`${suiteDate(1)} 09:00`);
      expect(message.text).toContain("サービス: カット、カラー");
      expect(message.text).not.toContain("https://");
      // Each type carries its own wording — a shared approve template would fail.
      expect(message.text).toContain(wording[type]);
      for (const other of Object.keys(wording) as Array<keyof typeof wording>) {
        if (other === type) continue;
        expect(message.text).not.toContain(wording[other]);
      }
      // FR-009 minimal payload: no customer name, notes, contact, history, or
      // management URL can appear — the fragment cannot carry any of them.
      expect(message.text).not.toContain("花子");
      expect(message.text).not.toContain("@");
    }
  });

  it("serializes byte-identically across calls (retry-safe by construction)", () => {
    const first = JSON.stringify(serializeMessageV1(fragment("cancel")));
    const second = JSON.stringify(serializeMessageV1(fragment("cancel")));
    expect(first).toBe(second);
  });
});

describe("token mint and push client", () => {
  beforeEach(() => {
    clearTokenCacheForTests();
  });

  const tokenFetch = (status: number, body?: unknown): LineFetch =>
    (() =>
      Promise.resolve(
        new Response(JSON.stringify(body ?? { access_token: "tok", token_type: "Bearer", expires_in: 900 }), {
          status,
        }),
      )) as LineFetch;

  it("mints and caches a stateless token, keyed by generation and secret digest", async () => {
    let calls = 0;
    const fetcher: LineFetch = (input, init) => {
      calls += 1;
      expect(String(input)).toBe("https://api.line.me/oauth2/v3/token");
      expect(String(init.body)).toContain("grant_type=client_credentials");
      return tokenFetch(200)(input, init);
    };
    const first = await mintChannelToken(
      { generation: 1, channelId: "9876543210", channelSecret: LINE_TEST_SECRET },
      fetcher,
    );
    expect(first).toEqual({ ok: true, accessToken: "tok" });
    await mintChannelToken(
      { generation: 1, channelId: "9876543210", channelSecret: LINE_TEST_SECRET },
      fetcher,
    );
    expect(calls).toBe(1);
    // A different generation misses the cache.
    await mintChannelToken(
      { generation: 2, channelId: "9876543210", channelSecret: LINE_TEST_SECRET },
      fetcher,
    );
    expect(calls).toBe(2);
  });

  it("maps token endpoint failures: 5xx/408/429 retryable, other 4xx configuration-rejected", async () => {
    expect(
      await mintChannelToken(
        { generation: 1, channelId: "9876543210", channelSecret: LINE_TEST_SECRET },
        tokenFetch(500),
      ),
    ).toEqual({ ok: false, code: "RETRYABLE" });
    expect(
      await mintChannelToken(
        { generation: 1, channelId: "9876543210", channelSecret: LINE_TEST_SECRET },
        tokenFetch(408),
      ),
    ).toEqual({ ok: false, code: "RETRYABLE" });
    expect(
      await mintChannelToken(
        { generation: 1, channelId: "9876543210", channelSecret: LINE_TEST_SECRET },
        tokenFetch(429),
      ),
    ).toEqual({ ok: false, code: "RETRYABLE" });
    expect(
      await mintChannelToken(
        { generation: 1, channelId: "9876543210", channelSecret: LINE_TEST_SECRET },
        tokenFetch(401, { error: "invalid_client" }),
      ),
    ).toEqual({ ok: false, code: "CONFIG_REJECTED" });
  });

  it("refuses a token response without Bearer type or a positive expires_in", async () => {
    expect(
      await mintChannelToken(
        { generation: 1, channelId: "9876543210", channelSecret: LINE_TEST_SECRET },
        tokenFetch(200, { access_token: "tok", token_type: "bearer", expires_in: 900 }),
      ),
    ).toEqual({ ok: false, code: "RETRYABLE" });
    clearTokenCacheForTests();
    expect(
      await mintChannelToken(
        { generation: 1, channelId: "9876543210", channelSecret: LINE_TEST_SECRET },
        tokenFetch(200, { access_token: "tok", token_type: "Bearer", expires_in: 0 }),
      ),
    ).toEqual({ ok: false, code: "RETRYABLE" });
    clearTokenCacheForTests();
    expect(
      await mintChannelToken(
        { generation: 1, channelId: "9876543210", channelSecret: LINE_TEST_SECRET },
        tokenFetch(200, { access_token: "tok", token_type: "Bearer", expires_in: 1.5 }),
      ),
    ).toEqual({ ok: false, code: "RETRYABLE" });
  });

  it("caches only up to min(expires_in*1000 - 60s, 840s) from request start", async () => {
    let calls = 0;
    const fetcher: LineFetch = () => {
      calls += 1;
      return Promise.resolve(
        new Response(
          JSON.stringify({ access_token: "short", token_type: "Bearer", expires_in: 90 }),
          { status: 200 },
        ),
      );
    };
    const first = await mintChannelToken(
      { generation: 1, channelId: "9876543210", channelSecret: LINE_TEST_SECRET },
      fetcher,
    );
    expect(first).toEqual({ ok: true, accessToken: "short" });
    // 90s grant → cacheable for 30s only (90*1000 - 60000).
    await mintChannelToken(
      { generation: 1, channelId: "9876543210", channelSecret: LINE_TEST_SECRET },
      fetcher,
    );
    expect(calls).toBe(1);
    vi.setSystemTime(Date.now() + 31_000);
    await mintChannelToken(
      { generation: 1, channelId: "9876543210", channelSecret: LINE_TEST_SECRET },
      fetcher,
    );
    expect(calls).toBe(2);
  });

  it("maps push outcomes: 200 sent, 409 accepted, 401 config, 5xx retryable, 429/other 4xx rejected", async () => {
    const push = (status: number) =>
      pushMessage(
        {
          accessToken: "tok",
          to: SUBJECT,
          messages: serializeMessageV1(
            {
              v: 1,
              type: "approve",
              date: suiteDate(1),
              startTime: "09:00",
              serviceLabel: "カット",
            },
          ),
          retryKey: crypto.randomUUID(),
        },
        (() => Promise.resolve(new Response("{}", { status }))) as LineFetch,
      );
    expect(await push(200)).toEqual({ ok: true, accepted: false });
    expect(await push(409)).toEqual({ ok: true, accepted: true });
    expect(await push(429)).toEqual({ ok: false, code: "REJECTED", status: 429 });
    expect(await push(401)).toEqual({ ok: false, code: "CONFIG_REJECTED", status: 401 });
    expect(await push(500)).toEqual({ ok: false, code: "RETRYABLE", status: 500 });
    expect(await push(400)).toEqual({ ok: false, code: "REJECTED", status: 400 });
  });

  it("sends the persisted retry key and a byte-identical body on every attempt", async () => {
    const bodies: string[] = [];
    const keys: string[] = [];
    const fetcher: LineFetch = (input, init) => {
      expect(String(input)).toBe("https://api.line.me/v2/bot/message/push");
      bodies.push(String(init.body));
      keys.push((init.headers as Record<string, string>)["x-line-retry-key"]);
      return Promise.resolve(new Response("{}", { status: 500 }));
    };
    const request = {
      accessToken: "tok",
      to: SUBJECT,
      messages: serializeMessageV1(
        {
          v: 1,
          type: "cancel",
          date: suiteDate(1),
          startTime: "09:00",
          serviceLabel: "カット",
        },
      ),
      retryKey: "11111111-2222-4333-8444-555555555555",
    };
    await pushMessage(request, fetcher);
    await pushMessage(request, fetcher);
    expect(bodies[0]).toBe(bodies[1]);
    expect(keys).toEqual([request.retryKey, request.retryKey]);
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
    expect(body.nonce).toMatch(/^[0-9a-f]{64}$/);
    return body.nonce;
  };

  it("hides every link surface while the adapter is inactive", async () => {
    const reservationId = await createPendingReservation();
    // Lifecycle gate runs before method/origin checks: every shape is 404.
    for (const method of ["GET", "POST", "PUT", "DELETE"] as const) {
      const response = await worker.fetch(
        new Request(`https://example.test/api/reservations/${reservationId}/line/link-intent`, {
          method,
          headers: { origin: "https://example.test", "content-type": "application/json" },
          body: method === "GET" || method === "DELETE" ? undefined : "{}",
        }),
        env,
      );
      expect(response.status, method).toBe(404);
    }
    const intent = await post(`/api/reservations/${reservationId}/line/link-intent`, {
      date: lineDay.date,
      managementKey: MANAGEMENT_KEY,
    });
    expect(intent.status).toBe(404);
    // Unlink/status stay hidden in the draft/disabled state too.
    expect(
      (
        await post(`/api/reservations/${reservationId}/line/unlink`, {
          date: lineDay.date,
          managementKey: MANAGEMENT_KEY,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await post(`/api/reservations/${reservationId}/line/status`, {
          date: lineDay.date,
          managementKey: MANAGEMENT_KEY,
        })
      ).status,
    ).toBe(404);
    const link = await post("/api/adapters/line/link", { nonce: "0".repeat(64), idToken: "a.b.c" });
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
      nonce: "0".repeat(64),
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

  it("verifies, dedups, and only persists subjects for finally-linked users", async () => {
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

    // Unlinked follower: acknowledged, but only the dedup row is written.
    expect((await send(payload, signature)).status).toBe(200);
    const unlinked = await runInDurableObject(deliveryStub(), (_i, state) => ({
      subjects: state.storage.sql
        .exec<{ subject: string }>("SELECT subject FROM subjects")
        .toArray(),
      dedup: state.storage.sql
        .exec<{ n: number }>("SELECT COUNT(*) AS n FROM webhook_dedup")
        .toArray()[0],
    }));
    expect(unlinked.subjects).toEqual([]);
    expect(unlinked.dedup).toEqual({ n: 1 });

    // Duplicate delivery: acknowledged, not re-applied.
    expect((await send(payload, signature)).status).toBe(200);
    const dedup = await runInDurableObject(deliveryStub(), (_i, state) =>
      state.storage.sql
        .exec<{ n: number }>("SELECT COUNT(*) AS n FROM webhook_dedup")
        .toArray()[0],
    );
    expect(dedup).toEqual({ n: 1 });

    // After a final link exists for the subject, a later follow persists it.
    const reservationId = await createPendingReservation();
    interceptVerify(validClaims());
    const nonce = await mintIntent(reservationId);
    expect(
      (
        await post("/api/adapters/line/link", {
          nonce,
          idToken: "aaaa.bbbb.cccc",
        })
      ).status,
    ).toBe(200);
    const follow2 = JSON.stringify({
      destination: "U0",
      events: [
        {
          type: "follow",
          webhookEventId: "01WEBHOOK0000000000000000B",
          timestamp: 1700000001000,
          source: { type: "user", userId: SUBJECT },
          deliveryContext: { isRedelivery: false },
        },
      ],
    });
    const sig2 = await signWebhookBody(LINE_TEST_SECRET, follow2);
    expect((await send(follow2, sig2)).status).toBe(200);
    const subjects = await runInDurableObject(deliveryStub(), (_i, state) =>
      state.storage.sql
        .exec<{ subject: string; followed: number }>(
          "SELECT subject, followed FROM subjects",
        )
        .toArray(),
    );
    expect(subjects).toEqual([{ subject: SUBJECT, followed: 1 }]);

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

  it("returns 503 and leaves the intent intact when the day watermark RPC fails", async () => {
    await enableLineAdapter();
    const reservationId = await createPendingReservation();
    const nonce = await mintIntent(reservationId);
    await runInDurableObject(
      env.RESERVATION_DAYS.getByName(`single-location:${lineDay.date}`) as never,
      (instance) => {
        (instance as unknown as Record<string, unknown>).readEventSequence = async () => {
          throw new Error("day unavailable");
        };
      },
    );
    interceptVerify(validClaims());
    const response = await post("/api/adapters/line/link", {
      nonce,
      idToken: "aaaa.bbbb.cccc",
    });
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "TEMPORARILY_UNAVAILABLE",
    );
    // Intent and provisional link survive for a retry.
    const status = await post(`/api/reservations/${reservationId}/line/status`, {
      date: lineDay.date,
      managementKey: MANAGEMENT_KEY,
    });
    expect(await status.json()).toEqual({ linked: "provisional" });
    const intentAlive = await deliveryStub().checkIntent({ nonce });
    expect(intentAlive).toEqual({ ok: true });
    // Counted apart from an invalid nonce so diagnostics stay unambiguous.
    const counted = await runInDurableObject(deliveryStub(), (_i, state) =>
      state.storage.sql
        .exec<{ name: string; value: number }>(
          "SELECT name, value FROM counters WHERE name LIKE 'link_failed:%'",
        )
        .toArray(),
    );
    expect(counted).toEqual([{ name: "link_failed:day-unavailable", value: 1 }]);
  });

  it("fails finalize and leaves no link when disable races an in-flight ID-token verify", async () => {
    await enableLineAdapter();
    const reservationId = await createPendingReservation();
    const nonce = await mintIntent(reservationId);

    let release!: (value: Response) => void;
    const held = new Promise<Response>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal("fetch", (input: string | URL | Request) => {
      const target = typeof input === "string" ? input : new URL(String(input)).href;
      expect(target).toBe("https://api.line.me/oauth2/v2.1/verify");
      return held;
    });

    const finalizePromise = post("/api/adapters/line/link", {
      nonce,
      idToken: "aaaa.bbbb.cccc",
    });

    // Disable and re-enable while verification is still in flight.
    const disable = await installationStub().executeLineCommand(
      {
        operation: "line.disable",
        commandId: crypto.randomUUID(),
        expectedLifecycleVersion: 2,
      },
      testRuntime(),
    );
    expect(disable).toMatchObject({ ok: true, phase: "deactivating" });
    await runInDurableObject(deliveryStub(), (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE meta SET purge_completed_at = ? WHERE singleton = 1",
        Date.now(),
      );
    });
    await deliveryStub().completeDisable();
    vi.setSystemTime(Date.now() + 61_000);
    await runDurableObjectAlarm(installationStub());
    // Re-enable under a new generation.
    const settings = await installationStub().executeLineCommand(
      {
        operation: "line.settings",
        commandId: crypto.randomUUID(),
        expectedLifecycleVersion: 3,
        identifiers,
      },
      testRuntime(),
    );
    expect(settings).toMatchObject({ ok: true });
    const enabled = await installationStub().executeLineCommand(
      {
        operation: "line.enable",
        commandId: crypto.randomUUID(),
        expectedLifecycleVersion: settings.ok ? settings.lifecycleVersion : 0,
        identifiers,
      },
      testRuntime(),
    );
    expect(enabled).toMatchObject({ ok: true });

    release(
      new Response(JSON.stringify(validClaims()), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const finished = await finalizePromise;
    expect(finished.status).not.toBe(200);

    const counts = await runInDurableObject(deliveryStub(), (_i, state) => ({
      links: state.storage.sql
        .exec<{ n: number }>("SELECT COUNT(*) AS n FROM links")
        .toArray()[0]?.n,
      subjects: state.storage.sql
        .exec<{ n: number }>("SELECT COUNT(*) AS n FROM subjects")
        .toArray()[0]?.n,
      deliveries: state.storage.sql
        .exec<{ n: number }>("SELECT COUNT(*) AS n FROM deliveries")
        .toArray()[0]?.n,
      intents: state.storage.sql
        .exec<{ n: number }>("SELECT COUNT(*) AS n FROM intents")
        .toArray()[0]?.n,
    }));
    expect(counts.links).toBe(0);
    expect(counts.subjects).toBe(0);
    expect(counts.deliveries).toBe(0);
    // The old generation's intent is gone with the purge; no new link formed.
    expect(counts.intents).toBe(0);
  });
});
