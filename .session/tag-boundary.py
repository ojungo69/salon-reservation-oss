from pathlib import Path
import sys

def replace(path, old, new):
    p=Path(path); t=p.read_text(); assert t.count(old)==1,(path,old); p.write_text(t.replace(old,new))

if sys.argv[1]=='tests':
    with Path('test/release-metadata.test.ts').open('a') as file:
        file.write('''
for (const kind of ["commit", "tag"] as const) {
  test(`replacement objects cannot conceal private ${kind} metadata`, { skip: !POSIX }, () => {
    const { tree, git, audit } = createFixture();
    try {
      const marker = ["PRIVATE", "PORTING", "EVIDENCE: DO NOT PUBLISH"].join("-");
      const base = git("rev-parse", "HEAD").trim();
      if (kind === "commit") {
        git("-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", marker);
        git("replace", git("rev-parse", "HEAD").trim(), base);
      } else {
        git("-c", "tag.gpgsign=false", "tag", "-a", "concealed", "-m", marker);
        git("-c", "tag.gpgsign=false", "tag", "-a", "substitute", "-m", "public release");
        git("replace", git("rev-parse", "concealed").trim(), git("rev-parse", "substitute").trim());
      }
      const result = audit();
      assert.equal(result.status, 1, result.output);
      assert.match(result.output, /private porting ledger marker found/);
      assert.equal(result.output.toUpperCase().includes(marker), false);
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  });
}

for (const kind of ["blob", "tree"] as const) {
  test(`rejects annotated tags targeting ${kind} objects outside commit history`, { skip: !POSIX }, () => {
    const { tree, git, audit } = createFixture();
    try {
      const marker = ["PRIVATE", "PORTING", "EVIDENCE: DO NOT PUBLISH"].join("-");
      let target = execFileSync("git", ["hash-object", "-w", "--stdin"], {
        cwd: tree, input: marker, encoding: "utf8",
      }).trim();
      if (kind === "tree") target = execFileSync("git", ["mktree"], {
        cwd: tree, input: `100644 blob ${target}\\tevidence.txt\\n`, encoding: "utf8",
      }).trim();
      git("-c", "tag.gpgsign=false", "tag", "-a", "non-commit", target, "-m", "public release");
      const result = audit();
      assert.equal(result.status, 1, result.output);
      assert.match(result.output, /non-commit tag targets are not supported/);
      assert.equal(result.output.toUpperCase().includes(marker), false);
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  });
}
''')
else:
    path=Path('scripts/release-audit.mjs'); text=path.read_text()
    assert text.count('["-C", ROOT,') == 3
    text=text.replace('["-C", ROOT,','["--no-replace-objects", "-C", ROOT,')
    text=text.replace('if (ref === null) invalid = true;', 'if (ref === null || ref[1] === "blob" || ref[1] === "tree") invalid = true;')
    old='    if (target[2] === "tag") pending.push(target[1]);'
    assert text.count(old)==1
    text=text.replace(old, '    if (target[2] === "blob" || target[2] === "tree") fail("non-commit tag targets are not supported");\n'+old)
    path.write_text(text)
    replace('docs/ADR-0001-REUSE-FIRST-PORTING.md', '## Contribution gate', 'The audit disables Git replacement-object resolution so a local replacement ref cannot hide original metadata. Ref targets and tag chains ending in a blob or tree are unsupported and fail closed; normal commit tags remain supported. This deliberately avoids claiming that commit-history scanning covers standalone non-commit objects.\n\n## Contribution gate')
    replace('CHANGELOG.md', '### Fixed\n', '### Fixed\n\n- Git replacement objects no longer conceal original metadata during release auditing.\n  References and tag chains with non-commit targets are rejected rather than omitted.\n')
