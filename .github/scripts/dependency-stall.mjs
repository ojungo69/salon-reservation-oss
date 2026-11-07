const day = 86_400_000;
const issueTitle = '部品の更新が止まっています';
const label = 'dependency-stall';
const failedRuns = new Set(['cancelled', 'failure', 'timed_out', 'startup_failure']);
const failedChecks = new Set([...failedRuns, 'action_required', 'stale']);
const code = value => `\`${String(value).replace(/[`\x00-\x1f\x7f]/g, ' ')}\``;

export async function main(args = process.argv.slice(2), {
  fetch = globalThis.fetch,
  env = process.env,
  now = Date.now(),
  write = console.log,
} = {}) {
  if (args.length) {
    write('Usage: node .github/scripts/dependency-stall.mjs');
    return 1;
  }

  try {
    const repository = env.GITHUB_REPOSITORY;
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '') || !env.GITHUB_TOKEN) {
      throw new Error('Missing workflow environment');
    }
    const root = `https://api.github.com/repos/${repository}`;
    const web = `https://github.com/${repository}`;
    async function request(path, { method = 'GET', data, allowMissing = false } = {}) {
      const response = await fetch(`${root}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${env.GITHUB_TOKEN}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
        },
        body: data === undefined ? undefined : JSON.stringify(data),
        signal: AbortSignal.timeout(20_000),
      });
      if (allowMissing && response.status === 404) return null;
      if (!response.ok) throw new Error('GitHub API request failed');
      return response.json();
    }
    async function list(path, key) {
      const values = [];
      for (let page = 1; ; page++) {
        const result = await request(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
        const batch = key ? result[key] : result;
        if (!Array.isArray(batch)) throw new Error('Unexpected GitHub API response');
        values.push(...batch);
        if (batch.length < 100) return values;
      }
    }

    const pulls = (await list('/pulls?state=open')).filter(pr =>
      ['dependabot[bot]', 'app/dependabot'].includes(pr.user?.login)
      && Date.parse(pr.created_at) < now - 14 * day,
    );
    const lines = [];
    if (pulls.length) lines.push('## 14日を超えて開いている Dependabot PR');
    for (const pull of pulls) {
      const pr = await request(`/pulls/${pull.number}`);
      const checks = await list(`/commits/${pr.head.sha}/check-runs?filter=latest`, 'check_runs');
      const statuses = await list(`/commits/${pr.head.sha}/status`, 'statuses');
      const names = [...new Set([
        ...checks.filter(check => failedChecks.has(check.conclusion)).map(check => check.name),
        ...statuses.filter(status => ['failure', 'error'].includes(status.state)).map(status => status.context),
      ])];
      lines.push(`- [#${pr.number}](${web}/pull/${pr.number}) ${code(pr.title)} / 作成: ${code(pr.created_at)} / mergeable_state: ${code(pr.mergeable_state ?? 'unknown')} / 落ちた検査: ${names.length ? names.map(code).join(', ') : 'なし'}`);
    }

    const since = now - 7 * day;
    const runs = (await list(`/actions/runs?event=dynamic&created=${encodeURIComponent(`>=${new Date(since).toISOString()}`)}`, 'workflow_runs'))
      // 実行の name は更新の中身（npm_and_yarn in /. ...）で、Dependabot Updates は path にしか出ない。
      .filter(run => run.path === 'dynamic/dependabot/dependabot-updates' && run.event === 'dynamic'
        && Date.parse(run.created_at) >= since && Date.parse(run.created_at) <= now);
    if (runs.length && runs.every(run => failedRuns.has(run.conclusion))) {
      lines.push('## 更新の係が動いていない（直近7日の Dependabot Updates がすべて失敗・取り消し）');
      for (const run of runs) {
        lines.push(`- [実行 ${run.id}](${web}/actions/runs/${run.id}) / 作成: ${code(run.created_at)} / 結果: ${code(run.conclusion)}`);
      }
    }

    const issues = await list(`/issues?state=open&labels=${label}`);
    const issue = issues.find(item => !item.pull_request && item.title === issueTitle);
    if (lines.length) {
      if (!await request(`/labels/${label}`, { allowMissing: true })) {
        await request('/labels', { method: 'POST', data: { name: label, color: 'fbca04' } });
      }
      const body = `${lines.join('\n')}\n`;
      const result = issue
        ? await request(`/issues/${issue.number}`, { method: 'PATCH', data: { body } })
        : await request('/issues', { method: 'POST', data: { title: issueTitle, body, labels: [label] } });
      write(`Dependency stall issue #${result.number}: ${issue ? 'updated' : 'created'}.`);
    } else if (issue) {
      await request(`/issues/${issue.number}/comments`, { method: 'POST', data: { body: '止まりは無くなりました' } });
      await request(`/issues/${issue.number}`, { method: 'PATCH', data: { state: 'closed' } });
      write(`Dependency stall issue #${issue.number}: closed.`);
    } else {
      write('No dependency stalls found.');
    }
    return 0;
  } catch {
    // API bodies and exception messages can contain credentials; keep them out of logs.
    write('Dependency stall watch failed; check GitHub API availability and workflow permissions.');
    return 1;
  }
}

if (import.meta.main) process.exitCode = await main();
