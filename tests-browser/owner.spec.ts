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
  // The page init fills the schedule date after its config fetch and ends in a
  // logged-out reset; a submit that outruns it gets silently rolled back.
  await expect(page.locator("#admin-date")).not.toHaveValue("", { timeout: 15_000 });
  await page.fill("#owner-token", OWNER_TOKEN);
  await page.click("#auth-form button[type=submit]");
  await expect(page.locator("#auth-status")).toContainText("認証しました", { timeout: 20_000 });
};

// The availability loader stamps its interim text synchronously when a date
// or service change starts it, so a settled status means no reload is in
// flight — and a start time selected after this point cannot be reset by a
// late option-list re-render.
const waitForAvailabilitySettled = async (page: Page): Promise<void> => {
  await expect(page.locator("#owner-create-status")).not.toContainText("確認しています", {
    timeout: 15_000,
  });
};

const openDayBoardAt = async (page: Page, date: string): Promise<void> => {
  await page.click("#schedule-view-day");
  await expect(page.locator("#day-board")).toBeVisible();
  await page.fill("#admin-date", date);
  await page.locator("#admin-date").blur();
  await waitForAvailabilitySettled(page);
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
  await page.locator("#admin-date").blur();
  await waitForAvailabilitySettled(page);
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

// One signed-in session checks every viewport: the sign-in burst of four
// separate tests bought nothing, and resizing an authenticated page keeps
// the assertions identical.
test("the operator screens fit every supported viewport", async ({ page }) => {
  await stubTurnstile(page);
  await signIn(page);
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await expectNoHorizontalOverflow(page);
  }
  // The setup screen shows its own sign-in form; the overflow check never
  // needed the operator session.
  await page.goto("/setup");
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await expectNoHorizontalOverflow(page);
  }
});

test("an owner status action updates the schedule and survives reload", async ({ page }) => {
  await stubTurnstile(page);
  await signIn(page);

  // complete/no_show require an elapsed endAt, so a future booking cannot use them
  // without a production change. cancel is the live status action on an approved row.
  // 14:00 is free of the morning/late slots the other shared-day specs take.
  const date = openDateFrom(await page.locator("#admin-date").inputValue());
  await page.locator("#owner-service-list input").first().check();
  // Sign-in defaults to the 7-day board; detail actions live on the day board only.
  await openDayBoardAt(page, date);
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
  await signIn(page);
  const rowAfterReload = page.locator("[data-reservation-list] article", { hasText: "状態 検証" });
  await openDayBoardAt(page, date);
  await expect(rowAfterReload).toBeVisible();
  await expect(rowAfterReload.locator(".badge")).toContainText("取消済み");
  await rowAfterReload.getByRole("button", { name: "詳細を開く" }).click();
  await expect(page.locator("[data-detail-status]")).toContainText("取消済み");
});

test("calendar diagnostics and reconciliation stay owner-only", async ({ page }) => {
  await stubTurnstile(page);
  await signIn(page);
  const result = await page.evaluate(async (ownerToken) => {
    const deniedResponses = await Promise.all([
      fetch("/api/admin/calendar/status", { cache: "no-store" }),
      fetch("/api/admin/calendar/status", {
        headers: { authorization: "Bearer invalid" },
        cache: "no-store",
      }),
      fetch("/api/admin/calendar/reconcile", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
      fetch("/api/admin/calendar/reconcile", {
        method: "POST",
        headers: {
          authorization: "Bearer invalid",
          "content-type": "application/json",
        },
        body: "{}",
      }),
    ]);
    const headers = {
      authorization: `Bearer ${ownerToken}`,
      "content-type": "application/json",
    };
    const status = await fetch("/api/admin/calendar/status", {
      headers,
      cache: "no-store",
    });
    const reconcile = await fetch("/api/admin/calendar/reconcile", {
      method: "POST",
      headers,
      body: "{}",
    });
    return {
      denied: await Promise.all(
        deniedResponses.map(async (response) => ({
          status: response.status,
          body: await response.text(),
        })),
      ),
      statusCode: status.status,
      status: await status.json(),
      reconcileCode: reconcile.status,
      reconcile: await reconcile.json(),
    };
  }, OWNER_TOKEN);
  expect(result).toMatchObject({
    statusCode: 200,
    status: {
      ok: true,
      modes: {
        ics: { configured: true, active: true },
        google: { configured: false, active: false },
      },
      authority: { state: "active", generation: 1 },
    },
    reconcileCode: 200,
    reconcile: { ok: true, processedDates: 7 },
  });
  expect(result.denied.map(({ status }) => status)).toEqual([401, 401, 401, 401]);
  expect(JSON.stringify(result)).not.toMatch(
    /AAAAAAAA|reservationId|externalId|calendarId|authorization|owner-test-token/i,
  );

  const calendarRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/calendar/")) calendarRequests.push(request.url());
  });
  await page.goto("/");
  await expect(page.locator("main")).toBeVisible();
  await expect(page.locator("body")).not.toContainText(/calendar|カレンダー/i);
  expect(calendarRequests).toEqual([]);
});
