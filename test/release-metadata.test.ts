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
    const audit = (...args: string[]) => {
      const result = spawnSync(process.execPath, [join(tree, "scripts/release-audit.mjs"), ...args], {
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

for (const required of ["docs/ADR-0001-REUSE-FIRST-PORTING.md", "docs/ADR-0002-CREATE-STORAGE-AUTHORITY.md", "docs/ADR-0003-MULTI-LOCATION-BOUNDARY.md", "docs/PORTING.md", "src/location.ts", "test/location.test.ts"]) {
  test(`refuses an omitted required public file: ${required}`, { skip: !POSIX }, () => {
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

test("accepts a clean history beyond the old one-MiB object inventory", { skip: !POSIX }, () => {
  const { tree, git, audit } = createFixture();
  try {
    const base = git("rev-parse", "HEAD").trim();
    // One packed fictional commit keeps the checkout small while reproducing
    // the output size that made the old all-objects metadata scan fail.
    let input = `commit refs/heads/large-fixture\ncommitter Public Test <public-test@users.noreply.github.com> 1789171200 +0000\ndata 8\nfixtures\nfrom ${base}\n`;
    for (let index = 0; index < 26_000; index += 1) {
      const value = `fixture-${index}\n`;
      input += `M 100644 inline synthetic/${index}.txt\ndata ${Buffer.byteLength(value)}\n${value}\n`;
    }
    input += "\ndone\n";
    execFileSync("git", ["fast-import", "--quiet"], {
      cwd: tree, input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
    });
    const inventory = execFileSync("git", ["rev-list", "--objects", "--all", "--no-object-names"], {
      cwd: tree, maxBuffer: 4 * 1024 * 1024,
    });
    assert.ok(inventory.length > 1024 * 1024, "fixture must exceed the old output limit");
    git("-c", "tag.gpgsign=false", "tag", "-a", "large-clean", "large-fixture", "-m", "public release");
    const result = audit();
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /release audit passed/);
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
});

for (const kind of ["commit", "tag"] as const) {
  test(`accepts clean ${kind} refs beyond the old one-MiB buffer`, { skip: !POSIX }, () => {
    const { tree, git, audit } = createFixture();
    try {
      if (kind === "tag") {
        git("-c", "tag.gpgsign=false", "tag", "-a", "root", "-m", "public release");
      }
      const oid = git("rev-parse", kind === "tag" ? "refs/tags/root" : "HEAD").trim();
      // A packed fixture avoids creating and syncing 26,000 loose files. Git
      // itself must read the refs and prove the output exceeds the old limit.
      const refs = Array.from({ length: 26_000 }, (_, index) =>
        `${oid} refs/archive/synthetic-${String(index).padStart(5, "0")}`);
      writeFileSync(join(tree, ".git/packed-refs"),
        `# pack-refs with: sorted\n${refs.join("\n")}\n`);
      const inventory = execFileSync("git", ["for-each-ref", "--format=%(objecttype) %(objectname)"], {
        cwd: tree, maxBuffer: 4 * 1024 * 1024,
      });
      assert.ok(inventory.length > 1024 * 1024, "fixture must exceed the old output limit");
      const result = audit();
      assert.equal(result.status, 0, result.output);
      assert.match(result.output, /release audit passed/);
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  });
}

for (const required of ["AGENTS.md", ".github/pull_request_template.md", "test/release-metadata.test.ts"]) {
  test(`public candidates retain required files: ${required}`, { skip: !POSIX }, () => {
    const { tree, git, audit } = createFixture();
    try {
      const baseline = audit("--public-tree");
      assert.equal(baseline.status, 0, baseline.output);
      writeFileSync(join(tree, "release/public-files.txt"),
        `${PUBLIC_PATHS.filter((path) => path !== required).join("\n")}\n`);
      rmSync(join(tree, required));
      git("add", "-A");
      git("-c", "commit.gpgsign=false", "commit", "--amend", "--no-edit");
      const result = audit("--public-tree");
      assert.equal(result.status, 1, result.output);
      assert.ok(result.output.includes(`required public path is missing: ${required}`), result.output);
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  });
}

for (const kind of ["commit", "tag"] as const) {
  test(`refuses private ${kind} metadata hidden by a replacement object`, { skip: !POSIX }, () => {
    const { tree, git, audit } = createFixture();
    try {
      const marker = ["PRIVATE", "PORTING", "EVIDENCE: DO NOT PUBLISH"].join("-");
      if (kind === "tag") {
        git("-c", "tag.gpgsign=false", "tag", "-a", "private-tag", "-m", marker);
        git("-c", "tag.gpgsign=false", "tag", "-a", "clean-tag", "-m", "public release");
        git("replace", "refs/tags/private-tag", "refs/tags/clean-tag");
        assert.equal(git("cat-file", "tag", "refs/tags/private-tag").includes(marker), false);
      } else {
        const base = git("rev-parse", "HEAD").trim();
        const cleanTree = git("rev-parse", "HEAD^{tree}").trim();
        git("-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", marker);
        const clean = git("commit-tree", cleanTree, "-p", base, "-m", "public replacement").trim();
        git("replace", "HEAD", clean);
        assert.equal(git("log", "--all", "--format=%B").includes(marker), false);
      }
      const result = audit();
      assert.equal(result.status, 1, result.output);
      assert.match(result.output, /private porting ledger marker found in (commit messages|annotated tag metadata)/);
      assert.equal(result.output.toUpperCase().includes(marker), false, "must not echo private metadata");
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  });
}

for (const kind of ["blob", "tree"] as const) {
  for (const ref of ["annotated", "nested", "lightweight"] as const) {
    test(`refuses a ${kind} outside commit history via ${ref} tag`, { skip: !POSIX }, () => {
      const { tree, git, audit } = createFixture();
      try {
        const marker = ["PRIVATE", "PORTING", "EVIDENCE: DO NOT PUBLISH"].join("-");
        const path = "unpublished-evidence.txt";
        writeFileSync(join(tree, path), `${marker}\n`);
        git("add", path);
        const target = git(...(kind === "blob" ? ["rev-parse", `:${path}`] : ["write-tree"])).trim();
        git("reset", "--", path);
        rmSync(join(tree, path));
        if (ref === "lightweight") git("tag", "retained", target);
        else {
          git("-c", "tag.gpgsign=false", "tag", "-a", "retained", target, "-m", "public release");
          if (ref === "nested") {
            git("-c", "tag.gpgsign=false", "tag", "-a", "outer", "retained", "-m", "public wrapper");
            git("tag", "-d", "retained");
          }
        }
        const result = audit();
        assert.equal(result.status, 1, result.output);
        assert.match(result.output, /non-commit tag target|cannot enumerate tag refs for metadata audit/);
        assert.equal(result.output.toUpperCase().includes(marker), false, "must not echo object contents");
      } finally {
        rmSync(tree, { recursive: true, force: true });
      }
    });
  }
}

for (const kind of ["marker", "path"] as const) {
  test(`refuses a private ${kind} added and removed only by merges`, { skip: !POSIX }, () => {
    const { tree, git, audit } = createFixture();
    try {
      const marker = ["PRIVATE", "PORTING", "EVIDENCE: DO NOT PUBLISH"].join("-");
      const base = git("rev-parse", "HEAD").trim();
      const cleanTree = git("rev-parse", "HEAD^{tree}").trim();
      const path = kind === "path" ? "docs/PRIVATE_PORTING_LEDGER.md" : "merge-evidence.txt";
      writeFileSync(join(tree, path), kind === "path" ? "fictional evidence\n" : `${marker}\n`);
      git("add", path);
      const privateTree = git("write-tree").trim();
      git("reset", "--", path);
      rmSync(join(tree, path));
      const side = git("commit-tree", cleanTree, "-p", base, "-m", "first side").trim();
      const added = git("commit-tree", privateTree, "-p", base, "-p", side, "-m", "merge addition").trim();
      const later = git("commit-tree", privateTree, "-p", added, "-m", "second side").trim();
      // A clean first parent makes default path history prune the entire merged side.
      const firstParent = kind === "path" ? base : added;
      const removed = git("commit-tree", cleanTree, "-p", firstParent, "-p", later, "-m", "merge removal").trim();
      git("update-ref", "refs/heads/main", removed);
      assert.equal(git("status", "--porcelain"), "", "only reachable merge history carries evidence");
      const result = audit();
      assert.equal(result.status, 1, result.output);
      assert.ok(result.output.includes(`private porting ledger ${kind} found in public history`), result.output);
      assert.equal(result.output.toUpperCase().includes(marker), false, "must not echo historical content");
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  });
}
