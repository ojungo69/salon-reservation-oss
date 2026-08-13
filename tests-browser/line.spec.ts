import { expect, test, type Page } from "@playwright/test";

import {
  BROWSER_ORIGIN,
  OWNER_TOKEN,
  VIEWPORTS,
  expectNoAxeViolations,
  expectNoHorizontalOverflow,
  forwardCreateWithoutTurnstile,
  openDateFrom,
  stubTurnstile,
} from "./harness.ts";

// Fictional identifiers only — the shape the Worker validates, never a real
// channel. page.route intercepts browser-initiated requests only (SDK loads,
// LIFF navigation). The Worker's own outbound fetches to LINE are covered at
// the Workers-test level, not here.
const LINE_IDENTIFIERS = {
  liffId: "1234567890-abcdefgh",
  loginChannelId: "1234567890",
  messagingChannelId: "9876543210",
};

const LINE_ORIGINS = ["https://static.line-scdn.net/**", "https://api.line.me/**", "https://liff.line.me/**"];

/** Abort every LINE-bound browser request and count the attempts. */
const interceptLineOrigins = async (page: Page): Promise<{ attempts: string[] }> => {
  const attempts: string[] = [];
  for (const pattern of LINE_ORIGINS) {
    await page.route(pattern, (route) => {
      attempts.push(route.request().url());
      return route.abort();
    });
  }
  return { attempts };
};

/** Owner LINE lifecycle command issued from the browser context (real origin
 * and hostname, real Worker, real Durable Objects). */
