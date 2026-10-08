# Tasks: create recovery evidence

## Phase 1: setup

- [X] T001 Read the adopted bounded scope and inspect existing create/expiry/snapshot/outbox tests in `test/reservation-day.test.ts` and `test/worker.test.ts`.
- [X] T002 Create and validate `specs/007-create-recovery-evidence/spec.md`, `plan.md`, and design artifacts without changing the existing application contract.

## Phase 2: evidence foundation

- [X] T003 Record current public-license and behavioral test mapping in the existing private evidence ledger, preserving historical rights records; use only a sanitized summary in `docs/PORTING.md`.

## Phase 3: US1, safe retry after failure

Independent test: four focused Worker cases prove unchanged exact values after failure, one identical successful retry, and unchanged replay.

- [X] T004 [US1] Add public/owner receipt/final-calendar-sequence recovery cases in `test/reservation-day.test.ts`, including all persisted values, availability, attribution, calendar create=1 and LINE create=0.
- [X] T005 [US1] Run the focused `test/reservation-day.test.ts` checks and record whether unchanged runtime passes. Modify runtime only for a reproduced defect.

## Phase 4: US2, scoped authority and honest provenance

Independent test: one comparison ADR and consistent public provenance identify the selected authority and the unproved expansion/migration limits.

- [X] T006 [US2] Write the scoped comparison and public-reference test mappings in `docs/ADR-0002-CREATE-STORAGE-AUTHORITY.md`.
- [X] T007 [US2] Link the ADR and current evidence from `docs/PORTING.md`, `docs/PARITY.md`, and `docs/ROADMAP.md`; register the ADR in `release/public-files.txt`.

## Phase 5: final gates

- [ ] T008 Run `npm run check`, `npm run test:browser`, install-script allowlist verification, and public-diff checks; record exact outcomes in `specs/007-create-recovery-evidence/verify-tasks-report.md`.
- [ ] T009 Independently review the exact task diff using `code-review` and `ponytail-review`, then fix valid findings and rerun affected checks.
- [ ] T010 Verify every marked task once against files and actual results in `specs/007-create-recovery-evidence/verify-tasks-report.md`.

## Dependencies and strategy

T001 → T002 → T003 → T004 → T005 → T006 → T007 → T008 → T009 → T010. T006 may be drafted while focused tests run, but its result claim waits for T005. One writer owns all edits; a separate reviewer is read-only. Deliver US1 as the smallest useful evidence increment, then record the decision and complete the standing gates. No runtime rewrite or backend migration is planned.
