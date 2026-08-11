import { expect, test, type Page } from "@playwright/test";

import {
  BROWSER_ORIGIN,
  OWNER_TOKEN,
  SERVER_ORIGIN,
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
  expect(managementKey).not.toBe("");
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

test("the slot list refreshes in place and shows the operator notice when configured", async ({ page }) => {
  await stubTurnstile(page);
  await page.goto("/");
  await expect(page.locator("[data-availability-notice]")).toBeHidden();

  const original = await updateInstallationSettings(page, (settings) => ({
    ...settings,
    availabilityNotice: "本日は短縮営業です",
  }));
  try {
    await page.reload();
    await expect(page.locator("[data-availability-notice]")).toHaveText("本日は短縮営業です");

    await page.locator("#service-list input").first().check();
    await chooseSlot(page, "12:00");
    await page.click("[data-availability-refresh]");
    await expect(page.locator("#booking-status")).toHaveText("空き時間を更新しました。");
    // The refresh keeps the already chosen time while re-rendering the list.
    await expect(page.locator("#slot-list input[value='12:00']")).toBeChecked();
  } finally {
    await updateInstallationSettings(page, () => original);
  }

  await page.reload();
  await expect(page.locator("[data-availability-notice]")).toBeHidden();
});

test("a remembered same-day booking asks for acknowledgement before a second request", async ({ page }) => {
  await stubTurnstile(page);
  const created = await forwardCreateWithoutTurnstile(page);
  await page.goto("/");
  await fillJourney(page, {
    startTime: "13:00",
    customerName: "重複 一郎",
    contact: "duplicate-first@example.invalid",
  });
  await page.click("#booking-submit");
  await expect(page.locator("#result-reservation-id")).toHaveText(UUID);
  await page.check("#remember-booking");
  expect(created.requests).toHaveLength(1);

  // A second journey on the same day in the same browser.
  await page.goto("/");
  // 16:00 was freed by the cancellation spec; 14:00 stays for the owner spec.
  await fillJourney(page, {
    startTime: "16:00",
    customerName: "重複 二郎",
    contact: "duplicate-second@example.invalid",
  });
  await page.click("#booking-submit");
  await expect(page.locator("[data-duplicate-dialog]")).toBeVisible();

  // Reviewing instead closes the dialog and sends nothing.
  await page.click("[data-duplicate-review]");
  await expect(page.locator("[data-duplicate-dialog]")).toBeHidden();
  expect(created.requests).toHaveLength(1);

  // Acknowledging resubmits the same journey and completes it.
  await page.click("#booking-submit");
  await expect(page.locator("[data-duplicate-dialog]")).toBeVisible();
  await page.click("[data-duplicate-continue]");
  await expect(page.locator("#booking-result")).toBeVisible();
  await expect(page.locator("#result-reservation-id")).toHaveText(UUID);
  expect(created.requests).toHaveLength(2);
});

test("capacity and stale-slot answers read correctly inside the shell", async ({ page }) => {
  await stubTurnstile(page);
  await page.goto("/");

  // A full day: the server said times exist but the day cap is reached.
  await page.route(
    "**/api/availability*",
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          settingsVersion: 1,
          services: [],
          resources: [{ id: "resource-demo", label: "デモ担当", startTimes: [] }],
          serviceMinutes: 60,
          cleanupMinutes: 0,
          occupiedMinutes: 60,
          priceYen: null,
          capacityReached: true,
        }),
      }),
    { times: 1 },
  );
  await page.locator("#service-list input").first().check();
  await expect(page.locator("#slot-list")).toContainText(
    "受付できる予約数の上限に達した",
  );

  // Back on live data, a slot that disappears between review and submit is
  // explained and the journey returns to the selection step.
  await chooseSlot(page, "12:00");
  await page.click("#selection-next");
  await page.fill("#customer-name", "枠切れ 検証");
  await page.fill("#customer-contact", "stale-slot@example.invalid");
  await page.check("#booking-consent");
  await page.click("#details-next");
  await expect(page.locator("#journey-review")).toBeVisible();
  await page.route("**/api/reservations", (route) =>
    route.request().method() === "POST"
      ? route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({ ok: false, error: { code: "UNAVAILABLE" } }),
        })
      : route.fallback(),
  );
  await page.click("#booking-submit");
  await expect(page.locator("#booking-status")).toContainText(
    "選んだ内容を現在受け付けられません",
  );
  await expect(page.locator("#journey-selection")).toBeVisible();
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

