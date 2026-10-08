import { expect, test, type Page } from "@playwright/test";

import {
  ALLOWED_HOSTNAME,
  BROWSER_ORIGIN,
  OWNER_TOKEN,
  SERVER_ORIGIN,
  SOURCE_URL,
  TURNSTILE_SITE_KEY,
  forwardCreateWithoutTurnstile,
  openDateFrom,
  stubTurnstile,
  expectNoAxeViolations,
  expectNoHorizontalOverflow,
  VIEWPORTS,
} from "./harness.ts";

test.describe.configure({ mode: "serial" });

const signInSetup = async (page: Page, path = "/setup"): Promise<void> => {
  await page.goto(path);
  await expect(page.locator("#setup-owner-token")).toBeEnabled();
  await page.fill("#setup-owner-token", OWNER_TOKEN);
  await page.click("#setup-auth-submit");
  await expect(page.locator("#setup-auth-status")).toContainText("認証しました");
};

test("an owner creates and publishes a second fictional location without changing default", async ({ page }) => {
  page.on("dialog", (dialog) => dialog.accept());
  await signInSetup(page);
  await expect(page.locator("[data-setup-locations-panel]")).toBeVisible();
  await page.fill("#new-location-id", "salon-b");
  await page.fill("#new-location-name", "サロン B");
  await page.click("[data-location-create-submit]");
  await expect(page.locator("[data-location-status]")).toContainText("場所を追加しました");
  await expect(page).toHaveURL(/\?location=salon-b$/);

  await page.fill("#setup-location-name", "サロン B");
  await page.fill("#setup-operator-name", "検証 運営者 B");
  await page.fill("#setup-operator-contact", "お問い合わせフォームをご利用ください");
  await page.fill("#setup-source-url", SOURCE_URL);
  await page.fill("#setup-privacy-notice", "予約の受付に必要な情報だけを利用します。");
  await page.fill("#setup-terms-notice", "表示内容を確認してから予約を送信してください。");
  await page.fill("#setup-cancellation-policy", "予約の管理画面からキャンセルできます。");
  await page.fill("#setup-consent-version", "browser-test-consent-b-v1");
  await page.fill("#setup-turnstile-site-key", TURNSTILE_SITE_KEY);
  await page.fill("#setup-allowed-hostname", ALLOWED_HOSTNAME);
  await page.click("#setup-save");
  await expect(page.locator("#setup-status")).toContainText("として保存しました");
  await page.click("#setup-enable-live");
  await expect(page.locator("#setup-status")).toContainText("公開予約を有効にしました");

  const published = await page.evaluate(async () => {
    const [directory, existing, named] = await Promise.all([
      fetch("/api/locations").then((response) => response.json()),
      fetch("/api/config").then((response) => response.json()),
      fetch("/api/config?location=salon-b").then((response) => response.json()),
    ]);
    return { directory: directory.locations, existing: existing.locationName, named: named.locationName };
  });
  expect(published.directory).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: "default", bookable: true }),
    expect.objectContaining({ id: "salon-b", label: "サロン B", bookable: true }),
  ]));
  expect(published.named).toBe("サロン B");
  expect(published.existing).not.toBe("サロン B");

  await page.fill("#new-location-id", "salon-b");
  await page.fill("#new-location-name", "別の名前");
  await page.click("[data-location-create-submit]");
  await expect(page.locator("[data-location-status]")).toHaveAttribute("data-tone", "error");
  const afterDuplicate = await page.evaluate(async () =>
    (await (await fetch("/api/locations")).json()).locations.length);
  expect(afterDuplicate).toBe(2);
});

test("a delayed default draft restore cannot overwrite the named booking form", async ({ page }) => {
  await page.goto("/?location=default");
  await expect(page.locator("#booking-date")).toHaveValue(/^\d{4}-\d{2}-\d{2}$/);
  const today = await page.locator("#booking-date").inputValue();
  const savedDate = openDateFrom(today);
  await page.locator("#service-list input").first().check();
  await page.fill("#booking-date", savedDate);
  await page.locator("#booking-date").blur();
  await expect(page.locator("#slot-list input").first()).toBeAttached();

  let release!: () => void;
  let requested!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { requested = resolve; });
  await page.route("**/api/availability?*", async (route) => {
    if (new URL(route.request().url()).searchParams.has("location")) return route.fallback();
    requested();
    await held;
    await route.continue();
  });
  await page.reload();
  await started;
  await page.locator("[data-location-select]").selectOption("salon-b");
  await expect(page).toHaveURL(/\?location=salon-b$/);
  await expect(page.locator("[data-location-name]").first()).toHaveText("サロン B");
  await expect(page.locator("#service-list input").first()).toBeAttached();
  const lateResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/availability" &&
    !new URL(response.url()).searchParams.has("location"));
  release();
  await lateResponse;
  await page.evaluate(() => new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.locator("#booking-date")).toHaveValue(today);
  const namedDraftDate = await page.evaluate(async () => {
    const { decodeJourneyDraft } = await import("/journey.js");
    const encoded = localStorage.getItem("salon-reservation:journey-draft:v1:location:salon-b");
    return decodeJourneyDraft(encoded, Date.now())?.date;
  });
  expect(namedDraftDate).toBe(today);
});

