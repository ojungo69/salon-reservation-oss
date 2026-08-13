import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";

// Fictional values only. The owner token matches the one the Workers test suite
// already publishes in vitest.config.ts, so nothing here is a real credential.
export const OWNER_TOKEN = "owner-test-token-0123456789abcdef0123456789";
export const TURNSTILE_SECRET = "turnstile-test-secret";
export const LINE_MESSAGING_CHANNEL_SECRET = "line-test-channel-secret-0123456789abcdef";
export const CALENDAR_FEED_TOKEN = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
// An installation refuses to go live on a Cloudflare test site key or a local
// hostname, both on purpose. The suite therefore uses a non-test key and a
// reserved .example hostname that Chromium is told to resolve to the dev server.
export const TURNSTILE_SITE_KEY = "browser-test-site-key-0000000000000000";
export const ALLOWED_HOSTNAME = "booking.salon.example";
export const SOURCE_URL = "https://github.com/public-fixture/salon-reservation";

export const PORT = 8788;
// HTTPS, not because the suite needs transport security against a local server,
// but because app.js uses crypto.randomUUID and crypto.subtle. Those exist only
// in a secure context, and the one insecure origin browsers treat as secure --
// localhost -- is exactly the hostname an installation refuses to go live on.
export const SERVER_ORIGIN = `https://127.0.0.1:${PORT}`;
export const BROWSER_ORIGIN = `https://${ALLOWED_HOSTNAME}:${PORT}`;

// Kept out of .wrangler/state so a developer's own `npm run dev` data is never
// read or destroyed by the suite. The webServer command in playwright.config.ts
// empties it before every run, because the specs run in a fixed order against
// one shared installation.
export const STATE_DIR = ".wrangler/browser-test-state";

// The widths docs/PARITY.md claims as acceptance evidence.
export const VIEWPORTS = [
  { name: "320", width: 320, height: 640 },
  { name: "360", width: 360, height: 740 },
  { name: "768", width: 768, height: 1024 },
  { name: "1440", width: 1440, height: 900 },
];

/**
 * Stands in for challenges.cloudflare.com/turnstile/v0/api.js. The real script
 * is never fetched, so the suite makes no external request and needs no secret.
 * Tests drive it through `window.__turnstileStub`, which app.js never reads.
 */
const TURNSTILE_STUB = `
window.__turnstileStub = window.__turnstileStub ?? { mode: "success", token: "stub-turnstile-token" };
(() => {
  const widgets = new Map();
  let nextId = 0;
  const settle = (id) => {
    const options = widgets.get(id);
    if (!options) return;
    const stub = window.__turnstileStub;
    setTimeout(() => {
      if (stub.mode === "error") options["error-callback"]?.();
      else options.callback?.(stub.token);
    }, 0);
  };
  window.turnstile = {
    render(container, options) {
      const id = String(nextId++);
      widgets.set(id, options);
      const box = typeof container === "string" ? document.querySelector(container) : container;
      if (box) box.textContent = "stub turnstile widget";
      settle(id);
      return id;
    },
    reset(id) {
      settle(id);
    },
  };
})();
`;

/**
 * Books two days out rather than today, because the demo hours close at 17:00
 * and a run after that would find nothing left, then skips Sunday, the one
 * weekday the shipped settings do not open. Both come from the installation's
 * own idea of today, so the suite does not depend on the runner's clock.
 */
export const openDateFrom = (today: string): string => {
  const date = new Date(`${today}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 2);
  if (date.getUTCDay() === 0) date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
};

/** Serve the stub in place of the real widget script for the whole page. */
export const stubTurnstile = async (page: Page, mode = "success"): Promise<void> => {
  await page.addInitScript(
    ([chosen]) => {
      window.__turnstileStub = { mode: chosen, token: "stub-turnstile-token" };
    },
    [mode],
  );
  await page.route("https://challenges.cloudflare.com/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/javascript; charset=utf-8",
      body: TURNSTILE_STUB,
    }),
  );
};

/**
 * The one thing the browser cannot do for real: a public reservation is gated
 * on a Turnstile token that only Cloudflare can issue, and reaching Cloudflare
 * is exactly what this suite must not do. So the customer's create request is
 * forwarded to the owner endpoint instead, which takes the same command and
 * returns the same response shape without the token. Everything else about the
 * request -- the body the client built, the Worker, the Durable Object, the
 * stored booking -- stays real, so the reservation the customer sees afterwards
 * genuinely exists and can be read back on the saved-bookings page.
 */
export const forwardCreateWithoutTurnstile = async (
  page: Page,
): Promise<{ requests: Array<Record<string, unknown>> }> => {
  const requests: Array<Record<string, unknown>> = [];
  await page.route("**/api/reservations", async (route) => {
    const request = route.request();
    if (request.method() !== "POST") return route.fallback();
    const body = JSON.parse(request.postData() ?? "{}") as Record<string, unknown>;
    requests.push(body);
    const { turnstileToken, replayOnly, ...owner } = body;
    // Addressed by IP because this call is made from Node, which was never told
    // how to resolve the hostname, but presented as the configured host: an
    // owner mutation is refused unless the request arrives on the hostname the
    // installation allows, and unless the origin matches it.
    const response = await route.fetch({
      url: `${SERVER_ORIGIN}/api/admin/reservations`,
      method: "POST",
      headers: {
        ...request.headers(),
        host: new URL(BROWSER_ORIGIN).host,
        origin: BROWSER_ORIGIN,
        authorization: `Bearer ${OWNER_TOKEN}`,
        "content-type": "application/json",
      },
      postData: JSON.stringify(owner),
    });
    await route.fulfill({ response });
  });
  return { requests };
};

/** Fails on any horizontal overflow, which is the claim docs/PARITY.md makes. */
export const expectNoHorizontalOverflow = async (page: Page): Promise<void> => {
  const overflow = await page.evaluate(() => {
    const root = document.documentElement;
    const widest = [...document.querySelectorAll<HTMLElement>("body *")]
      .filter((element) => element.getBoundingClientRect().right > root.clientWidth + 1)
      .map((element) => `${element.tagName.toLowerCase()}.${element.className}`);
    return { scrollWidth: root.scrollWidth, clientWidth: root.clientWidth, widest: widest.slice(0, 5) };
  });
  expect(
    overflow.scrollWidth,
    `horizontal overflow past ${overflow.clientWidth}px from ${JSON.stringify(overflow.widest)}`,
  ).toBeLessThanOrEqual(overflow.clientWidth);
};

/** WCAG 2.1 A and AA rules, which is what the accessibility claims cover. */
export const expectNoAxeViolations = async (page: Page): Promise<void> => {
  const { violations } = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(
    violations.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target).join(" ")}`),
  ).toEqual([]);
};

declare global {
  interface Window {
    __turnstileStub: { mode: string; token: string };
  }
}
