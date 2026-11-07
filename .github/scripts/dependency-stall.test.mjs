import assert from 'node:assert/strict';
import test from 'node:test';
import { main } from './dependency-stall.mjs';

const now = Date.parse('2026-11-07T10:00:00Z');
const day = 86_400_000;
const env = { GITHUB_REPOSITORY: 'owner/repository', GITHUB_TOKEN: 'test-token-do-not-log' };
const title = '部品の更新が止まっています';
const oldPull = {
  number: 12, title: 'Bump package', created_at: new Date(now - 15 * day).toISOString(),
  user: { login: 'dependabot[bot]' }, head: { sha: 'abc123' }, mergeable_state: 'blocked',
  body: 'DO NOT COPY PR BODY',
};
const run = (id, conclusion, age = 2) => ({
  id, name: 'npm_and_yarn in /studio for hono - Update #123', path: 'dynamic/dependabot/dependabot-updates', event: 'dynamic', conclusion,
  created_at: new Date(now - age * day).toISOString(), logs_url: 'DO NOT COPY RUN LOGS',
});

function github({ pulls = [], runs = [], issue = null, label = true, fail = null } = {}) {
  const writes = [];
  const reads = [];
  const fetch = async (input, options) => {
    assert.equal(options.headers.Authorization, `Bearer ${env.GITHUB_TOKEN}`);
    assert.ok(options.signal instanceof AbortSignal);
    const url = new URL(input);
    assert.equal(url.origin, 'https://api.github.com');
    const path = url.pathname.replace('/repos/owner/repository', '');
    const method = options.method ?? 'GET';
    const body = options.body && JSON.parse(options.body);
    if (method !== 'GET') writes.push({ method, path, body });
    else reads.push(`${path}${url.search}`);
    if (fail && path === fail) return Response.json({ message: env.GITHUB_TOKEN }, { status: 503 });
    const page = Number(url.searchParams.get('page') ?? 1);
    const paged = values => values.slice((page - 1) * 100, page * 100);
    if (path === '/pulls') return Response.json(paged(pulls));
    if (/^\/pulls\/\d+$/.test(path)) return Response.json(pulls.find(pr => pr.number === Number(path.split('/').at(-1))));
    if (path.endsWith('/check-runs')) return Response.json({ check_runs: [
      { name: 'CI build', conclusion: 'failure' }, { name: 'Passing check', conclusion: 'success' },
    ] });
    if (path.endsWith('/status')) return Response.json({ statuses: [{ context: 'SonarCloud', state: 'error' }] });
    if (path === '/actions/runs') return Response.json({ workflow_runs: paged(runs) });
    if (path === '/labels/dependency-stall') return Response.json(label ? { name: 'dependency-stall' } : {}, { status: label ? 200 : 404 });
    if (path === '/labels' && method === 'POST') return Response.json(body, { status: 201 });
    if (path === '/issues' && method === 'GET') return Response.json(issue ? [issue] : []);
    if (path === '/issues' && method === 'POST') return Response.json({ number: 45, ...body }, { status: 201 });
    if (path === '/issues/45/comments' && method === 'POST') return Response.json(body, { status: 201 });
    if (path === '/issues/45' && method === 'PATCH') return Response.json({ number: 45, ...body });
    assert.fail(`Unexpected API request: ${method} ${path}`);
  };
  return { fetch, writes, reads };
}

async function watch(api) {
  const output = [];
  const code = await main([], { fetch: api.fetch, env, now, write: line => output.push(line) });
  return { code, output: output.join('\n') };
}

