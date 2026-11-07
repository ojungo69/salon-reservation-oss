import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const script = fileURLToPath(new URL('./dependabot-diverged.jq', import.meta.url));
const commit = {
  parents: [{ sha: 'base' }],
  author: { login: 'dependabot[bot]', type: 'Bot' },
  commit: { verification: { verified: true }, committer: { name: 'GitHub' } },
};
function fixture() {
  return {
    compare: { status: 'diverged', total_commits: 1, files: [{ filename: 'studio/package-lock.json' }] },
    head: { total_commits: 1, commits: [structuredClone(commit)] },
    main: { files: [{ filename: 'emdash/package-lock.json' }] },
  };
}
function evaluate(input, run = spawn) {
  return new Promise((resolve, reject) => {
    const child = run('jq', ['-e', '-f', script], { timeout: 5000 });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', status => resolve({ status, stdout, stderr }));
    child.stdin.end(JSON.stringify(input));
  });
}

test('diverged: disjoint paths and a verified single-parent Dependabot commit pass', async () => {
  const result = await evaluate(fixture());
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'true');
});

for (const [name, change] of [
  ['a shared lockfile', data => { data.main.files[0].filename = 'studio/package-lock.json'; }],
  ['the old name of a renamed main file', data => { data.main.files[0].previous_filename = 'studio/package-lock.json'; }],
  ['the old name of a renamed PR file', data => { data.compare.files[0].previous_filename = 'emdash/package-lock.json'; }],
  ['main changes a parent directory', data => { data.main.files[0].filename = 'studio'; }],
  ['the PR changes a parent directory', data => { data.compare.files[0].filename = 'emdash'; }],
  ['a merge commit', data => { data.head.commits[0].parents.push({ sha: 'other' }); }],
  ['a human author', data => { data.head.commits[0].author = { login: 'owner', type: 'User' }; }],
  ['an unsigned commit', data => { data.head.commits[0].commit.verification.verified = false; }],
  ['a different committer', data => { data.head.commits[0].commit.committer.name = 'owner'; }],
  ['300 PR files', data => { data.compare.files = Array(300).fill({ filename: 'studio/package.json' }); }],
  ['300 main files', data => { data.main.files = Array(300).fill({ filename: 'emdash/package.json' }); }],
  ['251 commits', data => { data.compare.total_commits = 251; data.head.total_commits = 251; }],
  ['a truncated commit list', data => { data.head.total_commits = 2; }],
  ['missing commit evidence', data => { delete data.head.commits; }],
  ['a status other than diverged', data => { data.compare.status = 'behind'; }],
]) {
  test(`diverged: rejects ${name}`, async () => {
    const data = fixture();
    change(data);
    const result = await evaluate(data);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout.trim(), 'false');
  });
}

test('diverged: directory siblings sharing a prefix do not overlap', async () => {
  const data = fixture();
  data.main.files[0].filename = 'studio-other/package-lock.json';
  assert.equal((await evaluate(data)).status, 0);
});
