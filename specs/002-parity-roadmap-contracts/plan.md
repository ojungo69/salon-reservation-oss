# Implementation Plan: Production-Parity Roadmap and Adapter Extension Contracts

**Branch**: `feat/parity-roadmap-contracts` | **Date**: 2026-08-12 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/002-parity-roadmap-contracts/spec.md`, Phase-0 decisions from [research.md](./research.md) (integrated from two independent plans — Claude Code and a Codex second-opinion pass; divergence records live in research.md)

## Summary

Slice 1 of issue #1, documentation only. `docs/PARITY.md` evolves in place into the single **state** authority: the implemented-capabilities matrix (every current row and manual check kept), a new production-parity **target matrix** beside it (atomic four-value status; issue #1's capabilities assigned to stages; composite exclusion rows decomposed), and the deliberate exclusions — honoring the constitution's assignment of capability boundaries to this file. A new `docs/ROADMAP.md` holds **order** only: a versioned six-stage table (S0 documentation foundation → S1 LINE identity+notifications → S2 calendar ladder [ICS feed + outbound sync; bidirectional inbound import deliberately unscheduled per issue #1's recorded 2026-08-11 decision] → S3 staff/roles → S4 multi-location → S5 import/migration) with hard dependencies separated from recommended order and a recorded production-parity predicate. A new `docs/ADAPTER-CONTRACTS.md` holds the four extension contracts as identical seven-row obligation tables (28 auditable cells). `README.md` gains a conditional parity-status claim and drops its drifting absent-capability list; the two remaining frozen capability lists (`docs/RELEASING.md`'s release-notes template, `docs/UX-PARITY.md`'s "v0.x 除外" references) are redirected to the target matrix for the same reason. No runtime change; issue #1 stays open (PR says "Part of #1", never "Closes").

## Technical Context

**Language/Version**: Markdown documentation only; no code changes

**Primary Dependencies**: none added; content constrained by `.specify/memory/constitution.md` (principles I, II, V; Governance assignment of `docs/PARITY.md`) and issue #1's acceptance criteria

**Storage**: N/A

**Testing**: `npm run check` and the browser suite run unchanged as the FR-009 no-behavior-change gate; document-level audits (row accounting, 28-row/84-content-cell contract scan, status atomicity) are review steps recorded in tasks

**Target Platform**: repository documentation (GitHub rendering)

**Project Type**: single Worker repository; this slice touches `docs/`, `README.md`, `release/public-files.txt`, the two-line `scripts/release-audit.mjs` REQUIRED registration for the new documents, and the `specs/002-parity-roadmap-contracts/` Spec Kit artifacts

**Performance Goals**: N/A

**Constraints**: public-safe surface (constitution V): production system referenced only by user task and capability; `docs/PARITY.md` path keeps resolving with its content in place; no CI/workflow/quality-gate/test changes; no product SemVer promises on roadmap stages

**Scale/Scope**: 2 new documents, 4 evolved documents (`docs/PARITY.md`, `README.md`, `docs/RELEASING.md`, `docs/UX-PARITY.md`), 1 allowlist edit plus the matching release-audit REQUIRED entries, and the Spec Kit artifacts under `specs/002-parity-roadmap-contracts/`; baseline inventory to preserve: 16 implemented rows, 4 manual checks, 7 exclusion rows

## Constitution Check

- **I. Provider-neutral core**: no code change; the contracts codify "zero external services on the core booking path" as a binding requirement for every future adapter. ✅
- **II. Adapters invisible until configured**: each contract's Configuration-gating row makes this auditable per seam (no UI trace, no stored external identifiers, no booking-path dependency when unconfigured), and the shared invariants state adapters live inside the single Worker as configuration-gated modules — the constitution's own wording. ✅
- **III. Accessibility regression-protected**: no UI change; browser suite runs unchanged. ✅
- **IV. Transactional integrity**: no code change; the shared invariants keep the constitution's post-commit-events wording unweakened (every projection derives only from committed state; the recorded ICS feed must be observationally equivalent to an event-maintained projection) and nothing gates acceptance; the calendar contract reconciles fail-closed availability with that invariant by scoping it to the inbound-availability-authority mode only (the booking path reads pre-synchronized data, never calls out; ICS-feed and outbound-only modes never touch availability). ✅
- **V. Public-safe surface**: FR-010 gate on every new row and stage description; the target matrix names production *user tasks*, never production assets, accounts, or identifiers. ✅
- **Governance**: capability boundaries and deliberate exclusions stay recorded in `docs/PARITY.md` (target matrix and exclusions live there, not in a new file) — no constitution amendment needed. ✅

No violations → Complexity Tracking not needed.

## Project Structure

### Documentation (this feature)

```text
specs/002-parity-roadmap-contracts/
├── spec.md
├── research.md          # Phase 0, integrated two-plan decisions (done)
├── plan.md              # this file
├── checklists/requirements.md
└── tasks.md             # /speckit-tasks output (after plan approval)
```

Data shapes (matrix row schema, stage schema, contract table structure) are fully specified in research D2/D3/D5; no separate `data-model.md`/`contracts/` files (same convention as feature 001).

### Documents changed (repository root)

```text
README.md                    # + "Parity status" section (conditional claim, links); "Deliberate limits"
                             #   trimmed to bounded-deployment facts + matrix links (research D4)
