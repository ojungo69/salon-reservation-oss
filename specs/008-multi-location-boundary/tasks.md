# Tasks: Multi-location boundary

**Input**: `spec.md`, `plan.md`, `research.md`, `data-model.md`, `contracts/`, `design/`.
**Tests**: Regression-first for non-trivial public/security contracts; use fictional local fixtures. All implementation tasks remain unchecked until executed and verified.
**Ownership**: C = config/location writer; H = HTTP/adapter writer; U = UI/browser writer; I = coordinator/integration. These labels describe ownership in prose; `[P]` means disjoint files after stated prerequisites. One writer per file/worktree.

## Phase 1: Setup

- [X] T001 I: confirm the private evidence gate and accepted decision/selected images in `docs/PORTING.md`, `docs/ADR-0003-MULTI-LOCATION-BOUNDARY.md` and `specs/008-multi-location-boundary/design/selection.md`; do not start migration or runtime work before this gate.

## Phase 2: Foundation

- [X] T002 C: add failing canonical-name/default-byte/nameless-actor cases in `test/location.test.ts`, then implement `src/location.ts` exactly as `contracts/location-rpc.md`: four locations, `[a-z][a-z0-9-]{0,31}` without trailing hyphen, exact legacy-ID fallback only.
- [ ] T003 H: preserve exact pre-S4 default config/day/receipt/notification fixtures in `test/worker.test.ts`, `test/reservation-day.test.ts`, `test/adapter-delivery.test.ts` and `test/calendar-adapter.test.ts` before routing changes; no schema rewrite or response-field additions.

## Phase 3: US1 — Configure another salon (P1)

**Independent test**: three additions beside default, independent settings/live, exact replay, fifth/duplicate/concurrent-last-slot refusal.

- [X] T004 [US1] C: retain the existing pure settings fixtures and add failing location creation/settings/CAS/read-without-initialization cases at the real RPC boundary in `test/location-config.test.ts`.
- [X] T005 [US1] C: implement lazy `__location_states`, stable creation receipts and optional trailing location arguments in `src/installation-config.ts`; reuse InstallationState/reducer, 1–80-code-point labels, at most three named rows, new demo/off state.
- [ ] T006 [US1] H: implement public/authenticated directory and owner creation plus scoped config/setup/live/receipt routes in `src/worker.ts`; `{id,label,bookable}` is hostname/readiness-aware and includes paused locations; exact `LOCATION_NOT_FOUND` RPC propagation maps to 404.
- [ ] T007 [P] [US1] U: implement location creation/list/selection and independent existing setup form in `public/setup.html`, `public/app.js` and `public/styles.css` using `design/operator-reference.png`.
- [ ] T008 [US1] U: verify rendered creation, maximum/duplicate/conflict, settings and readiness isolation in `tests-browser/multi-location.spec.ts` against the integrated backend, retaining the existing installation suite.

## Phase 4: US2 — Book and manage the correct salon (P1)

**Independent test**: same local IDs/time across locations, two fifty-way races, failed-create exact rollback/retry, each proof scoped to its owner.

- [ ] T009 [US2] H: add failing location/day races, unknown-address refusal, exact failure/retry/replay and purge-isolation cases in `test/worker.test.ts` and `test/reservation-day.test.ts`.
- [ ] T010 [US2] H: thread canonical request-local location through existing strict routes/day calls in `src/worker.ts`, retaining old bodies/responses/rate buckets and binding named Siteverify idempotency to location; use shared names in `src/reservation-day.ts` handoff without new persisted day fields.
- [ ] T011 [P] [US2] U: implement directory-first selection, named-only-live URL preservation, explicit-unknown refusal, legacy pending precedence and suffixed storage keys in `public/app.js` and shared `public/location.js`; retain old default v1 record shapes from `public/journey.js`.
- [ ] T012 [US2] U: label/location-bind review/result/proof cards and internal legal/navigation links in `public/index.html`, `public/bookings.html`, `public/privacy.html`, `public/terms.html`, `public/cancellation.html` and `public/app.js`; known-key aggregate is at most four keys and 16 status checks per page, never current-scope proof fallback.
- [ ] T013 [US2] U: add real booking/return/cancel/uncertain-result/paused-proof/unknown-link/keyboard/width cases in `tests-browser/multi-location.spec.ts` and the existing `tests-browser/customer.spec.ts` selection/keyboard suite; preserve default tests; update `tests-browser/harness.ts` forwarding to retain named query scope.

