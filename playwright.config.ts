import { defineConfig, devices } from "@playwright/test";

import {
  ALLOWED_HOSTNAME,
  BROWSER_ORIGIN,
  OWNER_TOKEN,
  PORT,
  STATE_DIR,
  SERVER_ORIGIN,
  TURNSTILE_SECRET,
} from "./tests-browser/harness.ts";

export default defineConfig({
  testDir: "./tests-browser",
  outputDir: ".playwright/results",
  // One Worker, one Durable Object per date, one installation: the suite shares
  // server state, so it is ordered rather than parallel.
  timeout: 60_000,
  workers: 1,
  fullyParallel: false,
  forbidOnly: process.env.CI !== undefined,
  retries: 0,
  reporter:
    process.env.CI === undefined
      ? "list"
      : [["list"], ["html", { open: "never", outputFolder: ".playwright/report" }]],
  use: {
    ...devices["Desktop Chrome"],
    baseURL: BROWSER_ORIGIN,
    // wrangler dev serves HTTPS from a self-signed certificate.
    ignoreHTTPSErrors: true,
    // An installation refuses to go live on a local hostname, so the browser
    // has to address the dev server by the name the settings allow.
    launchOptions: {
      args: [`--host-resolver-rules=MAP ${ALLOWED_HOSTNAME} 127.0.0.1`],
    },
    // Artifacts only exist for a failing run, and the suite never types a real
    // credential or customer detail, so nothing sensitive can reach them.
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [
    { name: "install", testMatch: /install\.spec\.ts/ },
    { name: "app", testIgnore: /install\.spec\.ts/, dependencies: ["install"] },
  ],
  webServer: {
    // The suite runs in a fixed order against one installation, so every run
    // starts from the shipped defaults. Deleting the directory here rather than
    // in a global setup matters: Playwright starts this command before global
    // setup runs, and workerd fails with SQLITE_CANTOPEN if its open database
    // is removed underneath it.
    command: [
      `node -e "require('node:fs').rmSync('${STATE_DIR}',{recursive:true,force:true})"`,
      // The production owner limiter (10/minute/route) is far below what an
      // ordered full run sends inside one minute, so the suite would spend
      // its time waiting out windows instead of asserting behaviour. Derive
      // a test config from the canonical one with roomy limits — deriving,
      // rather than keeping a second config file, cannot drift. Paths are
      // absolutized because wrangler resolves them against the config file,
      // and a light JSONC strip (comments, trailing commas) keeps the read
      // aligned with the canonical file's format without a parser package.
      `&& node -e "const f=require('node:fs');const p=require('node:path');const t=f.readFileSync('wrangler.jsonc','utf8').replace(/\\\\/\\\\*[^]*?\\\\*\\\\//g,'').replace(/^[\\\\t ]*\\\\/\\\\/.*$/gm,'').replace(/,(\\\\s*[}\\\\]])/g,'$1');const c=JSON.parse(t);for(const r of c.ratelimits)r.simple.limit=1000;c.main=p.resolve(c.main);c.assets.directory=p.resolve(c.assets.directory);f.mkdirSync('.wrangler',{recursive:true});f.writeFileSync('.wrangler/browser-test.json',JSON.stringify(c))"`,
      "&& npx wrangler dev --config .wrangler/browser-test.json",
      `--ip 127.0.0.1 --port ${PORT} --local-protocol https`,
      `--persist-to ${STATE_DIR}`,
      `--var OWNER_TOKEN:${OWNER_TOKEN}`,
      `--var TURNSTILE_SECRET:${TURNSTILE_SECRET}`,
    ].join(" "),
    url: `${SERVER_ORIGIN}/api/config`,
    ignoreHTTPSErrors: true,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "ignore",
    stderr: "pipe",
    env: { WRANGLER_SEND_METRICS: "false" },
  },
});