test('only Dependabot PRs older than 14 days create one labelled issue with current failed checks', async () => {
  const api = github({ label: false, pulls: [
    oldPull,
    { ...oldPull, number: 13, created_at: new Date(now - 14 * day).toISOString() },
    { ...oldPull, number: 14, user: { login: 'human' } },
    { ...oldPull, number: 15, created_at: new Date(now - day).toISOString() },
  ] });
  assert.equal((await watch(api)).code, 0);
  assert.equal(api.writes.filter(call => call.path === '/labels').length, 1);
  const issues = api.writes.filter(call => call.path === '/issues');
  assert.equal(issues.length, 1);
  assert.equal(issues[0].body.title, title);
  assert.deepEqual(issues[0].body.labels, ['dependency-stall']);
  assert.match(issues[0].body.body, /#12/);
  assert.match(issues[0].body.body, /Bump package/);
  assert.match(issues[0].body.body, /2026-10-23T10:00:00/);
  assert.match(issues[0].body.body, /blocked/);
  assert.match(issues[0].body.body, /CI build/);
  assert.match(issues[0].body.body, /SonarCloud/);
  assert.doesNotMatch(issues[0].body.body, /#13|#14|#15|Passing check|DO NOT COPY/);
});

test('an open stall issue is replaced while stalled and commented then closed after recovery', async () => {
  const issue = { number: 45, title, body: 'old content' };
  const stalled = github({ pulls: [oldPull], issue });
  assert.equal((await watch(stalled)).code, 0);
  assert.deepEqual(stalled.writes.map(call => [call.method, call.path]), [['PATCH', '/issues/45']]);
  assert.match(stalled.writes[0].body.body, /#12/);
  assert.doesNotMatch(stalled.writes[0].body.body, /old content/);

  const recovered = github({ issue });
  assert.equal((await watch(recovered)).code, 0);
  assert.deepEqual(recovered.writes.map(call => [call.method, call.path]), [
    ['POST', '/issues/45/comments'], ['PATCH', '/issues/45'],
  ]);
  assert.equal(recovered.writes[0].body.body, '止まりは無くなりました');
  assert.equal(recovered.writes[1].body.state, 'closed');
});

test('at least one dynamic Dependabot run in seven days, all failed or cancelled, raises a stall', async () => {
  const api = github({ runs: [run(1, 'failure'), run(2, 'cancelled'), run(3, 'timed_out'),
    run(4, 'success', 8), { ...run(5, 'success'), name: 'CodeQL', path: 'dynamic/github-code-scanning/codeql' },
    { ...run(6, 'success'), event: 'push' },
  ] });
  assert.equal((await watch(api)).code, 0);
  const issue = api.writes.find(call => call.path === '/issues');
  assert.match(issue.body.body, /更新の係が動いていない/);
  assert.match(issue.body.body, /actions\/runs\/1/);
  assert.match(issue.body.body, /actions\/runs\/2/);
  assert.match(issue.body.body, /actions\/runs\/3/);
  assert.doesNotMatch(issue.body.body, /runs\/4|runs\/5|runs\/6|DO NOT COPY/);
});

test('zero recent runs, a successful run, or an unfinished run does not create a stall issue', async () => {
  for (const runs of [[], [run(1, 'failure', 8)], [run(1, 'failure'), run(2, 'success')], [run(1, 'failure'), run(2, null)]]) {
    const api = github({ runs });
    assert.equal((await watch(api)).code, 0);
    assert.deepEqual(api.writes, []);
  }
});

test('pagination finds an old Dependabot PR after the first 100 open PRs', async () => {
  const humanPulls = Array.from({ length: 100 }, (_, index) => ({
    ...oldPull, number: index + 100, user: { login: 'human' },
  }));
  const api = github({ pulls: [...humanPulls, oldPull] });
  assert.equal((await watch(api)).code, 0);
  assert.match(api.writes.find(call => call.path === '/issues').body.body, /#12/);
  assert.ok(api.reads.some(path => path.startsWith('/pulls?') && path.includes('page=2')));
});

test('an API failure leaves the open issue untouched and does not expose an error response', async () => {
  const api = github({ pulls: [oldPull], issue: { number: 45, title }, fail: '/actions/runs' });
  const result = await watch(api);
  assert.equal(result.code, 1);
  assert.deepEqual(api.writes, []);
  assert.doesNotMatch(result.output, /test-token-do-not-log/);
});

test('a week of startup failures counts as the updater not running', async () => {
  const api = github({ runs: [run(1, 'startup_failure'), run(2, 'startup_failure')] });
  assert.equal((await watch(api)).code, 0);
  const issue = api.writes.find(call => call.path === '/issues');
  assert.match(issue.body.body, /更新の係が動いていない/);
});
