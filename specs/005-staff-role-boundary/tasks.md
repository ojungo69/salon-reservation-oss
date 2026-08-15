# Tasks: Staff and role boundary (S3)

**Input**: Design documents from `/specs/005-staff-role-boundary/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md),
[data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md)

**Tests**: Included. The specification's own gates section requires the full `npm run check` and the
browser suites, and [quickstart.md](./quickstart.md) already defines eight validation scenarios that
these tasks implement.

**Who implements**: This project's own hands, not an external CLI. The slice is authorization,
credential handling, and secret storage — security scope, where delegation is not permitted.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: the user story from spec.md this task serves

## Path conventions

Single Worker at the repository root: `src/`, `public/`, `test/` (node --test), `tests-browser/`
(Playwright), `docs/`. No new directory is created by this slice.

---

## Phase 1: Setup

**Purpose**: start from a known-green baseline, so a later failure is attributable.

- [X] T001 Confirm the worktree is on `feat/s3-staff-role-design` rebased on `origin/main`, then run `npm run check` and `npm run test:browser` and record both as green before any edit

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: the roster, the resolver, and the gate. Every user story depends on all of it.

**⚠️ CRITICAL**: no user story work begins until this phase is complete and the suites are still green.

**Design intent for this phase**: it changes no observable behaviour. Every route keeps requiring
`owner`, and an installation with no roster is byte-identical to today. That is what makes the
checkpoint meaningful.

- [X] T002 [P] Add the roster types and `parseStaffRoster` to `src/installation-config.ts`, enforcing all four invariants from [data-model.md §1](./data-model.md) — at least one active `owner`, unique `id`, digest present iff active, and round-trip stability
- [X] T003 Add `__staff_roster` storage to `src/installation-config.ts`: an existence check, a read that answers `null` when the table is absent, and the `CREATE TABLE IF NOT EXISTS` + `INSERT … ON CONFLICT DO UPDATE … WHERE roster_json = ?` upsert from [research.md R7](./research.md) (depends on T002)
- [X] T004 Add the `resolveActor(digest)` RPC to `src/installation-config.ts`, scanning every member with a constant-time compare and **no early exit**, returning `{ staffId, role } | null` and never letting a digest leave the object (depends on T003)
- [X] T005 [P] Add the staff-credential helpers to `src/worker.ts`: generation as 32 bytes from `crypto.getRandomValues` encoded base64url to 43 characters, matching `newManagementKey` in `public/app.js:131-136`, plus the digest and its validation regex
- [X] T006 Replace `ownerGate` with `operatorGate` in `src/worker.ts` per [contracts/authorization.md](./contracts/authorization.md): rate limit, then `OWNER_TOKEN` from the environment with no Durable Object call, then `resolveActor`, then the role check — with both refusals answering an identical `401` and a comment recording that this is deliberate (depends on T004, T005)
- [X] T007 Add the `ROUTE_ROLE` record to `src/worker.ts` as a total `Record<OperatorRoute, Required>` with no index signature and no default branch, and set all thirteen existing buckets to `owner` so this phase changes nothing (depends on T006)
- [X] T008 [P] Add `test/staff-roster.test.ts` covering the parse and the four invariants, and register it in the `test:core` script in `package.json`

**Checkpoint**: `npm run check` and `npm run test:browser` are green and no existing test was edited. If either statement is false, stop here.

---

## Phase 3: User Story 1 — The owner gives a staff member their own way in (Priority: P1) 🎯 MVP

**Goal**: one person operates the installation without ever holding the deployment secret.

**Independent Test**: create a staff member through the owner-gated roster endpoint, sign in with the
returned credential, and confirm it is accepted on the operations routes and refused on the roster
and installation-settings routes — with no `OWNER_TOKEN` in that person's possession at any point.

- [X] T009 [US1] Add the roster commands to `src/installation-config.ts` — create and rotate — each a single CAS attempt that answers a conflict rather than retrying (depends on T003)
- [X] T010 [US1] Add `GET /api/admin/staff` and `POST /api/admin/staff` to `src/worker.ts` with the `owner-staff` bucket, per [contracts/roster-api.md](./contracts/roster-api.md), returning the credential exactly once and never a digest (depends on T007, T009)
- [X] T011 [US1] Add the `dryRun` branch to `POST /api/admin/staff` in `src/worker.ts`, validating the input and the exact document that would be stored, generating no credential and writing nothing (FR-020)
- [X] T012 [US1] Add `POST /api/admin/staff/:id/rotate` to the `CAPTURE_ROUTES` table in `src/worker.ts` with the `owner-staff-credential` bucket, answering one `404 NOT_FOUND_OR_UNAUTHORIZED` for both an unknown and an inactive member (depends on T010)
- [X] T013 [US1] Flip the six day-to-day buckets in `ROUTE_ROLE` to `staff` — `owner-availability`, `owner-schedule`, `owner-create`, `owner-transition`, `owner-closure-create`, `owner-closure-remove` — leaving the other seven and both roster buckets at `owner` (depends on T007)
- [X] T014 [US1] Add the route-by-route boundary test to `test/` or the worker suite: one assertion per row of [contracts/authorization.md](./contracts/authorization.md), sending each route its **real** method (note `/api/admin/setup` is `GET`/`PUT`, never `POST` — the method check answers `405` before the gate) (SC-004; depends on T013)
- [X] T015 [US1] Add the roster panel and staff sign-in to `public/app.js` and the operator screen markup: credential shown once with a copy affordance, role-aware panel rendering derived from `GET /api/admin/staff`, and a statement that the client-side role is presentation only
- [X] T016 [US1] Add a Playwright case for the roster screen **at the end** of the relevant file in `tests-browser/` — the installation bootstrap test must stay first, because the suite runs `workers: 1` with `fullyParallel: false` — with the accessibility and horizontal-overflow assertions the other specs use, and verify it fails against unfixed code once before trusting it (depends on T015)

**Checkpoint**: a staff credential runs the day and reaches nothing else. This is the MVP.

---

## Phase 4: User Story 2 — A staff member leaves and loses access immediately (Priority: P1)

**Goal**: revocation is individual and takes effect on the next request.

**Independent Test**: create two staff members, deactivate one, and confirm the deactivated
credential is refused on the very next request while the other is unaffected, and that the refusal
survives a restart of the object holding the roster.

- [X] T017 [US2] Add the deactivate and reactivate commands to `src/installation-config.ts`: deactivation clears the credential digest and stamps `deactivatedAt`; reactivation issues a **new** credential because the old digest is gone (depends on T009)
- [X] T018 [US2] Enforce the last-active-owner invariant as a property of the **resulting** document, not of the operation, so it also covers the role changes and removals a later slice adds (FR-011; depends on T017)
- [X] T019 [US2] Add `POST /api/admin/staff/:id/deactivate` and `/reactivate` to `CAPTURE_ROUTES` in `src/worker.ts` with the `owner-staff-credential` bucket, answering the specific `409 LAST_OWNER` for the invariant refusal and warning in the operator screen that reactivation cannot restore the old credential (depends on T012, T018)
- [X] T020 [US2] Add the revocation test to the worker suite: no sleep, retry, or delay anywhere in it — the absence of a wait is the assertion — and confirm the refusal survives a Durable Object reset, using a per-test object name and faking the whole `Date` (SC-001, SC-002; depends on T019)

**Checkpoint**: one person can be removed and nobody else re-enters anything.

---

## Phase 5: User Story 3 — The installation still has a way in when everything else fails (Priority: P1)

**Goal**: no sequence of roster operations can lock everyone out.

**Independent Test**: with a roster whose only owner-role account is deactivated, the `OWNER_TOKEN`
holder is still accepted on every owner-gated route and can reactivate an account.

- [X] T021 [US3] Add the break-glass test to the worker suite: assert the last-owner deactivation is refused with `409 LAST_OWNER`, then write a deliberately corrupt `__staff_roster` document straight into storage and confirm `OWNER_TOKEN` is still accepted on **every one of the fifteen gated paths** (SC-006; depends on T020). The roster's own routes are the exception and answer `503` — an unreadable document is reported as unreadable and repaired at the storage layer, which is the decision recorded in [research R12](./research.md); a parser-bypassing reset command is surface this slice does not add
- [X] T022 [US3] Confirm by reading `operatorGate` that the break-glass path reaches its verdict before `resolveActor` is called, so a corrupt or unreachable roster is invisible to it, and record that ordering in a comment at the call site (depends on T006)

**Checkpoint**: the installation cannot be locked out, and the property is structural rather than procedural.

---

## Phase 6: User Story 5 — A customer books without an account, exactly as before (Priority: P1)

**Goal**: the accountless customer path is untouched. A regression here is a stage failure.

**Independent Test**: the existing customer browser suite passes unchanged, and the public routes
answer identically whether the roster is empty, populated, or entirely absent.

- [X] T023 [US5] Run `npm run check` and `npm run test:browser` against an installation with **no roster** and confirm no existing test needed editing — a test that had to change is a behaviour change FR-026 does not permit, and is investigated rather than updated (SC-003)
- [X] T024 [US5] Add a worker-suite assertion that the public routes answer identically — same status, same body, same headers — with an empty roster and with a populated one (FR-026; depends on T019)

**Checkpoint**: the customer path is provably where it was.

---

## Phase 7: User Story 4 — An operator can tell who did what (Priority: P2)

**Goal**: every operator-initiated reservation state change resolves to exactly one acting identity.

**Independent Test**: perform one transition as each of two staff identities and confirm the recorded
history attributes each to the acting identity, and that the attribution survives that person's later
deactivation.

- [X] T025 [US4] Add the `__attribution` table to `src/reservation-day.ts` — three columns per [data-model.md §2](./data-model.md) — created by `CREATE TABLE IF NOT EXISTS` inside an already-open transaction, in the shape `#ensureAdapterSchema` uses at `src/reservation-day.ts:1145`
- [X] T026 [US4] Thread the actor from `operatorGate` through `src/worker.ts` into the DO inputs for `transitionOwner`, `createClosure`, `removeClosure`, and the owner branch of `#create` — **without adding it to the command fingerprint**, which stays at version 2 (FR-028; depends on T006, T025)
- [X] T027 [US4] Write the attribution row inside the same `transactionSync` that writes the receipt, after the command gate, in all four operator-initiated paths — so a replay short-circuits before the write and never re-attributes (depends on T026)
- [X] T028 [US4] Add the attribution test to the worker suite: three changes by three distinct actors including break-glass, the rows resolving one-to-one; the rows unchanged after the actor is deactivated; and a replayed command writing no second row and not changing the original actor (SC-005; depends on T027)