const lineCommand = async (
  page: Page,
  operation: "settings" | "enable" | "disable",
  expectedLifecycleVersion: number,
): Promise<{ lifecycleVersion: number }> => {
  const result = await page.evaluate(
    async ([op, version, token, identifiers]) => {
      const body: Record<string, unknown> = {
        commandId: crypto.randomUUID(),
        expectedLifecycleVersion: version,
      };
      if (op !== "disable") body.identifiers = identifiers;
      const response = await fetch(`/api/admin/line/${op}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    },
    [operation, expectedLifecycleVersion, OWNER_TOKEN, LINE_IDENTIFIERS] as const,
  );
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return result.body as { lifecycleVersion: number };
};

type LineStatus = {
  phase: "disabled" | "activating" | "active" | "deactivating";
  lifecycleVersion: number;
  draft: typeof LINE_IDENTIFIERS | null;
};

const lineStatus = async (page: Page): Promise<LineStatus> => {
  const result = await page.evaluate(async (token) => {
    const response = await fetch("/api/admin/line/status", {
      headers: { authorization: `Bearer ${token}` },
    });
    return { status: response.status, body: await response.json() };
  }, OWNER_TOKEN);
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return result.body as LineStatus;
};

const ensureLineActive = async (page: Page): Promise<void> => {
  await page.goto("/");
  const status = await lineStatus(page);
  if (status.phase === "active") return;
  expect(status.phase).toBe("disabled");
  let lifecycleVersion = status.lifecycleVersion;
  if (status.draft === null) {
    lifecycleVersion = (await lineCommand(page, "settings", lifecycleVersion)).lifecycleVersion;
  }
  await lineCommand(page, "enable", lifecycleVersion);
  await expect.poll(() => lineStatus(page).then(({ phase }) => phase)).toBe("active");
};

const configText = (page: Page): Promise<string> =>
  page.evaluate(async () => {
    const response = await fetch("/api/config", { cache: "no-store" });
    return response.text();
  });

const pageStatus = async (page: Page, path: string): Promise<number> =>
  page.evaluate(async (target) => (await fetch(target, { cache: "no-store" })).status, path);

/** Books a fresh reservation through the real UI and saves it to the browser.
 * Two openDateFrom hops land on a day the other ordered specs never touch, so
 * this suite's slots cannot collide with theirs. */
const bookAndRemember = async (page: Page, startTime: string): Promise<void> => {
  await stubTurnstile(page);
  await forwardCreateWithoutTurnstile(page);
  await page.goto("/");
  await page.locator("#service-list input").first().check();
  await page.fill(
    "#booking-date",
    openDateFrom(openDateFrom(await page.locator("#booking-date").inputValue())),
  );
  const slot = page.locator(`#slot-list input[value="${startTime}"]`);
  await slot.waitFor({ state: "attached" });
  await slot.check();
  await page.click("#selection-next");
  await page.fill("#customer-name", "連携 花子");
  await page.fill("#customer-contact", "line-test@example.invalid");
  await page.check("#booking-consent");
  await page.click("#details-next");
  await page.click("#booking-submit");
  await expect(page.locator("#booking-result")).toBeVisible();
  await page.check("#remember-booking");
};

test.describe("state 1: never configured", () => {
  test("no LINE trace exists on any surface", async ({ page }) => {
    const intercepted = await interceptLineOrigins(page);

    // /api/config carries no adapter property at all.
    await page.goto("/");
    expect("lineAdapter" in (JSON.parse(await configText(page)) as object)).toBe(false);

    // The LINE-only paths do not exist: they return the site's 404 page.
    for (const path of [
      "/line",
      "/line/",
      "/line.html",
      "/line/index",
      "/line/index.html",
      "/line-liff.mjs",
      "/line-link.mjs",
    ]) {
      expect(await pageStatus(page, path), path).toBe(404);
    }

    // The privacy page renders no LINE section.
    await page.goto("/privacy");
    await expect(page.locator("main")).not.toContainText("LINE");

    // A saved booking renders without any LINE affordance, and the page
    // fetched nothing LINE-shaped while doing so.
    await bookAndRemember(page, "10:00");
    await page.goto("/bookings");
    await expect(page.locator("[data-booking-card]").first()).toBeVisible();
    await expect(page.locator("[data-line-link-row]")).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText("LINE");
    expect(intercepted.attempts).toEqual([]);
  });
});

test.describe("state 2: active", () => {
  test.beforeEach(async ({ page }) => ensureLineActive(page));

  test("the owner API exposes the active adapter", async ({ page }) => {
    const config = JSON.parse(await configText(page)) as {
      lineAdapter?: { liffId?: string };
    };
    expect(config.lineAdapter).toEqual({ liffId: LINE_IDENTIFIERS.liffId });
  });

  test("the privacy page discloses the integration only now", async ({ page }) => {
    for (const path of ["/privacy", "/privacy.html"]) {
      await page.goto(path);
      await expect(page.locator("main")).toContainText("LINE 連携を利用する場合");
      await expect(page.locator("main")).toContainText(
        "連携はお客様が予約ごとに自分で選んだ場合",
      );
      await expectNoAxeViolations(page);
    }
  });

  test("a saved booking offers the opt-in and walks to the LIFF page", async ({ page }) => {
    const intercepted = await interceptLineOrigins(page);
    await bookAndRemember(page, "14:00");

    await page.goto("/bookings");
    const row = page.locator("[data-line-link-row]").first();
    await expect(row).toBeVisible();
    await expect(row.locator("[data-line-link-status]")).toContainText("LINE で受け取れます");
    const linkButton = row.getByRole("button", { name: "LINE で通知を受け取る" });
    await expect(linkButton).toBeVisible();

    // The row is real page structure: accessible and inside the viewport at
    // every documented width.
    for (const viewport of VIEWPORTS) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await expectNoHorizontalOverflow(page);
    }
    await expectNoAxeViolations(page);

    // Keyboard path: the button is reachable and Enter activates it.
    await linkButton.focus();
    await expect(linkButton).toBeFocused();
    await page.keyboard.press("Enter");

    // The intent landed in sessionStorage and the browser moved to the fixed
    // same-origin LIFF page — no query string, no external navigation.
    await page.waitForURL(`${BROWSER_ORIGIN}/line.html`);
    const intent = await page.evaluate(() =>
      sessionStorage.getItem("salon-reservation:line-link-intent:v1"),
    );
    expect(intent).not.toBeNull();
    expect(JSON.parse(intent as string)).toMatchObject({
      nonce: expect.stringMatching(/^[0-9a-f]{64}$/),
    });

    // The pinned SDK request was attempted against LINE's CDN and aborted by
    // the suite; the page degrades to its polite failure message with a way
    // back, instead of leaking or retrying elsewhere.
    await expect(page.locator("[data-line-status]")).toContainText("読み込みに失敗", {
      timeout: 10_000,
    });
    await expect(page.locator("[data-line-back]")).toBeVisible();
    expect(intercepted.attempts.some((url) => url.startsWith("https://static.line-scdn.net/"))).toBe(true);
    expect(intercepted.attempts.every((url) => url.startsWith("https://static.line-scdn.net/"))).toBe(true);

    // The LIFF page ships its own tightened CSP.
    const csp = await page.evaluate(async () => {
      const response = await fetch("/line.html", { cache: "no-store" });
      return response.headers.get("content-security-policy");
    });
    expect(csp).toContain("script-src 'self' https://static.line-scdn.net");
    expect(csp).toContain("frame-ancestors 'none'");

    await expectNoAxeViolations(page);
    for (const viewport of VIEWPORTS) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await expectNoHorizontalOverflow(page);
    }
  });

  test("a transient status failure keeps a retry action", async ({ page }) => {
    await bookAndRemember(page, "15:00");
    let requests = 0;
    let releaseFailedRetry = () => {};
    const failedRetry = new Promise<void>((resolve) => {
      releaseFailedRetry = resolve;
    });
    await page.route("**/api/reservations/*/line/status", async (route) => {
      requests += 1;
      if (requests <= 2) {
        if (requests === 2) await failedRetry;
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            error: { code: "TEMPORARILY_UNAVAILABLE", message: "現在処理できません。" },
          }),
        });
        return;
      }
      await route.continue();
    });

    await page.goto("/bookings");
    const row = page.locator("[data-line-link-row]").first();
    let retry = row.getByRole("button", { name: "もう一度試す" });
    await expect(retry).toBeVisible();
    await retry.click();
    await expect(row.locator("[data-line-link-status]")).toContainText(
      "もう一度確認しています",
    );
    releaseFailedRetry();
    retry = row.getByRole("button", { name: "もう一度試す" });
    await expect(retry).toBeVisible();
    await expect(retry).toBeFocused();
    await retry.click();
    await expect(row.locator("[data-line-link-status]")).toContainText("LINE で受け取れます");
  });

  test("liff.state in the URL is never read or followed", async ({ page }) => {
    await interceptLineOrigins(page);
    await page.addInitScript(() => {
      sessionStorage.setItem(
        "salon-reservation:line-link-intent:v1",
        JSON.stringify({ nonce: "a".repeat(64), expiresAt: Date.now() + 60_000 }),
      );
      const runtime = globalThis as typeof globalThis & {
        __liffInitCalls: number;
        liff: { init: () => Promise<void> };
      };
      runtime.__liffInitCalls = 0;
      runtime.liff = {
        init: () => {
          runtime.__liffInitCalls += 1;
          return Promise.resolve();
        },
      };
    });
    // Even with a valid stored intent, crafted callback state is refused
    // before the SDK can process it.
    await page.goto("/line.html?liff.state=%2Fadmin%3Fevil%3D1");
    await expect(page.locator("[data-line-status]")).toContainText(
      "予約管理ページからもう一度",
      { timeout: 10_000 },
    );
    expect(
      await page.evaluate(
        () => (globalThis as typeof globalThis & { __liffInitCalls: number }).__liffInitCalls,
      ),
    ).toBe(0);
    expect(new URL(page.url()).pathname).toBe("/line.html");
    await expect(page.locator("[data-line-back]")).toBeVisible();
  });

  test("a stalled optional module cannot block booking cancellation", async ({ page }) => {
    await bookAndRemember(page, "12:00");
    let releaseModule!: () => void;
    const heldModule = new Promise<void>((resolve) => {
      releaseModule = resolve;
    });
    await page.route("**/line-link.mjs", async (route) => {
      await heldModule;
      await route.abort();
    });

    try {
      await page.goto("/bookings");
      const card = page.locator("[data-booking-card]").first();
      await card.locator("[data-booking-cancel]").click();
      await page.locator("[data-booking-cancel-confirm-button]").click();
      await expect(card).toHaveAttribute("data-booking-state", "cancelled");
      await expect(page.locator("[data-bookings-status]")).toContainText("取り消しました");
    } finally {
      releaseModule();
    }
  });

  test("a provisional link shows its unfinished state and can be abandoned", async ({ page }) => {
    await interceptLineOrigins(page);
    await bookAndRemember(page, "11:00");
    await page.goto("/bookings");
    const row = page.locator("[data-line-link-row]").first();
    await row.getByRole("button", { name: "LINE で通知を受け取る" }).click();
    await page.waitForURL(`${BROWSER_ORIGIN}/line.html`);

    // Back on the management page the half-finished link is visible, offers
    // both continuing and abandoning, and abandoning returns to the start.
    await page.goto("/bookings");
    const provisionalRow = page.locator("[data-line-link-row]").first();
    await expect(provisionalRow.locator("[data-line-link-status]")).toContainText(
      "完了していません",
    );
    await expect(provisionalRow.getByRole("button", { name: "連携を続ける" })).toBeVisible();
    const abandon = provisionalRow.getByRole("button", { name: "手続きを取りやめる" });
    await abandon.focus();
    await page.keyboard.press("Enter");
    await expect(provisionalRow.locator("[data-line-link-status]")).toContainText(
      "LINE で受け取れます",
    );
    await expect(
      provisionalRow.getByRole("button", { name: "LINE で通知を受け取る" }),
    ).toBeFocused();

    // A cancellation rebuilds the booking card. The optional enhancer is
    // retained and runs for that replacement card as well.
    await provisionalRow.getByRole("button", { name: "LINE で通知を受け取る" }).click();
    await page.waitForURL(`${BROWSER_ORIGIN}/line.html`);
    await page.goto("/bookings");
    const card = page.locator("[data-booking-card]").first();
    await card.locator("[data-booking-cancel]").click();
    await page.locator("[data-booking-cancel-confirm-button]").click();
    await expect(card).toHaveAttribute("data-booking-state", "cancelled");
    await expect(card.locator("[data-line-link-status]")).toContainText("完了していません");

    // The webhook endpoint exists but refuses an unsigned body outright.
    const webhook = await page.evaluate(async () => {
      const response = await fetch("/api/adapters/line/webhook", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ events: [] }),
      });
      return response.status;
    });
    expect(webhook).toBe(403);
  });
});