for (const locationId of ["salon-b", "default"]) {
  test(`an uncertain customer booking replays only in ${locationId}${locationId === "default" ? " even when paused and a named location accepts bookings" : " after reloading"}`, async ({ page }) => {
    await stubTurnstile(page);
    const posted: Array<{ location: string; body: Record<string, unknown> }> = [];
    let committedStatus = 0;
    let replayStatus = 0;
    let committedId = "";
    let replayedId = "";
    await page.route(/\/api\/reservations(?:\?.*)?$/, async (route) => {
      const request = route.request();
      if (request.method() !== "POST") return route.fallback();
      const url = new URL(request.url());
      const body = JSON.parse(request.postData() ?? "{}") as Record<string, unknown>;
      posted.push({ location: url.searchParams.get("location") ?? "default", body });
      const { turnstileToken, replayOnly, ...command } = body;
      const response = await route.fetch({
        // The house Turnstile fixture uses owner-create receipts for both attempts.
        url: `${SERVER_ORIGIN}/api/admin/reservations${url.search}`,
        headers: {
          ...request.headers(),
          host: new URL(BROWSER_ORIGIN).host,
          origin: BROWSER_ORIGIN,
          authorization: `Bearer ${OWNER_TOKEN}`,
        },
        postData: JSON.stringify(command),
      });
      const result = await response.json() as { reservation?: { reservationId: string } };
      if (posted.length === 1) {
        committedStatus = response.status();
        committedId = result.reservation?.reservationId ?? "";
        if (response.ok()) await route.abort("failed");
        else await route.fulfill({ response });
      } else {
        replayStatus = response.status();
        replayedId = result.reservation?.reservationId ?? "";
        await route.fulfill({ response });
      }
    });
    const ownerPage = await page.context().newPage();
    ownerPage.on("dialog", (dialog) => dialog.accept());
    let pausedDefault = false;
    const otherId = locationId === "default" ? "salon-b" : "default";
    const customerName = `RECOVERY_${locationId}_PRIVATE`;
    const pendingKey = "salon-reservation:pending-customer-create:v1" +
      (locationId === "default" ? "" : `:location:${locationId}`);
    try {
      await page.goto(`/?location=${locationId}`);
      await expect(page.locator("#booking-date")).toHaveValue(/^\d{4}-\d{2}-\d{2}$/);
      const date = openDateFrom(openDateFrom(openDateFrom(openDateFrom(await page.locator("#booking-date").inputValue()))));
      await page.locator("#service-list input").first().check();
      await page.fill("#booking-date", date);
      await page.locator("#booking-date").blur();
      await page.locator("#slot-list input").first().check();
      await page.click("#selection-next");
      await page.fill("#customer-name", customerName);
      await page.fill("#customer-contact", "recovery@example.invalid");
      await page.check("#booking-consent");
      await page.click("#details-next");
      await page.click("#booking-submit");
      await expect(page.locator("#booking-status")).toContainText("同じ内容と管理キーで結果を再確認");
      expect(committedStatus).toBe(201);
      await expect(page.locator("[data-location-select]")).toBeDisabled();
      const pendingKeys = await page.evaluate((key) => ({
        own: Object.keys(JSON.parse(sessionStorage.getItem(key) ?? "{}")).sort(),
        otherPresent: sessionStorage.getItem(key.endsWith(":salon-b")
          ? "salon-reservation:pending-customer-create:v1"
          : "salon-reservation:pending-customer-create:v1:location:salon-b") !== null,
      }), pendingKey);
      expect(pendingKeys).toEqual({ own: ["commandId", "managementKey", "request", "retryAt"], otherPresent: false });

      await page.goto(`/?location=${otherId}`);
      await expect(page.locator("#booking-date")).toHaveValue(/^\d{4}-\d{2}-\d{2}$/);
      await expect(page.locator("#customer-name")).toBeEmpty();
      await expect(page.locator("body")).not.toContainText(customerName);
      expect(posted.length).toBe(1);
      expect(await page.evaluate((key) => sessionStorage.getItem(key) !== null, pendingKey)).toBe(true);
      if (locationId === "default") {
        await signInSetup(ownerPage, "/setup?location=default");
        pausedDefault = true;
        await ownerPage.click("#setup-enable-live");
        await expect(ownerPage.locator("#setup-status")).toContainText("公開予約を停止");
        const directory = await ownerPage.evaluate(async () =>
          (await (await fetch("/api/locations")).json()).locations as Array<{ id: string; bookable: boolean }>);
        expect(directory.find(({ id }) => id === "default")?.bookable).toBe(false);
        expect(directory.find(({ id }) => id === "salon-b")?.bookable).toBe(true);
      }

      await page.goto(locationId === "default" ? "/" : "/?location=salon-b");
      await expect(page).toHaveURL(new RegExp(`\\?location=${locationId}$`));
      await expect(page.locator("#booking-submit")).toHaveText("未確認の予約結果を再確認する");
      await expect(page.locator("[data-review-name]")).toHaveText(customerName);
      await page.click("#booking-submit");
      await expect(page.locator("#booking-result")).toBeVisible();
      await expect(page.locator("[data-booking-result-status]")).toContainText("同じ申請の受付結果を確認しました");
      expect(posted.length).toBe(2);
      expect(posted.every(({ location }) => location === locationId)).toBe(true);
      const commands = posted.map(({ body }) => {
        const { turnstileToken, replayOnly, ...command } = body;
        return JSON.stringify(command);
      });
      expect(commands[0] === commands[1]).toBe(true);
      expect(posted[0]?.body.replayOnly === false && posted[1]?.body.replayOnly === true).toBe(true);
      expect(posted[1]?.body.turnstileToken === "").toBe(true);
      expect(replayStatus).toBe(201);
      expect(committedId !== "" && committedId === replayedId).toBe(true);
      expect(await page.evaluate((key) => sessionStorage.getItem(key) === null, pendingKey)).toBe(true);
      const counts = await page.evaluate(async ({ ownerToken, date, customerName }) => {
        const counts = [];
        for (const location of ["default", "salon-b"]) {
          const response = await fetch(`/api/admin/schedule?location=${location}&startDate=${date}&days=1`, {
            headers: { authorization: `Bearer ${ownerToken}` },
          });
          const result = await response.json() as { boards: Array<{ reservations: Array<{ customerName: string }> }> };
          counts.push(result.boards.flatMap(({ reservations }) => reservations)
            .filter((reservation) => reservation.customerName === customerName).length);
        }
        return counts;
      }, { ownerToken: OWNER_TOKEN, date, customerName });
      expect(counts).toEqual(locationId === "default" ? [1, 0] : [0, 1]);
    } finally {
      await page.locator("#booking-result").evaluate((element) => element.remove());
      if (pausedDefault) {
        await signInSetup(ownerPage, "/setup?location=default");
        const live = await ownerPage.evaluate(async () => (await (await fetch("/api/config")).json()).mode === "live");
        if (!live) {
          await ownerPage.click("#setup-enable-live");
          await expect(ownerPage.locator("#setup-status")).toContainText("公開予約を有効にしました");
        }
      }
      await ownerPage.close();
    }
  });
}

