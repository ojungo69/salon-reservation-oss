import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, join, posix, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = "release/public-files.txt";
const PRIVATE_LEDGER_PATH = "docs/private_porting_ledger.md";
const AGPL = "AGPL-3.0-only";
const RELEASE_VERSION = "0.2.0";
const ALLOWED_NAMED_SECRETS = new Map([
  [".dev.vars.example:TURNSTILE_SECRET", "1x0000000000000000000000000000000AA"],
  [".dev.vars.example:OWNER_TOKEN", "replace-with-at-least-32-random-characters"],
  ["vitest.config.ts:TURNSTILE_SECRET", "turnstile-test-secret"],
  ["vitest.config.ts:OWNER_TOKEN", "owner-test-token-0123456789abcdef0123456789"],
  ["vitest.config.ts:CALENDAR_FEED_TOKEN", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"],
  ["tests-browser/harness.ts:CALENDAR_FEED_TOKEN", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"],
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
  "AGENTS.md",
  ".github/pull_request_template.md",
  ".github/scripts/dependabot-diverged.jq",
  ".github/scripts/dependabot-diverged.test.mjs",
  ".github/scripts/dependency-stall.mjs",
  ".github/scripts/dependency-stall.test.mjs",
  ".github/workflows/ci.yml",
  ".github/workflows/dependabot-auto-merge.yml",
  ".github/workflows/dependency-stall.yml",
  ".npmrc",
  "CHANGELOG.md",
  "CODE_OF_CONDUCT.md",
  "CONTRIBUTING.md",
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "docs/ADAPTER-CONTRACTS.md",
  "docs/ADR-0001-REUSE-FIRST-PORTING.md",
  "docs/ADR-0002-CREATE-STORAGE-AUTHORITY.md",
  "docs/ADR-0003-MULTI-LOCATION-BOUNDARY.md",
  "docs/CALENDAR-SETUP.md",
  "docs/CLOUDFLARE.md",
  "docs/MULTI-LOCATION.md",
  "docs/PARITY.md",
  "docs/PORTING.md",
  "docs/ROADMAP.md",
  "docs/RELEASING.md",
  "docs/PRIVACY.md",
  "docs/THIRD_PARTY_LICENSES.md",
  "docs/UX-PARITY.md",
  "package-lock.json",
  "package.json",
  "public/404.html",
  "public/bookings.html",
  "public/cancellation.html",
  "public/icon.svg",
  "public/index.html",
  "public/journey.js",
  "public/location.js",
  "public/setup.html",
  "public/terms.html",
  "release/public-files.txt",
  "scripts/assemble-public-release.sh",
  "scripts/release-audit.mjs",
  "src/installation-config.ts",
  "src/location.ts",
  "src/calendar-adapter.ts",
  "src/worker.ts",
  "test/installation-config.test.ts",
  "test/location-config.test.ts",
  "test/location.test.ts",
  "test/calendar-adapter.test.ts",
  "test/journey.test.ts",
  "test/release-metadata.test.ts",
  "tests-browser/multi-location.spec.ts",
  "tests-browser/multi-location-calendar.spec.ts",
  "tests-browser/multi-location-customer.spec.ts",
  "tests-browser/multi-location-operator.spec.ts",
  "test/reservation-day.test.ts",
  "test/worker.test.ts",
  "wrangler.jsonc",
]);

const fail = (message) => {
  throw new Error(message);
};

const readText = (path) => readFileSync(join(ROOT, path), "utf8");

// For the config files compared byte for byte. Their content is what is being
// pinned, and a contributor cloning on Windows with core.autocrlf=true would
// otherwise fail the audit over line endings npm and nvm both ignore.
const readLines = (path) => readText(path).replaceAll("\r\n", "\n");

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
  if (
    paths.join("\n") !==
    [...paths]
      .sort((left, right) => {
        if (left < right) return -1;
        if (left > right) return 1;
        return 0;
      })
      .join("\n")
  ) {
    fail("public manifest must be sorted");
  }
  for (const path of paths) {
    if (path.toLowerCase() === PRIVATE_LEDGER_PATH) {
      fail("private porting ledger must not be public");
    }
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

const realpathOrEmpty = (dir) => {
  try {
    return realpathSync(dir);
  } catch {
    return "";
  }
};

// Returns an open handle on the denylist, or null when an absent optional file
// means "no private terms". The default path is confined like an explicit one:
// it is gitignored, so a symlink planted there would otherwise read straight
// past the containment an explicit argument has to satisfy.
const openConfinedDenylist = (path, { optional }) => {
  // Assembler snapshots with TMPDIR=/tmp mktemp. Live terms stay outside both trees.
  // After realpath, only the repo and the fixed system temp roots are readable.
  let canonical;
  try {
    canonical = realpathSync(path);
  } catch (error) {
    if (optional && error?.code === "ENOENT") return null;
    fail("denylist path is not readable");
  }
  const root = realpathSync(ROOT);
  const tmpRoot = realpathOrEmpty("/tmp");
  const varTmpRoot = realpathOrEmpty("/var/tmp");
  if (
    canonical !== root &&
    !canonical.startsWith(`${root}${sep}`) &&
    (tmpRoot === "" ||
      (canonical !== tmpRoot && !canonical.startsWith(`${tmpRoot}${sep}`))) &&
    (varTmpRoot === "" ||
      (canonical !== varTmpRoot && !canonical.startsWith(`${varTmpRoot}${sep}`)))
  ) {
    fail("denylist path is not under the repository or a system temp directory");
  }
  // One handle carries the type check and the read, and it refuses to follow a
  // link. Resolving a name twice lets a link swapped in between send the read
  // somewhere neither the containment check nor the type check ever saw, and
  // realpath resolved every component already, so a link here is that swap.
  // O_NONBLOCK is what lets the type check run at all: opening a FIFO without it
  // waits for a writer that a planted denylist path never has to provide, so the
  // audit would hang before fstat could reject it. It does nothing to a regular
  // file, which is the only kind this goes on to read.
  // Both flags are load-bearing, so a platform without them fails the audit
  // rather than opening with a quietly weaker guarantee than this comment claims.
  if (constants.O_NOFOLLOW === undefined || constants.O_NONBLOCK === undefined) {
    fail("this platform cannot open the denylist without following links");
  }
  let handle;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    handle = openSync(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    // ELOOP here is the swap this refuses to follow, so it is reported as the
    // refusal it is rather than as an errno escaping the audit's own messages.
    fail(
      error?.code === "ELOOP"
        ? "denylist path became a link after it was checked"
        : "denylist path is not readable",
    );
  }
  try {
    if (!fstatSync(handle).isFile()) fail("denylist path is not a regular file");
  } catch (error) {
    closeSync(handle);
    throw error;
  }
  return handle;
};

const loadDenylist = (argument) => {
  const explicit = argument !== null;
  const handle = openConfinedDenylist(
    explicit ? resolve(argument) : join(ROOT, ".release-private-denylist"),
    { optional: !explicit },
  );
  if (handle === null) return [];
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const terms = readFileSync(handle, "utf8")
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
  } finally {
    closeSync(handle);
  }
};

// The dotenv and object-literal secret rules differ only in which capture group
// holds the value, so the loop is shared and the extraction is passed in.
const scanNamedSecrets = (label, text, pattern, extractValue) => {
  for (const match of text.matchAll(pattern)) {
    const name = match[1];
    if (ALLOWED_NAMED_SECRETS.get(`${label}:${name}`) !== extractValue(match)) {
      fail(`credential-like value found in ${label}`);
    }
  }
};

// None of these depend on the text being scanned, and scanText runs once per
// released file, so they are compiled once here rather than on every call.
// The two interpolated rules below keep the header and the token prefix from
// appearing contiguously in this file, which its own scan — and every other
// secret scanner pointed at the release tree — would otherwise flag. Both
// sources are literals written here, so the constructor takes no outside input.
// The directives in this file name the eslint-plugin-security rules whose
// checks they answer. The repository runs no ESLint of its own; they are there
// for the hosted analysers that read them, which accept only a directive on the
// line above the one they report.
const CREDENTIAL_RULES = [
  // eslint-disable-next-line security/detect-non-literal-regexp
  ["private key", new RegExp(`-----BEGIN (?:RSA |EC |OPENSSH |DSA )?${"PRIVATE KEY"}-----`)],
  // eslint-disable-next-line security/detect-non-literal-regexp
  ["GitHub token", new RegExp(String.raw`\b${"github"}_pat_[A-Za-z0-9_]{20,}\b`)],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{20,}\b/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["JWT-like token", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/],
  ["live payment secret", /\bsk_live_[A-Za-z0-9]{16,}\b/],
  ["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{16,}\b/],
];
const FORBIDDEN_ROOTS = [/\/home\/[^/\s]+\//, /\/Users\/[^/\s]+\//];
const PRIVATE_LEDGER_MARKER = ["PRIVATE", "PORTING", "EVIDENCE: DO NOT PUBLISH"].join("-");
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const SECRET_NAME =
  "(OWNER_TOKEN|TURNSTILE_SECRET|CALENDAR_FEED_TOKEN|GOOGLE_CALENDAR_CREDENTIALS|CLOUDFLARE_API_TOKEN|CLOUDFLARE_API_KEY|CF_API_TOKEN|CF_API_KEY|PASSWORD|CLIENT_SECRET)";
// Both rules share the name alternation above, so both are composed rather than
// written as literals. The only interpolation is that module constant.
// eslint-disable-next-line security/detect-non-literal-regexp
const DOTENV_SECRET = new RegExp(
  // eslint-disable-next-line security/detect-non-literal-regexp
  String.raw`^\s*(?:export\s+)?${SECRET_NAME}\s*=\s*(?:"([^"\n]*)"|'([^'\n]*)'|([^\s#]+))\s*(?:#.*)?$`,
  "gm",
);
// eslint-disable-next-line security/detect-non-literal-regexp
const OBJECT_SECRET = new RegExp(
  // eslint-disable-next-line security/detect-non-literal-regexp
  String.raw`["']?\b${SECRET_NAME}\b["']?\s*:\s*(["'])([^"'\n]+)\2`,
  "g",
);

const scanText = (label, text, denylist) => {
  if (text.toUpperCase().includes(PRIVATE_LEDGER_MARKER)) {
    fail(`private porting ledger marker found in ${label}`);
  }
  for (const [name, pattern] of CREDENTIAL_RULES) {
    if (pattern.test(text)) fail(`${name} pattern found in ${label}`);
  }
  if (FORBIDDEN_ROOTS.some((pattern) => pattern.test(text))) {
    fail(`private absolute path found in ${label}`);
  }
  for (const match of text.matchAll(EMAIL)) {
    const value = match[0].toLowerCase();
    if (!value.endsWith("@example.invalid") && !value.endsWith("@users.noreply.github.com")) {
      fail(`non-public email found in ${label}`);
    }
  }
  const lower = text.toLowerCase();
  for (const term of denylist) {
    if (lower.includes(term.toLowerCase())) fail(`private denylist term found in ${label}`);
  }
  scanNamedSecrets(label, text, DOTENV_SECRET, (match) => match[2] ?? match[3] ?? match[4]);
  scanNamedSecrets(label, text, OBJECT_SECRET, (match) => match[3]);
};

const scanPublicText = (paths, denylist) => {
  for (const path of paths) {
    const text = readText(path);
    if (text.includes("\0")) fail(`binary public file: ${path}`);
    scanText(path, text, denylist);
  }
};

// Order matters: the checks below fail on the first drift they find, so the
// message a broken release sees is the one the original single function gave.
const auditToolchain = (packageJson) => {
  if (
    readLines(".npmrc") !==
    "allow-scripts=\nengine-strict=true\nstrict-allow-scripts=true\n"
  ) {
    fail("strict install-script policy drift");
  }
  if (
    packageJson.engines?.node !== ">=24.0.0" ||
    packageJson.engines?.npm !== ">=12.0.0 <13.0.0" ||
    readLines(".nvmrc") !== "24.16.0\n"
  ) {
    fail("supported toolchain drift");
  }
  if (packageJson.scripts?.audit !== "npm audit --audit-level=high") {
    fail("dependency audit command drift");
  }
};

const auditDependencyLicenses = (packageJson, lock) => {
  const licenseDoc = readLines("docs/THIRD_PARTY_LICENSES.md");
  const documentedLicenses = new Map(
    [...licenseDoc.matchAll(/^\| `([^`]+)` \| [^|\r\n]+ \| ([^|\r\n]+) \|[ \t]*$/gm)]
      .map(([, name, license]) => [name, license.trim()]),
  );
  for (const [path, metadata] of Object.entries(lock.packages ?? {})) {
    if (path === "") continue;
    if (typeof metadata.license !== "string") fail(`missing package license: ${path}`);
    if (!ALLOWED_DEPENDENCY_LICENSES.has(metadata.license)) {
      fail(`unreviewed package license ${metadata.license}: ${path}`);
    }
  }
  for (const name of Object.keys(packageJson.devDependencies ?? {})) {
    const metadata = lock.packages?.[`node_modules/${name}`];
    if (!metadata || documentedLicenses.get(name) !== metadata.license) {
      fail(`direct dependency license documentation drift: ${name}`);
    }
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
  auditToolchain(packageJson);
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
  auditDependencyLicenses(packageJson, lock);
};

// Every active YAML line and literal block line of each workflow, in order.
// Each `uses:` value is reduced to the action identity so Dependabot's SHA
// bumps stay quiet. Pinning the whole file
// rather than the security-relevant subset is what makes the check hold: the
// pinned npm is what enforces allowScripts at all, --ignore-scripts is what
// keeps third-party install code from running, and the listing gate is what
// makes the allowlist real rather than decorative — but a workflow may also not
// grow a step that installs some other way, a job whose `permissions:` override
// the read-only default, a `container:` that picks a different machine, or a
// checkout that keeps its credentials. Only an exhaustive list says that.
const WORKFLOW_LINES = {
  "ci.yml": [
    "name: CI",
    "on:",
    "pull_request:",
    "push:",
    "branches:",
    "- main",
    "permissions:",
    "contents: read",
    "concurrency:",
    "group: ci-${{ github.ref }}",
    "cancel-in-progress: true",
    "jobs:",
    "check:",
    "runs-on: ubuntu-latest",
    "timeout-minutes: 25",
    "steps:",
    "- name: Check out source",
    "uses: actions/checkout",
    "with:",
    "fetch-depth: 0",
    "persist-credentials: false",
    "- name: Set up Node.js",
    "uses: actions/setup-node",
    "with:",
    "node-version-file: .nvmrc",
    "cache: npm",
    "package-manager-cache: false",
    "- name: Pin npm",
    "run: npm install -g --ignore-scripts npm@12.0.2",
    "- name: Report toolchain",
    "run: node --version && npm --version",
    "- name: Install locked dependencies",
    "run: npm ci --ignore-scripts",
    "- name: Verify the install-script allowlist covers every installed script",
    "run: npm install-scripts ls --json | jq -e '.allowScripts == []'",
    "- name: Verify",
    "run: npm run check",
    "- name: Cache the Playwright browser",
    "uses: actions/cache",
    "with:",
    "path: ~/.cache/ms-playwright",
    "key: ${{ runner.os }}-playwright-${{ hashFiles('package-lock.json') }}",
    "- name: Install the browser the rendered-page tests drive",
    "run: ./node_modules/.bin/playwright install chromium",
    "- name: Verify the rendered pages",
    "run: npm run test:browser",
    "- name: Keep a failing run's traces",
    "if: failure()",
    "uses: actions/upload-artifact",
    "with:",
    "name: rendered-page-failures",
    "path: .playwright",
    "include-hidden-files: true",
    "retention-days: 3",
  ],
  "dependabot-auto-merge.yml": [
    "name: Dependabot auto-merge",
    "on:",
    "workflow_run:",
    "workflows: [\"CI\"]",
    "types: [completed]",
    "permissions:",
    "contents: write",
    "pull-requests: write",
    "jobs:",
    "auto-merge:",
    "name: Merge minor/patch updates",
    "runs-on: ubuntu-latest",
    "if: >",
    "github.event.workflow_run.conclusion == 'success' &&",
    "github.event.workflow_run.event == 'pull_request' &&",
    "startsWith(github.event.workflow_run.head_branch, 'dependabot/')",
    "steps:",
    "- name: Checkout trusted scripts from main",
    "uses: actions/checkout",
    "with:",
    "ref: ${{ github.event.repository.default_branch }}",
    "persist-credentials: false",
    "sparse-checkout: .github/scripts",
    "- name: Merge grouped minor/patch PR",
    "env:",
    "GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}",
    "HEAD_BRANCH: ${{ github.event.workflow_run.head_branch }}",
    "HEAD_SHA: ${{ github.event.workflow_run.head_sha }}",
    "REPO: ${{ github.repository }}",
    "run: |",
    "set -euo pipefail",
    "case \"$HEAD_BRANCH\" in",
    "dependabot/*) ;;",
    "*)",
    "echo \"Skip: $HEAD_BRANCH is not a Dependabot branch\"",
    "exit 0",
    ";;",
    "esac",
    "# The PR number is all this lookup is for. The author filter stays",
    "# as a second condition, but it proves who OPENED the PR — not what",
    "# its text says now.",
    "pr=$(gh pr list --repo \"$REPO\" --head \"$HEAD_BRANCH\" \\",
    "--author \"app/dependabot\" --state open --json number --jq '.[0]')",
    "pr_number=$(printf '%s' \"$pr\" | jq -r '.number // empty')",
    "if [ -z \"$pr_number\" ]; then",
    "echo \"Skip: no open Dependabot PR for $HEAD_BRANCH\"",
    "exit 0",
    "fi",
    "# Decide from the COMMIT, not from the PR title. A title is mutable:",
    "# a collaborator, or any installed App holding pull-requests: write,",
    "# can rewrite it after CI, and rewriting it does not change HEAD — so",
    "# --match-head-commit cannot see it and an exact replacement would",
    "# look like a legitimate patch bump. The commit message belongs to the",
    "# SHA that CI verified and that --match-head-commit pins, and",
    "# Dependabot signs its commits, so require that signature too.",
    "commit=$(gh api \"repos/$REPO/commits/$HEAD_SHA\" \\",
    "--jq '{login: (.author.login // \"\"), verified: .commit.verification.verified, message: .commit.message}')",
    "commit_login=$(printf '%s' \"$commit\" | jq -r '.login')",
    "commit_verified=$(printf '%s' \"$commit\" | jq -r '.verified')",
    "message=$(printf '%s' \"$commit\" | jq -r '.message')",
    "subject=${message%%$'\\n'*}",
    "if [ \"$commit_login\" != \"dependabot[bot]\" ] || [ \"$commit_verified\" != \"true\" ]; then",
    "echo \"Skip: #$pr_number — $HEAD_SHA is not a verified Dependabot commit (author=$commit_login verified=$commit_verified)\"",
    "exit 0",
    "fi",
    "# Decide from the metadata trailer Dependabot writes at the end of",
    "# the commit message, not from its subject line. The subject is a",
    "# LOSSY rendering of the update: dependabot-core's commit_subject",
    "# drops the whole \" from X to Y\" once the subject passes 72",
    "# characters, and then cuts at the first \" in \" if it is still too",
    "# long, so #52 on this repository really is",
    "# \"bump actions/checkout in the actions-minor-patch group\" with no",
    "# versions anywhere in it. The trailer names update-type per",
    "# dependency and is the same block the official",
    "# dependabot/fetch-metadata action reads.",
    "#",
    "# Residual risk, accepted deliberately: nothing in the REST API",
    "# authenticates the CONTENT of a commit message. verified=true",
    "# attests the signature over the commit, and GitHub signs",
    "# Dependabot's commits with its own web-flow key, but author is a",
    "# separate field, so anyone who can write to this repository could",
    "# craft a commit that reads like a patch bump. That is not a",
    "# privilege this gate grants: write access already merges. The",
    "# officially recommended action authenticates no better, because",
    "# there is no second source to compare against.",
    "# The LAST complete block, so a \"---\" inside a quoted changelog",
    "# cannot introduce one.",
    "trailer=$(printf '%s\\n' \"$message\" | awk '",
    "/^---$/ { buffer = \"\"; inside = 1; next }",
    "/^\\.\\.\\.$/ { if (inside) { last = buffer; inside = 0 } next }",
    "inside { buffer = buffer $0 \"\\n\" }",
    "END { printf \"%s\", last }')",
    "# Parsed strictly against the shape dependabot-core writes, and every",
    "# deviation holds the PR. Counting keys across the block instead let a",
    "# quoted key (\"update-type\": …) read as \"no type declared\" and fall",
    "# through to the subject, and let an update-type outside the",
    "# updated-dependencies list count for a dependency that declared none.",
    "read -r verdict items typed majors _blocked reason <<< \"$(printf '%s\\n' \"$trailer\" | awk '",
    "# awk splits on LF, so a CR inside a line hides everything after it",
    "# from every rule below — and YAML would have read that as a second",
    "# line, which is how a major declaration became invisible. Printable",
    "# ASCII and spaces only; anything else holds.",
    "!/^[ -~]*$/ { bad = \"a character outside printable ASCII\"; exit }",
    "NR == 1 {",
    "if ($0 != \"updated-dependencies:\") { bad = \"the block does not start with updated-dependencies:\" ; exit }",
    "next",
    "}",
    "/^- dependency-name: ./ {",
    "items++; typed_here = 0",
    "name = $0; sub(/^- dependency-name: /, \"\", name)",
    "# Psych quotes scoped names. Accept simple single or double",
    "# quotes; hold escaped or ambiguous spellings rather than read",
    "# a different package name from the same YAML scalar.",
    "apostrophe = sprintf(\"%c\", 39)",
    "quote = substr(name, 1, 1)",
    "if (quote == apostrophe || quote == \"\\\"\") {",
    "if (length(name) < 3 || substr(name, length(name), 1) != quote) {",
    "bad = \"an unreadable dependency-name\"; exit",
    "}",
    "name = substr(name, 2, length(name) - 2)",
    "}",
    "if (index(name, apostrophe) || index(name, \"\\\"\") || index(name, \"\\\\\") || index(name, \" \")) {",
    "bad = \"an unreadable dependency-name\"; exit",
    "}",
    "next",
    "}",
    "/^- / { bad = \"a list item that is not dependency-name: \" $0; exit }",
    "/^  [a-z][a-z-]*: ./ {",
    "if (items == 0) { bad = \"a field before any dependency: \" $0; exit }",
    "key = $0; sub(/^  /, \"\", key); sub(/:.*$/, \"\", key)",
    "if (key == \"dependency-name\") { bad = \"a second dependency-name field\"; exit }",
    "if (key == \"update-type\") {",
    "if (typed_here) { bad = \"two update-type fields on one dependency\"; exit }",
    "typed_here = 1; typed++",
    "value = $0; sub(/^  update-type: /, \"\", value)",
    "if (value !~ /^version-update:semver-(major|minor|patch)$/) { bad = \"an unreadable update-type: \" value; exit }",
    "if (value == \"version-update:semver-major\") majors++",
    "}",
    "next",
    "}",
    "/^[[:space:]]*$/ { next }",
    "{ bad = \"an unrecognised line: \" $0; exit }",
    "END {",
    "if (bad != \"\") printf \"HOLD 0 0 0 0 %s\", bad",
    "else printf \"OK %d %d %d %d -\", items, typed, majors, blocked",
    "}')\"",
    "if [ \"$verdict\" != OK ]; then",
    "echo \"Skip: #$pr_number holds for manual review — its updated-dependencies trailer has $reason\"",
    "exit 0",
    "fi",
    "if [ \"$items\" -eq 0 ]; then",
    "echo \"Skip: #$pr_number holds for manual review — its commit message carries no updated-dependencies trailer\"",
    "exit 0",
    "fi",
    "if [ \"$majors\" -gt 0 ]; then",
    "echo \"Skip: #$pr_number declares $majors major update(s) (manual review required)\"",
    "exit 0",
    "fi",
    "if [ \"$typed\" -eq \"$items\" ]; then",
    "echo \"Non-major update ($items dependency/dependencies, all minor or patch): $subject\"",
    "elif [ \"$items\" -eq 1 ] && [ \"$typed\" -eq 0 ]; then",
    "# A security update declares no update-type — the trailer names only",
    "# the version it moves TO — so the version pair in the subject is",
    "# the only statement of what changed. These are the PRs this gate",
    "# exists for: dependabot.yml groups every *version* update, so what",
    "# arrives ungrouped is a security update, and those used to sit open",
    "# for days with high-severity advisories unpatched (fast-uri, svgo,",
    "# js-yaml). A subject long enough to have lost its version pair is",
    "# held rather than guessed at.",
    "case \"$subject\" in",
    "*[[:cntrl:]]*)",
    "echo \"Skip: #$pr_number holds for manual review — its commit subject is not a single plain line\"",
    "exit 0",
    ";;",
    "esac",
    "# Anchored to the WHOLE subject: an optional \"chore(deps): \"-style",
    "# prefix, the sentence, and the one suffix an untyped update can",
    "# carry — \" (via audit fix)\", which dependabot-core appends when",
    "# the fix came from npm audit. A group or directory suffix cannot",
    "# reach here: this branch needs a single dependency with no",
    "# declared type, and dependabot.yml groups only version updates,",
    "# in one directory.",
    "re_prefix='^([^[:space:]]+:[[:space:]]+)?[Bb]ump[[:space:]]+'",
    "# dependabot-core appends \" in /<directory>\" to an ungrouped update outside \"/\".",
    "re_dir='([[:space:]]+in[[:space:]]+/[A-Za-z0-9._/-]*)?'",
    "re_audit='([[:space:]]+\\(via[[:space:]]+audit[[:space:]]+fix\\))?'",
    "# A whole version token, not a numeric prefix of one: \"1evil\" and a",
    "# full-width digit in \"1０.0.0\" must not read as major 1. The suffix",
    "# takes further hyphens and pluses, so 1.0.0-rc.1+build.5 and",
    "# 1.0.0-alpha-beta parse as well.",
    "re_version='v?[0-9]+(\\.[0-9]+)*([-+][0-9A-Za-z.+-]+)?'",
    "# Group indices: 2 = old version token, 5 = new one.",
    "bump_re=\"${re_prefix}[^[:space:]]+[[:space:]]+from[[:space:]]+(${re_version})[[:space:]]+to[[:space:]]+(${re_version})${re_dir}${re_audit}$\"",
    "if [[ ! \"$subject\" =~ $bump_re ]]; then",
    "echo \"Skip: #$pr_number holds for manual review — one untyped dependency, and its subject is not one readable version pair\"",
    "echo \"  subject: $subject\"",
    "exit 0",
    "fi",
    "old_version=\"${BASH_REMATCH[2]#v}\"",
    "new_version=\"${BASH_REMATCH[5]#v}\"",
    "old_major=\"${old_version%%[.+-]*}\"",
    "new_major=\"${new_version%%[.+-]*}\"",
    "if [ \"$old_major\" != \"$new_major\" ]; then",
    "echo \"Skip: #$pr_number bumps major $old_major -> $new_major (manual review required)\"",
    "exit 0",
    "fi",
    "echo \"Untyped security update ($old_version -> $new_version): $subject\"",
    "else",
    "echo \"Skip: #$pr_number holds for manual review — $items dependencies, only $typed of them declare an update type\"",
    "exit 0",
    "fi",
    "# The trailer says what the update IS; this says what the PR may",
    "# TOUCH. Nothing in the REST API can authenticate the message (see",
    "# above), so bound the blast radius of a commit that lies: a",
    "# Dependabot PR only ever edits its ecosystem's manifests, and every",
    "# one this repository has merged did exactly that (#52 the workflow it",
    "# pins, #58/#60/#66 package.json and package-lock.json).",
    "case \"$HEAD_BRANCH\" in",
    "# \\A and \\z, not ^ and $: jq's $ matches before a trailing",
    "# newline, so \"package.json\\n\" — a different path to git, and not a",
    "# manifest — satisfied the anchored pattern (measured on jq 1.7).",
    "dependabot/npm_and_yarn/*) allow_re='\\A([^/]+/)*package(-lock)?\\.json\\z' ;;",
    "dependabot/github_actions/*) allow_re='\\A\\.github/workflows/[^/]+\\.ya?ml\\z' ;;",
    "*)",
    "echo \"Skip: #$pr_number is for an ecosystem this gate has no file allowlist for ($HEAD_BRANCH)\"",
    "exit 0",
    ";;",
    "esac",
    "# Pinned to HEAD_SHA, not read off the PR. The pull-request files",
    "# endpoint answers for whatever the PR points at WHEN IT IS CALLED, so",
    "# a branch flipped to a harmless commit for the length of that call and",
    "# flipped back would be checked in place of the commit being merged —",
    "# --match-head-commit would still match, because it only compares the",
    "# head at merge time. The compare endpoint takes the SHA itself.",
    "# The comparison point is main, named literally. Taking it from the",
    "# PR was the same hole one level up: base is mutable, so retargeting",
    "# the PR to a branch that already contains the unwanted change — no",
    "# push, no new HEAD, invisible to --match-head-commit — makes the",
    "# compare return only the manifests. The PR's own base is checked",
    "# instead of trusted, because a merge has to land on main.",
    "compare=$(gh api \"repos/$REPO/compare/main...$HEAD_SHA\")",
    "# Matched inside jq so a filename is never split on whitespace: git",
    "# accepts a newline in a path, and \"package.json\\npackage-lock.json\"",
    "# is one file that would read as two allowed ones. Only added,",
    "# modified and changed pass — a rename has a second path on the other",
    "# side of it and a removal takes a file away, so both hold.",
    "offenders=$(printf '%s' \"$compare\" | jq -r --arg allow \"$allow_re\" '",
    "[ .files[]?",
    "| select(((.status | IN(\"added\", \"modified\", \"changed\")) | not)",
    "or ((.filename | test($allow)) | not))",
    "| .status + \" \" + (.filename | @json) ] | .[]')",
    "file_count=$(printf '%s' \"$compare\" | jq '.files | length')",
    "# \"ahead\" means main is an ancestor of HEAD_SHA, so main is the only",
    "# merge base and this three-dot file list IS what a squash applies.",
    "# With a criss-cross history there are several merge bases, the API",
    "# picks one, and the list can then omit a change the merge would",
    "# carry — so anything but \"ahead\" holds until Dependabot rebases,",
    "# which it does on its own when main moves.",
    "compare_status=$(printf '%s' \"$compare\" | jq -r '.status // \"\"')",
    "merge_base=$(printf '%s' \"$compare\" | jq -r '.merge_base_commit.sha // \"\"')",
    "main_sha=$(gh api \"repos/$REPO/commits/main\" --jq '.sha')",
    "if [ \"$compare_status\" != ahead ] || [ \"$merge_base\" != \"$main_sha\" ]; then",
    "# D3: pin both sides to SHAs and accept only disjoint, signed Dependabot changes.",
    "gh api \"repos/$REPO/compare/$merge_base...$HEAD_SHA\" > \"$RUNNER_TEMP/dependabot-head.json\"",
    "gh api \"repos/$REPO/compare/$merge_base...$main_sha\" > \"$RUNNER_TEMP/dependabot-main.json\"",
    "printf '%s' \"$compare\" > \"$RUNNER_TEMP/dependabot-compare.json\"",
    "if ! jq -n --slurpfile compare \"$RUNNER_TEMP/dependabot-compare.json\" \\",
    "--slurpfile head \"$RUNNER_TEMP/dependabot-head.json\" \\",
    "--slurpfile main \"$RUNNER_TEMP/dependabot-main.json\" \\",
    "'{compare: $compare[0], head: $head[0], main: $main[0]}' \\",
    "| jq -e -f .github/scripts/dependabot-diverged.jq >/dev/null; then",
    "echo \"Skip: #$pr_number is $compare_status of main (merge base $merge_base, main $main_sha) — D3 could not prove disjoint paths and single-parent verified Dependabot commits\"",
    "exit 0",
    "fi",
    "mergeable=$(gh api \"repos/$REPO/pulls/$pr_number\" --jq '.mergeable')",
    "if [ \"$mergeable\" != true ]; then",
    "echo \"Skip: #$pr_number is not mergeable (mergeable=$mergeable)\"",
    "exit 0",
    "fi",
    "fi",
    "if [ -z \"$file_count\" ] || [ \"$file_count\" -eq 0 ]; then",
    "echo \"Skip: #$pr_number holds for manual review — no file list to check for $HEAD_SHA\"",
    "exit 0",
    "fi",
    "# The endpoint stops at 300 files, so above that the list cannot be",
    "# shown to be complete and a clean sample proves nothing.",
    "if [ \"$file_count\" -ge 300 ]; then",
    "echo \"Skip: #$pr_number changes $file_count files, at or past the compare limit — the file list cannot be checked in full\"",
    "exit 0",
    "fi",
    "if [ -n \"$offenders\" ]; then",
    "echo \"Skip: #$pr_number touches files outside the allowlist for $HEAD_BRANCH:\"",
    "printf '  %s\\n' \"$offenders\"",
    "exit 0",
    "fi",
    "echo \"Diff is $file_count file(s), all dependency manifests for $HEAD_BRANCH\"",
    "# --auto: 全要件（ruleset の required status checks とスレッド解決）が",
    "# 満たされた時点で GitHub がマージする。この時点で既に満たされていれば即マージ。",
    "# --match-head-commit: CI が検証した commit と PR HEAD が一致する場合のみ",
    "# 対象にする（TOCTOU 防止）。CI 後に rebase されていたら失敗するが、",
    "# 新しい CI 実行が完了すれば再試行される。",
    "# Read last, immediately before the merge call. There is no",
    "# --match-base to pin it the way --match-head-commit pins HEAD (the",
    "# REST merge takes an expected head `sha` and nothing for the base),",
    "# and GitHub's auto-merge resolves the base when it merges, minutes",
    "# later — so this narrows the window, it does not close it.",
    "#",
    "# Accepted residual, and its precondition: an actor holding only",
    "# pull-requests: write could retarget the PR after this read and have",
    "# this job's contents: write token merge HEAD onto that other branch.",
    "#",
    "# A second window has the same shape and is NOT covered by \"the base",
    "# is still main\": main can advance between the checks above and the",
    "# moment auto-merge fires. If such a commit RENAMES one of the",
    "# allowlisted manifests, the squash applies this PR's change to the",
    "# renamed path — a path the allowlist never approved. It needs no",
    "# attacker: a maintainer renaming a lockfile while a PR is pending",
    "# does it. What lands is still a dependency bump, and pushing that",
    "# rename to main already requires write access to main.",
    "#",
    "# Both windows would close server-side with one setting rather than",
    "# more code here: strict_required_status_checks_policy on the ruleset",
    "# makes GitHub require the branch to be current with main before it",
    "# merges, so the diff checked here would be the diff applied.",
    "#",
    "# It stays off (false), deliberately. Dependabot opens its PRs in",
    "# pairs on the same schedule, and merging the first leaves the second",
    "# behind main. Under strict the second stops there — and nothing",
    "# restarts it: CI does not re-run when only main moves, so this job",
    "# never reaches a second decision, and Dependabot's own rebasing does",
    "# not trigger on \"the base advanced\" either (dependabot-core #10969).",
    "# Turning it on would trade a window of minutes for a weekly manual",
    "# step on the very updates this workflow exists to land unattended.",
    "# Before turning it on, this job needs a trigger for main moving (the",
    "# token Dependabot acts on is REBASE_TOKEN, used above).",
    "base_ref=$(gh api \"repos/$REPO/pulls/$pr_number\" --jq '.base.ref')",
    "if [ \"$base_ref\" != main ]; then",
    "echo \"Skip: #$pr_number targets $base_ref, not main\"",
    "exit 0",
    "fi",
    "echo \"Enabling auto-merge for PR #$pr_number ($HEAD_BRANCH @ $HEAD_SHA)\"",
    "gh pr merge --repo \"$REPO\" --auto --squash --delete-branch \\",
    "--match-head-commit \"$HEAD_SHA\" \"$pr_number\"",
  ],
  "dependency-stall.yml": [
    "name: Dependency stall watch",
    "on:",
    "schedule:",
    "- cron: '0 1 * * 1'",
    "workflow_dispatch:",
    "permissions:",
    "contents: read",
    "pull-requests: read",
    "actions: read",
    "checks: read",
    "statuses: read",
    "issues: write",
    "concurrency:",
    "group: dependency-stall",
    "cancel-in-progress: false",
    "jobs:",
    "watch:",
    "runs-on: ubuntu-latest",
    "timeout-minutes: 10",
    "steps:",
    "- name: Checkout monitoring script",
    "uses: actions/checkout",
    "with:",
    "persist-credentials: false",
    "sparse-checkout: .github/scripts",
    "- name: Setup Node.js",
    "uses: actions/setup-node",
    "with:",
    "node-version: '24'",
    "- name: Report stalled dependency updates",
    "env:",
    "GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}",
    "run: node .github/scripts/dependency-stall.mjs",
  ],
};
const WORKFLOW_ACTION = /^(- )?uses: (\S+)$/;

// Space and tab are the only YAML whitespace, and a `#` is only a comment when
// YAML whitespace precedes it. Both rules have to be followed exactly: cutting
// or trimming on anything wider hides characters from the comparison that
// Actions still executes. `run: npm run check # rest` is one command to
// YAML and to the shell, and `String.prototype.trim` treats U+00A0 as space.
const YAML_SPACE = " \t";
const stripComment = (line, literal = false) => {
  const comment = literal ? -1 : line.search(/[ \t]#/);
  const content = comment === -1 ? line : line.slice(0, comment);
  let start = 0;
  let end = content.length;
  while (start < end && YAML_SPACE.includes(content[start])) start += 1;
  while (end > start && YAML_SPACE.includes(content[end - 1])) end -= 1;
  return content.slice(start, end);
};

// Indentation is dropped, so the list is what says where a line belongs: a
// job-level `permissions:` block the reviewed workflow does not have is rejected.
const auditWorkflow = (name, reviewedLines) => {
  const workflow = readText(`.github/workflows/${name}`);
  // Deliberately redundant with the list. This is the one key whose presence
  // hands a write token to code from a fork, and it should fail by name however
  // it is written.
  if (/pull_request_target\s*:/.test(workflow)) fail("pull_request_target is forbidden");
  // Split the way YAML does. A lone CR is a line break to YAML and not to
  // JavaScript, so `split("\n")` would read an injected step as the tail of a
  // comment on the line above it. A leading byte-order mark is legal and
  // changes nothing about what runs, so it is removed by name rather than by a
  // whitespace rule wide enough to swallow more than it is.
  const lines = [];
  let blockIndent = null;
  for (const rawLine of workflow.replace(/^\uFEFF/, "").split(/\r\n|\r|\n/)) {
    const indent = rawLine.match(/^[ \t]*/)[0].length;
    const inBlock = blockIndent !== null && (indent > blockIndent || /^[ \t]*$/.test(rawLine));
    if (!inBlock) blockIndent = null;
    // A block's # characters belong to its script/expression, not YAML comments.
    const line = stripComment(rawLine, inBlock);
    if (line.length === 0 || (!inBlock && line.startsWith("#"))) continue;
    if (!inBlock && /^[a-z-]+: [|>]$/.test(line)) blockIndent = indent;
    const action = inBlock ? null : WORKFLOW_ACTION.exec(line);
    if (action === null) {
      lines.push(line);
    } else {
      if (!/@[0-9a-f]{40}$/.test(action[2])) {
        fail(`GitHub Action is not commit-pinned: ${action[2]} in ${name}`);
      }
      lines.push(`${action[1] ?? ""}uses: ${action[2].slice(0, action[2].lastIndexOf("@"))}`);
    }
  }
  for (let index = 0; index < Math.max(lines.length, reviewedLines.length); index += 1) {
    if (lines[index] !== reviewedLines[index]) {
      fail(
        `workflow drift in ${name}: ${JSON.stringify(lines[index] ?? null)} where the reviewed` +
          ` workflow has ${JSON.stringify(reviewedLines[index] ?? null)}`,
      );
    }
  }
};

const auditWorkflows = () => {
  const workflows = readdirSync(join(ROOT, ".github/workflows")).sort();
  if (JSON.stringify(workflows) !== JSON.stringify(Object.keys(WORKFLOW_LINES).sort())) {
    fail(`unreviewed workflow file: ${JSON.stringify(workflows)}`);
  }
  for (const [name, lines] of Object.entries(WORKFLOW_LINES)) auditWorkflow(name, lines);
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

const resolveGit = () => {
  const path = ["/usr/bin/git", "/bin/git", "/usr/local/bin/git"].find((candidate) =>
    existsSync(candidate),
  );
  if (path === undefined) fail("git executable not found in a fixed directory");
  return path;
};

const gitRaw = (args) =>
  execFileSync(resolveGit(), ["--no-replace-objects", "-C", ROOT, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

const git = (args) => gitRaw(args).trim();

const auditCurrentLedgerFiles = (paths) => {
  for (const path of paths) {
    if (path.toLowerCase() === PRIVATE_LEDGER_PATH) {
      fail("private porting ledger must not be public");
    }
    const absolute = join(ROOT, path);
    if (!existsSync(absolute)) continue;
    const stat = lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) continue;
    if (readText(path).toUpperCase().includes(PRIVATE_LEDGER_MARKER)) {
      fail(`private porting ledger marker found in ${path}`);
    }
  }
};

const auditPrivatePortingLedger = () => {
  let shallow;
  try {
    shallow = git(["rev-parse", "--is-shallow-repository"]);
  } catch {
    fail("cannot determine repository history depth for private ledger audit");
  }
  if (shallow !== "false") {
    fail("private ledger history audit requires a complete Git history");
  }
  let trackedPaths;
  let paths;
  let markerInIndex;
  let pathInHistory;
  let markerInMessages;
  let markerInHistory;
  try {
    trackedPaths = gitRaw(["ls-files", "--cached", "-z"])
      .split("\0")
      .filter(Boolean);
    const untrackedPaths = gitRaw(["ls-files", "--others", "--exclude-standard", "-z"])
      .split("\0")
      .filter(Boolean);
    paths = [...new Set([...trackedPaths, ...untrackedPaths])];
    try {
      gitRaw(["grep", "--cached", "-a", "-i", "-F", PRIVATE_LEDGER_MARKER, "--"]);
      markerInIndex = true;
    } catch (error) {
      if (error?.status !== 1) throw error;
      markerInIndex = false;
    }
    pathInHistory =
      git(["log", "--all", "--full-history", "--format=%H", "--", `:(icase)${PRIVATE_LEDGER_PATH}`]) !== "";
    markerInHistory =
      git([
        "log",
        "--all",
        "-m",
        "--format=%H",
        "--text",
        "--regexp-ignore-case",
        "-G",
        PRIVATE_LEDGER_MARKER,
        "--",
      ]) !== "";
    // -G examines file diffs, not commit messages. Search all reachable refs,
    // including empty commits, without returning any potentially private text.
    markerInMessages =
      git([
        "log",
        "--all",
        "--format=%H",
        "--max-count=1",
        "--fixed-strings",
        "--regexp-ignore-case",
        `--grep=${PRIVATE_LEDGER_MARKER}`,
        "--",
      ]) !== "";
  } catch {
    fail("cannot enumerate repository paths for private ledger audit");
  }
  auditCurrentLedgerFiles(paths);
  if (markerInIndex) fail("private porting ledger marker found in Git index");
  if (pathInHistory) fail("private porting ledger path found in public history");
  if (markerInHistory) fail("private porting ledger marker found in public history");
  if (markerInMessages) fail("private porting ledger marker found in commit messages");
};

// Only tag objects can contain tag metadata. Stream refs and retain unique tag
// roots only; neither unrelated refs nor blobs should hit a subprocess buffer.
// Follow nested tag targets so deleting an inner ref cannot hide its metadata.
// Reject blob/tree refs: commit-history scans cannot inspect their contents.
const readAnnotatedTagRoots = async () => {
  const child = spawn(
    resolveGit(),
    ["--no-replace-objects", "-C", ROOT, "for-each-ref", "--format=%(objecttype) %(objectname)"],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const roots = new Set();
  let invalid = false;
  lines.on("line", (line) => {
    const ref = /^(commit|tag) ([0-9a-f]{40}|[0-9a-f]{64})$/.exec(line);
    if (ref === null) invalid = true;
    else if (ref[1] === "tag") roots.add(ref[2]);
  });
  lines.on("error", () => {
    invalid = true;
    child.kill();
  });
  try {
    // close follows stdout closure; all line events have been consumed. once
    // rejects a spawn error, and neither refs nor Git diagnostics are printed.
    const [code] = await once(child, "close");
    if (code !== 0 || invalid) fail("cannot enumerate tag refs for metadata audit");
    return [...roots];
  } finally {
    lines.close();
  }
};

const auditAnnotatedTagMetadata = async () => {
  let pending;
  try {
    pending = await readAnnotatedTagRoots();
  } catch {
    fail("cannot enumerate tag refs for metadata audit");
  }
  const visited = new Set();
  while (pending.length > 0) {
    const id = pending.pop();
    if (visited.has(id)) continue;
    if (!/^[0-9a-f]{40,64}$/.test(id)) fail("invalid tag object identifier");
    visited.add(id);
    let metadata;
    try {
      metadata = gitRaw(["cat-file", "tag", id]);
    } catch {
      fail("cannot read reachable tag metadata");
    }
    if (metadata.toUpperCase().includes(PRIVATE_LEDGER_MARKER)) {
      fail("private porting ledger marker found in annotated tag metadata");
    }
    const target = /^object ([0-9a-f]{40,64})\ntype (blob|tree|commit|tag)\n/.exec(metadata);
    if (target === null) fail("invalid tag target metadata");
    if (target[2] === "tag") pending.push(target[1]);
    else if (target[2] !== "commit") fail("non-commit tag target is not allowed");
  }
};

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
  execFileSync(resolveGit(), ["--no-replace-objects", "-C", ROOT, "fsck", "--full", "--no-reflogs", "--no-dangling"], {
    stdio: ["ignore", "ignore", "pipe"],
  });
};

try {
  const options = parseArguments();
  const paths = readManifest();
  auditPrivatePortingLedger();
  await auditAnnotatedTagMetadata();
  const denylist = loadDenylist(options.denylist);
  scanPublicText(paths, denylist);
  auditPackage();
  auditWorkflows();
  auditAuthForms();
  if (options.publicTree) auditPublicTree(paths, denylist);
  console.log(`release audit passed (${paths.length} allowlisted files${options.publicTree ? ", public history" : ""})`);
} catch (error) {
  console.error(`release audit failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