test.describe("state 3: deactivating (cleanup mode)", () => {
  test.beforeEach(async ({ page }) => ensureLineActive(page));

  test("disable flips the surfaces to cleanup and privacy stays until purge", async ({ page }) => {
    await interceptLineOrigins(page);
    // Leave a provisional link behind, then disable.
    await bookAndRemember(page, "16:00");
    await page.goto("/bookings");
    await page
      .locator("[data-line-link-row]")
      .first()
      .getByRole("button", { name: "LINE で通知を受け取る" })
      .click();
    await page.waitForURL(`${BROWSER_ORIGIN}/line.html`);
    await lineCommand(page, "disable", (await lineStatus(page)).lifecycleVersion);

    // The capability is replaced by the cleanup marker; the LIFF surfaces
    // are gone while the opt-in module still serves for cleanup.
    const config = JSON.parse(await configText(page)) as Record<string, unknown>;
    expect(config.lineAdapter).toEqual({ cleanup: true });
    expect(await pageStatus(page, "/line.html")).toBe(404);
    expect(await pageStatus(page, "/line-liff.mjs")).toBe(404);
    expect(await pageStatus(page, "/line-link.mjs")).toBe(200);

    // The management page shows only the abandon affordance for the
    // provisional link — no way to start a new link.
    await page.goto("/bookings");
    const row = page.locator("[data-line-link-row]").first();
    await expect(row.getByRole("button", { name: "手続きを取りやめる" })).toBeVisible();
    await expect(page.getByRole("button", { name: "LINE で通知を受け取る" })).toHaveCount(0);
    await expect(row.getByRole("button", { name: "連携を続ける" })).toHaveCount(0);
    await expectNoAxeViolations(page);

    // Personal rows are removable during cleanup, needing nothing from LINE.
    await row.getByRole("button", { name: "手続きを取りやめる" }).click();
    await expect(page.locator("[data-line-link-row]")).toHaveCount(0);

    // Privacy keeps disclosing while data may still be held; the disabled
    // end-state (section absent again, config byte-identical) is asserted at
    // the Workers-test level, where the purge clock can be driven.
    await page.goto("/privacy");
    await expect(page.locator("main")).toContainText("LINE 連携を利用する場合");
  });
});