test("a remembered named booking stays bound to its own proof after another location is selected and paused", async ({ page }) => {
  test.setTimeout(180_000);
  await stubTurnstile(page);
  const created = await forwardCreateWithoutTurnstile(page);
  await page.goto("/?location=default");
  await expect(page.locator("[data-location-select]")).toBeVisible();
  await page.locator("[data-location-select]").selectOption("salon-b");
  await expect(page.locator("[data-location-name]").first()).toHaveText("サロン B");
  await page.locator("#service-list input").first().check();
  await page.fill("#booking-date", openDateFrom(await page.locator("#booking-date").inputValue()));
  await page.locator("#booking-date").blur();
  const slot = page.locator("#slot-list input").first();
  await slot.waitFor({ state: "attached" });
  await slot.check();
  await page.click("#selection-next");
  await expect(page.locator("[data-summary-location]")).toHaveText("サロン B");
  await page.fill("#customer-name", "架空 利用者 B");
  await page.fill("#customer-contact", "named-booking@example.invalid");
  await page.check("#booking-consent");
  await page.click("#details-next");
  await expect(page.locator("[data-review-location]")).toHaveText("サロン B");
  await page.click("#booking-submit");
  await expect(page.locator("#booking-result")).toBeVisible();
  await expect(page.locator("[data-result-location]")).toHaveText("サロン B");
  // Traverse past review, details and B selection back to the A URL. The
  // result must keep its B scope even though that earlier history entry exists.
  await page.evaluate(() => new Promise<void>((resolve) => {
    window.addEventListener("popstate", () => setTimeout(resolve, 0), { once: true });
    history.go(-3);
  }));
  await expect(page).toHaveURL(/\?location=salon-b$/);
  await expect(page.locator("#booking-result")).toBeVisible();
  await page.check("#remember-booking");
  expect(created.requests).toHaveLength(1);
  expect(created.requests[0]).not.toHaveProperty("locationId");
  const stored = await page.evaluate(() => ({
    named: Object.keys(JSON.parse(localStorage.getItem("salon-reservation:owned-bookings:v1:location:salon-b") ?? "[]")[0] ?? {}).sort(),
    legacy: localStorage.getItem("salon-reservation:owned-bookings:v1"),
  }));
  expect(stored.named).toEqual(["date", "managementKey", "reservationId", "savedAt"]);
  expect(stored.legacy).toBeNull();

  const ownerPage = await page.context().newPage();
  ownerPage.on("dialog", (dialog) => dialog.accept());
  await signInSetup(ownerPage, "/setup?location=salon-b");
  const lineEnabled = await ownerPage.evaluate(async (ownerToken) => {
    const headers = { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" };
    const endpoint = "/api/admin/line/";
    const identifiers = {
      liffId: "1234567890-abcdefgh",
      loginChannelId: "1234567890",
      messagingChannelId: "9876543210",
    };
    const status = await (await fetch(endpoint + "status?location=salon-b", { headers })).json();
    let version = status.lifecycleVersion as number;
    if (status.draft === null) {
      const saved = await fetch(endpoint + "settings?location=salon-b", {
        method: "POST", headers,
        body: JSON.stringify({ commandId: crypto.randomUUID(), expectedLifecycleVersion: version, identifiers }),
      });
      version = (await saved.json()).lifecycleVersion;
    }
    const enabled = await fetch(endpoint + "enable?location=salon-b", {
      method: "POST", headers,
      body: JSON.stringify({ commandId: crypto.randomUUID(), expectedLifecycleVersion: version, identifiers }),
    });
    return enabled.status;
  }, OWNER_TOKEN);
  expect(lineEnabled).toBe(200);
  await expect.poll(() => ownerPage.evaluate(async (ownerToken) => {
    const response = await fetch("/api/admin/line/status?location=salon-b", {
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    return (await response.json()).phase;
  }, OWNER_TOKEN)).toBe("active");

  await page.route("https://static.line-scdn.net/**", (route) => route.abort());
  await page.goto("/bookings?location=default");
  const linkedCard = page.locator("[data-booking-card][data-location-id='salon-b']").first();
  await linkedCard.getByRole("button", { name: "LINE で通知を受け取る" }).click();
  await page.waitForURL(/\/line\.html\?location=salon-b$/);
  const intentKeys = await page.evaluate(() => ({
    named: sessionStorage.getItem("salon-reservation:line-link-intent:v1:location:salon-b") !== null,
    legacy: sessionStorage.getItem("salon-reservation:line-link-intent:v1") !== null,
  }));
  expect(intentKeys).toEqual({ named: true, legacy: false });
  await expect(page.locator("[data-line-back]")).toHaveAttribute("href", "/bookings.html?location=salon-b");
  await page.goto("/bookings?location=default");
  await linkedCard.getByRole("button", { name: "手続きを取りやめる" }).click();
  await expect(linkedCard.locator("[data-line-link-status]")).toContainText("LINE で受け取れます");

  await ownerPage.click("#setup-enable-live");
  await expect(ownerPage.locator("#setup-status")).toContainText("公開予約を停止");
  await ownerPage.close();

  const proofRequests: string[] = [];
  page.on("request", (request) => {
    if (/\/api\/reservations\/[^/]+\/(status|cancel)/.test(request.url())) proofRequests.push(request.url());
  });
  await page.goto("/bookings?location=default");
  const card = page.locator("[data-booking-card][data-location-id='salon-b']").first();
  await expect(card).toBeVisible();
  await expect(card.locator("[data-booking-location]")).toHaveText("サロン B");
  await card.locator("[data-booking-cancel]").click();
  await expect(page.locator("[data-booking-cancel-summary]")).toContainText("サロン B");
  await page.click("[data-booking-cancel-confirm-button]");
  await expect(card).toHaveAttribute("data-booking-state", "cancelled");
  expect(proofRequests.length).toBeGreaterThanOrEqual(2);
  expect(proofRequests.every((url) => new URL(url).searchParams.get("location") === "salon-b")).toBe(true);
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await expectNoHorizontalOverflow(page);
  }
  await expectNoAxeViolations(page);
});

test("named LIFF login keeps the fixed return location and rejects callback state", async ({ page }) => {
  await page.route("https://static.line-scdn.net/**", (route) => route.fulfill({
    status: 200,
    contentType: "application/javascript",
    body: "",
  }));
  await page.addInitScript(() => {
    const runtime = globalThis as typeof globalThis & {
      __lineLoginCalls: Array<{ redirectUri: string }>;
      __lineInitCalls: number;
      liff: {
        init: () => Promise<void>;
        isLoggedIn: () => boolean;
        login: (options: { redirectUri: string }) => void;
      };
    };
    runtime.__lineLoginCalls = [];
    runtime.__lineInitCalls = 0;
    runtime.liff = {
      init: async () => { runtime.__lineInitCalls += 1; },
      isLoggedIn: () => false,
      login: (options) => { runtime.__lineLoginCalls.push(options); },
    };
  });
  await page.goto("/privacy?location=salon-b");
  await page.evaluate(() => sessionStorage.setItem(
    "salon-reservation:line-link-intent:v1:location:salon-b",
    JSON.stringify({ nonce: "a".repeat(64), expiresAt: Date.now() + 60_000 }),
  ));
  await page.goto("/line.html?location=salon-b");
  await expect(page.locator("[data-line-status]")).toContainText("ログイン画面へ移動します");
  const login = await page.evaluate(() => {
    const runtime = globalThis as typeof globalThis & {
      __lineLoginCalls: Array<{ redirectUri: string }>;
      __lineInitCalls: number;
    };
    return { calls: runtime.__lineLoginCalls, initCalls: runtime.__lineInitCalls };
  });
  expect(login).toEqual({
    calls: [{ redirectUri: `${BROWSER_ORIGIN}/line.html?location=salon-b` }],
    initCalls: 1,
  });
  await page.goto("/line.html?location=salon-b&liff.state=%2Fadmin%3Fevil%3D1");
  await expect(page.locator("[data-line-status]")).toContainText("予約管理ページからもう一度");
  expect(await page.evaluate(() => (globalThis as typeof globalThis & {
    __lineInitCalls: number;
  }).__lineInitCalls)).toBe(0);
  await expect(page.locator("[data-line-back]")).toHaveAttribute("href", "/bookings.html?location=salon-b");
});

test("a staff member assigned only to the named location cannot see default, and revocation clears private data", async ({ page }) => {
  test.setTimeout(120_000);
  let credential = "";
  await page.route("**/api/admin/staff", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const response = await route.fetch({
      url: `${SERVER_ORIGIN}/api/admin/staff`,
      headers: {
        ...route.request().headers(),
        host: new URL(BROWSER_ORIGIN).host,
        origin: BROWSER_ORIGIN,
      },
    });
    const result = await response.json() as Record<string, unknown>;
    credential = String(result.credential ?? "");
    await route.fulfill({
      status: response.status(),
      contentType: "application/json",
      body: JSON.stringify({ ...result, credential: "fixture-only-placeholder" }),
    });
  });
  page.on("dialog", (dialog) => dialog.accept());
  await signInSetup(page, "/setup?location=salon-b");
  await page.click("#setup-enable-live");
  await expect(page.locator("#setup-status")).toContainText("公開予約を有効にしました");
  await page.fill("#staff-display-name", "担当者 B");
  await page.selectOption("#staff-role", "staff");
  await page.locator("[data-staff-create-scope-options] input[value='default']").uncheck();
  await page.locator("[data-staff-create-scope-options] input[value='salon-b']").check();
  await page.click("#staff-submit");
  await expect(page.locator("[data-staff-list]")).toContainText("担当者 B");
  expect(/^[A-Za-z0-9_-]{43}$/.test(credential)).toBe(true);
  await page.click("#setup-logout");

  await page.goto("/admin");
  await expect(page.locator("#owner-token")).toBeEnabled();
  await page.fill("#owner-token", credential);
  await page.click("#auth-form button[type=submit]");
  await expect(page.locator("#auth-status")).toContainText("認証しました");
  await expect(page).toHaveURL(/\?location=salon-b$/);
  await expect(page.locator("[data-operator-location-anchor]")).toContainText("サロン B");
  const denied = await page.evaluate(async (staffCredential) => {
    const date = (document.querySelector("#admin-date") as HTMLInputElement).value;
    const response = await fetch(`/api/admin/schedule?location=default&startDate=${date}&days=1`, {
      headers: { authorization: `Bearer ${staffCredential}` },
    });
    return response.status;
  }, credential);
  expect(denied).toBe(401);
  const targetDate = openDateFrom(await page.locator("#admin-date").inputValue());
  await page.fill("#admin-date", targetDate);
  await page.locator("#admin-date").blur();
  await expect(page.locator("[data-reservation-list]")).toContainText("架空 利用者 B");

  await page.locator("#owner-service-list input").first().check();
  await expect(page.locator("#owner-resource")).toBeEnabled();
  if (await page.locator("#owner-resource").inputValue() === "") {
    const resource = await page.locator("#owner-resource option:not([value=''])").first().getAttribute("value");
    await page.selectOption("#owner-resource", resource ?? "");
  }
  const timeOption = page.locator("#owner-time option:not([value=''])").first();
  await timeOption.waitFor({ state: "attached" });
  await page.selectOption("#owner-time", (await timeOption.getAttribute("value")) ?? "");
  await page.fill("#owner-customer-name", "B_PROXY_PRIVATE");
  await page.fill("#owner-contact", "b-proxy@example.invalid");
  const posted: Array<Record<string, unknown>> = [];
  let firstCommitStatus = 0;
  await page.route("**/api/admin/reservations?location=salon-b", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    posted.push(JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>);
    if (posted.length === 1) {
      const committed = await route.fetch({
        url: `${SERVER_ORIGIN}/api/admin/reservations?location=salon-b`,
        headers: {
          ...route.request().headers(),
          host: new URL(BROWSER_ORIGIN).host,
          origin: BROWSER_ORIGIN,
        },
      });
      firstCommitStatus = committed.status();
      if (committed.ok()) await route.abort("failed");
      else await route.fulfill({ response: committed });
    } else {
      await route.continue();
    }
  });
  await page.click("#owner-create-form button[type=submit]");
  await expect(page.locator("#owner-create-status")).toContainText("同じ内容と管理キーで結果を再確認");
  expect([200, 201]).toContain(firstCommitStatus);
  const seeded = await page.evaluate(async () => {
    const namedKey = "salon-reservation:pending-owner-create:v1:location:salon-b";
    const legacyKey = "salon-reservation:pending-owner-create:v1";
    const pending = JSON.parse(sessionStorage.getItem(namedKey) ?? "null");
    const { encodePendingMutationRecord, decodePendingMutationRecord } = await import("/journey.js");
    const other = {
      ...pending,
      commandId: crypto.randomUUID(),
      request: { ...pending.request, customerName: "A_PENDING_PRIVATE", contact: "a-pending@example.invalid" },
    };
    const encoded = encodePendingMutationRecord(other);
    if (!decodePendingMutationRecord(encoded, Date.now())) throw new Error("Invalid A fixture");
    sessionStorage.setItem(legacyKey, encoded);
    return sessionStorage.getItem(namedKey) !== null && sessionStorage.getItem(legacyKey) !== null;
  });
  expect(seeded).toBe(true);

  await page.goto("/admin");
  await page.fill("#owner-token", credential);
  await page.click("#auth-form button[type=submit]");
  await expect(page.locator("#auth-status")).toContainText("認証しました");
  await expect(page).toHaveURL(/\?location=salon-b$/);
  await expect(page.locator("#owner-create-status")).toContainText("B_PROXY_PRIVATE");
  await expect(page.locator("body")).not.toContainText("A_PENDING_PRIVATE");
  await page.click("#owner-create-form button[type=submit]");
  await expect(page.locator("#owner-create-result")).toBeVisible();
  await expect(page.locator("#owner-create-status")).toContainText("代理予約を登録しました");
  const keyLifecycle = await page.evaluate(() => {
    const key = document.querySelector("#owner-management-key");
    const visible = Boolean(key?.textContent);
    (document.querySelector("#logout-button") as HTMLButtonElement).click();
    const clearedByApp = !key?.textContent;
    // Mask only after observing the runtime result, before a failure artifact.
    if (!clearedByApp && key) key.textContent = "";
    return { visible, clearedByApp };
  });
  expect(keyLifecycle).toEqual({ visible: true, clearedByApp: true });
  await page.fill("#owner-token", credential);
  await page.click("#auth-form button[type=submit]");
  await expect(page.locator("#auth-status")).toContainText("認証しました");
  expect(posted.length).toBe(2);
  expect(JSON.stringify(posted[0]) === JSON.stringify(posted[1])).toBe(true);
  await page.click("#schedule-view-day");
  await page.fill("#admin-date", targetDate);
  await page.locator("#admin-date").blur();
  await expect(page.locator("[data-reservation-list] article", { hasText: "B_PROXY_PRIVATE" })).toHaveCount(1);
  const pendingAfter = await page.evaluate(() => ({
    original: sessionStorage.getItem("salon-reservation:pending-owner-create:v1") !== null,
    named: sessionStorage.getItem("salon-reservation:pending-owner-create:v1:location:salon-b") !== null,
  }));
  expect(pendingAfter).toEqual({ original: true, named: false });

  const privateRequests: string[] = [];
  page.on("request", (request) => {
    if (/\/api\/admin\/(?:schedule|availability|reservations)(?:\/|\?|$)/.test(request.url())) {
      privateRequests.push(request.url());
    }
  });
  await page.goto("/admin?location=default");
  await page.fill("#owner-token", credential);
  await page.click("#auth-form button[type=submit]");
  await expect(page.locator("#auth-status")).toContainText("この場所を表示できません。許可された場所を選んでください");
  await expect(page).toHaveURL(/\?location=default$/);
  await expect(page.locator("#owner-customer-name")).toBeEmpty();
  await expect(page.locator("#owner-contact")).toBeEmpty();
  await expect(page.locator("#owner-customer-name")).toBeDisabled();
  await expect(page.locator("body")).not.toContainText("A_PENDING_PRIVATE");
  await expect(page.locator("body")).not.toContainText("B_PROXY_PRIVATE");
  await expect(page.locator("[data-operator-location] option[value='default']")).toHaveCount(0);
  await expect(page.locator("[data-operator-location]")).toHaveValue("");
  expect(privateRequests.length).toBe(0);
  await page.locator("[data-operator-location]").selectOption("salon-b");
  await expect(page).toHaveURL(/\?location=salon-b$/);
  await expect(page.locator("#auth-status")).toContainText("認証しました");

  const closureDay = new Date(`${targetDate}T00:00:00Z`);
  closureDay.setUTCDate(closureDay.getUTCDate() + 4);
  if (closureDay.getUTCDay() === 0) closureDay.setUTCDate(closureDay.getUTCDate() + 1);
  const closureDate = closureDay.toISOString().slice(0, 10);
  const closurePosts: Array<{ location: string | null; body: string }> = [];
  let closureCommitStatus = 0;
  await page.route("**/api/admin/closures?*", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const request = route.request();
    const url = new URL(request.url());
    closurePosts.push({ location: url.searchParams.get("location"), body: request.postData() ?? "" });
    if (closurePosts.length === 1) {
      const response = await route.fetch({
        url: `${SERVER_ORIGIN}${url.pathname}${url.search}`,
        headers: { ...request.headers(), host: new URL(BROWSER_ORIGIN).host, origin: BROWSER_ORIGIN },
      });
      closureCommitStatus = response.status();
      if (response.ok()) await route.abort("failed");
      else await route.fulfill({ response });
    } else {
      await route.continue();
    }
  });
  await page.fill("#closure-date", closureDate);
  await page.selectOption("#closure-resource", "__all__");
  await page.fill("#closure-label", "架空休業 B");
  await page.click("#closure-submit");
  await expect(page.locator("[data-closure-status]")).toContainText("同じ内容で結果を再確認できます");
  expect(closureCommitStatus).toBe(201);
  await expect(page.locator("#closure-label")).toBeDisabled();
  await page.evaluate(() => {
    history.pushState({}, "", "/admin?location=default");
    dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(page).toHaveURL(/\?location=salon-b$/);
  await expect(page.locator("#auth-status")).toContainText("未確認の操作結果を先に再確認");
  await page.fill("#owner-token", credential);
  await page.click("#auth-form button[type=submit]");
  await expect(page.locator("#auth-status")).toContainText("未確認の操作結果を再確認してから認証し直して");
  await expect(page.locator("#closure-submit")).toHaveText("未確認の登録結果を再確認する");
  expect(closurePosts.length).toBe(1);
  await page.click("#closure-submit");
  await expect(page.locator("[data-closure-status]")).toContainText("登録しました");
  expect(closurePosts.length).toBe(2);
  expect(closurePosts[0]?.body === closurePosts[1]?.body).toBe(true);
  expect(closurePosts.every(({ location }) => location === "salon-b")).toBe(true);
  await page.fill("#admin-date", closureDate);
  await page.locator("#admin-date").blur();
  await page.click("#schedule-view-day");
  await expect(page.locator("#day-board")).toBeVisible();
  await expect(page.locator("#closure-list")).toContainText("架空休業 B");
  await expect(page.locator("#closure-list .closure-item", { hasText: "架空休業 B" })).toHaveCount(1);
  await page.locator("#closure-list .closure-item", { hasText: "架空休業 B" })
    .getByRole("button", { name: "解除する" }).click({ timeout: 10_000 });
  await expect(page.locator("[data-closure-status]")).toContainText("解除しました");

  const ownerPage = await page.context().newPage();
  await signInSetup(ownerPage, "/setup?location=default");
  const staffCard = ownerPage.locator(".staff-item").filter({ hasText: "担当者 B" });
  await staffCard.locator(".staff-scope-form input[value='salon-b']").uncheck();
  await staffCard.getByRole("button", { name: "担当場所を保存する" }).click();
  await expect(ownerPage.locator("[data-staff-status]")).toContainText("担当場所を更新しました");
  await ownerPage.close();

  await page.click("#schedule-view-day");
  await expect(page.locator("#auth-status")).toContainText("もう一度認証");
  await expect(page.locator("[data-reservation-list]")).not.toContainText("架空 利用者 B");
  await expect(page.locator("[data-detail-customer]")).toHaveText("—");
  await page.evaluate(() => {
    const original = JSON.parse(sessionStorage.getItem("salon-reservation:pending-owner-create:v1") ?? "null");
    sessionStorage.setItem("salon-reservation:pending-owner-create:v1:location:salon-b", JSON.stringify({
      ...original,
      request: { ...original.request, customerName: "EMPTY_SCOPE_PRIVATE" },
    }));
  });
  const beforeEmptySignIn = privateRequests.length;
  await page.goto("/admin");
  await page.fill("#owner-token", credential);
  await page.click("#auth-form button[type=submit]");
  await expect(page.locator("#auth-status")).toContainText("担当できる場所がありません。運営者に確認してください");
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.locator("[data-operator-location-anchor]")).toContainText("担当できる場所がありません");
  await expect(page.locator("#owner-customer-name")).toBeEmpty();
  await expect(page.locator("#owner-contact")).toBeEmpty();
  await expect(page.locator("#owner-customer-name")).toBeDisabled();
  await expect(page.locator("body")).not.toContainText("A_PENDING_PRIVATE");
  await expect(page.locator("body")).not.toContainText("EMPTY_SCOPE_PRIVATE");
  await expect(page.locator("[data-reservation-list]")).not.toContainText("架空 利用者 B");
  await expect(page.locator("[data-detail-customer]")).toHaveText("—");
  expect(privateRequests.length).toBe(beforeEmptySignIn);
});

