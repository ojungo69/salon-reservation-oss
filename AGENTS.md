# Development instructions

Read `docs/ADR-0001-REUSE-FIRST-PORTING.md`, `docs/PORTING.md`, `docs/PARITY.md`,
`docs/ROADMAP.md`, and `CONTRIBUTING.md` before changing this project.

## Maintainer direction — 2026-09-12

Build the best supported reservation product, not the largest copy of an existing system.
Inspect proven implementation and regression evidence first. Reuse/generalize where beneficial;
replace a component when the comparison supports a better result. Preserve important behavioral
tests even when replacing code. Existing design and progress are not reasons to keep an inferior
choice. Neither the production storage model nor the current OSS storage model is preselected.

Keep provenance honest: Copied, Generalized, Reimplemented, and Excluded-private describe what
actually happened. A preferred future method is not completed work. Follow the private evidence
and publication-rights boundary; never put private source coordinates, identity, data, credentials,
assets, deployment output, or history into public files, issues, images, or commit messages.

## UI: images before implementation

Generate and refine real design images before implementing new or substantially redesigned UI.
Record the actual reference, selection rationale, task flows, responsive layout, and failure states.
The maintainer delegates design selection; do not mislabel that as personal approval of an image.
Use fictional data and neutral branding. Compare the implemented browser screenshots against the
selected design and verify accessibility, keyboard operation, narrow widths, and real user flows.
A written brief alone does not satisfy the image gate. See the ADR for the full requirements.

## PRs: fix, verify, review, repeat

Inspect bot comments, review threads, annotations, and CI results on the current head. Verify each
finding. Fix all valid in-scope findings, add applicable regression tests, rerun quality gates,
and obtain a fresh review of the changed head. Repeat until no valid unresolved finding remains.
Explain false positives with evidence; do not suppress a valid warning merely to merge.

Do not merge with failed/pending required checks, unresolved valid findings, or an outstanding
requested current-head review. Quota refusals and unavailable checks are blockers, not success.
Resolve threads only after evidence is recorded. Re-read the head and merge with its expected SHA.
Do not bypass repository protections, rewrite published history, or weaken tests to pass CI.

## Delivery boundaries

Keep changes independently reviewable and reversible. A bounded comparison experiment may use
fictional data; it must not silently become a production migration. Do not deploy, purchase
services, mutate live accounts, or delete production data without specific authorization.
Run `npm run check` and the browser suite required by the changed behavior and standing gates.
Report the exact verification performed and blockers; never claim work continues after the session.