## Phase 5: US3 — Limit staff to assigned salons (P1)

**Independent test**: B-only credential discovers/operates B, cannot access A, loses B on next request/restart; old responses never repaint private data.

- [X] T014 [US3] C: retain exact legacy `test/staff-roster.test.ts` fixtures and add failing legacy default-only, explicit empty, 0–4 distinct-known-ID, stale version, current-owner recheck and atomic scoped-create cases at the root RPC boundary in `test/location-config.test.ts`.
- [X] T015 [US3] C: implement lazy `__staff_location_scopes`, scope projection/CAS and atomic optional initial grants in `src/installation-config.ts`; owner stays global, old roster JSON/resolveActor return bodies stay exact, omitted resolveActor location means global authentication.
- [ ] T016 [US3] H: implement new scope projection/update routes and total route-to-role/location authorization in `src/worker.ts`; global directory works for B-only staff, wrong-role/location matches invalid credential 401.
- [ ] T017 [P] [US3] U: add staff scope controls and authenticated scoped operator selector in `public/setup.html`, `public/admin.html`, `public/app.js`; preserve memory-only credentials and invalidate credential/location/request generations for all private responses.
- [ ] T018 [US3] H: expand the complete endpoint matrix, slow-body/revocation, malformed/duplicate query, unknown-scope and PII non-disclosure tests in `test/worker.test.ts`; explicitly preserve S3 in-flight reservation semantics.
- [ ] T019 [US3] U: prove B-only sign-in, grant removal, empty grants, wrong explicit scope, late old-location responses and proxy/closure pending recovery in `tests-browser/multi-location.spec.ts`, retaining existing `tests-browser/install.spec.ts` and `tests-browser/owner.spec.ts` coverage.

## Phase 6: US4 — Enable optional integrations per salon (P2)

**Independent test**: two local fixture actors, local consent, shared webhook retry, separate feed/target, one disabled while other operates, restart-safe earliest work.

- [ ] T020 [US4] H: add failing actor/day/nonce/watermark/dedup/unlink/claim isolation and default-v1/named-v2 byte-stability cases in `test/adapter-delivery.test.ts` and `test/line-adapter.test.ts`.
- [X] T021 [US4] C: generalize root LINE lifecycle RPC/storage and shared-realm target projection in `src/installation-config.ts`; keep default lifecycle JSON, lazy named rows, one bounded earliest-due alarm driver; test simultaneous sagas, stalled actor and restart and concurrent different-realm enabling in `test/location-config.test.ts`.
- [ ] T022 [US4] H: scope complete LINE actors and all alarm/sequence/sweep accesses in `src/adapter-delivery.ts`; store a bounded public location label in named v2 payload and keep local synchronous consent/claim checks in `src/line-adapter.ts`.
- [ ] T023 [US4] H: implement global signature-verified bounded webhook fanout and scoped LINE proof/lifecycle/assets/return routing in `src/worker.ts`; partial failure is retryable, default may be disabled, public location never chooses webhook targets.
- [ ] T024 [P] [US4] U: preserve scope and default compatibility in `public/line-link.mjs`, `public/line-liff.mjs`, `public/line.html` and `public/app.js`, including scoped module gates, intent keys and fixed same-origin returns; retain unsupported liff.state refusal.
- [X] T025 [US4] C: retain existing pure settings fixtures and add failing named-calendar version/digest-only/immutable-unique-target/enable-readiness cases at the root RPC boundary in `test/location-config.test.ts`.
- [X] T026 [US4] C: implement root named calendar context/settings/digest RPCs in `src/installation-config.ts`: virtual version0/off, target null then immutable, feed requires digest, no plaintext secrets and no default env mutation.
- [ ] T027 [US4] H: scope calendar actor IDs/day access/feed/reconcile/provider IDs in `src/calendar-adapter.ts`, reuse existing OAuth credential set with named immutable target, fail/rearm on unavailable configuration or required shared credentials, and preserve 60-second timing; add reversed config-response/version/activation-epoch fences, wrong-target/token/retry/retention tests in `test/calendar-adapter.test.ts`.
- [ ] T028 [US4] H: implement named owner calendar settings/token routes and redacted status in `src/worker.ts`; generate token once/store digest, no OAuth callback, verify role/origin/rate/versions in `test/worker.test.ts`.
- [ ] T029 [P] [US4] U: implement the small named-only calendar settings/enable/token panel in `public/setup.html`, `public/app.js`, `public/styles.css` against `design/calendar-reference.png`; default remains env-managed, tokens stay memory-only.
- [ ] T030 [US4] U/H: prove scoped LINE login/intent/abandon with real local state in `tests-browser/multi-location.spec.ts`, preserving `tests-browser/line.spec.ts`; compose this with native verified-token/finalization/unlink fixtures in `test/line-adapter.test.ts`. Prove owner calendar setup/token/version/error flows in `tests-browser/multi-location-calendar.spec.ts`; use provider fixtures and disclose the absence of live-provider verification.
- [ ] T031 [US4] H: verify actual alarm name/restart, earliest root saga wake-up, full supported per-day outbox backlog with bounded more/pending continuation, lost handoff, configuration outage, retry/claim/disable/retention and cross-location purge boundaries in `test/adapter-delivery.test.ts`, `test/calendar-adapter.test.ts` and `test/reservation-day.test.ts`; do not change sweep cadence in S4.

