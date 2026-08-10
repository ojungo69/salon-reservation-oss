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
        },
      },
      wrangler: { configPath: "./wrangler.jsonc" },
    }),
  ],
  test: {
    include: ["test/reservation-day.test.ts", "test/worker.test.ts"],
    testTimeout: 20_000,
  },
});
