# Quickstart: Verify the Reuse-First Porting Boundary

## Prerequisites

- Work from the issue-specific public worktree on `feat/reuse-first-porting`.
- Keep the production source repository read-only and clean.
- Set `PORT_SOURCE_ROOT` to its explicit local path only for the hash comparison.
- Keep the private ledger in the separate private development workspace.
- Do not configure remotes, deploy, migrate, seed, or read secret values.

## 1. Confirm baseline and scope

```bash
git status --short --branch
git diff --check
```

Expected:

- Only Phase 0 documentation, pull-request template, release manifest, and required-path audit changes appear.
- No `src/`, `public/`, Worker configuration, package, lockfile, migration, or runtime test file changes appear.

## 2. Verify the one exact copied implementation

```bash
sha256sum "$PORT_SOURCE_ROOT/src/date-parse.ts" src/date-parse.ts
```

Expected: both hashes are identical. A mismatch makes the date-parser ledger row stale and blocks completion.

## 3. Verify the public/private boundary

Review the public diff and the private ledger side by side against [the projection contract](contracts/provenance-record.md).

Expected:

- Every initial public row maps to one private ledger row.
- The private ledger keeps the mandatory do-not-publish sentinel defined by the projection contract; release audit rejects it even after a rename.
- Public files contain no private repository/workspace names or paths, private revision identifiers, exact private test coordinates, rights-evidence coordinates, customer or account identifiers, deployment details, credentials, private runbooks, private history, raw denylist terms, or proprietary assets.
- The private ledger contains coordinates and rights evidence references, but no secret values or customer data.

When a maintainer-controlled private denylist is available at an allowed local path, also run:

```bash
npm run release:audit -- --denylist /absolute/allowed/path/to/private-denylist
```

Expected: `release audit passed` without printing denylist contents.

## 4. Verify release registration

```bash
npm run release:audit
```

Expected:

- Manifest remains sorted and newline-terminated.
- Both new public governance documents are regular files and required public paths.
- A canonical or marker-bearing private ledger fails the normal audit when current, staged, renamed, omitted from the manifest, or deleted but retained in reachable history. Non-Git and shallow checkouts fail closed.
- Existing release scans pass.

## 5. Run the complete project gate

```bash
npm run check
```

Expected:

- Core and Worker tests pass.
- Type checks and generated-type checks pass.
- Wrangler dry-run build passes.
- Dependency audit and release audit pass.

The known Worker suites may print exception logs from deliberate corrupt-storage, eviction, or missing-RPC test cases; completion is determined by the final test counts and process exit code.

## 6. Confirm both repository scopes

Public worktree:

```bash
git status --short
git diff --check
```

Private development workspace:

```bash
git status --short
git diff --check
```

Expected:

- Public worktree contains only approved public Phase 0 files.
- Private workspace adds only `docs/PRIVATE_PORTING_LEDGER.md`; pre-existing unrelated untracked files remain untouched.
- Production source repository remains clean and unchanged.

## 7. Review gates

1. Run correctness review over both diffs.
2. Validate every accepted finding against the actual source and project policy.
3. Run ponytail review and remove only proven duplication or unnecessary machinery.
4. Re-run focused release audit after any accepted edit.
5. Run task verification exactly once and record evidence in `verify-tasks-report.md`.

## Stop conditions

- Any public artifact exposes a forbidden private coordinate or identifier.
- The exact copied file hash differs.
- A row needs more than one current disposition and has not been split.
- Additional copying lacks explicit rights confirmation.
- A runtime, schema, API, auth, deployment, or dependency change appears.
- Either repository contains an overlapping pre-existing change that cannot be preserved.