test("a late default schedule cannot repaint the named operator board", async ({ page }) => {
  await page.goto("/admin?location=default");
  await expect(page.locator("#owner-token")).toBeEnabled();
  await page.fill("#owner-token", OWNER_TOKEN);
  await page.click("#auth-form button[type=submit]");
  await expect(page.locator("#auth-status")).toContainText("認証しました");
  await expect(page.locator("[data-operator-location]")).toBeVisible();

  let release!: () => void;
  let requested!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { requested = resolve; });
  await page.route("**/api/admin/schedule?*", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.has("location")) return route.fallback();
    requested();
    await held;
    const date = url.searchParams.get("startDate");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        startDate: date,
        days: 7,
        attentionCount: 1,
        boards: [{
          date,
          opensAt: "09:00",
          closesAt: "17:00",
          closures: [],
          reservations: [{
            reservationId: "00000000-0000-4000-8000-000000000001",
            date,
            startTime: "10:00",
            resourceLabel: "架空担当",
            services: [{ id: "cut", label: "カット" }],
            serviceMinutes: 60,
            cleanupMinutes: 0,
            priceYen: null,
            status: "pending",
            customerName: "A_PRIVATE",
            contact: "a-private@example.invalid",
          }],
        }],
      }),
    });
  });
  const changedDate = openDateFrom(await page.locator("#admin-date").inputValue());
  await page.fill("#admin-date", changedDate);
  await page.locator("#admin-date").blur();
  await started;
  await page.locator("[data-operator-location]").selectOption("salon-b");
  await expect(page).toHaveURL(/\?location=salon-b$/);
  await expect(page.locator("#auth-status")).toContainText("認証しました");
  const oldResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/admin/schedule" &&
    !new URL(response.url()).searchParams.has("location"));
  release();
  await oldResponse;
  await page.evaluate(() => new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.locator("body")).not.toContainText("A_PRIVATE");
  await expect(page.locator("[data-reservation-list]")).not.toContainText("a-private@example.invalid");
});


