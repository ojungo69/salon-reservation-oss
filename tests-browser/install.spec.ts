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

/**
 * The roster screen is where an owner hands out and takes away access, so the
 * two moments that matter are that the credential is readable exactly once and
 * that stopping someone is visible on the page afterwards. The name below is
 * invented, as every fixture name in this repository is.
 */
test("an owner adds a staff member, reads the credential once, and stops them", async ({
  page,
}) => {
  page.on("dialog", (dialog) => dialog.accept());
  await page.goto("/setup");
  await page.fill("#setup-owner-token", OWNER_TOKEN);
  await page.click("#setup-auth-submit");
  await expect(page.locator("#setup-auth-status")).toContainText("認証しました");

  await expect(page.locator("[data-staff-list]")).toContainText("まだ誰も登録されていません");
  await expect(page.locator("[data-staff-credential]")).toBeHidden();

  await page.fill("#staff-display-name", "検証 受付");
  await page.selectOption("#staff-role", "staff");
  await page.click("#staff-submit");

  await expect(page.locator("#staff-status")).toContainText("一度だけ表示します");
  const credential = await page.locator("[data-staff-credential-value]").innerText();
  // 32 random bytes as base64url, which is the shape the Worker mints.
  expect(credential).toMatch(/^[A-Za-z0-9_-]{43}$/);

  const member = page.locator(".staff-item").filter({ hasText: "検証 受付" });
  await expect(member).toContainText("有効");
  await expect(member).toContainText("日々の予約対応");
  await expect(page.locator("[data-staff-count]")).toHaveText("有効 1人");
  await expectNoAxeViolations(page);
  await expectNoHorizontalOverflow(page);

  await member.getByRole("button", { name: "停止する" }).click();
  await expect(member).toContainText("停止中");
  await expect(page.locator("#staff-status")).toContainText("次の操作から認証できません");
  await expect(page.locator("[data-staff-count]")).toHaveText("有効 0人");
  // The credential was in one response and is not in the page any more; there
  // is no read that returns it and no second chance to copy it.
  await expect(page.locator("[data-staff-credential]")).toBeHidden();
  await expect(page.locator("[data-staff-list]")).not.toContainText(credential);
});

/**
 * The signed-out notice follows the publication mode, which the page learns
 * from the public config. When that read fails the page has nothing better to
 * say than the notice it was served with, and blanking the banner would leave
 * an operator with no statement of the publication state at all.
 */
test("the setup screen keeps its served notice when the public config is unreachable", async ({
  page,
}) => {
  await page.route("**/api/config", (route) => route.abort("failed"));
  await page.goto("/setup");

  await expect(page.locator("#setup-auth-status")).toContainText("公開設定を読み込めませんでした");
  await expect(page.locator("[data-setup-mode-notice]")).toContainText("デモ");
});
