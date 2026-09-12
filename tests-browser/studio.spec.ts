import { expect, test } from "@playwright/test";
import { OWNER_TOKEN, expectNoAxeViolations, expectNoHorizontalOverflow, openDateFrom, stubTurnstile } from "./harness.ts";

// These tests use the actual application and its local Worker, not static mocks.
test("the mobile week strip and native date input stay synchronized", async ({ page }, testInfo) => {
  await stubTurnstile(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.locator("#service-list input").first()).toBeVisible();
  await page.locator("#service-list input").first().check();
  const date = openDateFrom(await page.locator("#booking-date").inputValue());
  await page.fill("#booking-date", date);
  await page.locator("#booking-date").blur();
  const current = page.locator(`.date-strip-day[data-date="${date}"]`);
  await expect(current).toHaveAttribute("aria-pressed", "true");
  const other = page.locator('.date-strip-day[aria-pressed="false"]').first();
  const next = await other.getAttribute("data-date");
  await other.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#booking-date")).toHaveValue(next!);
  await expect(other).toBeFocused();
  await expect(other).toHaveAttribute("aria-pressed", "true");
  await expectNoHorizontalOverflow(page);
  await expectNoAxeViolations(page);
  await testInfo.attach("customer-mobile", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
  for (const width of [320, 360, 768]) {
    await page.setViewportSize({ width, height: 900 });
    await expectNoHorizontalOverflow(page);
  }
});

test("the authoritative timetable opens details and is cleared on sign-out", async ({ page }, testInfo) => {
  await stubTurnstile(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/admin");
  await page.fill("#owner-token", OWNER_TOKEN);
  await page.click('#auth-form button[type="submit"]');
  await expect(page.locator("#auth-status")).toContainText("認証しました");
  await page.click("#schedule-view-day");
  const today = await page.locator("#admin-date").inputValue();
  const date = openDateFrom(openDateFrom(openDateFrom(today)));
  await page.fill("#admin-date", date);
  await page.locator("#admin-date").blur();
  await page.locator("#owner-service-list input").first().check();
  await expect(async () => {
    const option = page.locator('#owner-time option:not([value=""])').first();
    await expect(option).toBeAttached();
    const time = await option.getAttribute("value");
    await page.selectOption("#owner-time", time!);
    await expect(page.locator("#owner-time")).toHaveValue(time!, { timeout: 1000 });
  }).toPass({ timeout: 15_000 });
  await page.fill("#owner-customer-name", "表示 検証");
  await page.fill("#owner-contact", "studio@example.invalid");
  await page.click('#owner-create-form button[type="submit"]');
  await expect(page.locator("#owner-create-result")).toBeVisible();
  await expect(page.locator(".schedule-timeline")).toBeVisible();
  await expect(page.locator("[data-reservation-list]")).not.toContainText("studio@example.invalid");
  const tile = page.locator("[data-timeline-reservation]").first();
  await expect(tile).toBeVisible();
  await page.locator("#day-board").scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollTo(0, 0));
  await testInfo.attach("operator-desktop", { body: await page.screenshot(), contentType: "image/png" });
  await tile.click();
  await expect(page.locator("[data-detail-customer]")).toContainText("studio@example.invalid");
  await expect(page.locator("#reservation-detail")).toBeFocused();
  await expectNoAxeViolations(page);
  await page.setViewportSize({ width: 360, height: 800 });
  await expect(page.locator(".schedule-timeline")).toBeHidden();
  await expect(page.locator('[data-reservation-list] article', { hasText: "表示 検証" })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.click("#logout-button");
  await expect(page.locator(".schedule-timeline")).toHaveCount(0);
  await expect(page.locator("[data-detail-customer]")).not.toContainText("studio@example.invalid");
});

test("the studio surfaces retain dark-mode and reduced-motion accessibility", async ({ page }, testInfo) => {
  await stubTurnstile(page);
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.locator("#service-list input").first()).toBeVisible();
  for (const theme of ["ink", "forest", "clay"]) {
    await page.evaluate((name) => { document.body.dataset.theme = name; }, theme);
    await expectNoAxeViolations(page);
    await expectNoHorizontalOverflow(page);
  }
  await page.evaluate(() => { document.body.dataset.theme = "ink"; });
  await testInfo.attach("customer-dark", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
});
