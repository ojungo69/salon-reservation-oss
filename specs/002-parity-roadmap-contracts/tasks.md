# Tasks: Production-Parity Roadmap and Adapter Extension Contracts

**Input**: Design documents from `/specs/002-parity-roadmap-contracts/` (spec.md, plan.md, research.md)

**Tests**: No new automated tests — test changes are out of this slice's scope by design, and FR-009 requires the existing tests to pass unchanged. Verification is the existing suite run unchanged plus the document-level audits below.

**Organization**: Strictly the plan's implementation order — anchors are written before the documents that link to them (contracts → roadmap → matrices → derived views), verification last.

## Format: `[ID] Description`

---

## Phase 0: Environment

- [X] T001 Worktree preflight: copy `.specify/` from the main checkout into the worktree, run `specify self check` and `specify integration status`, then `npm ci --ignore-scripts` and `./node_modules/.bin/playwright install chromium`
- [X] T002 Baseline inventory: record `git status --short`; enumerate the current 16 implemented rows, 4 manual checks, and 7 exclusion rows of `docs/PARITY.md` (uncommitted working notes) for the final crosswalk

---

## Phase 1: New authority documents

- [X] T003 Write `docs/ADAPTER-CONTRACTS.md`: shared invariants (post-commit events only, with every projection derived from committed state and the recorded ICS feed observationally equivalent to an event-maintained projection; booking acceptance never waits; unconfigured = no UI trace, no stored external identifiers, no booking-path dependency; single-Worker configuration-gated modules), then four seam sections (identity, notifications, calendar synchronization, audit/event delivery) each with the fixed seven-row table `Dimension | Core guarantee | Adapter obligation | Operator-visible outcome` (research D3: calendar's three modes with fail-closed scoped to inbound availability authority; identity's accountless default; notifications' committed-events-only; audit's immutable-history authority), closing with the staging note that code-level contracts land with the first adapter stage implemented (S1 in the recommended order)
- [X] T004 Write `docs/ROADMAP.md`: header (document version 1.0.0, baseline release 0.2.0, stage-status vocabulary `Not started`/`In progress`/`Complete` with the status-cell-only transition rule, dated revision log, gates-are-additive framing, production-parity predicate), the dependency-versus-recommended-order note, the S0–S5 stage table per research D5 (S0 `In progress`), and the prominent pointer to the authoritative exclusions in `docs/PARITY.md`

---

## Phase 2: State authority and derived views

- [X] T005 Evolve `docs/PARITY.md` in place: retitle preamble (implemented capability matrix + target matrix, describing the current repository candidate at this commit, relation to Roadmap 1.0.0 / baseline release 0.2.0); keep all 16 implemented rows and 4 manual checks verbatim; add the production-parity target matrix (`Capability | Production task it serves | Status | Current evidence / remaining gap | Roadmap stage / exclusion boundary`, research D2 assignments — calendar as three mode rows, inbound authority Deliberately excluded with demand + job/queue-substrate boundary; external audit/event delivery Deliberately excluded with the contract seam as boundary; no evidence inflation); decompose the 7 legacy exclusion rows (fan-out allowed, every rationale and future boundary preserved); append the update rule
- [X] T006 Update `README.md`: add the "Parity status" section (conditional claim derived from the target matrix, links to both matrices and roadmap); trim the "Deliberate limits" absent-capability sentence to bounded-deployment facts + links; verify fragment anchors resolve
- [X] T007 Update `docs/RELEASING.md` (replace the inline "currently: …" limitation list with the derive-from-target-matrix instruction + link) and `docs/UX-PARITY.md` (derived-view preamble line; two "v0.x 除外" multi-location references → target-matrix row; three adapter-dependent "先送り" status cells → target-row references, keeping the absence evidence)
- [X] T008 Add `docs/ADAPTER-CONTRACTS.md` and `docs/ROADMAP.md` to `release/public-files.txt` in lexicographic order

---

## Phase 3: Verification and closure (plan step 8 order is binding)

- [X] T009 Cross-document audit: map FR-001…FR-010 and SC-001…SC-005 to concrete locations; semantic crosswalk (every capability in the 7 legacy exclusion rows → exactly one new row); 28 contract rows × 3 substantive columns (84 cells, none a bare pointer to shared invariants); exact four-value status enum; no atomic row both planned and excluded; atomic-row uniqueness covering every issue #1 capability; no independent status list outside the target matrix (derived views and CHANGELOG exempt); relative links and fragments resolve
- [X] T010 Stage exactly the intended paths (`git add README.md docs/PARITY.md docs/ROADMAP.md docs/ADAPTER-CONTRACTS.md docs/RELEASING.md docs/UX-PARITY.md release/public-files.txt specs/002-parity-roadmap-contracts/`), verify `git diff --cached --check` clean and `git diff --cached --name-only` lists exactly those paths; `npm run check` EXIT 0; `npm run test:browser` EXIT 0
- [X] T011 Set S0 → `Complete` in `docs/ROADMAP.md`, re-stage, re-run the T010 checks; then correctness review and over-implementation review over the full cached diff including the flip; apply accepted findings and repeat T009–T011 until both reviews pass a diff with zero subsequent edits; open the PR referencing issue #1 as "Part of #1" (never "Closes")

---

## Dependencies & Execution Order

- T001 → everything (environment); T002 → T005/T009 (crosswalk baseline)
- T003 → T004 → T005 (anchor direction: contracts ← roadmap ← matrices) → T006/T007 (derived views) → T008 → T009 → T010 → T011