test("same reservation ID in two local proof keys keeps cards, actions and removal separate", async ({ page }) => {
  page.on("dialog", (dialog) => dialog.accept());
  await page.goto("/privacy");
  const reservationId = "00000000-0000-4000-8000-000000000001";
  await page.evaluate((id) => {
    const record = {
      reservationId: id,
      date: "2026-11-18",
      managementKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      savedAt: Date.now(),
    };
    localStorage.setItem("salon-reservation:owned-bookings:v1", JSON.stringify([record]));
    localStorage.setItem("salon-reservation:owned-bookings:v1:location:salon-b", JSON.stringify([record]));
  }, reservationId);
  await page.route("**/api/reservations/*/status*", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      reservationId,
      date: "2026-11-18",
      startTime: "10:00",
      services: [{ id: "cut", label: "カット" }],
      resourceLabel: "架空担当",
      status: "approved",
      allowedActions: ["cancel"],
    }),
  }));
  await page.route("**/line-link.mjs*", (route) => route.abort());
  await page.goto("/bookings?location=default");
  const a = page.locator("[data-booking-card][data-location-id='default']");
  const b = page.locator("[data-booking-card][data-location-id='salon-b']");
  await expect(a).toHaveCount(1);
  await expect(b).toHaveCount(1);
  await expect(a.locator("[data-booking-reference]")).toHaveText(reservationId);
  await expect(b.locator("[data-booking-reference]")).toHaveText(reservationId);
  await expect(b.locator("[data-booking-remove]")).toHaveAttribute("aria-label", /サロン B/);
  await b.locator("[data-booking-remove]").click();
  await expect(b).toHaveCount(0);
  await expect(a).toHaveCount(1);
  const storage = await page.evaluate(() => ({
    legacy: localStorage.getItem("salon-reservation:owned-bookings:v1"),
    named: localStorage.getItem("salon-reservation:owned-bookings:v1:location:salon-b"),
  }));
  expect(storage.legacy).not.toBeNull();
  expect(storage.named).toBeNull();
});

