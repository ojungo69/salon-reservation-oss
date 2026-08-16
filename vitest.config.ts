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
    // Wall clock, and these five files run concurrently, so the budget has to
    // survive the contention that buys the parallelism. The most expensive
    // test — the calendar adapter walking its whole retry ladder and then
    // recovering an expired send claim — costs 2.7s alone, 11.8s inside its
    // own suite on an idle 32-core machine, and more than 20s on a 4-core
    // runner with the other four suites alongside it. At 20s that was a
    // coin flip nobody had noticed losing yet.
    //
    // This is not the hang detector; the job's own 25-minute limit is. It is
    // the line between "slow under load" and "never finishing", and 60s puts
    // it where the measurement says it belongs.
    //
    // The 4x an idle suite adds over the same test alone is worth its own
    // look — it is object state accumulating across tests, not the test
    // getting harder — but that is a change to how the suites are named and
    // reset, not to a budget.
    testTimeout: 60_000,
  },
});
