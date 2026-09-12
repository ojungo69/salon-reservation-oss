# Tasks: Reuse-First Porting Boundary

**Input**: Design documents from `specs/006-reuse-first-porting/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/provenance-record.md](contracts/provenance-record.md), [quickstart.md](quickstart.md)

**Tests**: This specification requires exact-copy verification, public/private scope checks, focused release-audit evidence, and the complete existing project gate. No browser test is required because rendered behavior does not change.

**Organization**: Tasks are grouped by user story. One writer executes them sequentially; `[P]` marks only file-disjoint work that would otherwise be parallelizable.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Different files and no dependency on an incomplete task
- **[Story]**: User story from `spec.md`
- Every task names its exact repository-relative path; `docs/PRIVATE_PORTING_LEDGER.md` belongs to the separate private development workspace

## Phase 1: Setup and Evidence Baseline

**Purpose**: Bind the approved design to clean, current repositories before any implementation edit.

- [X] T001 Reconfirm the public worktree, production source, and private workspace status plus the exact date-parser hash using `specs/006-reuse-first-porting/quickstart.md`; preserve unrelated private-workspace changes
- [X] T002 Run GitNexus upstream impact analysis for `REQUIRED` in `scripts/release-audit.mjs` and record risk, direct dependents, and affected processes before editing the symbol

**Checkpoint**: All three repositories are identified, the production source is read-only, and the one exact-copy claim is current.

---

## Phase 2: Foundational Provenance Gate

**Purpose**: Create the fail-closed release assertion and private source of truth that all stories use.

**Critical**: User-story work starts only after this phase.

- [X] T003 Add `docs/ADR-0001-REUSE-FIRST-PORTING.md` and `docs/PORTING.md` to `REQUIRED` in `scripts/release-audit.mjs`, run `npm run release:audit`, and capture the expected `required public path is missing` red result before changing `release/public-files.txt`
- [X] T004 Create and fill the eight initial records plus the mandatory do-not-publish sentinel in private-workspace `docs/PRIVATE_PORTING_LEDGER.md` using `specs/006-reuse-first-porting/contracts/provenance-record.md`, exact source/public paths, bound revisions, test mappings, rights status, sanitization, owner, and next gates without reading secret values

**Checkpoint**: Release audit is intentionally red for the missing manifest entries, and exact evidence exists only in the private workspace.

---

## Phase 3: User Story 1 - Classify Existing Implementation Provenance (Priority: P1)

**Goal**: Publish an honest, sanitized current-provenance summary backed by the private ledger.

**Independent Test**: Every initial public row maps to one private row; date parsing is the only `Copied` implementation; no private coordinate appears publicly; release audit returns green after manifest registration.

- [X] T005 [P] [US1] Create the reuse-first decision, exception rules, pause boundary, and future canonical-core goal in `docs/ADR-0001-REUSE-FIRST-PORTING.md`
- [X] T006 [US1] Project the eight private ledger records into the allowed seven-column public table and explanatory rules in `docs/PORTING.md`
- [X] T007 [US1] Add `docs/ADR-0001-REUSE-FIRST-PORTING.md` and `docs/PORTING.md` in lexical order to `release/public-files.txt`, then rerun `npm run release:audit` and require green
- [X] T008 [US1] Re-run the exact `src/date-parse.ts` hash comparison and review `docs/PORTING.md` against private-workspace `docs/PRIVATE_PORTING_LEDGER.md` for one-to-one projection and forbidden-field absence

**Checkpoint**: Current provenance is public-safe, supported, and release-required.

---

## Phase 4: User Story 2 - Prevent Silent Parallel Reimplementation (Priority: P2)

**Goal**: Put the disposition and evidence declaration in every contributor's normal pull-request path.

**Independent Test**: A parity pull request cannot complete the new section without selecting exactly one disposition and addressing ledger, tests, sanitization, reimplementation evidence, and ADR requirements; a non-parity change has an explicit not-applicable path.

- [X] T009 [US2] Run `rg -n "Production-parity provenance|Private porting ledger|Reimplementation reason" .github/pull_request_template.md` and require the expected pre-implementation no-match result
- [X] T010 [US2] Add the conditional production-parity provenance declaration from `specs/006-reuse-first-porting/contracts/provenance-record.md` to `.github/pull_request_template.md`
- [X] T011 [US2] Re-run the focused `rg` declaration check against `.github/pull_request_template.md` and manually verify one not-applicable path plus exactly-one-disposition wording

**Checkpoint**: The review surface makes provenance omissions visible without adding CI or dependencies.

---

## Phase 5: User Story 3 - Read Capability and Provenance Separately (Priority: P3)

**Goal**: Separate capability status, provenance, and migration readiness and block unsupported roadmap expansion.

**Independent Test**: Public docs alone identify the three distinct authorities and state that architecture-expanding parity work is blocked without a ledger row, disposition, mapped tests, and required ADR while security fixes remain allowed.

- [X] T012 [P] [US3] Run `rg -n "PORTING|provenance|migration readiness|reuse-first" docs/PARITY.md docs/ROADMAP.md` and require the expected incomplete pre-implementation result
- [X] T013 [P] [US3] Link the public provenance authority, distinguish capability/provenance/migration status, and extend the update rule in `docs/PARITY.md`
- [X] T014 [P] [US3] Add the reuse-first precondition, security-fix exception, and versioned revision entry in `docs/ROADMAP.md`
- [X] T015 [P] [US3] Record the unreleased Phase 0 governance change in `CHANGELOG.md`
- [X] T016 [US3] Re-run the focused cross-reference check across `docs/PARITY.md`, `docs/ROADMAP.md`, `docs/PORTING.md`, and `docs/ADR-0001-REUSE-FIRST-PORTING.md` and reconcile contradictions

**Checkpoint**: A capability claim can no longer be read as an implementation-reuse or migration-ready claim.

---

## Phase 6: Final Cross-Cutting Gates

**Purpose**: Prove scope, release safety, simplicity, and task completion once.

- [X] T017 Run `npm run release:audit` and confirm sorted manifest, both required paths, regular-file checks, and all existing scans pass
- [X] T018 Run `npm run check` and require core tests, Worker tests, type checks, generated-type checks, Wrangler dry-run build, dependency audit, and release audit all green
- [X] T019 Inspect `git diff --check`, public-worktree status/diff, private-workspace status/diff, and production-source status; confirm zero runtime/schema/API/auth/deploy changes and only `docs/PRIVATE_PORTING_LEDGER.md` added privately
- [X] T020 Run GitNexus `detect_changes` for the linked public worktree and confirm only the expected release-audit symbol and documentation surface are affected
- [X] T021 Run correctness review over both diffs, validate every finding against issue #60, the approved spec, and actual source, then apply only valid fixes
- [X] T022 Run the independent Grok review gate for the governance and privacy boundary, then apply only reproducible findings
- [X] T023 Run `ponytail-review` and remove only proven duplication, unnecessary automation, configuration, or abstraction
- [X] T024 Re-run `npm run release:audit`, `git diff --check`, projection inspection, and any check affected by accepted review fixes
- [X] T025 Run task verification exactly once, reconcile every `[X]` with evidence, and write `specs/006-reuse-first-porting/verify-tasks-report.md`

---

## Dependencies and Execution Order

### Phase dependencies

- Phase 1 has no dependency.
- Phase 2 depends on Phase 1 and blocks every user story.
- US1, US2, and US3 depend on Phase 2.
- Phase 6 depends on all three user stories.

### User story dependencies

- **US1**: Uses the private ledger from T004 and completes release registration.
- **US2**: Uses the disposition vocabulary and contract; independently testable after Phase 2.
- **US3**: Uses the public authority defined by US1; file edits may start after Phase 2, but T016 waits for US1.

### Parallel opportunities

- T005 can proceed beside T009 and T012 because the files do not overlap.
- T013, T014, and T015 are file-disjoint after their shared terminology is fixed.
- This run uses one inline writer; `[P]` documents dependency shape, not delegated execution.

## Parallel Example: User Story 3

```text
Task T013: Update capability/provenance authority in docs/PARITY.md
Task T014: Update reuse-first stage gate in docs/ROADMAP.md
Task T015: Record the change in CHANGELOG.md
```

## Implementation Strategy

### MVP first

1. Complete Phase 1 and Phase 2.
2. Complete US1.
3. Stop and validate the private-to-public projection and release audit.

### Incremental completion

1. Add the contributor declaration in US2.
2. Add public cross-document authority and pause gate in US3.
3. Run the full cross-cutting verification and reviews once.

## Notes

- No new dependency, workflow, generator, runtime code, schema, or UI is allowed.
- A current `Reimplemented` disposition does not pre-decide the next slice's preferred storage or migration architecture.
- Do not mark a task complete from intent; record command or file evidence first.
- Do not commit or publish; user authorization covers local implementation and verification only.
