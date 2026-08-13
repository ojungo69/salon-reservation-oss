import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./src/worker.ts",
      miniflare: {
        bindings: {
          OWNER_TOKEN: "owner-test-token-0123456789abcdef0123456789",
          TURNSTILE_SECRET: "turnstile-test-secret",
          LINE_MESSAGING_CHANNEL_SECRET: "line-test-channel-secret-0123456789abcdef",
          CALENDAR_FEED_TOKEN: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          GOOGLE_CALENDAR_CREDENTIALS: JSON.stringify({
            clientId: "fixture.apps.googleusercontent.com",
            clientSecret: "fixture-client-secret",
            refreshToken: "fixture-refresh-token",
            calendarId: "fixture+calendar@example.invalid",
          }),
        },
      },
      wrangler: { configPath: "./wrangler.jsonc" },
    }),
  ],
  test: {
    include: [
      "test/reservation-day.test.ts",
      "test/worker.test.ts",
      "test/adapter-delivery.test.ts",
      "test/line-adapter.test.ts",
      "test/calendar-adapter.test.ts",
    ],
    testTimeout: 20_000,
  },
});
