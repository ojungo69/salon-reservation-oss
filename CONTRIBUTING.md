# Contributing

Thank you for improving Salon Reservation OSS.

## Before changing code

1. Use Node.js 24 and npm 12.
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

## Install scripts

Dependency install scripts are governed by the `allowScripts` field in
[`package.json`](package.json): only the packages listed there may run `preinstall`, `install`, or
`postinstall`, pinned to an exact version.

When a dependency update changes a package that runs an install script (for example, a `wrangler`
bump that pulls a new `workerd`), two files must be updated together:

1. `package.json` → `allowScripts`, with the new exact `name@version`.
2. `scripts/release-audit.mjs` → the `allowScripts` comparison in `auditPackage()`.

That duplication is deliberate. It forces a human to look at the new install script before it runs
in CI. Do not relax the audit to avoid the second edit.

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
