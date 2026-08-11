# Tasks: Customer UI/UX Production Parity

**Input**: Design documents from `/specs/001-customer-ux-parity/` (spec.md, plan.md, research.md)

**Tests**: Included — constitution III (accessibility regression-protected) and the quality gates make evidence mandatory for every surface this feature touches.

**Organization**: Foundational settings first (they carry US1/US3/US5 surfaces), then user stories in priority order. Each phase lands as an independently green commit on `feat/customer-ux-parity`.

## Format: `[ID] [P?] [Story] Description`

---

## Phase 1: Foundational — versioned settings pair (blocks US1 display, US3 notice)

**Purpose**: `availabilityNotice` + `exposeResourceChoice` end to end (validation → public config → setup screen), riding the existing settings-version mechanics so drafts reset correctly.

- [ ] T001 Add `availabilityNotice` (optional string, trimmed, 1–200 chars, plain text) and `exposeResourceChoice` (boolean, default true) to the settings shape, validation, defaults and OPTIONAL_SETTINGS_KEYS in `src/installation-config.ts`
- [ ] T002 Expose both fields in the public `/api/config` projection and the owner setup projection in `src/worker.ts`
- [ ] T003 Add the notice textarea and the resource-choice checkbox to the setup screen: markup in `public/setup.html`, load/save wiring in `startSetup` in `public/app.js`
- [ ] T004 Worker tests in `test/worker.test.ts`: notice bounds (empty/1/200/201 chars, whitespace trim), flag default and round-trip, both fields visible in public config, settings-version bump on change

**Checkpoint**: `npm run check` green; setup screen edits and persists both fields.

---

## Phase 2: US1 (P1) — booking summary card + confirmation presentation 🎯 MVP

**Goal**: The details step shows an editable summary of every choice; the review step reads as a dedicated confirmation with an isolated primary action; the resource assignment is always visible on summary/review, and the resource select hides when `exposeResourceChoice` is false (best eligible resource auto-assigned, shown read-only).

**Independent Test**: Rendered browser test walks selection → details → review at 320/360/768/1440 px, edits from the card, and sees the change reflected.

- [ ] T005 [US1] Summary derivation as pure functions in `public/journey.js` (selection/service labels, duration and price totals from server-derived values, resource label, date/slot) with unit tests in `test/journey.test.ts`
- [ ] T006 [US1] Details-step summary card markup with per-field edit links and review-step confirmation panel markup in `public/index.html`
- [ ] T007 [US1] Wire the card in `startCustomer` in `public/app.js`: render from journey state, edit links jump to the owning step, review panel isolation, `exposeResourceChoice=false` hides the select and shows the auto-assigned resource
- [ ] T008 [US1] Card, confirmation panel and CTA styles in `public/styles.css` (all themes, forced-colors, reduced-motion)
- [ ] T009 [US1] Browser tests in `tests-browser/customer.spec.ts`: card contents match choices, edit-link jump round-trip, confirmation panel present, resource line visible, axe + overflow at the four viewports

**Checkpoint**: US1 demoable on its own; suite green.

---

## Phase 3: US2 (P2) — scalable service selection

**Goal**: At ≤8 services today's flat list renders unchanged; above 8 a filter input + checkbox list + selected chips + running duration/price total activates, fully keyboard/SR operable.

**Independent Test**: Unit tests for the filter state; browser test against a >8-service fixture catalog drives filter + chips by keyboard.

- [ ] T010 [P] [US2] Filter/selection state as pure functions in `public/journey.js` (query filtering, chip add/remove, running totals, 4-selection cap unchanged) with unit tests in `test/journey.test.ts`
- [ ] T011 [US2] Compact-surface markup (filter input, chip list, totals line) in `public/index.html` and threshold switch (>8) + wiring in `startCustomer` in `public/app.js`
- [ ] T012 [US2] Chips, filter and totals styles in `public/styles.css`
- [ ] T013 [US2] Browser test with a >8 fixture catalog in `tests-browser/` (new spec or `customer.spec.ts`): keyboard-only filter→select→chip-remove path, totals update, ≤8 path byte-identical assertion, axe

**Checkpoint**: Both branches (≤8 / >8) exercised under the current cap of 16.

---

## Phase 4: US3 (P2) — freshness, notice, duplicate recovery

**Goal**: Slots can be refreshed in place; the operator notice shows near availability; a pre-submit duplicate check against *this browser's remembered same-day bookings* (existing `POST /api/reservations/:id/status`, ≤3 lookups) warns and requires acknowledgement; capacity/stale-slot copy reads correctly inside the shell.

**Independent Test**: Browser test creates + remembers a booking, starts a second same-day journey, sees the warning, acknowledges, and completes.

- [ ] T014 [P] [US3] Duplicate-check candidate selection (same-day remembered records, cap 3) and acknowledgement state as pure functions in `public/journey.js` with unit tests in `test/journey.test.ts`
- [ ] T015 [US3] Slot-refresh button reusing the sequenced availability loader + `availabilityNotice` rendering near availability in `public/index.html` / `startCustomer` in `public/app.js` / `public/styles.css`
- [ ] T016 [US3] Pre-submit duplicate check wiring in `startCustomer`: status lookups, warning dialog with acknowledgement gate, uniform failure handling (lookup errors never block booking)
- [ ] T017 [US3] Browser tests in `tests-browser/customer.spec.ts`: refresh re-renders slots, notice visible when configured and absent otherwise, duplicate warn→ack→complete path, CAPACITY_REACHED and stale-slot copy assertions

**Checkpoint**: Duplicate path proves privacy posture (no lookups without stored proofs).

---

## Phase 5: US4 + US5 (P3) — key comfort and adapter-slot absence

- [ ] T018 [P] [US4] One-sentence management-key explanation on the success surface in `public/index.html` and entry copy check in `public/bookings.html`
- [ ] T019 [P] [US5] Document the three adapter insertion points (location, identity, notification) in `docs/UX-PARITY.md`
- [ ] T020 [US5] Absence tests in `tests-browser/customer.spec.ts`: no location selector, no identity UI, no notification-channel promises in default config

---

## Phase 6: Matrix + closure

- [ ] T021 Fill the user-task parity matrix (parity / exceeds / deferred-with-reason per task) in `docs/UX-PARITY.md`, including cross-device duplicates as deferred (research D4)
- [ ] T022 Update the acceptance rows this feature touches in `docs/PARITY.md`
- [ ] T023 Full verification: `npm run check`, `npm run test:browser`, manual keyboard + 320px pass over the three changed screens; record results in the PR body

---

## Dependencies & Execution Order

- Phase 1 blocks T007 (flag display) and T015 (notice display); everything else in US1–US5 is independent of it in code but lands after it to keep each commit green.
- US phases run in priority order (P1 → P2 → P3); T005/T010/T014/T018/T019 are parallel-safe ([P]) as disjoint files or pure additions.
- T021–T023 close the feature and precede the PR.