const SETUP_HEADERS = {
  host: new URL(BROWSER_ORIGIN).host,
  origin: BROWSER_ORIGIN,
  authorization: `Bearer ${OWNER_TOKEN}`,
};

/**
 * Rewrites the stored settings through a read-modify-write. Talks to the dev
 * server from Node the same way the create forward does, so a wedged page
 * cannot strand the shared installation in a mutated state for the specs that
 * follow: every mutating test restores inside a finally around this helper.
 */
const updateInstallationSettings = async (
  page: Page,
  mutate: (settings: Record<string, unknown>) => Record<string, unknown>,
): Promise<Record<string, unknown>> => {
  const currentResponse = await page.request.fetch(`${SERVER_ORIGIN}/api/admin/setup`, {
    headers: SETUP_HEADERS,
  });
  expect(currentResponse.status()).toBe(200);
  const current = (await currentResponse.json()) as {
    settingsVersion: number;
    settings: Record<string, unknown>;
  };
  const response = await page.request.fetch(`${SERVER_ORIGIN}/api/admin/setup`, {
    method: "PUT",
    headers: { ...SETUP_HEADERS, "content-type": "application/json" },
    data: {
      commandId: crypto.randomUUID(),
      expectedSettingsVersion: current.settingsVersion,
      settings: mutate(structuredClone(current.settings)),
    },
  });
  expect(response.status(), "installation settings update").toBe(200);
  return current.settings;
};

const setResourceChoice = (page: Page, expose: boolean | null): Promise<Record<string, unknown>> =>
  updateInstallationSettings(page, ({ exposeResourceChoice: _previous, ...settings }) =>
    expose === null ? settings : { ...settings, exposeResourceChoice: expose },
  );

test("the details step summarizes the choices and edit links jump back to the owning field", async ({ page }) => {
  await stubTurnstile(page);
  await page.goto("/");
  await page.locator("#service-list input").first().check();
  await chooseSlot(page, "11:00");
  const date = await page.locator("#booking-date").inputValue();
  const resourceLabel = (await page.locator("#booking-resource option:checked").textContent()) ?? "";
  expect(resourceLabel).not.toBe("");
  await page.click("#selection-next");

  await expect(page.locator("[data-summary-card]")).toBeVisible();
  await expect(page.locator("[data-summary-services]")).not.toHaveText("未選択");
  await expect(page.locator("[data-summary-resource]")).toHaveText(resourceLabel);
  await expect(page.locator("[data-summary-time]")).toHaveText(`${date} 11:00`);
  await expect(page.locator("[data-summary-duration]")).toContainText("計");
  // The demo catalog publishes no price, so the availability-backed wording is
  // the announce-on-site copy rather than a number.
  await expect(page.locator("[data-summary-price]")).toHaveText("料金は当日ご案内します");

  await page.click("[data-summary-edit='booking-date']");
  await expect(page.locator("#journey-selection")).toBeVisible();
  await expect(page.locator("#booking-date")).toBeFocused();
  await page.locator('#slot-list input[value="12:00"]').check();
  await page.click("#selection-next");
  await expect(page.locator("[data-summary-time]")).toHaveText(`${date} 12:00`);

  await page.fill("#customer-name", "要約 確認");
  await page.fill("#customer-contact", "summary-card@example.invalid");
  await page.check("#booking-consent");
  await page.click("#details-next");
  await expect(page.locator("[data-confirmation-panel]")).toBeVisible();
  await expect(page.locator("[data-review-resource]")).toHaveText(resourceLabel);
  await expect(page.locator("[data-review-time]")).toHaveText(`${date} 12:00`);
});

test("the summary card and confirmation panel fit every supported viewport", async ({ page }) => {
  await stubTurnstile(page);
  await page.goto("/");
  // 12:00 stays free: the booking specs take the morning slots, 13:00-16:00.
  await fillJourney(page, { startTime: "12:00" });
  await expectNoAxeViolations(page);
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await expectNoHorizontalOverflow(page);
  }

  await page.click("[data-journey-back='details']");
  await expect(page.locator("[data-summary-card]")).toBeVisible();
  await expectNoAxeViolations(page);
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await expectNoHorizontalOverflow(page);
  }
});

