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
  await page.fill("#owner-token", OWNER_TOKEN);
  await page.click("#auth-form button[type=submit]");
  await expect(page.locator("#auth-status")).toContainText("認証しました");
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
