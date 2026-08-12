# Releasing

Every advertised version must resolve to an immutable Git tag and a GitHub Release that points at
the exact source commit. This procedure is reproducible from a clean checkout and needs no
Cloudflare account, deployment, or private input.

## Versioning

The project follows Semantic Versioning. Because the application is deployed by operators rather
than consumed as a library, "breaking" means an operator has to do something during an upgrade —
change configuration, accept a data-model migration, or re-run part of the setup wizard.

Three places carry the version and must always agree:

| Location | Purpose |
|---|---|
| `package.json` → `version` | The source's own claim |
| `scripts/release-audit.mjs` → `RELEASE_VERSION` | The audit that enforces the claim |
| The Git tag `vX.Y.Z` | The immutable published artifact |

`npm run release:audit` fails when the first two disagree, so a version bump is a single commit that
edits both, adds the `CHANGELOG.md` section, and updates the comparison links at the bottom of the
changelog.

## Cutting a release

1. Confirm `main` is green and every change intended for the release is merged.
2. Open a release pull request from a branch off current `main`:
   - move the `Unreleased` changelog entries into a new `## [X.Y.Z] - YYYY-MM-DD` section and add a
     fresh empty `Unreleased` section;
   - update the `[Unreleased]` and `[X.Y.Z]` link definitions at the bottom of `CHANGELOG.md`;
   - bump `package.json` → `version` and `scripts/release-audit.mjs` → `RELEASE_VERSION`;
   - refresh `package-lock.json` so its root `version` matches.
3. Verify locally from a clean checkout:

   ```bash
   npm ci
   npm run check
   ```

4. Merge the release pull request. Note the resulting commit on `main`.
5. Create an annotated tag on that exact commit and push it:

   ```bash
   git fetch origin
   git tag -a vX.Y.Z <commit> -m "Salon Reservation OSS vX.Y.Z"
   git push origin vX.Y.Z
   ```

   Sign the tag with `-s` if the maintainer has a GPG or SSH signing key configured. When no signing
   key is available, say so in the release notes rather than leaving readers to guess.
6. Publish the GitHub Release for that tag. The notes must state:
   - what the release contains, in operator-visible terms;
   - the limitations that are still intentional at this version, derived at release time from
     [the production-parity target matrix](PARITY.md#production-parity-target-matrix): list every
     row that is not `Implemented` (planned, partial, and deliberately excluded alike), so the
     notes never carry a hand-maintained capability list that can drift from the matrix;
   - which checks were performed and whether the tag is signed;
   - upgrade notes, including anything an existing deployment must do;
   - a link to the exact source commit.

Tags matching `v*` are protected by a repository ruleset: they cannot be deleted or moved. A
mistaken release is corrected by publishing the next patch version, never by rewriting a tag.

## Scope of `release:audit` and `release:audit:public`

`npm run release:audit` runs on every pull request as part of `npm run check`. It verifies the file
manifest, the absence of secret-shaped and personal content in published files, the package and
lockfile metadata, dependency licenses against `docs/THIRD_PARTY_LICENSES.md`, the commit-pinning of
GitHub Actions, and the owner authentication form shape. This is the audit that guards the published
repository.

`npm run release:audit:public` additionally asserts that the tree is a Git repository with exactly
one commit, one root, one ref, and no remote. Those assertions describe a **freshly assembled
publication candidate**, not a published repository. They no longer hold here and are not expected
to: this repository has a remote and an ongoing history. Use `release:audit:public` only inside a
tree produced by `scripts/assemble-public-release.sh`, which is the original one-time path from a
private development workspace to a first public commit.

Never re-run the assembler against the published repository. It creates a new single-commit history,
which would require a force push and would destroy the published history, the pull requests, and the
branch protection that depends on them.

## Adding a file to the published tree

`release/public-files.txt` is the allowlist of published paths. It must stay sorted and free of
duplicates, and under `release:audit:public` it must match the tracked file set exactly. A new
published file therefore needs a manifest entry in the same commit that adds it. Files that must
never be missing are additionally listed in the `REQUIRED` set in `scripts/release-audit.mjs`.