**Checkpoint**: the history answers "by whom" without anyone trusting a memory of who was on shift.

---

## Phase 8: Polish & Cross-Cutting Concerns

- [X] T029 [P] Add the staff data category to `docs/PRIVACY.md` and the served privacy page: what a staff record contains and deliberately does not, how the credential is protected, the two retention terms — a staff record for the life of the installation, attribution for the life of its day partition — and the structural separation from customer records that satisfies FR-024 (FR-022, SC-007)
- [X] T030 [P] Add the staff retention terms to the operator checklist in `docs/PRIVACY.md`, including FR-012's plain statement that deactivation does **not** reach the calendar feed token, the LINE channel secret, or the Google calendar credentials (FR-023)
- [X] T031 [P] Update the staff-accounts row in `docs/PARITY.md:85` and the S3 row in `docs/ROADMAP.md:42`, and add the revision-log entry
- [X] T032 [P] Confirm no real staff name, credential, or identifier entered the tree — fixtures, tests, and documentation examples — and that `npm run release:audit` still passes (FR-025)
- [X] T033 Run the security battery: `semgrep scan --config=p/security-audit`, a security-focused review iterated to a clean verdict, and an adversarial review of the authorization boundary (depends on Phases 2–7). Semgrep: 30 files, no findings. Defensive review: no critical, high, or medium; its two findings are fixed. Adversarial review, two passes: the first found the rate-limit starvation and four more, the second found that the lane added to fix it was an unthrottled credential oracle — reverted, with R15 recording why the exposure is kept instead. Every finding is fixed or declined with the reason written into [research.md](./research.md) as R12 through R18. A third, confirming pass was started against the finished branch and stalled with no verdict; it was abandoned rather than retried, so what closes "iterated to a clean verdict" is the review on the pull request, against the same tree
- [X] T034 Confirm every `[X]` above has implementation behind it, and that the artifacts still agree with the code (depends on T033). `speckit-verify-tasks` is not installed in this repository — `speckit-analyze` is the cross-artifact check that is, and its procedure is what this task means. Every ticked task was matched to the symbol or file it promised; FR-019 and FR-027, which no task names, were verified directly. The drift it found is fixed: the contract's gate signature, the `Actor` producer in the data model, the roster-api staff sign-in section, `quickstart` Scenario 7's response shape, and this file's own T021 and T034
- [X] T035 Run the correctness review and then, separately, the over-implementation review of the whole diff (depends on T034). The over-implementation pass cut two things and rejected five with reasons. The correctness pass, across nine angles, found the roster failures reusing the reservation error message, a successful command reported as a failure when the refresh after it failed, ~95 test call sites silently passing no actor because `tsconfig` covers `src/` only, table creation before document validation, and the status map falling through to 409 — all fixed
- [X] T036 Run `npm run check` and `npm run test:browser` green, plus the manual keyboard-only and 320 px review the constitution requires for the new operator screen (depends on T035). `npm run check` green at 71 core and 244 worker tests; browser suite green at 37. The manual pass reached and operated every roster control by keyboard alone with a visible focus ring throughout, found no horizontal overflow and no axe violation at 320 px, and produced one fix: the count chip read `0人` beside a visible stopped member, and now reads `有効 0人`

