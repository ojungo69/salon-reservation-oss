# Contributing

Thank you for improving Salon Reservation OSS.

## Before changing code

1. Use the Node.js version in [`.nvmrc`](.nvmrc) and npm 12. See
   [Toolchain](#toolchain) for why both matter.
2. Run `npm ci`.
3. Read the relevant source and tests end to end.
4. Keep fixtures fictional. Never copy customer data, credentials, account IDs, private runbooks,
   or deployment output into the repository.
5. For anything security-sensitive, open a
   [private security advisory](https://github.com/ojungo69/salon-reservation-oss/security/advisories/new)
   instead of a public issue. See [SECURITY.md](SECURITY.md).

## Development

```bash
npm run test:core
npm run test:worker
npm run typecheck
npm run build
npm run check
```

For non-trivial behavior, add the smallest test that fails for the intended assertion before the
implementation. Reuse the pure reservation kernel and native Worker/browser/SQLite features before
adding a dependency or abstraction.

## Branch and merge policy

`main` is protected by an active repository ruleset and is treated as releasable code. The ruleset
applies to everyone, including repository administrators.

- Every change reaches `main` through a pull request. Direct pushes, force pushes, and branch
  deletion are blocked.
- The `check` status check (the `npm run check` pipeline) must pass, and the branch must be up to
  date with `main` before merging. The up-to-date requirement matters here because
  `scripts/release-audit.mjs` verifies consistency *between* files — the file manifest, the
  dependency license table, and the version number — so two independently green branches can still
  produce a broken `main`.
- All review conversations must be resolved before merging. Declining a suggestion is a valid
  resolution; say why in the thread.
- Squash merge is the only enabled method, and history on `main` stays linear. The merged branch is
  deleted automatically.
- Review approval is not currently required, because the project has a single active maintainer.
  This will be raised once a second maintainer is active.
- Release tags matching `v*` are protected against deletion and rewriting.

There is no automatic emergency bypass. If `main` must be repaired urgently, the maintainer
temporarily sets the ruleset to `evaluate`, lands the fix, restores `active` enforcement, and
records what happened in the pull request that follows.

## Toolchain

| Where | What it pins |
|---|---|
| [`.nvmrc`](.nvmrc) | The exact Node.js version. CI reads this file, so there is one source of truth. |
| `package.json` → `engines` | The supported Node.js floor and the npm major (`>=12.0.0 <13.0.0`). |
| [`.npmrc`](.npmrc) → `engine-strict=true` | Turns those `engines` values into a hard install failure instead of a warning. |
| `.github/workflows/ci.yml` → "Pin npm" | The exact npm patch version CI installs. |

npm 12 matters specifically: it blocks dependency install scripts by default, and
`strict-allow-scripts=true` turns an unreviewed install script into a failed install rather than a
silent skip. Node 24.16.0 bundles npm 11.13.0, which has neither behavior — `allowScripts` and
`strict-allow-scripts` do not exist there at all, and npm reports them as unknown config — so CI
installs npm 12 explicitly.

Corepack could pin npm instead: `corepack enable npm` does install an npm shim, and
`packageManager: "npm@12.0.2"` is honoured. It is not used here because Corepack is Stability 1 —
Experimental, is not distributed by default from Node.js 25, and `corepack enable npm` replaces
Node's own npm launcher without `corepack disable npm` restoring it. A global install has no such
shelf life. `actions/setup-node` has no npm-version input either, so an explicit step is the only
mechanism in CI.

**Install npm 12 before your first `npm ci`.** `nvm use` alone leaves you on the bundled npm 11.13.0,
and `engine-strict=true` with `engines.npm` turns that into a failed install:

```sh
nvm install                      # reads .nvmrc
npm install -g --ignore-scripts npm@12.0.2
npm --version                    # expect 12.0.2
npm ci
```

Bumping the CI npm patch version is a manual edit; Dependabot does not manage it. Bumping the npm
major additionally requires updating `engines.npm`, which `scripts/release-audit.mjs` verifies.

## Install scripts

Dependency install scripts are governed by the `allowScripts` field in
[`package.json`](package.json). It covers a dependency's `preinstall`, `install`, and `postinstall`,
the implicit `node-gyp rebuild` a `binding.gyp` produces, and `prepare` for dependencies that do not
come from the registry (git, file, link). The project's own scripts are not affected.

Each entry is a boolean, and the version pin lives in the key:

| Entry | Meaning |
|---|---|
| `"esbuild@0.28.1": true` | Reviewed and permitted, for that version only. |
| `"fsevents": false` | Reviewed and refused, at every version, without a warning. |
| absent | Not reviewed. Skipped, with a warning — or a failed install under `strict-allow-scripts`. |

`strict-allow-scripts=true` in `.npmrc` is what turns that warning into a failure, so an unreviewed
install script cannot be skipped in silence.

CI additionally passes `--ignore-scripts`, so **no** dependency install script runs there at all.
The two are not redundant, and the precedence matters:

- `--ignore-scripts` wins over everything. It skips all install scripts and short-circuits before
  the per-package `allowScripts` check, so on its own it would make the allowlist decorative.
- The separate `npm install-scripts ls` step is therefore what enforces the allowlist in CI. It
  fails the build as soon as an installed package has an install script nobody has approved, whether
  or not that script would have run. It asserts with `jq -e` rather than comparing a count, because
  npm prints `{"error": …}` to standard output on any failure and a count taken from that is `0` —
  the gate would have passed green every time npm itself failed.
- The listing covers what actually installs on the CI runner, so an optional dependency excluded by
  `os` or `cpu` — `fsevents` is the one here — is not in it. Those are covered by
  `strict-allow-scripts` on the machine they do install on.
- On a contributor's machine `npm ci` runs without the flag, and there `strict-allow-scripts` is the
  live enforcement.

The result is that CI executes no third-party install code while still refusing to accept an
unreviewed one, and a local install runs only reviewed scripts. Nothing in the build has ever needed
an install script to succeed.

`npm install-scripts prune` will offer to remove the `"fsevents": false` entry because fsevents is
not installed on Linux. Do not accept that: the entry is a deliberate denial that matters on macOS.

The empty `allow-scripts=` line in [`.npmrc`](.npmrc) looks redundant — it is a *different* npm
mechanism, aimed at global installs and `npx`, and npm ignores it while `package.json` declares an
`allowScripts` field — but it is load-bearing, for a reason that is easy to test for and get wrong.
`allow-scripts` is commonly set in a personal `~/.npmrc`, and running `npm audit` directly with one
is harmless: a value from a config file is ignored. But npm exports every resolved config to child
processes as `npm_config_*`, and a value arriving from the *environment* is refused outright:

```
$ npm run check                  # with the project line removed
npm error code EALLOWSCRIPTS
npm error --allow-scripts is not allowed in project-scoped installs.
```

So the personal value reaches `npm audit` inside `npm run check` as an environment variable and
fails it, while the same command run on its own passes. The empty project-level line wins the
config resolution, so what gets exported is empty. Keep the line, and test any change to it through
`npm run check` rather than by invoking the inner command yourself.

When a dependency update changes a package that runs an install script (for example, a `wrangler`
bump that pulls a new `workerd`), two files must be updated together:

1. `package.json` → `allowScripts`, with the new exact `name@version`.
2. `scripts/release-audit.mjs` → the `allowScripts` comparison in `auditPackage()`.

That duplication is deliberate. It forces a human to look at the new install script before it runs
in CI. Do not relax the audit to avoid the second edit.

The workflow that carries this policy is pinned too. `scripts/release-audit.mjs` holds
`WORKFLOW_LINES`: every active line of `.github/workflows/ci.yml`, in order. The file must match it
exactly, with one exemption — each `uses:` value is reduced to the action identity before comparing,
and the SHA is checked separately for being a 40-character commit pin, so Dependabot's digest bumps
stay quiet. `.nvmrc` is compared exactly too. Changing what CI runs therefore means editing
`WORKFLOW_LINES` in the same pull request.

Lines are split the way YAML splits them, including on a lone carriage return, which YAML treats
as a line break and JavaScript does not. Comments are stripped before matching, so commenting a step
out fails the audit the same way deleting it does, and rewording a comment does not. Indentation is stripped as well: the list is
what says where a line belongs, so a job-level `permissions:` block is two lines the reviewed
workflow does not have, wherever it sits.

Both of those follow YAML's rule that space and tab are the only whitespace, and that a `#` starts a
comment only when whitespace precedes it. Anything wider would hide characters from the comparison
that Actions still executes — `run: npm run check<U+00A0># rest` is one command to YAML and to the
shell, but `String.prototype.trim` and `\s` both treat U+00A0 as space. A byte-order mark and CRLF
endings are removed by name instead, because they are legal and change nothing about what runs.

`ci.yml` must also be the only file in `.github/workflows/`. GitHub runs every workflow in that
directory, so a second one is a second place to install, with triggers and permissions of its own,
and pinning one file would say nothing about it.

The list is exhaustive rather than limited to the security-relevant lines, because a partial list
says nothing about what someone *adds* or *retunes* — a second `npm ci`, a `yarn install`, an
unfamiliar action, a second job, `persist-credentials: true`, `runs-on: self-hosted`, an `env:` that
reaches inside node and npm, an `if:` that turns a pinned step off. A pinned `run:` is only pinned
while nothing else decides how it runs, so rather than name each way, anything that is not the
reviewed line fails.

Matching whole lines is also what rules out the YAML spellings a looser reader would miss: a folded
scalar continuing a pinned command on the next line, a block scalar hiding a script under `run: |`,
a flow mapping step, `on: {pull_request: null, pull_request_target: null}` on one line, a quoted
`"run":` key, an anchor, a second `---` document. None of them is the reviewed line. Write the
workflow in the plain style already there.

This is a drift gate, not a boundary against a hostile committer: anyone who can edit the workflow
can edit the audit beside it. Its job is to make a weakening visible in review rather than
accidental.

## Pull requests

- Keep one user-visible or security-relevant change per pull request.
- Add a `CHANGELOG.md` entry under `Unreleased` for anything a user or operator would notice.
- Explain the affected trust boundary and any abuse, data-loss, race, rollback, or secret-handling
  impact.
- Update the API contract and operator documentation when behavior changes.
- Include keyboard, narrow-screen, dark-mode, and reduced-motion evidence for UI changes.
- Confirm `npm run check` succeeds from the exact commit.
- Do not include a deployment, remote configuration, generated secret, or real resource identifier.

By submitting a contribution, you agree that it is licensed under `AGPL-3.0-only` and that you
have the right to provide it under that license.