test("past eight services a keyboard-only filter, chips and totals drive the selection", async ({ page }) => {
  await stubTurnstile(page);
  await page.goto("/");

  // The shipped one-service catalog stays on the flat list with no compact chrome.
  await page.locator("#service-list [data-service-option]").first().waitFor();
  await expect(page.locator("[data-service-filter]")).toBeHidden();
  await expect(page.locator("[data-service-chips]")).toBeHidden();
  await expect(page.locator("[data-service-totals]")).toBeHidden();
  const flatListHtml = await page.locator("#service-list").innerHTML();

  const original = await updateInstallationSettings(page, (settings) => {
    const resourceId = (settings.resources as Array<{ id: string }>)[0]!.id;
    return {
      ...settings,
      services: Array.from({ length: 9 }, (_, index) => ({
        id: `svc-${index + 1}`,
        label: `検証サービス${index + 1}`,
        category: index === 0 ? "ヘア" : null,
        durationMinutes: 60,
        cleanupMinutes: 0,
        priceYen: index < 2 ? 1_000 * (index + 1) : null,
        eligibleResourceIds: [resourceId],
        active: true,
      })),
    };
  });
  try {
    await page.reload();
    const options = page.locator("#service-list [data-service-option]");
    await expect(options).toHaveCount(9);
    await expect(page.locator("[data-service-filter]")).toBeVisible();

    // Keyboard only: type a query, tab into the narrowed list, select by Space.
    await page.locator("#service-filter-input").focus();
    await page.keyboard.type("検証サービス2");
    await expect(page.locator("#service-list [data-service-option]:visible")).toHaveCount(1);
    await expect(page.locator("[data-service-filter-count]")).toHaveText(
      "9件中1件を表示しています。",
    );
    await page.keyboard.press("Tab");
    await page.keyboard.press("Space");
    await expect(page.locator("input[name='serviceIds'][value='svc-2']")).toBeChecked();

    // Clearing the filter keeps the selection and both totals lines honest:
    // one selection with a listed price shows the sum.
    await page.locator("#service-filter-input").fill("");
    await expect(page.locator("#service-list [data-service-option]:visible")).toHaveCount(9);
    await expect(page.locator("[data-service-chips] button")).toHaveCount(1);
    await expect(page.locator("[data-service-totals]")).toHaveText(
      "選択中 1件 / 目安 60分 / 2,000円",
    );

    // A second service with no listed price withholds the partial sum.
    await page.locator("input[name='serviceIds'][value='svc-3']").focus();
    await page.keyboard.press("Space");
    await expect(page.locator("[data-service-totals]")).toHaveText(
      "選択中 2件 / 目安 120分 / 料金は当日ご案内します",
    );

    // Chip removal by keyboard unchecks the hidden source checkbox.
    await page.locator("[data-service-chips] button", { hasText: "検証サービス3" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("input[name='serviceIds'][value='svc-3']")).not.toBeChecked();
    await expect(page.locator("[data-service-totals]")).toHaveText(
      "選択中 1件 / 目安 60分 / 2,000円",
    );

    await expectNoAxeViolations(page);
  } finally {
    await updateInstallationSettings(page, () => original);
  }

  // Back under the threshold the flat list renders exactly as before.
  await page.reload();
  await page.locator("#service-list [data-service-option]").first().waitFor();
  await expect(page.locator("[data-service-filter]")).toBeHidden();
  expect(await page.locator("#service-list").innerHTML()).toBe(flatListHtml);
});

test("hiding the resource choice auto-assigns and shows the assignment on every surface", async ({ page }) => {
  await stubTurnstile(page);
  await page.goto("/");
  await setResourceChoice(page, false);
  try {
    await page.reload();
    await page.locator("#service-list input").first().check();
    await chooseSlot(page, "11:00");
    await expect(page.locator("[data-resource-row]")).toBeHidden();
    await expect(page.locator("[data-assigned-resource]")).toBeVisible();
    await expect(page.locator("[data-assigned-resource]")).toContainText("自動で割り当てました");

    await page.click("#selection-next");
    await expect(page.locator("[data-summary-resource]")).not.toHaveText("未選択");
    await expect(page.locator("[data-summary-edit='booking-resource']")).toBeHidden();

    await page.fill("#customer-name", "自動 割当");
    await page.fill("#customer-contact", "auto-resource@example.invalid");
    await page.check("#booking-consent");
    await page.click("#details-next");
    await expect(page.locator("[data-confirmation-panel]")).toBeVisible();
    await expect(page.locator("[data-review-resource]")).not.toHaveText("未選択");
  } finally {
    await setResourceChoice(page, null);
  }
});
