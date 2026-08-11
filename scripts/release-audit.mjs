import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = "release/public-files.txt";
const AGPL = "AGPL-3.0-only";
const RELEASE_VERSION = "0.2.0";
const ALLOWED_NAMED_SECRETS = new Map([
  [".dev.vars.example:TURNSTILE_SECRET", "1x0000000000000000000000000000000AA"],
  [".dev.vars.example:OWNER_TOKEN", "replace-with-at-least-32-random-characters"],
  ["vitest.config.ts:TURNSTILE_SECRET", "turnstile-test-secret"],
  ["vitest.config.ts:OWNER_TOKEN", "owner-test-token-0123456789abcdef0123456789"],
]);
const ALLOWED_DEPENDENCY_LICENSES = new Set([
  "0BSD",
  "Apache-2.0",
  "Apache-2.0 AND LGPL-3.0-or-later",
  "Apache-2.0 AND LGPL-3.0-or-later AND MIT",
  "BSD-3-Clause",
  "CC0-1.0",
  "ISC",
  "LGPL-3.0-or-later",
  "MIT",
  "MIT OR Apache-2.0",
  "MPL-2.0",
]);
const REQUIRED = new Set([
  ".github/workflows/ci.yml",
  ".npmrc",
  "CHANGELOG.md",
  "CODE_OF_CONDUCT.md",
  "CONTRIBUTING.md",
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "docs/CLOUDFLARE.md",
  "docs/PARITY.md",
  "docs/RELEASING.md",
  "docs/PRIVACY.md",
  "docs/THIRD_PARTY_LICENSES.md",
  "package-lock.json",
  "package.json",
  "public/404.html",
  "public/bookings.html",
  "public/cancellation.html",
  "public/icon.svg",
  "public/index.html",
  "public/journey.js",
  "public/setup.html",
  "public/terms.html",
  "release/public-files.txt",
  "scripts/assemble-public-release.sh",
  "scripts/release-audit.mjs",
  "src/installation-config.ts",
  "src/worker.ts",
  "test/installation-config.test.ts",
  "test/journey.test.ts",
  "test/reservation-day.test.ts",
  "test/worker.test.ts",
  "wrangler.jsonc",
]);

const fail = (message) => {
  throw new Error(message);
};

const readText = (path) => readFileSync(join(ROOT, path), "utf8");

const parseArguments = () => {
  let publicTree = false;
  let denylist = null;
  for (let index = 2; index < process.argv.length; index += 1) {
    const argument = process.argv[index];
    if (argument === "--public-tree") {
      publicTree = true;
    } else if (argument === "--denylist") {
      denylist = process.argv[index + 1] ?? fail("--denylist requires a path");
      index += 1;
    } else {
      fail(`unknown argument: ${argument}`);
    }
  }
  return { publicTree, denylist };
};

const readManifest = () => {
  const raw = readText(MANIFEST);
  if (!raw.endsWith("\n")) fail("public manifest must end with a newline");
  const paths = raw.split("\n").filter(Boolean);
  if (paths.length === 0) fail("public manifest is empty");
  if (new Set(paths).size !== paths.length) fail("public manifest has duplicate paths");
  if (paths.join("\n") !== [...paths].sort().join("\n")) {
    fail("public manifest must be sorted");
  }
  for (const path of paths) {
    if (
      isAbsolute(path) ||
      path.includes("\\") ||
      posix.normalize(path) !== path ||
      path.split("/").some((part) => part === "" || part === "." || part === "..")
    ) {
      fail(`unsafe public path: ${path}`);
    }
    const stat = lstatSync(join(ROOT, path));
    if (!stat.isFile() || stat.isSymbolicLink()) fail(`public path is not a regular file: ${path}`);
  }
  for (const path of REQUIRED) {
    if (!paths.includes(path)) fail(`required public path is missing: ${path}`);
  }
  return paths;
};

