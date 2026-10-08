import { expect, test } from "@playwright/test";

import {
  ALLOWED_HOSTNAME,
  OWNER_TOKEN,
  SERVER_ORIGIN,
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

/**
 * The credential exists in the response to the command that minted it and
 * nowhere else. The screen refreshes the roster around that moment, and a
 * refresh is a second request that can fail on its own — so the order of those
 * two steps decides whether a failure costs a list or costs the credential.
 */
test("a failed roster refresh does not take the new credential with it", async ({ page }) => {
  await page.goto("/setup");
  await page.fill("#setup-owner-token", OWNER_TOKEN);
  await page.click("#setup-auth-submit");
  await expect(page.locator("#setup-auth-status")).toContainText("認証しました");
  await expect(page.locator("#staff-submit")).toBeEnabled();

  // Only the refresh is broken. The create still succeeds, which is exactly the
  // situation where the credential is irrecoverable if it is dropped.
  await page.route("**/api/admin/staff", (route) =>
    route.request().method() === "GET" ? route.abort("failed") : route.continue(),
  );

  await page.fill("#staff-display-name", "検証 当番");
  await page.click("#staff-submit");

  await expect(page.locator("[data-staff-credential]")).toBeVisible();
  await expect(page.locator("[data-staff-credential-value]")).toHaveText(
    /^[A-Za-z0-9_-]{43}$/,
  );
});

test("an issued credential does not survive signing out, or a second sign-in", { tag: "@private-artifact" }, async ({
  page,
}) => {
  await page.goto("/setup");
  await page.fill("#setup-owner-token", OWNER_TOKEN);
  await page.click("#setup-auth-submit");
  await expect(page.locator("#setup-auth-status")).toContainText("認証しました");
  await expect(page.locator("#staff-submit")).toBeEnabled();

  const writeCommitted = Promise.withResolvers<void>();
  const writeReply = Promise.withResolvers<void>();
  const rosterRequested = Promise.withResolvers<void>();
  const rosterReply = Promise.withResolvers<void>();
  let holdRoster = true;
  await page.route("**/api/admin/staff", async (route) => {
    if (route.request().method() === "POST") {
      const response = await route.fetch({
        url: `${SERVER_ORIGIN}/api/admin/staff`,
        headers: { ...route.request().headers(), host: new URL(route.request().url()).host },
      });
      expect(response.ok()).toBe(true);
      writeCommitted.resolve();
      await writeReply.promise;
      await route.fulfill({ response });
    } else if (holdRoster) {
      holdRoster = false;
      const response = await route.fetch({
        url: `${SERVER_ORIGIN}/api/admin/staff`,
        headers: { ...route.request().headers(), host: new URL(route.request().url()).host },
      });
      rosterRequested.resolve();
      await rosterReply.promise;
      await route.fulfill({ response });
    } else {
      await route.continue();
    }
  });

  try {
    await page.fill("#staff-display-name", "検証 交代");
    await page.click("#staff-submit");
    await writeCommitted.promise;
    // The real write committed, but its response has not reached this session.
    await page.click("#setup-logout");
    await expect(page.locator("#setup-auth-status")).toContainText("再確認してからログアウト");
    await expect(page.locator("#setup-location-name")).toBeEnabled();
    await page.fill("#setup-owner-token", OWNER_TOKEN);
    await page.click("#setup-auth-submit");
    await expect(page.locator("#setup-auth-status")).toContainText("再確認してから認証し直して");
    await expect(page.locator("#setup-location-name")).toBeEnabled();

    writeReply.resolve();
    await rosterRequested.promise;
    await expect.poll(() => page.locator("[data-staff-credential-value]").evaluate(
      (element) => /^[A-Za-z0-9_-]{43}$/.test(element.textContent ?? ""),
    )).toBe(true);

    // A read-only refresh must not keep the one-time secret on a signed-out screen.
    await page.click("#setup-logout");
    await expect.poll(() => page.locator("[data-staff-credential]").evaluate(
      (element) => element instanceof HTMLElement && element.hidden,
    )).toBe(true);
    expect(await page.locator("[data-staff-credential-value]").evaluate(
      (element) => element.textContent === "",
    )).toBe(true);
    const finished = page.waitForEvent("requestfinished", {
      predicate: (request) => request.method() === "GET" && request.url().endsWith("/api/admin/staff"),
    });
    rosterReply.resolve();
    await finished;
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    await expect(page.locator("[data-staff-list]")).toContainText("認証すると、登録済みのスタッフを表示します");
    await expect(page.locator("#staff-submit")).toBeDisabled();

    await page.fill("#setup-owner-token", OWNER_TOKEN);
    await page.click("#setup-auth-submit");
    await expect(page.locator("#setup-auth-status")).toContainText("認証しました");
    expect(await page.locator("[data-staff-credential]").evaluate(
      (element) => element instanceof HTMLElement && element.hidden,
    )).toBe(true);
    expect(await page.locator("[data-staff-credential-value]").evaluate(
      (element) => element.textContent === "",
    )).toBe(true);
  } finally {
    writeReply.resolve();
    rosterReply.resolve();
    // Failed assertions must not leave a secret in Playwright's error context.
    await page.locator("[data-staff-credential-value]").evaluate((element) => { element.textContent = ""; });
  }
});

test("reauthentication clears old setup fields and receipt before the new directory returns", async ({ page }) => {
  page.on("dialog", (dialog) => dialog.accept());
  await page.goto("/setup");
  await page.fill("#setup-owner-token", OWNER_TOKEN);
  await page.click("#setup-auth-submit");
  await expect(page.locator("#setup-auth-status")).toContainText("認証しました");
  await page.fill("#setup-operator-contact", "OLD_PRIVATE");
  await expect(page.locator("[data-installation-receipt]")).toBeVisible();

  let release!: () => void;
  let requested!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { requested = resolve; });
  await page.route("**/api/admin/locations", async (route) => {
    requested();
    await held;
    await route.continue();
  });
  await page.fill("#setup-owner-token", "invalid-credential-000000000000000000000");
  await page.click("#setup-auth-submit");
  try {
    await started;
    await expect(page.locator("#setup-operator-contact")).toBeEmpty();
    await expect(page.locator("#setup-operator-contact")).toBeDisabled();
    await expect(page.locator("[data-installation-receipt]")).toBeHidden();
    await expect(page.locator("[data-calendar-token-box]")).toBeHidden();
  } finally {
    release();
  }
  await expect(page.locator("#setup-auth-status")).toHaveAttribute("data-tone", "error");
});

