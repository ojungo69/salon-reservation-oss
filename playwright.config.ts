import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { defineConfig, devices } from "@playwright/test";

import {
  ALLOWED_HOSTNAME,
  BROWSER_ORIGIN,
  CALENDAR_FEED_TOKEN,
  LINE_MESSAGING_CHANNEL_SECRET,
  OWNER_TOKEN,
  PORT,
  STATE_DIR,
  SERVER_ORIGIN,
  TURNSTILE_SECRET,
} from "./tests-browser/harness.ts";

// Remove comments and trailing commas without ever rewriting string literals
// (the canonical config legitimately contains "/api/*"). Character walks, not
// regexes, and comments go first so a trailing comma hiding behind one
// ("period": 60, // note) is still recognized by the second pass.
const copyStringLiteral = (text: string, start: number): { chunk: string; end: number } => {
  let chunk = text[start];
  let i = start + 1;
  while (i < text.length && text[i] !== '"') {
    chunk += text[i];
    if (text[i] === "\\") {
      chunk += text[i + 1] ?? "";
      i += 1;
    }
    i += 1;
  }
  return { chunk: chunk + (text[i] ?? ""), end: i };
};

const stripComments = (text: string): string => {
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') {
      const literal = copyStringLiteral(text, i);
      out += literal.chunk;
      i = literal.end;
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      out += "\n";
    } else if (ch === "/" && text[i + 1] === "*") {
      for (i += 2; i < text.length && !(text[i] === "*" && text[i + 1] === "/"); i += 1);
      i += 1;
    } else {
      out += ch;
    }
  }
  return out;
};

const stripTrailingCommas = (text: string): string => {
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') {
      const literal = copyStringLiteral(text, i);
      out += literal.chunk;
      i = literal.end;
    } else if (ch !== "," || !/^\s*[}\]]/.test(text.slice(i + 1))) {
      out += ch;
    }
  }
  return out;
};

const stripJsonc = (text: string): string => stripTrailingCommas(stripComments(text));

// The production owner limiter (10/minute/route) is far below what an ordered
// full run sends inside one minute, so the suite would spend its time waiting
// out limiter windows instead of asserting behaviour. The web server runs on
// a config derived from the canonical one with roomy limits — deriving at
// load, rather than keeping a second config file, cannot drift. Paths are
// absolutized because wrangler resolves them against the config file.
const TEST_CONFIG_PATH = ".wrangler/browser-test.json";
{
  const config = JSON.parse(stripJsonc(readFileSync(resolve("wrangler.jsonc"), "utf8")));
  for (const limiter of config.ratelimits) limiter.simple.limit = 1000;
  config.main = resolve(config.main);
  config.assets.directory = resolve(config.assets.directory);
  mkdirSync(".wrangler", { recursive: true });
  writeFileSync(TEST_CONFIG_PATH, JSON.stringify(config));
}

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
      `&& npx wrangler dev --config ${TEST_CONFIG_PATH}`,
      `--ip 127.0.0.1 --port ${PORT} --local-protocol https`,
      `--persist-to ${STATE_DIR}`,
      `--var OWNER_TOKEN:${OWNER_TOKEN}`,
      `--var TURNSTILE_SECRET:${TURNSTILE_SECRET}`,
      `--var LINE_MESSAGING_CHANNEL_SECRET:${LINE_MESSAGING_CHANNEL_SECRET}`,
      `--var CALENDAR_FEED_TOKEN:${CALENDAR_FEED_TOKEN}`,
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
