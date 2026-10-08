import { expect, test } from "@playwright/test";

import {
  BROWSER_ORIGIN,
  OWNER_TOKEN,
  SERVER_ORIGIN,
  openDateFrom,
  signInSetup,
} from "./harness.ts";

test.describe.configure({ mode: "serial" });

test("a staff member assigned only to the named location cannot see default, and revocation clears private data", async ({ page }) => {
  test.setTimeout(120_000);
  let credential = "";
  const signInStaff = async (): Promise<void> => {
    const input = page.locator("#owner-token");
    await expect(input).toBeVisible();
    await expect(input).toBeEnabled();
    // Playwright fill() includes its value in action timeout logs.
    try {
      await page.evaluate((value) => {
        const input = document.querySelector("#owner-token");
        if (!(input instanceof HTMLInputElement)) throw new Error("Authentication input is missing");
        input.value = value;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }, credential);
      await page.click("#auth-form button[type=submit]");
    } finally {
      await page.evaluate(() => {
        const input = document.querySelector("#owner-token");
        if (input instanceof HTMLInputElement) input.value = "";
      });
    }
  };
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
  await signInStaff();
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
  await signInStaff();
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
  await signInStaff();
  await expect(page.locator("#auth-status")).toContainText("認証しました");
  const proxyReplayEvidence = {
    requestCount: posted.length,
    sameCommand: JSON.stringify(posted[0]) === JSON.stringify(posted[1]),
  };
  expect(proxyReplayEvidence).toEqual({ requestCount: 2, sameCommand: true });
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
  await signInStaff();
  await expect(page.locator("#auth-status")).toContainText("この場所を表示できません。許可された場所を選んでください");
  await expect(page).toHaveURL(/\?location=default$/);
  await expect(page.locator("#owner-customer-name")).toBeEmpty();
  await expect(page.locator("#owner-contact")).toBeEmpty();
  await expect(page.locator("#owner-customer-name")).toBeDisabled();
  await expect(page.locator("body")).not.toContainText("A_PENDING_PRIVATE");
  await expect(page.locator("body")).not.toContainText("B_PROXY_PRIVATE");
  await expect(page.locator("[data-operator-location] option[value='default']")).toHaveCount(0);
  await expect(page.locator("[data-operator-location]")).toHaveValue("");
  expect(privateRequests).toHaveLength(0);
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
  await signInStaff();
  await expect(page.locator("#auth-status")).toContainText("未確認の操作結果を再確認してから認証し直して");
  await expect(page.locator("#closure-submit")).toHaveText("未確認の登録結果を再確認する");
  const pendingClosureRequestCount = closurePosts.length;
  expect(pendingClosureRequestCount).toBe(1);
  await page.click("#closure-submit");
  await expect(page.locator("[data-closure-status]")).toContainText("登録しました");
  const closureReplayEvidence = {
    requestCount: closurePosts.length,
    sameCommand: closurePosts[0]?.body === closurePosts[1]?.body,
  };
  expect(closureReplayEvidence).toEqual({ requestCount: 2, sameCommand: true });
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
  await signInStaff();
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
  expect(privateRequests).toHaveLength(beforeEmptySignIn);
  const pendingRetained = await page.evaluate(() => ({
    hasA: sessionStorage.getItem("salon-reservation:pending-owner-create:v1") !== null,
    hasB: sessionStorage.getItem("salon-reservation:pending-owner-create:v1:location:salon-b") !== null,
  }));
  expect(pendingRetained).toEqual({ hasA: true, hasB: true });
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
