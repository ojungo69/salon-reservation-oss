# Research: Current Customer-Flow Inventory (Phase 0)

**Date**: 2026-08-11 | **Method**: direct read of `public/index.html`, `public/journey.js`, `public/app.js` (structure + key paths), `src/worker.ts` routes, `docs/PARITY.md`; issue #11 checklists cross-referenced item by item.

## Decision log

- **D1 — Delta, not rebuild**: The OSS customer flow already implements a three-step journey shell: `journey-progress` indicator with `aria-current`, one visible stage at a time (`data-journey-stage` selection/details/review), back/next controls gated by validators (`getJourneyStep`), a live announcer, draft persistence with settings-version-aware restore (`restoreJourneyDraft`), Turnstile in the review stage, and a success surface with management-key copy, remember-toggle and a management link. Issue #11 was written against an older mental model; the plan targets the residual gaps only.
- **D2 — Residual gaps** (issue checklist → status):
  - Booking-summary card on the *details* step (currently the summary `dl` exists only in review) — **gap**.
  - Dedicated final-confirmation presentation (review stage exists; presentation/isolation of the primary CTA can be strengthened) — **partial gap, small**.
  - Scalable service selection (search/filter + selected chips + running totals near the selection; current UI is a flat checkbox list capped at 4 selections, catalog capped at 16) — **gap**.
  - Slot refresh/retry affordance (availability reloads only on input change; sequence guard exists at `app.js` availability loader) — **gap, small**.
  - Operator availability notice on the booking step — **gap; requires an optional bounded-text settings field** (installation config + setup screen + public config exposure).
  - Duplicate-booking warning driven by the backend — **gap; requires one read-only backend signal** (see D4).
  - Resource auto-selection: single eligible resource already auto-selects (`app.js` ~line 580); an operator-controlled "expose resource choice" toggle does not exist — **gap, small config flag**.
  - Success-state "next expected action" copy and notification-channel conditionality — **partial gap, copy-level** (no channel exists yet; text must simply not promise one).
  - Management-key one-click copy — **already present**; add the one-sentence explanation polish only.
  - Customer management entry point — **already present** (site nav + success surface + bookings.html).
  - Location selector, identity-adapter surface — **correctly absent**; ship absence tests + documented insertion points only (constitution I–II, issue #1 sequencing).
- **D3 — Files that carry the change**: `public/index.html`, `public/app.js` (mostly `startCustomer`), `public/styles.css`, `public/bookings.html` (entry-point copy), `src/installation-config.ts` (+ setup surface in `public/setup.html`/`startSetup`) for the notice text and resource-choice flag, `src/worker.ts` for config exposure and the duplicate signal, `tests-browser/*` and `test/journey.test.ts` for evidence, `docs/UX-PARITY.md` for the matrix.
- **D4 — Duplicate-signal design (privacy-first)**: matching by free-text contact would create a contact-enumeration oracle. Instead the check is proof-bound: the browser already stores owned-booking records (reservationId + management key) for up to a year (`journey.js`). Before submission, the client asks the backend which of its *remembered same-day reservations* are still active, and warns on a non-empty answer. No schema change, no new write path, no way to probe other people's contacts. Cross-device duplicates are out of scope and recorded as such in the parity matrix (an identity adapter is the future cross-device answer, per issue #1).
- **D5 — Catalog cap stays**: the 16-service catalog cap is a validated installation bound; raising it is a separate capacity decision. The new selection surface must handle the current cap gracefully and scale visually beyond it, so a future cap raise is UI-free.
- **D6 — Threshold for the compact surface**: below/at 8 services the current flat list renders unchanged (simplicity parity, spec US2 scenario 3); above 8 the search/filter + chips surface activates. 8 chosen so both branches are exercisable under the current cap (16) by test fixtures.

## Risks

- `startCustomer` is a long closure (~600 lines); the changes concentrate there. Mitigation: extend the existing pure-function seam (`journey.js`) for new state logic so it stays unit-testable, keep DOM wiring in `app.js`.
- Browser-suite slot budget: new specs must not consume slots existing specs rely on (same constraint as issue #27; coordinate after #27 merges).
- The notice/resource-flag config additions touch the versioned settings surface; they must ride the existing settings-version mechanics so drafts reset correctly (already handled by `restoreJourneyDraft`).
