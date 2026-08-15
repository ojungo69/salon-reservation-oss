import { execFileSync } from "node:child_process";
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
  ".github/workflows/ci.yml",
  ".npmrc",
  "CHANGELOG.md",
  "CODE_OF_CONDUCT.md",
  "CONTRIBUTING.md",
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "docs/ADAPTER-CONTRACTS.md",
  "docs/CALENDAR-SETUP.md",
  "docs/CLOUDFLARE.md",
  "docs/PARITY.md",
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
  "public/setup.html",
  "public/terms.html",
  "release/public-files.txt",
  "scripts/assemble-public-release.sh",
  "scripts/release-audit.mjs",
  "src/installation-config.ts",
  "src/calendar-adapter.ts",
  "src/worker.ts",
  "test/installation-config.test.ts",
  "test/calendar-adapter.test.ts",
  "test/journey.test.ts",
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
  // eslint-disable-next-line -- the open is what the containment above exists to protect
  const handle = openSync(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); // nosemgrep
  if (!fstatSync(handle).isFile()) {
    closeSync(handle);
    fail("denylist path is not a regular file");
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
    // eslint-disable-next-line -- handle is the descriptor opened above, not a path
    const terms = readFileSync(handle, "utf8") // nosemgrep
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
const CREDENTIAL_RULES = [
  // eslint-disable-next-line
  ["private key", new RegExp(`-----BEGIN (?:RSA |EC |OPENSSH |DSA )?${"PRIVATE KEY"}-----`)], // nosemgrep
  // eslint-disable-next-line
  ["GitHub token", new RegExp(String.raw`\b${"github"}_pat_[A-Za-z0-9_]{20,}\b`)], // nosemgrep
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{20,}\b/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["JWT-like token", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/],
  ["live payment secret", /\bsk_live_[A-Za-z0-9]{16,}\b/],
  ["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{16,}\b/],
];
const FORBIDDEN_ROOTS = [/\/home\/[^/\s]+\//, /\/Users\/[^/\s]+\//];
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const SECRET_NAME =
  "(OWNER_TOKEN|TURNSTILE_SECRET|CALENDAR_FEED_TOKEN|GOOGLE_CALENDAR_CREDENTIALS|CLOUDFLARE_API_TOKEN|CLOUDFLARE_API_KEY|CF_API_TOKEN|CF_API_KEY|PASSWORD|CLIENT_SECRET)";
// Both rules share the name alternation above, so both are composed rather than
// written as literals. The only interpolation is that module constant.
// eslint-disable-next-line
const DOTENV_SECRET = new RegExp( // nosemgrep
  String.raw`^\s*(?:export\s+)?${SECRET_NAME}\s*=\s*(?:"([^"\n]*)"|'([^'\n]*)'|([^\s#]+))\s*(?:#.*)?$`, // nosemgrep
  "gm",
);
// eslint-disable-next-line
const OBJECT_SECRET = new RegExp( // nosemgrep
  String.raw`["']?\b${SECRET_NAME}\b["']?\s*:\s*(["'])([^"'\n]+)\2`, // nosemgrep
  "g",
);

const scanText = (label, text, denylist) => {
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

// Every active line of ci.yml, in order, with each `uses:` value reduced to the
// action identity so Dependabot's SHA bumps stay quiet. Pinning the whole file
// rather than the security-relevant subset is what makes the check hold: the
// pinned npm is what enforces allowScripts at all, --ignore-scripts is what
// keeps third-party install code from running, and the listing gate is what
// makes the allowlist real rather than decorative — but a workflow may also not
// grow a step that installs some other way, a job whose `permissions:` override
// the read-only default, a `container:` that picks a different machine, or a
// checkout that keeps its credentials. Only an exhaustive list says that.
const WORKFLOW_LINES = [
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
  "fetch-depth: 1",
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
  "retention-days: 3",
];
const WORKFLOW_ACTION = /^(- )?uses: (\S+)$/;

// Space and tab are the only YAML whitespace, and a `#` is only a comment when
// YAML whitespace precedes it. Both rules have to be followed exactly: cutting
// or trimming on anything wider hides characters from the comparison that
// Actions still executes. `run: npm run check # rest` is one command to
// YAML and to the shell, and `String.prototype.trim` treats U+00A0 as space.
const YAML_SPACE = " \t";
const stripComment = (line) => {
  const comment = line.search(/[ \t]#/);
  const content = comment === -1 ? line : line.slice(0, comment);
  let start = 0;
  let end = content.length;
  while (start < end && YAML_SPACE.includes(content[start])) start += 1;
  while (end > start && YAML_SPACE.includes(content[end - 1])) end -= 1;
  return content.slice(start, end);
};

// Indentation is dropped, so the list is what says where a line belongs: a
// job-level `permissions:` block is two lines the reviewed workflow does not
// have, wherever it sits.
const auditWorkflow = () => {
  // GitHub runs every file in this directory, so pinning one of them says
  // nothing on its own: a second workflow is a second place to install, with
  // its own permissions and its own triggers.
  const workflows = readdirSync(join(ROOT, ".github/workflows")).sort();
  if (workflows.length !== 1 || workflows[0] !== "ci.yml") {
    fail(`unreviewed workflow file: ${JSON.stringify(workflows)}`);
  }
  const workflow = readText(".github/workflows/ci.yml");
  // Deliberately redundant with the list. This is the one key whose presence
  // hands a write token to code from a fork, and it should fail by name however
  // it is written.
  if (/pull_request_target\s*:/.test(workflow)) fail("pull_request_target is forbidden");
  // Split the way YAML does. A lone CR is a line break to YAML and not to
  // JavaScript, so `split("\n")` would read an injected step as the tail of a
  // comment on the line above it. A leading byte-order mark is legal and
  // changes nothing about what runs, so it is removed by name rather than by a
  // whitespace rule wide enough to swallow more than it is.
  const lines = workflow
    .replace(/^\uFEFF/, "")
    .split(/\r\n|\r|\n/)
    .map(stripComment)
    .filter((line) => line.length !== 0 && !line.startsWith("#"))
    .map((line) => {
      const action = WORKFLOW_ACTION.exec(line);
      if (action === null) return line;
      if (!/@[0-9a-f]{40}$/.test(action[2])) {
        fail(`GitHub Action is not commit-pinned: ${action[2]}`);
      }
      return `${action[1] ?? ""}uses: ${action[2].slice(0, action[2].lastIndexOf("@"))}`;
    });
  for (let index = 0; index < Math.max(lines.length, WORKFLOW_LINES.length); index += 1) {
    if (lines[index] !== WORKFLOW_LINES[index]) {
      fail(
        `workflow drift: ${JSON.stringify(lines[index] ?? null)} where the reviewed` +
          ` workflow has ${JSON.stringify(WORKFLOW_LINES[index] ?? null)}`,
      );
    }
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

const resolveGit = () => {
  const path = ["/usr/bin/git", "/bin/git", "/usr/local/bin/git"].find((candidate) =>
    existsSync(candidate),
  );
  if (path === undefined) fail("git executable not found in a fixed directory");
  return path;
};

const git = (args) =>
  execFileSync(resolveGit(), ["-C", ROOT, ...args], {
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
  execFileSync(resolveGit(), ["-C", ROOT, "fsck", "--full", "--no-reflogs", "--no-dangling"], {
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
