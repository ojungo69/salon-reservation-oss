import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The release audit's private denylist is the one input a caller names, so the
 * open that reads it is the script's only path-handling surface: it canonicalises
 * the name, confines the result to the repository or a system temp directory, and
 * then reads through one handle that refuses to follow a link or to wait on a
 * FIFO. `npm run check` runs the audit with no denylist at all, and the default
 * file is gitignored, so nothing else in the suite reaches any of it.
 */

const SCRIPT = fileURLToPath(new URL("../scripts/release-audit.mjs", import.meta.url));
const workspace = mkdtempSync(join(tmpdir(), "release-audit-denylist-"));

after(() => {
  rmSync(workspace, { recursive: true, force: true });
});

const write = (name: string, contents: string): string => {
  const path = join(workspace, name);
  writeFileSync(path, contents);
  return path;
};

const runAudit = (denylist: string): { status: number | null; output: string } => {
  // Killed rather than awaited forever: a denylist the open blocks on would
  // otherwise hang this test the way it hung the audit.
  const result = spawnSync(process.execPath, [SCRIPT, "--denylist", denylist], {
    encoding: "utf8",
    timeout: 30_000,
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
};

test("accepts a denylist file inside a system temp directory", () => {
  const { status, output } = runAudit(write("terms.txt", "# a comment\nunreleased-codename\n"));
  assert.equal(status, 0, output);
  assert.match(output, /release audit passed/);
});

test("refuses a denylist that is not a regular file", () => {
  const directory = join(workspace, "as-a-directory");
  mkdirSync(directory);
  const asDirectory = runAudit(directory);
  assert.equal(asDirectory.status, 1, asDirectory.output);
  assert.match(asDirectory.output, /denylist path is not a regular file/);

  // The open would wait for a writer without O_NONBLOCK, so the type check that
  // refuses this could never run and the audit would never finish.
  const fifo = join(workspace, "as-a-fifo");
  execFileSync("mkfifo", [fifo]);
  const asFifo = runAudit(fifo);
  assert.equal(asFifo.status, 1, asFifo.output);
  assert.match(asFifo.output, /denylist path is not a regular file/);
});

test("refuses a denylist outside the repository and the system temp roots, named or linked", () => {
  const outside = join(homedir(), ".release-audit-denylist-test-target");
  writeFileSync(outside, "unreleased-codename\n");
  try {
    const named = runAudit(outside);
    assert.equal(named.status, 1, named.output);
    assert.match(
      named.output,
      /denylist path is not under the repository or a system temp directory/,
    );

    // Confinement applies to where the name resolves, not where it sits, so a
    // link parked inside a permitted root does not carry its target in with it.
    const link = join(workspace, "points-outside");
    symlinkSync(outside, link);
    const linked = runAudit(link);
    assert.equal(linked.status, 1, linked.output);
    assert.match(
      linked.output,
      /denylist path is not under the repository or a system temp directory/,
    );
  } finally {
    rmSync(outside, { force: true });
  }
});

test("refuses a denylist it cannot read at all", () => {
  const { status, output } = runAudit(join(workspace, "never-written"));
  assert.equal(status, 1, output);
  assert.match(output, /denylist path is not readable/);
});

test("refuses a denylist with nothing in it", () => {
  const { status, output } = runAudit(write("empty.txt", "\n# only a comment\n"));
  assert.equal(status, 1, output);
  assert.match(output, /private denylist is empty/);
});

test("refuses denylist terms that are too short, unprintable, or repeated", () => {
  for (const [name, contents, message] of [
    ["short.txt", "ab\n", /unsafe term/],
    ["control.txt", "code\u0007name\n", /unsafe term/],
    ["duplicate.txt", "codename\nCODENAME\n", /duplicate terms/],
  ] as const) {
    const { status, output } = runAudit(write(name, contents));
    assert.equal(status, 1, output);
    assert.match(output, message);
  }
});
