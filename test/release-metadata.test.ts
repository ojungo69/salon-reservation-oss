import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const PUBLIC_PATHS = readFileSync(join(ROOT, "release/public-files.txt"), "utf8").trimEnd().split("\n");
const POSIX = process.platform !== "win32";

const createFixture = () => {
  const tree = mkdtempSync("/tmp/release-metadata-");
  try {
    for (const path of PUBLIC_PATHS) {
      const destination = join(tree, path);
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(join(ROOT, path), destination);
    }
    const git = (...args: string[]) => execFileSync("git", args, {
      cwd: tree, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    git("init", "-b", "main");
    git("config", "user.name", "Public Test");
    git("config", "user.email", "public-test@users.noreply.github.com");
    git("add", ".");
    git("-c", "commit.gpgsign=false", "commit", "-m", "public fixture");
    const audit = () => {
      const result = spawnSync(process.execPath, [join(tree, "scripts/release-audit.mjs")], {
        encoding: "utf8", timeout: 30_000,
      });
      return { status: result.status, output: `${result.stdout}${result.stderr}` };
    };
    return { tree, git, audit };
  } catch (error) {
    rmSync(tree, { recursive: true, force: true });
    throw error;
  }
};

for (const variant of ["subject", "body-lowercase", "nested"] as const) {
  test(`refuses private evidence in annotated tag metadata: ${variant}`, { skip: !POSIX }, () => {
    const { tree, git, audit } = createFixture();
    try {
      let result = audit();
      assert.equal(result.status, 0, result.output);
      git("tag", "lightweight");
      git("-c", "tag.gpgsign=false", "tag", "-a", "clean", "-m", "public release");
      result = audit();
      assert.equal(result.status, 0, result.output);
      const marker = ["PRIVATE", "PORTING", "EVIDENCE: DO NOT PUBLISH"].join("-");
      const message = variant === "body-lowercase" ? `release\n\n${marker.toLowerCase()}` : marker;
      git("-c", "tag.gpgsign=false", "tag", "-a", "inner", "-m", message);
      if (variant === "nested") {
        git("-c", "tag.gpgsign=false", "tag", "-a", "outer", "inner", "-m", "public wrapper");
        git("tag", "-d", "inner");
      }
      result = audit();
      assert.equal(result.status, 1, result.output);
      assert.match(result.output, /private porting ledger marker found in annotated tag metadata/);
      assert.equal(result.output.toUpperCase().includes(marker), false, "must not echo tag contents");
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  });
}

for (const required of ["docs/ADR-0001-REUSE-FIRST-PORTING.md", "docs/PORTING.md"]) {
  test(`refuses an omitted governance document: ${required}`, { skip: !POSIX }, () => {
    const { tree, audit } = createFixture();
    try {
      const baseline = audit();
      assert.equal(baseline.status, 0, baseline.output);
      writeFileSync(join(tree, "release/public-files.txt"),
        `${PUBLIC_PATHS.filter((path) => path !== required).join("\n")}\n`);
      const result = audit();
      assert.equal(result.status, 1, result.output);
      assert.ok(result.output.includes(`required public path is missing: ${required}`), result.output);
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  });
}
