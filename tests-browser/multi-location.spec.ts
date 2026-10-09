import { expect, test } from "@playwright/test";

import {
  ALLOWED_HOSTNAME,
  OWNER_TOKEN,
  SOURCE_URL,
  TURNSTILE_SITE_KEY,
  signInSetup,
} from "./harness.ts";

test.describe.configure({ mode: "serial" });

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

test("a failed duplicate-location refresh cannot repaint a newer setup session", async ({ page }) => {
  await signInSetup(page, "/setup?location=default");
  const requested = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let directoryReads = 0;
  await page.route("**/api/admin/locations", async (route) => {
    if (route.request().method() === "GET" && ++directoryReads === 1) {
      requested.resolve();
      await release.promise;
      await route.abort("failed");
    } else {
      await route.continue();
    }
  });
  const duplicate = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/admin/locations" && response.request().method() === "POST");
  await page.fill("#new-location-id", "salon-b");
  await page.fill("#new-location-name", "重複の架空サロン");
  await page.click("[data-location-create-submit]");
  expect((await duplicate).status()).toBe(409);
  await requested.promise;
  try {
    await page.fill("#setup-owner-token", OWNER_TOKEN);
    await page.click("#setup-auth-submit");
    await expect(page.locator("#setup-auth-status")).toContainText("認証しました");
    const status = page.locator("[data-location-status]");
    await expect(status).toHaveAttribute("data-tone", "success");
    const newSessionStatus = await status.textContent();
    const failed = page.waitForEvent("requestfailed", {
      predicate: (request) => new URL(request.url()).pathname === "/api/admin/locations" && request.method() === "GET",
    });
    release.resolve();
    await failed;
    await page.evaluate(() => new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(status).toHaveText(newSessionStatus ?? "");
    await expect(status).toHaveAttribute("data-tone", "success");
  } finally {
    release.resolve();
  }
});

test("a fifth location is refused and a stale owner form refreshes to the four-location limit", { tag: "@capacity-final" }, async ({ page }) => {
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
