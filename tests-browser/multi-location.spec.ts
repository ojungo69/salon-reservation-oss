import { expect, test, type Page } from "@playwright/test";

import {
  ALLOWED_HOSTNAME,
  OWNER_TOKEN,
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

test("a remembered named booking stays bound to its own proof after another location is selected and paused", async ({ page }) => {
  test.setTimeout(180_000);
  await stubTurnstile(page);
  const created = await forwardCreateWithoutTurnstile(page);
  await page.goto("/?location=salon-b");
  await expect(page.locator("[data-location-select]")).toBeVisible();
  await expect(page.locator("[data-location-name]").first()).toHaveText("サロン B");
  await page.locator("#service-list input").first().check();
  await page.fill("#booking-date", openDateFrom(await page.locator("#booking-date").inputValue()));
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

test("a staff member assigned only to the named location cannot see default, and revocation clears private data", async ({ page }) => {
  test.setTimeout(240_000);
  let credential = "";
  await page.route("**/api/admin/staff", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const response = await route.fetch();
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
  expect(credential).toMatch(/^[A-Za-z0-9_-]{43}$/);
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
      const committed = await route.fetch();
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
  expect(posted).toHaveLength(2);
  expect(JSON.stringify(posted[0]) === JSON.stringify(posted[1])).toBe(true);
  await expect(page.locator("[data-reservation-list] article", { hasText: "B_PROXY_PRIVATE" })).toHaveCount(1);
  const pendingAfter = await page.evaluate(() => ({
    original: sessionStorage.getItem("salon-reservation:pending-owner-create:v1") !== null,
    named: sessionStorage.getItem("salon-reservation:pending-owner-create:v1:location:salon-b") !== null,
  }));
  expect(pendingAfter).toEqual({ original: true, named: false });

  const closureDay = new Date(`${targetDate}T00:00:00Z`);
  closureDay.setUTCDate(closureDay.getUTCDate() + 4);
  if (closureDay.getUTCDay() === 0) closureDay.setUTCDate(closureDay.getUTCDate() + 1);
  const closureDate = closureDay.toISOString().slice(0, 10);
  await page.fill("#closure-date", closureDate);
  await page.selectOption("#closure-resource", "__all__");
  await page.fill("#closure-label", "架空休業 B");
  await page.click("#closure-submit");
  await expect(page.locator("#closure-status")).toContainText("登録しました");
  await page.fill("#admin-date", closureDate);
  await page.locator("#admin-date").blur();
  await expect(page.locator("#closure-list")).toContainText("架空休業 B");
  await page.locator("#closure-list .closure-item", { hasText: "架空休業 B" })
    .getByRole("button", { name: "解除する" }).click();
  await expect(page.locator("#closure-status")).toContainText("解除しました");

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
