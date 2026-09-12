from pathlib import Path
import sys

def replace(path, old, new):
    p = Path(path)
    text = p.read_text()
    assert text.count(old) == 1, (path, old)
    p.write_text(text.replace(old, new))

if sys.argv[1] == 'tests':
    replace('test/release-metadata.test.ts', 'const audit = () => {', 'const audit = (...args: string[]) => {')
    replace('test/release-metadata.test.ts', '[join(tree, "scripts/release-audit.mjs")],', '[join(tree, "scripts/release-audit.mjs"), ...args],')
    with Path('test/release-metadata.test.ts').open('a') as file:
        file.write('''
for (const required of ["AGENTS.md", ".github/pull_request_template.md"]) {
  test(`public candidates retain maintainer instructions: ${required}`, { skip: !POSIX }, () => {
    const { tree, git, audit } = createFixture();
    try {
      const baseline = audit("--public-tree");
      assert.equal(baseline.status, 0, baseline.output);
      writeFileSync(join(tree, "release/public-files.txt"),
        `${PUBLIC_PATHS.filter((path) => path !== required).join("\\n")}\\n`);
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
''')
else:
    replace('scripts/release-audit.mjs', 'const REQUIRED = new Set([', 'const REQUIRED = new Set([\n  "AGENTS.md",\n  ".github/pull_request_template.md",')
    replace('docs/PORTING.md', 'The governing rule is [ADR 0001](ADR-0001-REUSE-FIRST-PORTING.md): reuse and generalize production-tested implementation, schema, tests, and operational invariants first. Reimplement only with a recorded reason and equivalent-or-better evidence.', 'The governing rule is [ADR 0001](ADR-0001-REUSE-FIRST-PORTING.md): inspect production-tested implementation, schema, tests, and operational invariants as evidence first, then select reuse, generalization, or replacement by the best supported outcome. Record the comparison and equivalent-or-better behavioral evidence for replacements. Neither existing architecture nor work already invested is a reason to retain an inferior component.')
    replace('CHANGELOG.md', '- Reuse-first production-porting governance:', '- Quality-led, inspection-first production-porting governance:')
    replace('CHANGELOG.md', '## [0.2.0] - 2026-08-10', '### Fixed\n\n- Operator and setup authentication controls now remain disabled until initialization has\n  installed their handlers, preventing lost sign-in attempts during slow configuration loading.\n  Both pages explain the JavaScript requirement when scripting is unavailable.\n- Failing rendered-page runs retain hidden Playwright trace and screenshot files.\n- Public release candidates must include the maintainer instructions and PR declaration template.\n\n## [0.2.0] - 2026-08-10')
