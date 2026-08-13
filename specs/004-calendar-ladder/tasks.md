# Tasks: Calendar ladder (S2)

**Input**: Design documents from `/specs/004-calendar-ladder/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md),
[data-model.md](data-model.md), [contracts/calendar-api.md](contracts/calendar-api.md)

**Tests**: Required by the S2 roadmap completion criteria and FR-013/FR-014. For each behavior task,
write the focused failing assertion first, verify the intended assertion fails (not an incidental
TypeError), then implement.

**Organization**: Shared transactional/event substrate is foundational. Stories then land in order:
portable ICS feed (MVP), Google outbound, and operator lifecycle/reconciliation.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run independently in a different file after its phase prerequisites
- **[US1–US3]**: User story mapping from `spec.md`
- Every task names its concrete file/evidence target

## Phase 1: Setup and design gates

**Purpose**: Establish authoritative scope and current primary mechanisms before code.

- [x] T001 Run `specify self check` and `specify integration status`, restore constitution 1.0.1, and record the active feature in `.specify/feature.json`
- [x] T002 Read issue #1, `docs/ROADMAP.md`, `docs/PARITY.md`, `docs/ADAPTER-CONTRACTS.md`, RFC 5545, current Google OAuth/Calendar references, and current Cloudflare limits/alarms/secrets documentation into `specs/004-calendar-ladder/research.md`
- [x] T003 Run GitNexus impact analysis before edits; record CRITICAL scope for `isDayConfig`, `installationContext`, and `toDayConfig`, and LOW scope for event emit/handoff in `specs/004-calendar-ladder/plan.md`
- [x] T004 Complete and validate `specs/004-calendar-ladder/spec.md`, `plan.md`, `data-model.md`, `contracts/calendar-api.md`, `quickstart.md`, and the 16/16 requirements checklist with no unresolved clarification

---

## Phase 2: Foundational post-commit calendar substrate

**Purpose**: Extend the released outbox and add the isolated authority without changing observable
booking behavior. This phase blocks all stories.

- [x] T005 Add focused failing migration/two-consumer/create-event/lease/projection/privacy/availability-equality tests in `test/reservation-day.test.ts`
- [x] T006 Extend `DayAdapterDescriptor`, day config validation, additive `__adapter_outbox` columns, calendar-only create events, generic drain/ack/purge, safe `calendarProjection`, and independent handoff in `src/reservation-day.ts`
- [x] T007 Add focused failing pure-contract tests for secret parsing, opaque IDs, RFC 5545 escaping/folding, OAuth token responses, fixed Google URLs/payloads, and HTTP outcome classification in `test/calendar-adapter.test.ts`
- [x] T008 Implement the minimum pure helpers and complete first-release SQLite schema/state model in new `src/calendar-adapter.ts`, reusing Web APIs and shared constants with no provider interface or dependency
- [x] T009 Add `CALENDAR_ADAPTER` binding/export and optional secret types without changing required secrets in `wrangler.jsonc`, `worker-configuration.d.ts`, `vitest.config.ts`, and `.dev.vars.example`; validate with `npm run types`/`types:check`
- [x] T010 Wire a fail-open optional calendar descriptor into `InstallationContext`/`toDayConfig` and export `CalendarAdapter` in `src/worker.ts`, while preserving byte-identical no-calendar public config and zero calendar DO RPC when both secrets are absent
- [x] T011 Run the focused foundation tests plus `npm run typecheck`; verify LINE outbox/delivery tests and all pre-S2 availability/race assertions remain green

**Checkpoint**: Calendar events are committed and recoverable for a second consumer, but no public
feed or Google call is exposed yet.

---

## Phase 3: User Story 1 — Subscribe from common calendars (Priority: P1) 🎯 MVP

**Goal**: An explicitly configured, capability-authenticated ICS feed projects only committed
pending/approved schedule facts and remains absent otherwise.

**Independent Test**: Enable only a fixture feed token, drive create/approve/reschedule/terminal
transitions, parse repeated feeds, and prove one stable UID, correct state/interval, token rotation,
UTF-8 conformance, uniform 404, no forbidden field, and unchanged availability with zero Google call.

### Tests for User Story 1

- [x] T012 [US1] Add failing `CalendarAdapter` projection/dedup/order/retention/overflow and authenticated feed tests in `test/calendar-adapter.test.ts`
- [x] T013 [P] [US1] Add failing Worker route tests for absent/bad/valid/rotated token, exact query, headers, cache prevention, and response privacy in `test/worker.test.ts`

### Implementation for User Story 1

- [x] T014 [US1] Implement calendar event acceptance, projection upsert/removal, bounded sweep/cleanup, aggregate feed-auth diagnostics, and RFC 5545 rendering in `src/calendar-adapter.ts`
- [x] T015 [US1] Implement uniform-404 `GET /api/adapters/calendar/feed.ics` routing and security headers in `src/worker.ts`
- [x] T016 [US1] Run US1 focused tests, parse CRLF/UTF-8 fixtures, and prove no customer/contact/management/resource/reservation identifier appears in feed bytes

**Checkpoint**: ICS works with Google/Apple/Outlook-compatible wire semantics and can ship alone;
Google credentials remain entirely absent.

---

## Phase 4: User Story 2 — Mirror to Google Calendar (Priority: P2)

**Goal**: Optional outbound create/update/delete converges on one opaque Google event with bounded
retry and no booking/availability effect.

**Independent Test**: Enable only fixture Google credentials and exercise create→approve→reschedule→
delete plus duplicate, lost response, insert 409, delete 404/410, timeout, 429, rate-limit 403, 5xx,
permanent 4xx, auth loss, retry exhaustion, stale claim, and newer-desire races against mocked fixed
endpoints.

### Tests for User Story 2

- [x] T017 [US2] Add failing OAuth refresh/cache/rotation/redirect/body-bound/error-schema tests in `test/calendar-adapter.test.ts`
- [x] T018 [US2] Add failing Google desired-state queue/claim/retry/idempotency/convergence/race/retention tests in `test/calendar-adapter.test.ts`
- [x] T019 [P] [US2] Add failing integration assertions that Google outage, retry, and terminal failure leave reservation and availability JSON identical in `test/worker.test.ts`

### Implementation for User Story 2

- [x] T020 [US2] Implement bounded OAuth refresh-token exchange and isolate-memory access-token cache in `src/calendar-adapter.ts`
- [x] T021 [US2] Implement canonical minimal Google event serialization and deterministic update→insert/409→update/delete convergence in `src/calendar-adapter.ts`
- [x] T022 [US2] Implement latest-desired mutation persistence, per-row claims, shared bounded retry ladder, HTTP/reason classification, configuration parking, terminal ledger, and alarm scheduling in `src/calendar-adapter.ts`
- [x] T023 [US2] Run US2 tests and assert no live network, redirect follow, secret/body logging, provider read/import endpoint, or first runtime dependency exists

**Checkpoint**: US1 and US2 work independently and together; neither affects booking availability.

---

## Phase 5: User Story 3 — Configure, rotate, and diagnose safely (Priority: P3)

**Goal**: Owner-only status and bounded reconciliation make independent mode state, gaps, recovery,
and terminal failures actionable without revealing identifiers or credentials.

**Independent Test**: Exercise modes off/feed-only/Google-only/both, secret removal/restoration,
generation/lease disable race, seven-date cursor pages, repeated pages, pending expiry during
reconcile, missing handoff sweep, aggregate diagnostics, and redaction.

### Tests for User Story 3

- [x] T024 [US3] Add failing lifecycle/generation/high-water/deactivation/purge/re-enable/requeue and diagnostics-redaction tests in `test/calendar-adapter.test.ts`
- [x] T025 [US3] Add failing owner status and seven-day cursor reconciliation contract/auth/origin/rate/input/idempotency tests in `test/worker.test.ts`
- [x] T026 [P] [US3] Add browser/API checks for owner calendar status/reconciliation and zero calendar customer DOM/network trace in `tests-browser/owner.spec.ts`

### Implementation for User Story 3

- [x] T027 [US3] Complete mode-transition, descriptor lease, consumer purge, configuration fingerprint/requeue, reconciliation status, and quiescent-alarm lifecycle in `src/calendar-adapter.ts`
- [x] T028 [US3] Implement redacted `GET /api/admin/calendar/status` and bounded `POST /api/admin/calendar/reconcile` using authoritative day config/projection in `src/worker.ts`
- [x] T029 [US3] Run US3 focused and browser tests; prove invalid/removed credentials stop new calls and owner responses contain no token, calendar ID, reservation ID, external ID, provider body, or authorization header

**Checkpoint**: All three stories and every calendar contract dimension are independently operable.

---

## Phase 6: Documentation, security, review, and release evidence

**Purpose**: Complete the standing S2 gates before any status claim.

- [x] T030 [P] Write exact optional setup, OAuth provisioning, token generation/rotation, safe target-calendar change, recovery, optional live smoke, and no-deploy-for-development guidance in new `docs/CALENDAR-SETUP.md`
- [x] T031 [P] Update exact schedule-field/privacy/capability-URL/provider disclosures in `docs/PRIVACY.md` and `public/privacy.html`, keeping calendar customer disclosure visible through active and residual-cleanup states and absent after disabled-and-purged in `src/worker.ts`
- [x] T032 [P] Update optional secret/binding, Free-plan budget, alarm/backout/release procedures in `docs/CLOUDFLARE.md` and `docs/RELEASING.md`
- [x] T033 Register sorted new public files and required evidence in `release/public-files.txt` and `scripts/release-audit.mjs`; run secret/email/license/install-script scans
- [x] T034 Run focused tests, full `npm run check`, and `npm run test:browser`; separate any environment blocker from code regression and record commands/results in `specs/004-calendar-ladder/verify-tasks-report.md`
- [x] T035 Run rule-based security analysis plus adversarial review for feed auth, credentials, fixed URLs, input/output bounds, retry/claim races, retention, redaction, and abuse; record accepted/rejected findings in `specs/004-calendar-ladder/security-scan.md`
- [x] T036 Run normal correctness review, then mandatory `ponytail-review`; remove any one-use abstraction, duplicate helper, unused config, speculative provider surface, or unnecessary dependency before rerunning focused checks
- [x] T037 Run GitNexus `detect_changes({scope:"compare",base_ref:"main"})`, inspect all changed execution flows, run `git diff --check`, review the complete diff, and verify no unrelated/user-owned files changed
- [x] T038 Only after T034–T037 pass, update `docs/PARITY.md` calendar evidence/status and `docs/ROADMAP.md` S2 status/revision line; keep inbound availability deliberately excluded
- [x] T039 Run `speckit-verify-tasks` once if available; otherwise manually prove every `[x]` in this file has implementation/evidence in `specs/004-calendar-ladder/verify-tasks-report.md`, with no false completion

---

## Dependencies & Execution Order

### Phase dependencies

- Phase 1 is complete and authoritative.
- Phase 2 blocks all stories because every story uses the shared committed projection.
- US1 can complete immediately after Phase 2 and is the smallest useful MVP.
- US2 depends on the projection/authority but not on ICS activation; its tests run Google-only.
- US3 depends on US1/US2 state existing so diagnostics/reconciliation can prove both modes.
- Phase 6 and status flips depend on all desired stories and all standing gates.

### Story dependency graph

```text
Foundational outbox + authority
├── US1 authenticated ICS (MVP)
└── US2 Google outbound
     └── US3 shared lifecycle/diagnostics/reconciliation
          └── security + reviews + full verification + status evidence
