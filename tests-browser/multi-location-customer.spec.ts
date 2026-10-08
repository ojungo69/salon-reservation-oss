import { expect, test, type Page } from "@playwright/test";

import {
  BROWSER_ORIGIN,
  OWNER_TOKEN,
  SERVER_ORIGIN,
  VIEWPORTS,
  enableNamedLine,
  expectNoAxeViolations,
  expectNoHorizontalOverflow,
  forwardCreateWithoutTurnstile,
  openDateFrom,
  signInSetup,
  stubTurnstile,
} from "./harness.ts";

test.describe.configure({ mode: "serial" });

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
  await expect(page).toHaveURL((url) => /\?location=salon-b$/.test(url.href));
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

const forwardUncertainCreateWithoutTurnstile = async (page: Page) => {
  const posted: Array<{ location: string; body: Record<string, unknown> }> = [];
  const receipts = { committedStatus: 0, replayStatus: 0, committedId: "", replayedId: "" };
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
      receipts.committedStatus = response.status();
      receipts.committedId = result.reservation?.reservationId ?? "";
      if (response.ok()) await route.abort("failed");
      else await route.fulfill({ response });
    } else {
      receipts.replayStatus = response.status();
      receipts.replayedId = result.reservation?.reservationId ?? "";
      await route.fulfill({ response });
    }
  });
  return { posted, receipts };
};

const submitUncertainBooking = async (page: Page, locationId: string, customerName: string): Promise<string> => {
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
  return date;
};

for (const locationId of ["salon-b", "default"]) {
  test(`an uncertain customer booking replays only in ${locationId}${locationId === "default" ? " even when paused and a named location accepts bookings" : " after reloading"}`, async ({ page }) => {
    await stubTurnstile(page);
    const { posted, receipts } = await forwardUncertainCreateWithoutTurnstile(page);
    const ownerPage = await page.context().newPage();
    ownerPage.on("dialog", (dialog) => dialog.accept());
    let pausedDefault = false;
    const otherId = locationId === "default" ? "salon-b" : "default";
    const customerName = `RECOVERY_${locationId}_PRIVATE`;
    const pendingKey = "salon-reservation:pending-customer-create:v1" +
      (locationId === "default" ? "" : `:location:${locationId}`);
    const retryUncertainBooking = async (date: string): Promise<void> => {
      await page.goto(locationId === "default" ? "/" : "/?location=salon-b");
      await expect(page).toHaveURL((url) => url.pathname === "/" &&
        url.searchParams.getAll("location").length === 1 && url.searchParams.get("location") === locationId);
      await expect(page.locator("#booking-submit")).toHaveText("未確認の予約結果を再確認する");
      await expect(page.locator("[data-review-name]")).toHaveText(customerName);
      await page.click("#booking-submit");
      await expect(page.locator("#booking-result")).toBeVisible();
      await expect(page.locator("[data-booking-result-status]")).toContainText("同じ申請の受付結果を確認しました");
      expect(posted.every(({ location }) => location === locationId)).toBe(true);
      const commands = posted.map(({ body }) => {
        const { turnstileToken, replayOnly, ...command } = body;
        return JSON.stringify(command);
      });
      const replayEvidence = {
        requestCount: posted.length,
        sameCommand: commands[0] === commands[1],
        initialCreate: posted[0]?.body.replayOnly === false,
        receiptOnlyRetry: posted[1]?.body.replayOnly === true,
        emptyTurnstile: posted[1]?.body.turnstileToken === "",
      };
      expect(replayEvidence).toEqual({
        requestCount: 2, sameCommand: true, initialCreate: true,
        receiptOnlyRetry: true, emptyTurnstile: true,
      });
      expect(receipts.replayStatus).toBe(201);
      expect(receipts.committedId !== "" && receipts.committedId === receipts.replayedId).toBe(true);
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
    };
    try {
      const date = await submitUncertainBooking(page, locationId, customerName);
      expect(receipts.committedStatus).toBe(201);
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
      // Keep captured commands out of matcher failure diagnostics.
      const pendingRequestCount = posted.length;
      expect(pendingRequestCount).toBe(1);
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

      await retryUncertainBooking(date);
    } finally {
      await page.close();
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

const createRememberedNamedBooking = async (page: Page): Promise<void> => {
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
  await expect(page).toHaveURL((url) => /\?location=salon-b$/.test(url.href));
  await expect(page.locator("#booking-result")).toBeVisible();
  await page.check("#remember-booking");
  expect(created.requests.length).toBe(1);
  expect(Object.hasOwn(created.requests[0], "locationId")).toBe(false);
  const stored = await page.evaluate(() => ({
    named: Object.keys(JSON.parse(localStorage.getItem("salon-reservation:owned-bookings:v1:location:salon-b") ?? "[]")[0] ?? {}).sort(),
    hasLegacy: localStorage.getItem("salon-reservation:owned-bookings:v1") !== null,
  }));
  expect(stored.named).toEqual(["date", "managementKey", "reservationId", "savedAt"]);
  expect(stored.hasLegacy).toBe(false);
};

test("a remembered named booking stays bound to its own proof after another location is selected and paused", async ({ page }) => {
  test.setTimeout(180_000);
  const ownerPage = await page.context().newPage();
  try {
    await createRememberedNamedBooking(page);

    ownerPage.on("dialog", (dialog) => dialog.accept());
    await signInSetup(ownerPage, "/setup?location=salon-b");
    await enableNamedLine(ownerPage);

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
  } finally {
    await page.close();
    await ownerPage.close();
  }
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
