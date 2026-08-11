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
`strict-allow-scripts=true` turns an unlisted install script into a failed install rather than a
silent skip. Node 24 still bundles npm 11, which has neither behavior, so CI installs npm 12
explicitly. Corepack cannot do this — it has no npm shim, which is why there is no `packageManager`
field.

Bumping the CI npm patch version is a manual edit; Dependabot does not manage it. Bumping the npm
major additionally requires updating `engines.npm`, which `scripts/release-audit.mjs` verifies.

## Install scripts

Dependency install scripts are governed by the `allowScripts` field in
[`package.json`](package.json): only the packages listed there may run `preinstall`, `install`, or
`postinstall`, pinned to an exact version. `strict-allow-scripts=true` in `.npmrc` makes an
unlisted install script fail the install instead of being skipped in silence.

CI additionally passes `--ignore-scripts`, so **no** dependency install script runs there at all.
The two are not redundant, and the precedence matters:

- `--ignore-scripts` wins over everything. It skips all install scripts and short-circuits before
  the per-package `allowScripts` check, so on its own it would make the allowlist decorative.
- The separate `npm install-scripts ls` step is therefore what enforces the allowlist in CI. It
  fails the build as soon as an installed package has an install script nobody has approved, whether
  or not that script would have run.
- On a contributor's machine `npm ci` runs without the flag, and there `strict-allow-scripts` is the
  live enforcement.

The result is that CI executes no third-party install code while still refusing to accept an
unreviewed one, and a local install runs only reviewed scripts. Nothing in the build has ever needed
an install script to succeed.

`npm install-scripts prune` will offer to remove the `"fsevents": false` entry because fsevents is
not installed on Linux. Do not accept that: the entry is a deliberate denial that matters on macOS.

The empty `allow-scripts=` line in [`.npmrc`](.npmrc) looks redundant — npm reports that
`package.json` takes precedence and warns that the line is ignored — but it is load-bearing. It is a
*different* npm mechanism, meant for global installs and `npx`, and it is commonly set in a personal
`~/.npmrc`. Without the empty project-level override, a personal value leaks into project-scoped
commands and npm 12 fails them outright with `EALLOWSCRIPTS`, so `npm run check` would pass or fail
depending on the contributor's home directory. Keep the line.

When a dependency update changes a package that runs an install script (for example, a `wrangler`
bump that pulls a new `workerd`), two files must be updated together:

1. `package.json` → `allowScripts`, with the new exact `name@version`.
2. `scripts/release-audit.mjs` → the `allowScripts` comparison in `auditPackage()`.

That duplication is deliberate. It forces a human to look at the new install script before it runs
in CI. Do not relax the audit to avoid the second edit.

The workflow steps that carry this policy — `node-version-file: .nvmrc`, the pinned global npm, both
`--ignore-scripts`, and the `npm install-scripts ls` gate — are themselves pinned by
`REQUIRED_WORKFLOW_STEPS` in `scripts/release-audit.mjs`, and `.nvmrc` is compared exactly. Each has
to appear as an active line: comments are stripped before matching, so commenting a step out fails
the audit the same way deleting it does. Any other `npm ci`, `npm install`, or `npm rebuild` added
to the workflow must also carry `--ignore-scripts`. Editing any of those lines fails the audit until
the constant is updated in the same change. Without that, removing the enforcement would leave a
build that still passes every other check.

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