```

### Parallel opportunities

- After T006/T008 stabilize contracts, Worker route tests (T013/T019) can be written separately
  from authority tests, but implementation edits to `src/calendar-adapter.ts` remain sequential.
- Documentation T030–T032 touches separate files and can be done independently after behavior locks.
- No parallel implementation edits to `src/reservation-day.ts`, `src/calendar-adapter.ts`, or
  `src/worker.ts`; they are shared trust boundaries.

## Parallel example: US1

```text
Task T012: authority/feed contract tests in test/calendar-adapter.test.ts
Task T013: route/auth/header tests in test/worker.test.ts
```

After both fail for the intended assertion, implement T014 then T015 and run T016.

## Implementation Strategy

### MVP first

1. Finish Phase 2 with no externally reachable route.
2. Ship US1's authenticated ICS feed and validate it independently.
3. Add Google outbound without changing the feed or provider-free path.
4. Add shared owner lifecycle/reconciliation.
5. Run every standing gate, then and only then change roadmap/parity status.

### Deliberate omissions

- no deployment or temporary Cloudflare/Google account;
- no inbound free/busy/list/sync/watch/import;
- no Queue, cron trigger, second Worker, provider registry/factory, or runtime npm dependency;
- no customer calendar UI, contact data, resource ID, attendee, description, or management URL;
- no target-calendar migration automation without the old credential—document safe cleanup instead.

## Notes

- `[P]` marks file-isolated work, not permission to edit shared files concurrently.
- The CRITICAL GitNexus symbols require their full affected reservation/race/browser suites.
- The current task is not complete at local feature tests: full check, browser, security, correctness,
  Ponytail, impact/diff, task verification, and status evidence all remain mandatory.
