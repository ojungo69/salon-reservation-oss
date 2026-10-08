import { expect, test, type Page } from "@playwright/test";

import { OWNER_TOKEN } from "./harness.ts";

const signInSetup = async (page: Page, path = "/setup?location=salon-b"): Promise<void> => {
  await page.goto(path);
  await expect(page.locator("#setup-owner-token")).toBeEnabled();
  await page.fill("#setup-owner-token", OWNER_TOKEN);
  await page.click("#setup-auth-submit");
  await expect(page.locator("#setup-auth-status")).toContainText("認証しました");
};

test.describe("one-time calendar capability without artifacts", () => {
  test("named calendar feed issue, rotation and conflict stay scoped to the owner panel", async ({ page }) => {
    test.setTimeout(120_000);
    page.on("dialog", (dialog) => dialog.accept());
    await signInSetup(page, "/setup?location=salon-b");
    await expect(page.locator("[data-calendar-panel]")).toBeVisible();
    await expect(page.locator("[data-calendar-panel]")).toContainText("primary");
    const before = await page.evaluate(async (ownerToken) => {
      const response = await fetch("/api/admin/calendar/status?location=salon-b", {
        headers: { authorization: "Bearer " + ownerToken },
      });
      return (await response.json()).settings.version as number;
    }, OWNER_TOKEN);

    await page.click("[data-calendar-issue]");
    await expect(page.locator("[data-calendar-status]")).toContainText("発行しました");
    const first = await page.evaluate(async (ownerToken) => {
      const token = document.querySelector("[data-calendar-token]")?.textContent ?? "";
      (window as typeof window & { __firstCalendarToken?: string }).__firstCalendarToken = token;
      const stored = [localStorage, sessionStorage].some((storage) =>
        Array.from({ length: storage.length }, (_, index) => storage.getItem(storage.key(index) ?? "") ?? "")
          .some((value) => value.includes(token)));
      const response = await fetch("/api/admin/calendar/status?location=salon-b", {
        headers: { authorization: "Bearer " + ownerToken },
      });
      const settings = (await response.json()).settings;
      return { length: token.length, stored, version: settings.version, present: settings.feedTokenPresent };
    }, OWNER_TOKEN);
    expect(first.length).toBeGreaterThan(20);
    expect(first.stored).toBe(false);
    expect(first.version).toBe(before + 1);
    expect(first.present).toBe(true);

    await page.click("[data-calendar-issue]");
    await expect(page.locator("[data-calendar-status]")).toContainText("発行しました");
    const rotated = await page.evaluate(async (ownerToken) => {
      const token = document.querySelector("[data-calendar-token]")?.textContent ?? "";
      const holder = window as typeof window & { __firstCalendarToken?: string };
      const changed = token !== holder.__firstCalendarToken;
      delete holder.__firstCalendarToken;
      const response = await fetch("/api/admin/calendar/status?location=salon-b", {
        headers: { authorization: "Bearer " + ownerToken },
      });
      const settings = (await response.json()).settings;
      return { length: token.length, changed, version: settings.version };
    }, OWNER_TOKEN);
    expect(rotated.length).toBeGreaterThan(20);
    expect(rotated.changed).toBe(true);
    expect(rotated.version).toBe(first.version + 1);

    await page.check("[data-calendar-feed-enabled]");
    await page.click("[data-calendar-save]");
    await expect(page.locator("[data-calendar-status]")).toContainText("保存しました");
    const concurrentSave = await page.evaluate(async (ownerToken) => {
      const headers = { authorization: "Bearer " + ownerToken, "content-type": "application/json" };
      const current = await (await fetch("/api/admin/calendar/status?location=salon-b", { headers })).json();
      const response = await fetch("/api/admin/calendar/settings?location=salon-b", {
        method: "PUT",
        headers,
        body: JSON.stringify({
          expectedVersion: current.settings.version,
          googleEnabled: false,
          calendarId: null,
          feedEnabled: false,
        }),
      });
      return response.status;
    }, OWNER_TOKEN);
    expect(concurrentSave).toBe(200);
    await page.click("[data-calendar-save]");
    await expect(page.locator("[data-calendar-status]")).toContainText("設定が更新されました");
    await expect(page.locator("[data-calendar-feed-enabled]")).not.toBeChecked();
    const denied = await page.evaluate(async () =>
      (await fetch("/api/admin/calendar/status?location=salon-b")).status);
    expect(denied).toBe(401);

    await page.click("#setup-logout");
    await expect(page.locator("[data-calendar-token-box]")).toBeHidden();
    await expect(page.locator("[data-calendar-token]")).toBeEmpty();
  });
});