---

## Dependencies & Execution Order

### Phase dependencies

- **Phase 1 (Setup)** → no dependencies
- **Phase 2 (Foundational)** → blocks every user story
- **Phase 3 (US1)** → the MVP; US2 and US4 build on its endpoints
- **Phase 4 (US2)** → depends on US1's roster commands
- **Phase 5 (US3)** → depends on US2's invariant existing to test against
- **Phase 6 (US5)** → runnable any time after Phase 2; run it again at the end
- **Phase 7 (US4)** → depends on Phase 2's actor, independent of US2 and US3
- **Phase 8 (Polish)** → depends on the stories it documents

### Story dependencies

US1 is the only story that must come first. US2 needs US1's create command to have something to
deactivate. US3 needs US2's invariant. US4 needs only the actor from Phase 2 and can be built in
parallel with US2 and US3 by a second pair of hands. US5 is a regression guard and is cheapest to run
continuously.

### Parallel opportunities

- T002, T005, T008 — different files, no ordering between them
- T029, T030, T031, T032 — four independent documentation tasks
- Phase 7 (US4) alongside Phases 4–5, once Phase 2 is complete

---

## Implementation Strategy

### MVP first

Phase 1 → Phase 2 → Phase 3, then **stop and validate**: a staff credential runs the day and reaches
nothing else. That alone is the thing the shared secret structurally could not provide, and it is
worth confirming on a real screen before building further.

### Then, in order of what would hurt most if wrong

Phase 4 (revocation is the property the whole stage exists for) → Phase 5 (prove nobody can be locked
out) → Phase 6 (prove the customer path did not move) → Phase 7 (attribution) → Phase 8.

### Notes

- Commit after each task or logical group; the phases are checkpoints, not commits.
- Do not pipe `npm run check` or `npm run test:browser` into `tail` or `head` — the pipeline reports
  the pager's exit status and a failing run reads as green.
- New browser cases go at the **end** of their file; the installation bootstrap test stays first.
- Every new browser or worker assertion is checked against unfixed code once. An assertion that
  passes before the feature exists is not coverage.