docs/
├── PARITY.md                # evolves in place: implemented matrix (all 16 rows + 4 manual checks kept)
│                            #   + target matrix (research D2 schema/assignments) + decomposed exclusions
│                            #   + update rule (status changes edit the target row in the same change)
├── ROADMAP.md               # new: doc version 1.0.0, baseline release 0.2.0, revision log, gates-are-
│                            #   additive framing, stage table S0–S5 (research D5); links to PARITY for
│                            #   all capability status + prominent pointer to authoritative exclusions
├── ADAPTER-CONTRACTS.md     # new: shared invariants + 4 seams × 7-row obligation tables (research D3)
├── RELEASING.md             # release-notes template: inline "currently: …" limitation list replaced by
│                            #   derive-from-target-matrix instruction + link (research D4)
└── UX-PARITY.md             # two "v0.x 除外" references to multi-location reworded to point at the
                             #   capability's target-matrix row/stage (research D4)
release/public-files.txt     # + docs/ADAPTER-CONTRACTS.md, docs/ROADMAP.md (lexicographic order)
```

**Structure Decision**: research D1 — state in `PARITY.md` (constitution Governance), order in `ROADMAP.md`, obligations in `ADAPTER-CONTRACTS.md`; README carries only the classification and entry links.

## Implementation order

0. **Worktree preflight** — the fresh worktree carries neither the git-excluded `.specify/` nor `node_modules`: copy `.specify/` from the main checkout (`cp -r ~/projects/salon-reservation-oss-public/.specify .`, still covered by the shared `info/exclude`), run `specify self check` and `specify integration status`, then `npm ci --ignore-scripts` and `./node_modules/.bin/playwright install chromium` (the CI workflow's own commands; the browser download is a cached no-op when `~/.cache/ms-playwright` already has the pinned version). Without this step every verification command in this plan fails on environment, not content.
1. **Baseline inventory** — record `git status --short`; count the current 16 implemented rows, 4 manual checks, 7 exclusion rows for the final row-for-row accounting (SC-005). Working notes stay uncommitted.
2. **`docs/ADAPTER-CONTRACTS.md`** — shared invariants, then the four 7-row tables; self-audit the 28 cells (SC-002). First because target-matrix rows and stage criteria reference contract sections.
3. **`docs/ROADMAP.md`** — header (doc version, baseline, vocabulary, revision log) + stage table S0–S5 with S0 `In progress`. Defines the stage anchors the target matrix links to.
4. **`docs/PARITY.md`** — retitle/reframe preamble; implemented matrix kept row-for-row; target matrix added with the research-D2 assignments (calendar as three mode rows: ICS feed and outbound sync Planned/S2, inbound availability authority Deliberately excluded with the demand + job/queue-substrate condition as its recorded future boundary); composite exclusion rows decomposed (planned items move to target-matrix Planned rows; payments, CRM/medical, cross-day moves, custom operations, unspecified providers, external audit delivery, and inbound calendar authority stay Deliberately excluded with rationale and future boundary); manual checks kept; update rule appended.
5. **`README.md`** — "Parity status" section; trim the "Deliberate limits" capability list; verify fragment links resolve.
6. **`docs/RELEASING.md` and `docs/UX-PARITY.md`** — replace the release-notes inline limitation list with the derive-from-target-matrix instruction; reframe UX-PARITY as a derived task-level evidence view (preamble line), reword the two "v0.x 除外" multi-location references and point the adapter-dependent "先送り" status cells (notifications, location choice, external identity) at their target-matrix rows.
7. **`release/public-files.txt`** — add the two new docs in lexicographic order.
8. **Verification and closure, in this order** — (a) cross-document audit: FR-001…FR-010, SC-001…SC-005 mapped to concrete locations; row accounting 16/4/7; the 28-row/84-content-cell contract scan; status atomicity; no atomic row both planned and excluded; no orphan links; no list asserting capability status *independently of* the target matrix (derived views whose status cells reference target rows — the reframed `docs/UX-PARITY.md` — and historical records such as `CHANGELOG.md`, which describe past releases, are exempt). The audit also includes: a semantic crosswalk in which every capability contained in the 7 legacy exclusion rows maps to exactly one new target/exclusion row (one legacy row may fan out to several new rows) with its rationale and future boundary preserved; all 28 contract rows carrying substantive content in each of the three obligation columns (84 content cells, no cell that is only a pointer to the shared invariants); the exact four-value status enum; atomic-row uniqueness with recorded decompositions whose union covers every issue #1 capability; and relative links plus heading fragments resolving in every changed document. (b) Stage the intended paths explicitly (`git add README.md docs/PARITY.md docs/ROADMAP.md docs/ADAPTER-CONTRACTS.md docs/RELEASING.md docs/UX-PARITY.md release/public-files.txt scripts/release-audit.mjs specs/002-parity-roadmap-contracts/` — never a bare `git add -A`, so no unrelated change rides along), then verify with `git diff --cached --check` and confirm `git diff --cached --name-only` lists exactly those paths — plain `git diff` misses the untracked new documents. (c) `npm run check` EXIT 0; `npm run test:browser` EXIT 0. (d) Set S0 → `Complete` (its completion evidence now exists), re-stage, and re-run the staged-diff check plus both commands, so the flip itself is part of the reviewed diff. (e) Correctness review, then over-implementation review, over the full cached diff *including* the flip; apply accepted findings, repeat (b)–(d) for anything that changed, and re-review until both reviews pass a diff that receives zero edits afterwards — the constitution's "every diff passes both reviews" holds for the exact final state. PR references issue #1 as "Part of #1".

## Execution routing

Documentation authoring stays with Claude Code in this slice: the deliverables are planning/contract artifacts whose content is exactly the judgment work (constitution-V safety, contract semantics), and delegating prose to an external CLI adds a review round-trip without reducing risk. Review remains the standard two-lane gate (correctness review, then over-implementation review) plus the plan-review gate before implementation.

## Risks

- **Status duplicated across documents** (drift): the single-authority rule — status lives only in `PARITY.md`'s target matrix; `ROADMAP.md` carries stage status only and links for capability status; README derives, never lists.
- **Composite exclusion rows land a capability as both planned and excluded**: the decomposition step (order step 4) enumerates each legacy row's parts and assigns each part exactly one target row; the verification audit checks for double-appearance explicitly.
- **Calendar fail-closed written as a synchronous external check**: would contradict constitution IV/II; the contract's phrasing (pre-synchronized confirmed availability only; delivery failures surface as reconciliation status) is fixed in research D3 and re-checked at review.
- **Implemented-evidence inflation** (internal history presented as external audit delivery, schedule fallback as notifications): target matrix links these as separate implemented capabilities with the external gap named in the gap column.
- **Release-audit failure on new files**: the allowlist enumerates files explicitly (verified); step 7 adds both before `npm run check` runs.
- **README/roadmap read as commitment**: conditional claim + versioned revision log frame stages as direction revisable by recorded revision.

## Decisions surfaced at the plan gate (recommendation, with default)

1. **Slicing of issue #1** — recommended: docs-only S0 now (this plan), LINE adapter as feature 003, issue #1 closes at the final slice. Default if unchallenged: proceed as planned.
2. **Stage order and granularity** — recommended: S1 LINE → S2 calendar ladder (ICS feed + outbound only; bidirectional inbound import stays unscheduled per issue #1's recorded 2026-08-11 decision) → S3 staff/roles → S4 multi-location → S5 migration, with cross-day moves staying excluded; hard dependencies (S0 → all; S3/S4 → S5) distinguished from recommended order (research D5). Default: as recommended.
3. **Audit/event delivery target status and the parity predicate** — recommended: external audit/event delivery is `Deliberately excluded` (nothing of the external pipeline exists; the contract-defined seam is its recorded future boundary; adding a stage is a recorded roadmap revision — a `Partial` claim on the strength of the separate internal-history row was rejected at review as evidence inflation), with the roadmap recording the explicit predicate: production parity = every target row `Implemented` or `Deliberately excluded`, read from the matrix at claim time. Default: as recommended.
4. **Whether calendar/staff/location/migration get their own specs now** — recommended: no; they are roadmap stages, specced when their stage starts. Default: as recommended.
5. **Delegation assumption** — the 「判断は任せる」 grant from feature 001's five design questions was scoped to that feature; this plan assumes the same delegation posture for documentation design decisions here (D1–D5). Approving this plan confirms that assumption.
