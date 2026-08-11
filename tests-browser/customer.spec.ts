import { expect, test, type Page } from "@playwright/test";

import {
  VIEWPORTS,
  expectNoAxeViolations,
  expectNoHorizontalOverflow,
  forwardCreateWithoutTurnstile,
  openDateFrom,
  stubTurnstile,
} from "./harness.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const PUBLIC_PAGES = ["/", "/bookings", "/privacy", "/terms", "/cancellation"];

const chooseSlot = async (page: Page, startTime?: string): Promise<void> => {
  await page.fill("#booking-date", openDateFrom(await page.locator("#booking-date").inputValue()));
  // The slot fieldset is disabled while availability loads, so this check waits
  // out the load and cannot land on a slot rendered for the previous date.
  // Explicit times keep later scenarios off the early slots the other specs take.
  const slot = startTime
    ? page.locator(`#slot-list input[value="${startTime}"]`)
    : page.locator("#slot-list input").first();
  await slot.waitFor({ state: "attached" });
  await slot.check();
};

/** Walks selection -> details -> review, leaving the form ready to submit. */
const fillJourney = async (
  page: Page,
  {
    startTime,
    customerName = "検証 太郎",
    contact = "test-customer@example.invalid",
  }: { startTime?: string; customerName?: string; contact?: string } = {},
): Promise<void> => {
  await page.locator("#service-list input").first().check();
  await chooseSlot(page, startTime);
  await page.click("#selection-next");

  await page.fill("#customer-name", customerName);
  await page.fill("#customer-contact", contact);
  await page.check("#booking-consent");
  await page.click("#details-next");
  await expect(page.locator("#journey-review")).toBeVisible();
};

test("a customer can book from service selection through the recorded result", async ({ page }) => {
  await stubTurnstile(page);
  const created = await forwardCreateWithoutTurnstile(page);
  await page.goto("/");

  await expect(page.locator("[data-installation-mode]")).toHaveAttribute("data-installation-mode", "live");
  await fillJourney(page);
  await expect(page.locator("[data-review-name]")).toHaveText("検証 太郎");

  await page.click("#booking-submit");

  await expect(page.locator("#booking-result")).toBeVisible();
  await expect(page.locator("#result-reservation-id")).toHaveText(UUID);
  await expect(page.locator("#result-management-key")).not.toBeEmpty();
  await expect(page.locator("#booking-status")).toContainText("受け付けました");

  // The body the client built is its half of the API contract.
  expect(created.requests).toHaveLength(1);
  const body = created.requests[0]!;
  expect(body.turnstileToken).toBe("stub-turnstile-token");
  expect(body.replayOnly).toBe(false);
  expect(body.managementDigest).toMatch(/^[0-9a-f]{64}$/);
  expect(body.consentVersion).toBe("browser-test-consent-v1");

  // Focus has to land on the result, or a screen reader is left on a button
  // that no longer exists.
  await expect(page.locator("#booking-result")).toBeFocused();
});

test("the submit is refused until the anti-automation check passes", async ({ page }) => {
  await stubTurnstile(page, "error");
  const created = await forwardCreateWithoutTurnstile(page);
  await page.goto("/");
  await fillJourney(page);

  await expect(page.locator("#booking-status")).toContainText("自動送信防止の確認に失敗");
  // Nothing to click: without a token the submit stays disabled, which is the
  // fail-closed behaviour the server also enforces.
  await expect(page.locator("#booking-submit")).toBeDisabled();
  expect(created.requests).toHaveLength(0);
  await expect(page.locator("#booking-result")).toBeHidden();
});

test("a remembered booking is listed and offers cancellation", async ({ page }) => {
  await stubTurnstile(page);
  await forwardCreateWithoutTurnstile(page);
  await page.goto("/");
  await fillJourney(page);
  await page.click("#booking-submit");
  await expect(page.locator("#result-reservation-id")).toHaveText(UUID);
  const reservationId = await page.locator("#result-reservation-id").textContent();
  // The offer to remember a booking only exists once there is one to remember.
  await page.check("#remember-booking");

  await page.goto("/bookings");
  const card = page.locator("[data-booking-card]").first();
  await expect(card).toBeVisible();
  await expect(card.locator("[data-booking-reference]")).toHaveText(reservationId ?? "");
  await expect(page.locator("[data-bookings-empty]")).toBeHidden();

  await card.locator("[data-booking-cancel]").click();
  await expect(page.locator("[data-booking-cancel-dialog]")).toBeVisible();
});