test("a fifth location is refused and a stale owner form refreshes to the four-location limit", async ({ page }) => {
  await signInSetup(page, "/setup?location=default");
  await expect(page.locator("[data-setup-location-count]")).toHaveText("2 / 4");
  const created = await page.evaluate(async (ownerToken) => {
    const results = [];
    for (const [locationId, locationName] of [
      ["salon-c", "サロン C"],
      ["salon-d", "サロン D"],
    ]) {
      const response = await fetch("/api/admin/locations", {
        method: "POST",
        headers: {
          authorization: `Bearer ${ownerToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ commandId: crypto.randomUUID(), locationId, locationName }),
      });
      results.push(response.status);
    }
    return results;
  }, OWNER_TOKEN);
  expect(created).toEqual([201, 201]);
  // The open form still has the earlier two-location projection until it sees
  // the limit conflict. It must then refresh and stop offering another create.
  await expect(page.locator("[data-setup-location-count]")).toHaveText("2 / 4");
  await page.fill("#new-location-id", "salon-e");
  await page.fill("#new-location-name", "サロン E");
  await page.click("[data-location-create-submit]");
  await expect(page.locator("[data-location-status]")).toHaveAttribute("data-tone", "error");
  await expect(page.locator("[data-setup-location-count]")).toHaveText("4 / 4");
  await expect(page.locator("[data-location-create-submit]")).toBeDisabled();
  const ids = await page.evaluate(async () =>
    (await (await fetch("/api/locations")).json()).locations.map(({ id }: { id: string }) => id));
  expect(ids).toEqual(["default", "salon-b", "salon-c", "salon-d"]);
});