## Phase 7: Integration and evidence

- [ ] T032 I: record measured fixture request/write counts and conditional empty/full-backlog scenarios in `specs/008-multi-location-boundary/verification.md`; retain 60-second cadence and explicitly withdraw universal multi-location Free-plan-fit claims.
- [ ] T033 I: update actual delivered boundaries and operator/privacy/backout instructions in `docs/PARITY.md`, `docs/PORTING.md`, `docs/ROADMAP.md`, `docs/ADAPTER-CONTRACTS.md`, `docs/CLOUDFLARE.md`, `docs/LINE-SETUP.md`, `docs/CALENDAR-SETUP.md`, `docs/PRIVACY.md`, `docs/UX-PARITY.md`, `docs/RELEASING.md` and `CHANGELOG.md` only after evidence; S5 stays Not started.
- [ ] T034 I: register actual new source/tests and ADR in `release/public-files.txt`, required release metadata in `scripts/release-audit.mjs`/`test/release-metadata.test.ts`, test invocation in `package.json` if needed and generated types in `worker-configuration.d.ts`; do not add new namespace/binding/dependency.
- [ ] T035 I: run full `npm run check` and the real combined backend/browser suite; record commands/results in `specs/008-multi-location-boundary/verification.md`, compare screenshots to `design/`, include keyboard/dark/reduced-motion/forced-color evidence and no secrets.
- [ ] T036 I: obtain correctness and separate over-implementation reviews plus static security/adversarial scope/privacy/race review; resolve valid findings and rerun affected checks, recording evidence in `specs/008-multi-location-boundary/verification.md`.
- [ ] T037 I: invoke task verification once after implementation and record `specs/008-multi-location-boundary/verify-tasks-report.md`; check off only tasks with actual evidence and preserve separate migration confirmation boundary.

## Dependencies and parallel work

T001 precedes runtime work. T002 establishes names; C registers the new runtime `test/location-config.test.ts` in `vitest.config.ts` and actual new source/tests in the release manifest; config commits T005/T015/T021/T026 unblock combined H execution. US2/US3 depend on US1 location existence; US4 uses the same locations but its provider tests remain independent of browser UI. U can implement selected-image markup and pure controller changes after contracts, but only combined real-backend tests complete a story.

Within each writer keep one focused failing behavior then implementation then verification; never parallel-edit its files. After T002, C can implement US1/US3 persistence while H prepares route/adapter tests and U works on disjoint public/browser files. Example US2: H T009/T010 and U T011/T012 can proceed in separate worktrees; join before T013. Example US3: C T014/T015 and U T017 may overlap, then H T016/T018 and U T019 prove integration. Example US4: C T021/T025/T026, H T020/T022/T027 and U T024/T029 prepare separately, then join before T030/T031.

US1+US2+US3 form the usable accountless multi-location increment; S4 completion additionally includes US4 and all standing gates. No milestone authorizes live provider/deploy/data operations. Idle-sweep optimization is a later measured task, not an implementation task in this feature.