const loadDenylist = (argument) => {
  const defaultPath = join(ROOT, ".release-private-denylist");
  const path = argument === null ? defaultPath : resolve(argument);
  try {
    const terms = readFileSync(path, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"));
    if (terms.length === 0) fail("private denylist is empty");
    if (terms.some((term) => [...term].length < 3 || /[\u0000-\u001f\u007f]/.test(term))) {
      fail("private denylist contains an unsafe term");
    }
    if (new Set(terms.map((term) => term.toLowerCase())).size !== terms.length) {
      fail("private denylist contains duplicate terms");
    }
    return terms;
  } catch (error) {
    if (argument === null && error?.code === "ENOENT") return [];
    throw error;
  }
};

const scanText = (label, text, denylist) => {
  const privateKeyHeader = new RegExp(`-----BEGIN (?:RSA |EC |OPENSSH |DSA )?${"PRIVATE KEY"}-----`);
  const rules = [
    ["private key", privateKeyHeader],
    ["GitHub token", new RegExp(`\\b${"github"}_pat_[A-Za-z0-9_]{20,}\\b`)],
    ["GitHub token", new RegExp(`\\bgh[pousr]_[A-Za-z0-9]{20,}\\b`)],
    ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
    ["JWT-like token", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/],
    ["live payment secret", /\bsk_live_[A-Za-z0-9]{16,}\b/],
    ["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{16,}\b/],
  ];
  const forbiddenRoots = ["home", "Users"].map((name) => new RegExp(`/${name}/[^/\\s]+/`));
  const email = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
  const secretName =
    "(OWNER_TOKEN|TURNSTILE_SECRET|CLOUDFLARE_API_TOKEN|CLOUDFLARE_API_KEY|CF_API_TOKEN|CF_API_KEY|PASSWORD|CLIENT_SECRET)";
  const dotenvSecret = new RegExp(
    `^\\s*(?:export\\s+)?${secretName}\\s*=\\s*(?:"([^"\\n]*)"|'([^'\\n]*)'|([^\\s#]+))\\s*(?:#.*)?$`,
    "gm",
  );
  const objectSecret = new RegExp(
    `["']?\\b${secretName}\\b["']?\\s*:\\s*(["'])([^"'\\n]+)\\2`,
    "g",
  );
  for (const [name, pattern] of rules) {
    if (pattern.test(text)) fail(`${name} pattern found in ${label}`);
  }
  if (forbiddenRoots.some((pattern) => pattern.test(text))) {
    fail(`private absolute path found in ${label}`);
  }
  for (const match of text.matchAll(email)) {
    const value = match[0].toLowerCase();
    if (!value.endsWith("@example.invalid") && !value.endsWith("@users.noreply.github.com")) {
      fail(`non-public email found in ${label}`);
    }
  }
  const lower = text.toLowerCase();
  for (const term of denylist) {
    if (lower.includes(term.toLowerCase())) fail(`private denylist term found in ${label}`);
  }
  for (const match of text.matchAll(dotenvSecret)) {
    const name = match[1];
    const value = match[2] ?? match[3] ?? match[4];
    if (ALLOWED_NAMED_SECRETS.get(`${label}:${name}`) !== value) {
      fail(`credential-like value found in ${label}`);
    }
  }
  for (const match of text.matchAll(objectSecret)) {
    const name = match[1];
    const value = match[3];
    if (ALLOWED_NAMED_SECRETS.get(`${label}:${name}`) !== value) {
      fail(`credential-like value found in ${label}`);
    }
  }
};

const scanPublicText = (paths, denylist) => {
  for (const path of paths) {
    const text = readText(path);
    if (text.includes("\0")) fail(`binary public file: ${path}`);
    scanText(path, text, denylist);
  }
};

const auditPackage = () => {
  const packageJson = JSON.parse(readText("package.json"));
  const lock = JSON.parse(readText("package-lock.json"));
  if (packageJson.version !== RELEASE_VERSION) {
    fail(`package version must be ${RELEASE_VERSION}`);
  }
  if (packageJson.license !== AGPL || packageJson.private !== true) {
    fail("package must be private AGPL-3.0-only metadata");
  }
  if (
    readText(".npmrc") !==
    "allow-scripts=\nengine-strict=true\nstrict-allow-scripts=true\n"
  ) {
    fail("strict install-script policy drift");
  }
  if (
    packageJson.engines?.node !== ">=24.0.0" ||
    packageJson.engines?.npm !== ">=12.0.0 <13.0.0" ||
    readText(".nvmrc") !== "24.16.0\n"
  ) {
    fail("supported toolchain drift");
  }
  if (packageJson.scripts?.audit !== "npm audit --audit-level=high") {
    fail("dependency audit command drift");
  }
  if (packageJson.dependencies !== undefined && Object.keys(packageJson.dependencies).length !== 0) {
    fail("runtime dependencies require explicit release review");
  }
  if (
    JSON.stringify(packageJson.allowScripts) !==
    JSON.stringify({ "esbuild@0.28.1": true, fsevents: false, "workerd@1.20260801.1": true })
  ) {
    fail("install-script allowlist drift");
  }
  if (lock.lockfileVersion !== 3) fail("package lockfile version drift");
  const root = lock.packages?.[""];
  if (
    root?.name !== packageJson.name ||
    root?.version !== packageJson.version ||
    root?.license !== AGPL ||
    JSON.stringify(root?.devDependencies) !== JSON.stringify(packageJson.devDependencies)
  ) {
    fail("package metadata and lockfile root drift");
  }
  const licenseDoc = readText("docs/THIRD_PARTY_LICENSES.md");
  for (const [path, metadata] of Object.entries(lock.packages ?? {})) {
    if (path === "") continue;
    if (typeof metadata.license !== "string") fail(`missing package license: ${path}`);
    if (!ALLOWED_DEPENDENCY_LICENSES.has(metadata.license)) {
      fail(`unreviewed package license ${metadata.license}: ${path}`);
    }
  }
  for (const [name, version] of Object.entries(packageJson.devDependencies ?? {})) {
    if (!licenseDoc.includes(`| \`${name}\` | ${version} |`)) {
      fail(`direct dependency license documentation drift: ${name}`);
    }
  }
};

// Everything the workflow executes, in order. Naming the whole set rather than
// the security-relevant subset is what makes the check hold: the pinned npm is
// what enforces allowScripts at all, --ignore-scripts is what keeps third-party
// install code from running, and the listing gate is what makes the allowlist
// real rather than decorative — but a workflow may also not grow a step that
// installs some other way, which only an exhaustive list can say. Dependabot
// bumps `uses:` SHAs and never touches these, so the list stays quiet.
const WORKFLOW_COMMANDS = [
  "npm install -g --ignore-scripts npm@12.0.2",
  "node --version && npm --version",
  "npm ci --ignore-scripts",
  `test "$(npm install-scripts ls --json | jq '.allowScripts | length')" = "0"`,
  "npm run check",
];
// The same list for actions, without the SHA so Dependabot's digest bumps do
// not touch it. A step that calls an action is executing someone else's code
// just as much as a `run:` line is, and a reusable workflow would appear here
// as a path that is not in the list.
const WORKFLOW_ACTIONS = ["actions/checkout", "actions/setup-node"];
const REQUIRED_WORKFLOW_LINES = ["node-version-file: .nvmrc"];
// Every key ci.yml is allowed to contain, including the one job name. Listing
// the permitted keys rather than the forbidden ones is what makes the two lists
// above mean what they say: a pinned `run:` is only pinned while nothing else
// chooses how it runs. `shell:` picks the interpreter, `container:` and
// `services:` pick the machine, `env:` and `defaults:` reach inside node and
// npm, `if:` turns a pinned step off, `strategy:` multiplies it, and a second
// job name is a second place to install — none of which changes a `run:` or
// `uses:` value. An unlisted key fails instead of being ignored.
const WORKFLOW_KEYS = new Set([
  "branches",
  "cache",
  "cancel-in-progress",
  "check",
  "concurrency",
  "contents",
  "fetch-depth",
  "group",
  "jobs",
  "name",
  "node-version-file",
  "on",
  "package-manager-cache",
  "permissions",
  "persist-credentials",
  "pull_request",
  "push",
  "run",
  "runs-on",
  "steps",
  "timeout-minutes",
  "uses",
  "with",
]);
// The only sequence entry that is a bare value rather than a key.
const WORKFLOW_SEQUENCE_VALUES = new Set(["- main"]);
const KEY_LINE = /^(?:-\s+)?"?([A-Za-z_][\w-]*)"?\s*:(?:\s+(.*))?$/;

const auditWorkflow = () => {
  const workflow = readText(".github/workflows/ci.yml");
  if (!/^permissions:\n\s+contents: read$/m.test(workflow)) fail("workflow permissions drift");
  // Comments are stripped before matching, so a pinned command cannot be
  // satisfied by text that never runs: `run: npm ci # run: npm ci
  // --ignore-scripts` keeps the string and drops the flag.
  const activeLines = workflow
    .split("\n")
    .map((line) => line.replace(/\s+#.*$/, "").trim())
    .filter((line) => line.length !== 0 && !line.startsWith("#"));
  for (const line of REQUIRED_WORKFLOW_LINES) {
    if (!activeLines.includes(line)) fail(`install-script enforcement drift: ${line}`);
  }
  // Every line has to be one this reader understands. Without that the lists
  // below would only cover the spellings anticipated here, and YAML has many:
  // a folded plain scalar continues a pinned command on the next line, a block
  // scalar hides a script under it, `{run: …}` is a step, `"run"` is `run`, and
  // `---` starts a second document. None of those is a key line.
  for (const line of activeLines) {
    if (WORKFLOW_SEQUENCE_VALUES.has(line)) continue;
    const key = KEY_LINE.exec(line);
    if (key === null) fail(`unreviewed workflow line: ${line}`);
    if (!WORKFLOW_KEYS.has(key[1])) fail(`unreviewed workflow key: ${key[1]}`);
    // A flow value carries keys of its own that this reader would never see:
    // `on: {pull_request: null, pull_request_target: null}` is one allowed key
    // on one line.
    if (/^[[{]/.test(key[2] ?? "")) fail(`unreviewed workflow flow value: ${line}`);
  }
  // Deliberately redundant with the key list above. This is the one key whose
  // presence hands a write token to code from a fork, and it should fail by
  // name however it is written.
  if (/pull_request_target\s*:/.test(workflow)) fail("pull_request_target is forbidden");
  // The leading dash is optional: `- run: npm ci` is a step just as much as a
  // `run:` under a `- name:` is, and reading only the second form would let a
  // whole extra step through.
  const values = (keyword) =>
    activeLines
      .map((line) => KEY_LINE.exec(line))
      .filter((match) => match !== null && match[1] === keyword)
      .map((match) => match[2].trim());
  const commands = values("run");
  if (JSON.stringify(commands) !== JSON.stringify(WORKFLOW_COMMANDS)) {
    fail(`workflow command drift: ${JSON.stringify(commands)}`);
  }
  const actions = values("uses");
  for (const action of actions) {
    if (!/@[0-9a-f]{40}$/.test(action)) fail(`GitHub Action is not commit-pinned: ${action}`);
  }
  const identities = actions.map((action) => action.slice(0, action.lastIndexOf("@")));
  if (JSON.stringify(identities) !== JSON.stringify(WORKFLOW_ACTIONS)) {
    fail(`workflow action drift: ${JSON.stringify(identities)}`);
  }
};

const auditAuthForms = () => {
  for (const path of ["public/admin.html", "public/setup.html"]) {
    const passwordInputs = [...readText(path).matchAll(/<input\b[^>]*>/gis)]
      .map(([tag]) => tag)
      .filter((tag) => /\btype\s*=\s*["']password["']/i.test(tag));
    if (passwordInputs.length !== 1 || passwordInputs.some((tag) => /\bname\s*=/i.test(tag))) {
      fail(`owner password input must not be a default form control: ${path}`);
    }
  }
};

const git = (args) =>
  execFileSync("git", ["-C", ROOT, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

const auditPublicTree = (paths, denylist) => {
  if (git(["rev-parse", "--is-inside-work-tree"]) !== "true") fail("public tree is not a Git repository");
  if (git(["rev-parse", "--is-shallow-repository"]) !== "false") {
    fail("public repository must not be shallow");
  }
  if (git(["symbolic-ref", "--short", "HEAD"]) !== "main") fail("public branch must be main");
  if (git(["rev-list", "--count", "HEAD"]) !== "1") fail("public history must contain one commit");
  if (git(["rev-list", "--max-parents=0", "HEAD"]).split("\n").filter(Boolean).length !== 1) {
    fail("public history must contain one root");
  }
  if (git(["for-each-ref", "--format=%(refname)"]) !== "refs/heads/main") {
    fail("public repository contains unexpected refs");
  }
  if (git(["remote"]) !== "") fail("public candidate must not have a remote");
  if (git(["status", "--porcelain", "--untracked-files=all"]) !== "") {
    fail("public candidate working tree is dirty");
  }
  const tracked = git(["ls-files"]).split("\n").filter(Boolean).sort();
  if (tracked.join("\n") !== paths.join("\n")) fail("tracked paths differ from public manifest");
  const emails = git(["show", "-s", "--format=%ae%n%ce", "HEAD"]).split("\n");
  if (emails.some((value) => !value.toLowerCase().endsWith("@users.noreply.github.com"))) {
    fail("public commit identity must use a noreply address");
  }
  const metadata = git(["show", "-s", "--format=%an%n%ae%n%cn%n%ce%n%B", "HEAD"]);
  scanText("commit metadata", metadata, denylist);
  execFileSync("git", ["-C", ROOT, "fsck", "--full", "--no-reflogs", "--no-dangling"], {
    stdio: ["ignore", "ignore", "pipe"],
  });
};

try {
  const options = parseArguments();
  const paths = readManifest();
  const denylist = loadDenylist(options.denylist);
  scanPublicText(paths, denylist);
  auditPackage();
  auditWorkflow();
  auditAuthForms();
  if (options.publicTree) auditPublicTree(paths, denylist);
  console.log(`release audit passed (${paths.length} allowlisted files${options.publicTree ? ", public history" : ""})`);
} catch (error) {
  console.error(`release audit failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