/** Authentication is disabled in delivered HTML until its handlers are ready. */
for (const outcome of ["success", "failure"] as const) {
  test(`setup authentication waits for initialization: ${outcome}`, async ({ page }) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let requested!: () => void;
    const started = new Promise<void>((resolve) => { requested = resolve; });
    await page.route("**/api/config", async (route) => {
      requested();
      await gate;
      if (outcome === "failure") await route.abort("failed");
      else await route.continue();
    });
    try {
      await page.goto("/setup", { waitUntil: "domcontentloaded" });
      await started;
      await expect(page.locator("#setup-auth-submit")).toBeDisabled();
      await expect(page.locator("#setup-owner-token")).toBeDisabled();
    } finally {
      release();
    }
    await expect(page.locator("#setup-auth-submit")).toBeEnabled();
    await page.fill("#setup-owner-token", OWNER_TOKEN);
    await page.click("#setup-auth-submit");
    await expect(page.locator("#setup-auth-status")).toContainText("認証しました");
    await expect(page.locator("#staff-submit")).toBeEnabled();
  });
}

test("operator authentication waits for initialization", async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let requested!: () => void;
  const started = new Promise<void>((resolve) => { requested = resolve; });
  await page.route("**/api/config", async (route) => {
    requested();
    await gate;
    await route.continue();
  });
  const submit = page.locator("#auth-form button[type=submit]");
  try {
    await page.goto("/admin", { waitUntil: "domcontentloaded" });
    await started;
    await expect(submit).toBeDisabled();
    await expect(page.locator("#owner-token")).toBeDisabled();
  } finally {
    release();
  }
  await expect(submit).toBeEnabled();
  await page.fill("#owner-token", OWNER_TOKEN);
  await submit.click();
  await expect(page.locator("#auth-status")).toContainText("認証しました");
});
