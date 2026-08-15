import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The release audit's private denylist is the one input a caller names, so the
 * open that reads it is the script's only path-handling surface: it canonicalises
 * the name, confines the result to the repository or a system temp directory, and
 * then reads through one handle that will not follow a link or wait on a FIFO.
 * `npm run check` runs the audit with no denylist at all, and the default file is
 * gitignored, so nothing else in the suite reaches any of it.
 *
 * The fixtures go under `/tmp` rather than `os.tmpdir()` on purpose: the audit
 * trusts `/tmp` and `/var/tmp` by name, and `os.tmpdir()` follows `TMPDIR`, which
 * points somewhere else entirely on macOS and wherever a shell has set it. Both
 * that and the FIFO case need a POSIX system, which is what the confined open
 * itself requires — it refuses to run at all where `O_NOFOLLOW` is absent.
 */

const POSIX = process.platform !== "win32";
const SCRIPT = fileURLToPath(new URL("../scripts/release-audit.mjs", import.meta.url));
const ROOT = dirname(dirname(SCRIPT));
const workspace = POSIX ? mkdtempSync("/tmp/release-audit-denylist-") : "";

after(() => {
  if (workspace) rmSync(workspace, { recursive: true, force: true });
});

const write = (name: string, contents: string): string => {
  const path = join(workspace, name);
  writeFileSync(path, contents);
  return path;
};

const runAudit = (...args: string[]): { status: number | null; output: string } => {
  // Killed rather than awaited forever: a denylist the open blocks on would
  // otherwise hang this test the way it hung the audit.
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    timeout: 30_000,
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
};

const runWithDenylist = (denylist: string) => runAudit("--denylist", denylist);

test("takes the absent default denylist as no private terms", { skip: !POSIX }, (t) => {
  if (existsSync(join(ROOT, ".release-private-denylist"))) {
    t.skip("this checkout keeps a private denylist, which this case exists to test the absence of");
    return;
  }
  const { status, output } = runAudit();
  assert.equal(status, 0, output);
  assert.match(output, /release audit passed/);
});

test("accepts a denylist file inside a system temp directory", { skip: !POSIX }, () => {
  const { status, output } = runWithDenylist(write("terms.txt", "# a comment\nunreleased-codename\n"));
  assert.equal(status, 0, output);
  assert.match(output, /release audit passed/);
});

test("refuses a denylist that is not a regular file", { skip: !POSIX }, () => {
  const directory = join(workspace, "as-a-directory");
  mkdirSync(directory);
  const asDirectory = runWithDenylist(directory);
  assert.equal(asDirectory.status, 1, asDirectory.output);
  assert.match(asDirectory.output, /denylist path is not a regular file/);

  // The open would wait for a writer without O_NONBLOCK, so the type check that
  // refuses this could never run and the audit would never finish.
  const fifo = join(workspace, "as-a-fifo");
  execFileSync("mkfifo", [fifo]);
  const asFifo = runWithDenylist(fifo);
  assert.equal(asFifo.status, 1, asFifo.output);
  assert.match(asFifo.output, /denylist path is not a regular file/);
});

test("refuses a denylist outside the permitted roots, named or linked", { skip: !POSIX }, (t) => {
  const home = homedir();
  // The home directory is the one place that is normally neither the repository
  // nor a system temp root. Where it is one of them there is nothing to test.
  for (const root of [ROOT, "/tmp", "/var/tmp"]) {
    if (home === root || home.startsWith(`${root}${sep}`)) {
      t.skip(`this environment's home directory is inside ${root}`);
      return;
    }
  }
  // mkdtemp rather than a fixed name, because the cleanup deletes what it names.
  const outsideRoot = mkdtempSync(join(home, ".release-audit-denylist-test-"));
  const outside = join(outsideRoot, "terms.txt");
  writeFileSync(outside, "unreleased-codename\n");
  try {
    const named = runWithDenylist(outside);
    assert.equal(named.status, 1, named.output);
    assert.match(
      named.output,
      /denylist path is not under the repository or a system temp directory/,
    );

    // Confinement applies to where the name resolves, not where it sits, so a
    // link parked inside a permitted root does not carry its target in with it.
    const link = join(workspace, "points-outside");
    symlinkSync(outside, link);
    const linked = runWithDenylist(link);
    assert.equal(linked.status, 1, linked.output);
    assert.match(
      linked.output,
      /denylist path is not under the repository or a system temp directory/,
    );
  } finally {
    rmSync(outsideRoot, { recursive: true, force: true });
  }
});

test("refuses a denylist it cannot read at all", { skip: !POSIX }, () => {
  const { status, output } = runWithDenylist(join(workspace, "never-written"));
  assert.equal(status, 1, output);
  assert.match(output, /denylist path is not readable/);
});

test("refuses a denylist with nothing in it", { skip: !POSIX }, () => {
  const { status, output } = runWithDenylist(write("empty.txt", "\n# only a comment\n"));
  assert.equal(status, 1, output);
  assert.match(output, /private denylist is empty/);
});

test("refuses terms that are too short, unprintable, or repeated", { skip: !POSIX }, () => {
  for (const [name, contents, message] of [
    ["short.txt", "ab\n", /unsafe term/],
    ["control.txt", "code\u0007name\n", /unsafe term/],
    ["duplicate.txt", "codename\nCODENAME\n", /duplicate terms/],
  ] as const) {
    const { status, output } = runWithDenylist(write(name, contents));
    assert.equal(status, 1, output);
    assert.match(output, message);
  }
});
