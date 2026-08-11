import { expect, test, type Locator, type Page } from "@playwright/test";

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
  // The page init fills the schedule date after its config fetch and ends in a
  // logged-out reset; a submit that outruns it gets silently rolled back.
  await expect(page.locator("#admin-date")).not.toHaveValue("", { timeout: 15_000 });
  await page.fill("#owner-token", OWNER_TOKEN);
  await page.click("#auth-form button[type=submit]");
  await expect(page.locator("#auth-status")).toContainText("認証しました", { timeout: 20_000 });
};

// Owner routes are rate limited per route at 10/minute. The viewport specs
// sign in four times in a burst right before the status-action test, so its
// own sign-ins can land in a spent owner-schedule window. Retry the whole
// attempt until the window frees instead of sleeping a fixed period; only
// this caller carries the enlarged test budget the retries need.
const signInWithRetry = async (page: Page): Promise<void> => {
  await expect(async () => {
    await signIn(page);
  }).toPass({ intervals: [15_000], timeout: 180_000 });
};

// Opening the day board fires schedule and availability loads that draw on
// the same spent buckets (the page swallows a rate-limited load and simply
// leaves the board hidden), so the whole switch retries as one unit until
// its observable milestone renders.
const openDayBoardAt = async (page: Page, date: string, milestone: Locator): Promise<void> => {
  await expect(async () => {
    await page.click("#schedule-view-day");
    await expect(page.locator("#day-board")).toBeVisible({ timeout: 3_000 });
    await page.fill("#admin-date", date);
    await page.locator("#admin-date").blur();
    await milestone.waitFor({ state: "attached", timeout: 5_000 });
  }).toPass({ intervals: [15_000], timeout: 180_000 });
};

// A date or service change refreshes availability asynchronously, and a
// response landing after selectOption rebuilds the option list and resets
// the selection to the placeholder. Select, verify the value stuck, and
// reselect from the fresh list until the renders settle.
const selectStartTime = async (page: Page, startTime?: string): Promise<void> => {
  await expect(async () => {
    const time = startTime
      ? page.locator(`#owner-time option[value="${startTime}"]`)
      : page.locator("#owner-time option:not([value=''])").first();
    await time.waitFor({ state: "attached", timeout: 5_000 });
    const value = (await time.getAttribute("value")) ?? "";
    await page.selectOption("#owner-time", value);
    await expect(page.locator("#owner-time")).toHaveValue(value, { timeout: 1_000 });
  }).toPass({ timeout: 30_000 });
};

const chooseOpenStartTime = async (page: Page): Promise<void> => {
  await page.fill("#admin-date", openDateFrom(await page.locator("#admin-date").inputValue()));
  // Only an option carrying a real start time means the date has availability.
  await selectStartTime(page);
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
  // Rate-limit retries can spend well over the suite's default 60s budget.
  test.setTimeout(240_000);
  await stubTurnstile(page);
  await signInWithRetry(page);

  // complete/no_show require an elapsed endAt, so a future booking cannot use them
  // without a production change. cancel is the live status action on an approved row.
  // 14:00 is free of the morning/late slots the other shared-day specs take.
  const date = openDateFrom(await page.locator("#admin-date").inputValue());
  // Selecting the service ahead of the board switch lets the availability
  // reload inside openDayBoardAt render the time options on any retry.
  await page.locator("#owner-service-list input").first().check();
  const time = page.locator('#owner-time option[value="14:00"]');
  // Sign-in defaults to the 7-day board; detail actions live on the day board only.
  await openDayBoardAt(page, date, time);
  await selectStartTime(page, "14:00");
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
  await signInWithRetry(page);
  const rowAfterReload = page.locator("[data-reservation-list] article", { hasText: "状態 検証" });
  await openDayBoardAt(page, date, rowAfterReload);
  await expect(rowAfterReload).toBeVisible();
  await expect(rowAfterReload.locator(".badge")).toContainText("取消済み");
  await rowAfterReload.getByRole("button", { name: "詳細を開く" }).click();
  await expect(page.locator("[data-detail-status]")).toContainText("取消済み");
});
