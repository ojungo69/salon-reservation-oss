import { expect, test, type Page } from "@playwright/test";

import {
  OWNER_TOKEN,
  VIEWPORTS,
  expectNoAxeViolations,
  expectNoHorizontalOverflow,
  openDateFrom,
  stubTurnstile,
} from "./harness.ts";

const signIn = async (page: Page): Promise<void> => {
  await page.goto("/admin");
  // Owner routes share a 10/minute limiter. Extra schedule specs can hit it mid-suite;
  // wait out one period rather than failing the whole ordered run.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.fill("#owner-token", OWNER_TOKEN);
    await page.click("#auth-form button[type=submit]");
    const status = page.locator("#auth-status");
    await expect(status).not.toContainText("認証しています", { timeout: 15_000 });
    const text = (await status.textContent()) ?? "";
    if (text.includes("認証しました")) return;
    if (text.includes("操作が多すぎます") && attempt < 2) {
      await page.waitForTimeout(65_000);
      continue;
    }
    throw new Error(`owner sign-in failed: ${text}`);
  }
};

const chooseOpenStartTime = async (page: Page): Promise<void> => {
  await page.fill("#admin-date", openDateFrom(await page.locator("#admin-date").inputValue()));

  // The placeholder option is always present, so only an option carrying a real
  // start time means the date has availability.
  const time = page.locator("#owner-time option:not([value=''])").first();
  await time.waitFor({ state: "attached" });
  await page.selectOption("#owner-time", (await time.getAttribute("value")) ?? "");
};

test("an owner signs in, books on a customer's behalf and signs out", async ({ page }) => {
  await stubTurnstile(page);
  await signIn(page);
  await page.click("#schedule-view-day");
  await expect(page.locator("#day-board")).toBeVisible();

  await page.locator("#owner-service-list input").first().check();
  await chooseOpenStartTime(page);
  await page.fill("#owner-customer-name", "代理 花子");
  await page.fill("#owner-contact", "owner-booked@example.invalid");
  await page.click("#owner-create-form button[type=submit]");

  await expect(page.locator("#owner-create-result")).toBeVisible();
  await expect(page.locator("#owner-management-key")).not.toBeEmpty();
  await expect(page.locator("[data-reservation-list]")).toContainText("代理 花子");

  // The customer specs may have booked the same day, so pick the row by name
  // rather than by position.
  await page
    .locator("[data-reservation-list] article", { hasText: "代理 花子" })
    .getByRole("button", { name: "詳細を開く" })
    .click();
  await expect(page.locator("#reservation-detail")).toBeVisible();
  await expect(page.locator("[data-detail-customer]")).toContainText("代理 花子");

  await page.click("#logout-button");
  await expect(page.locator("#owner-token")).toBeVisible();
  await expect(page.locator("[data-reservation-list]")).not.toContainText("代理 花子");
});

test("the operator screen carries no automated accessibility violations", async ({ page }) => {
  await stubTurnstile(page);
  await page.goto("/admin");
  await expectNoAxeViolations(page);
  await signIn(page);
  await expectNoAxeViolations(page);
});

for (const viewport of VIEWPORTS) {
  test(`the operator screen fits ${viewport.name} pixels wide`, async ({ page }) => {
    await stubTurnstile(page);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await signIn(page);
    await expectNoHorizontalOverflow(page);
    await page.goto("/setup");
    await expectNoHorizontalOverflow(page);
  });
}

test("an owner status action updates the schedule and survives reload", async ({ page }) => {
  // Cool-down (65s) plus two sign-ins exceeds the suite's default 60s budget.
  test.setTimeout(240_000);
  await stubTurnstile(page);
  // Earlier owner specs already spend most of the 10/min owner-schedule budget.
  // Without a cool-down the schedule reloads below fail closed on RATE_LIMITED.
  await page.waitForTimeout(65_000);
  await signIn(page);
  // Sign-in defaults to the 7-day board; detail actions live on the day board only.
  await page.click("#schedule-view-day");
  await expect(page.locator("#day-board")).toBeVisible();

  // complete/no_show require an elapsed endAt, so a future booking cannot use them
  // without a production change. cancel is the live status action on an approved row.
  // 14:00 is free of the morning/late slots the other shared-day specs take.
  const date = openDateFrom(await page.locator("#admin-date").inputValue());
  await page.fill("#admin-date", date);
  await page.locator("#admin-date").blur();
  // Service change reloads owner availability for the date above.
  await page.locator("#owner-service-list input").first().check();
  const time = page.locator('#owner-time option[value="14:00"]');
  await time.waitFor({ state: "attached" });
  await page.selectOption("#owner-time", "14:00");
  await page.fill("#owner-customer-name", "状態 検証");
  await page.fill("#owner-contact", "status-action@example.invalid");
  await page.click("#owner-create-form button[type=submit]");
  await expect(page.locator("#owner-create-result")).toBeVisible();
  await expect(page.locator("[data-reservation-list]")).toContainText("状態 検証");

  const row = page.locator("[data-reservation-list] article", { hasText: "状態 検証" });
  await row.getByRole("button", { name: "詳細を開く" }).click();
  await expect(page.locator("#reservation-detail")).toBeVisible();
  await expect(page.locator("[data-detail-status]")).toContainText("予約確定");

  page.once("dialog", (dialog) => dialog.accept());
  await page.locator('[data-reservation-action="cancel"]').click();

  await expect(page.locator("[data-reservation-action-status]")).toContainText("取消を反映しました");
  await expect(page.locator("[data-detail-status]")).toContainText("取消済み");
  await expect(row.locator(".badge")).toContainText("取消済み");

  await page.reload();
  await signIn(page);
  await page.click("#schedule-view-day");
  await expect(page.locator("#day-board")).toBeVisible();
  await page.fill("#admin-date", date);
  await page.locator("#admin-date").blur();
  const rowAfterReload = page.locator("[data-reservation-list] article", { hasText: "状態 検証" });
  await expect(rowAfterReload).toBeVisible();
  await expect(rowAfterReload.locator(".badge")).toContainText("取消済み");
  await rowAfterReload.getByRole("button", { name: "詳細を開く" }).click();
  await expect(page.locator("[data-detail-status]")).toContainText("取消済み");
});