test("a turnstile failure can be recovered within one session", async ({ page }) => {
  await stubTurnstile(page, "error");
  const created = await forwardCreateWithoutTurnstile(page);
  await page.goto("/");
  // Late slot: earlier specs take the first free morning times on this shared day.
  await fillJourney(page, {
    startTime: "15:00",
    customerName: "再試行 太郎",
    contact: "turnstile-retry@example.invalid",
  });

  await expect(page.locator("#booking-status")).toContainText("自動送信防止の確認に失敗");
  await expect(page.locator("#booking-submit")).toBeDisabled();
  expect(created.requests).toHaveLength(0);
  await expect(page.locator("#booking-result")).toBeHidden();

  // Same page session: flip the harness stub and re-settle the already-rendered widget.
  await page.evaluate(() => {
    window.__turnstileStub.mode = "success";
    window.turnstile.reset("0");
  });

  await expect(page.locator("#booking-submit")).toBeEnabled();
  await page.click("#booking-submit");

  await expect(page.locator("#booking-result")).toBeVisible();
  await expect(page.locator("#result-reservation-id")).toHaveText(UUID);
  await expect(page.locator("#result-management-key")).not.toBeEmpty();
  await expect(page.locator("#booking-status")).toContainText("受け付けました");
  expect(created.requests).toHaveLength(1);
  expect(created.requests[0]!.turnstileToken).toBe("stub-turnstile-token");
});

test("a remembered booking can be cancelled and stays cancelled after reload", async ({ page }) => {
  await stubTurnstile(page);
  await forwardCreateWithoutTurnstile(page);
  await page.goto("/");
  // Distinct afternoon slot so this booking does not collide with the other specs.
  await fillJourney(page, {
    startTime: "16:00",
    customerName: "取消 花子",
    contact: "cancel-complete@example.invalid",
  });
  await page.click("#booking-submit");
  await expect(page.locator("#result-reservation-id")).toHaveText(UUID);
  const reservationId = (await page.locator("#result-reservation-id").textContent()) ?? "";
  const managementKey = (await page.locator("#result-management-key").textContent()) ?? "";
  // fillJourney already set the date to openDateFrom; do not shift it again.
  const bookingDate = await page.locator("#booking-date").inputValue();
  await page.check("#remember-booking");

  await page.goto("/bookings");
  const card = page.locator("[data-booking-card]", {
    has: page.locator("[data-booking-reference]", { hasText: reservationId }),
  });
  await expect(card).toBeVisible();
  await card.locator("[data-booking-cancel]").click();
  await expect(page.locator("[data-booking-cancel-dialog]")).toBeVisible();
  await page.locator("[data-booking-cancel-confirm-button]").click();

  await expect(page.locator("[data-bookings-status]")).toContainText("取り消しました");
  await expect(card).toHaveAttribute("data-booking-state", "cancelled");
  await expect(card.locator("[data-booking-status]")).toContainText("取消済み");
  await expect(card.locator("[data-booking-cancel]")).toBeHidden();
  await expect(page.locator("[data-booking-cancel-dialog]")).toBeHidden();

  // The cancel response is not the only proof: re-read through the public status API.
  const apiStatus = await page.evaluate(
    async ({ id, date, key }) => {
      const response = await fetch(`/api/reservations/${encodeURIComponent(id)}/status`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ date, managementKey: key }),
      });
      return response.json();
    },
    { id: reservationId, date: bookingDate, key: managementKey },
  );
  expect(apiStatus.status).toBe("cancelled");

  await page.reload();
  const cardAfterReload = page.locator("[data-booking-card]", {
    has: page.locator("[data-booking-reference]", { hasText: reservationId }),
  });
  await expect(cardAfterReload).toBeVisible();
  await expect(cardAfterReload).toHaveAttribute("data-booking-state", "cancelled");
  await expect(cardAfterReload.locator("[data-booking-status]")).toContainText("取消済み");
  await expect(cardAfterReload.locator("[data-booking-cancel]")).toBeHidden();
});

test("the public pages carry no automated accessibility violations", async ({ page }) => {
  await stubTurnstile(page);
  for (const path of PUBLIC_PAGES) {
    await page.goto(path);
    await expectNoAxeViolations(page);
  }
});

test("keyboard alone reaches the first booking control and the skip link", async ({ page }) => {
  await stubTurnstile(page);
  await page.goto("/");

  await page.keyboard.press("Tab");
  await expect(page.locator(".skip-link")).toBeFocused();
  await page.keyboard.press("Enter");
  expect(new URL(page.url()).hash).toBe("#main");
  await page.keyboard.press("Tab");
  const insideMain = await page.evaluate(() =>
    document.querySelector("#main")?.contains(document.activeElement) === true);
  expect(insideMain, "the skip link did not move the tab sequence into the main region").toBe(true);

  await page.locator("#service-list input").first().focus();
  await page.keyboard.press("Space");
  await expect(page.locator("#service-list input").first()).toBeChecked();
});

for (const viewport of VIEWPORTS) {
  test(`the public pages fit ${viewport.name} pixels wide`, async ({ page }) => {
    await stubTurnstile(page);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    for (const path of PUBLIC_PAGES) {
      await page.goto(path);
      await expectNoHorizontalOverflow(page);
    }
  });
}
