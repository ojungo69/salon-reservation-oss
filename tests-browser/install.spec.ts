import { expect, test } from "@playwright/test";

import {
  ALLOWED_HOSTNAME,
  OWNER_TOKEN,
  SOURCE_URL,
  TURNSTILE_SITE_KEY,
  expectNoAxeViolations,
  expectNoHorizontalOverflow,
  stubTurnstile,
} from "./harness.ts";

/**
 * Runs before every other spec, because a fresh installation starts in demo
 * mode with placeholder identity text and refuses public reservations until an
 * owner completes it. Driving that through the rendered form rather than the
 * API is deliberate: it is also the setup screen's smoke test.
 */
test("an owner completes the installation through the setup screen", async ({ page }) => {
  await stubTurnstile(page);
  page.on("dialog", (dialog) => dialog.accept());
  await page.goto("/setup");

  await expect(page.locator("[data-setup-mode-notice]")).toContainText("デモ");
  await expect(page.locator("#setup-location-name")).toBeDisabled();
  await expectNoAxeViolations(page);
  await expectNoHorizontalOverflow(page);

  await page.fill("#setup-owner-token", OWNER_TOKEN);
  await page.click("#setup-auth-submit");
  await expect(page.locator("#setup-location-name")).toBeEnabled();
  await expect(page.locator("#setup-auth-status")).toContainText("認証しました");

  await page.fill("#setup-location-name", "ブラウザ検証サロン");
  await page.fill("#setup-operator-name", "検証 運営者");
  await page.fill("#setup-operator-contact", "お問い合わせフォームをご利用ください");
  await page.fill("#setup-source-url", SOURCE_URL);
  await page.fill("#setup-privacy-notice", "予約の受付に必要な情報だけを利用します。");
  await page.fill("#setup-terms-notice", "表示内容を確認してから予約を送信してください。");
  await page.fill("#setup-cancellation-policy", "予約の管理画面からキャンセルできます。");
  // Rewriting the legal notices without a new consent version is refused, so
  // that nobody is recorded as having accepted text they were never shown.
  await page.fill("#setup-consent-version", "browser-test-consent-v1");
  await page.fill("#setup-turnstile-site-key", TURNSTILE_SITE_KEY);
  await page.fill("#setup-allowed-hostname", ALLOWED_HOSTNAME);
  await page.click("#setup-save");
  await expect(page.locator("#setup-status")).toContainText("として保存しました");

  await expect(page.locator("#setup-enable-live")).toBeEnabled();
  await page.click("#setup-enable-live");
  await expect(page.locator("#setup-status")).toContainText("公開予約を有効にしました");

  // Read through the page: Chromium is the only process told how to resolve
  // this hostname, so Node's request context cannot reach the dev server.
  const mode = await page.evaluate(async () => {
    const response = await fetch("/api/config", { cache: "no-store" });
    return (await response.json()).mode;
  });
  expect(mode).toBe("live");

  // Signing out restores the notice a visitor would see, and the installation
  // has been published since this page loaded, so the demo notice it opened
  // with is no longer true.
  await page.click("#setup-logout");
  await expect(page.locator("#setup-location-name")).toBeDisabled();
  await expect(page.locator("[data-setup-mode-notice]")).not.toContainText("デモ");
  await expect(page.locator("[data-setup-mode-notice]")).toContainText("公開予約を受け付けています");
});
