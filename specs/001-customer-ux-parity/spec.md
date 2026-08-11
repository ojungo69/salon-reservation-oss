# Feature Specification: Customer UI/UX Production Parity

**Feature Branch**: `feat/customer-ux-parity`

**Created**: 2026-08-11

**Status**: Draft

**Input**: GitHub issue #11 "[P1] Bring customer-facing UI/UX to production parity or better", constrained by issue #1's recorded design decision (2026-08-11) and `docs/PARITY.md` exclusions.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Book through a three-step shell (Priority: P1)

A customer opens the booking page and moves through a compact, clearly signposted three-step flow — booking (service, date, time, resource), identity (contact details), confirmation (a dedicated final review surface) — instead of one long page of stacked sections. Before entering contact details they see an editable summary card of what they chose, so they never navigate backward just to double-check the menu or date. Submission ends in a distinct success state that says what happens next.

**Why this priority**: This is the core journey every customer takes; the production flow's main UX advantage is this progressive shell. Every other story hangs off it.

**Independent Test**: Complete one booking end to end in a rendered browser at 320 px and 1440 px, keyboard-only, and verify each step transition, the summary card's edit affordance, the dedicated confirmation panel, and the success state.

**Acceptance Scenarios**:

1. **Given** a configured installation, **When** a customer selects services, date, time and resource, **Then** the shell advances to the identity step showing a booking-summary card (services, total duration, displayed price, date/time) with a way to go back and edit any part of it.
2. **Given** a completed identity step, **When** the customer proceeds, **Then** a dedicated confirmation panel presents the complete booking for final review before any request is submitted.
3. **Given** a submitted booking, **When** acceptance succeeds, **Then** the success surface shows the booking state (e.g. awaiting approval), the next expected action, and a clear path to manage the reservation.
4. **Given** any step, **When** viewed at 320, 360, 768 or 1440 px, **Then** there is no horizontal overflow, exactly one primary call-to-action is visible for the step, and step headings remain visible.

---

### User Story 2 - Choose services at scale (Priority: P2)

A customer at an installation with many services picks them from a compact, searchable/selectable surface instead of an always-expanded list. Selected services appear as removable chips with a running total of duration and displayed price, updating immediately on every change.

**Why this priority**: The always-expanded list stops scaling past ~16 services; totals-at-a-glance is a production behavior customers rely on. Depends on the P1 shell for placement.

**Independent Test**: With a catalog large enough to overflow the simple list, select and deselect services by pointer, keyboard and screen reader; verify chips, totals and the compatibility rules match the server's authoritative computation.

**Acceptance Scenarios**:

1. **Given** a large service catalog, **When** the customer filters/searches it, **Then** matching services can be selected without losing existing selections, entirely by keyboard.
2. **Given** selected services, **When** any selection changes, **Then** chips and the server-derived duration/price totals update immediately and are announced to assistive technology.
3. **Given** a small catalog (at or below the threshold where the compact surface adds nothing), **When** the page renders, **Then** the selection surface stays as simple as today's list.

---

### User Story 3 - Recover from staleness, capacity and duplicates (Priority: P2)

A customer whose chosen slot went stale, whose day filled up, or who already holds a booking for the same day sees an explicit, provider-neutral explanation and a recovery action — refresh the slots, pick another time, or acknowledge a duplicate-booking warning before proceeding where policy allows it.

**Why this priority**: Production parity is mostly about failure UX; the happy path already works today. Requires the P1 shell for where these surfaces live.

**Independent Test**: Drive each failure (stale slot, capacity reached, duplicate booking) in a rendered browser via the test harness and verify the explanation, the recovery affordance, and the outcome after recovery.

**Acceptance Scenarios**:

1. **Given** displayed availability that has gone stale, **When** the customer attempts to book the stale slot, **Then** the refusal explains the situation and offers a one-action slot refresh that re-renders current availability without restarting the flow.
2. **Given** an installation-configured notice (e.g. a temporary schedule note), **When** the booking step renders, **Then** the notice is visible near the availability it affects.
3. **Given** the customer already has an active booking on the selected day (as reported by the backend), **When** they attempt another one, **Then** a warning names the conflict and requires explicit acknowledgement before the request is submitted, without blocking legitimate re-booking after cancellation.
4. **Given** a day whose acceptance budget is spent, **When** the customer reaches that day, **Then** the message distinguishes "no free slots" from "no further bookings accepted today" (behavior introduced in #28) inside the new shell.

---

### User Story 4 - Keep and use the management key comfortably (Priority: P3)

After booking, a customer without any external account keeps their portable management key with one-click copy/save plus a short plain-language explanation of what it is, and reaches the reservation-management page through a clearly labeled entry point instead of memorizing a URL.

**Why this priority**: The accountless fallback is an OSS strength to preserve; this story reduces its cognitive load without changing its security model.

**Independent Test**: Complete a booking, use the copy affordance, follow the management entry point, cancel the booking with the remembered proof, and verify the states after reload.

**Acceptance Scenarios**:

1. **Given** a successful booking with a management key, **When** the success surface renders, **Then** the key can be copied in one action, is explained in one short sentence, and the portable fallback (raw key) remains available.
2. **Given** any public page, **When** a customer looks for their reservation, **Then** a direct customer reservation-management entry point is reachable and works with the remembered proof or the raw key.

---

### User Story 5 - Adapter-ready surfaces stay invisible until configured (Priority: P3)

An operator running the default single-location, no-provider installation sees exactly today's simplicity: no location selector, no external-login surface, no notification-channel messaging. The new shell reserves the places where a location choice, an identity adapter's login/friendship state, and a notification expectation will appear once such capabilities are configured — but renders none of them until then.

**Why this priority**: Constitution principles I–II make invisibility of unconfigured adapters non-negotiable; building the slots now prevents rework when issue #1's contracts land. No adapter itself is in scope.

**Independent Test**: Render every customer page in the default configuration and assert the absence of any location/identity/notification UI; assert the success surface mentions a notification channel only when one is configured (none exists in this feature's scope).

**Acceptance Scenarios**:

1. **Given** a single-location, no-provider installation, **When** any customer page renders, **Then** no location, login, friendship or notification-channel control or text appears, and the flow has no extra mandatory step compared to the pre-change flow.
2. **Given** the delivered code, **When** issue #1 later introduces adapter contracts, **Then** the shell's reserved surfaces (documented in the parity matrix) are the designated insertion points — verified in this feature only as documentation plus "renders nothing when unconfigured" tests.

---

### Edge Cases

- Configuration version changes mid-journey (settings or consent version): the flow surfaces the conflict and restarts safely with fresh data rather than submitting against stale versions.
- Turnstile (anti-automation) failure at submission: the failure and retry remain visible within the shell (existing bounded-retry behavior preserved).
- Capacity or slot loss occurring between confirmation display and submission: refusal maps to the recovery UX of User Story 3.
- Reload in the middle of any step: no invented state — the flow resumes or restarts coherently, and completed bookings remain reachable via the management path.
- Reduced motion, forced colors, high-contrast, and screen-reader step announcements keep working across the new shell (constitution III).
- Very long service names / large prices at 320 px: chips and totals wrap without horizontal overflow.

## Clarifications

### Session 2026-08-11 (resolved from the user's recorded decisions; no live Q&A)

- Q: Does "optional location selection" require a multi-location backend? → A: No. `docs/PARITY.md` excludes multiple locations for v0.x ("design a new partition/transaction model before adding"), and issue #1's decision comment sequences that work later. FR-010 therefore specifies a control that never renders under the current single-location model; only the slot and its absence-test ship now.
- Q: Does the identity-adapter surface include any LINE functionality? → A: No. Issue #1's decision comment: extension contracts precede any concrete adapter, and #11 precedes adapter work entirely. User Story 5 ships documented, test-asserted absence; LIFF/LINE work stays in #1.
- Q: May this feature touch the backend at all ("duplicate-booking warning driven by the backend")? → A: Minimally. FR-006/FR-015 bound it to one provider-neutral, read-only signal over existing data — no schema change, no new write path, no change to acceptance semantics. Exact mechanism is a plan-phase decision listed in the plan-approval request.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The customer booking flow MUST present three labeled steps — booking, identity, confirmation — with visible progress indication, exactly one primary action per step, and back-navigation that preserves entered data.
- **FR-002**: The identity step MUST show an editable booking-summary card (selected services, server-derived total duration and displayed price, date, time, resource when exposed) before contact fields.
- **FR-003**: A dedicated confirmation surface MUST present the complete booking for final review before submission; submission MUST NOT be reachable without passing it.
- **FR-004**: The service-selection surface MUST scale beyond 16 services via search/filter with removable selected-service chips and immediately updated server-derived totals, while remaining fully operable by keyboard and screen reader; below the scaling threshold it MUST stay as simple as the current list.
- **FR-005**: The booking step MUST offer an explicit slot refresh/retry action and display operator-configured availability notices near the affected availability.
- **FR-006**: The system MUST warn about a duplicate booking — defined as an existing active booking for the same day reported by the backend for the customer's presented proof/contact — and require explicit acknowledgement before submission; the backend signal MUST be provider-neutral.
- **FR-007**: The success surface MUST state the booking state, the next expected action, and the management path; it MUST mention a notification channel only when one is configured.
- **FR-008**: The management key MUST get one-click copy plus a one-sentence explanation; the raw-key fallback MUST remain.
- **FR-009**: A direct customer reservation-management entry point MUST exist on the customer surface.
- **FR-010**: Location selection MUST appear only when more than one location is configured; with the current single-location model it MUST never render (no backend location model is added by this feature).
- **FR-011**: When the operator does not expose resource choice, the system MUST auto-select the best eligible resource and show the assignment on the summary/confirmation surfaces; explicit resource selection MUST remain when exposed.
- **FR-012**: Legal consent MUST stay concise inline with progressive disclosure for secondary details; recorded consent versions keep their current meaning.
- **FR-013**: All existing accessibility behaviors (semantic sections, skip links, focus management, live regions, reduced motion, forced colors) and the theme system MUST be preserved or improved; no production branding enters the repository.
- **FR-014**: A documented UX parity matrix MUST compare the OSS flow with the production flow by user task, recording which tasks reach parity, which exceed it, and which are deferred to adapter work (issue #1).
- **FR-015**: Backend reservation semantics (idempotency, budgets, transactional integrity) MUST remain unchanged except for the minimal read-only signal needed by FR-006.

### Key Entities

- **Booking journey state**: the customer's in-progress selections (services, date, time, resource, contact, consent, acknowledgements) as they move through the steps; client-held, never authoritative over server state.
- **Availability notice**: operator-configured, location/schedule-scoped text shown near availability.
- **Duplicate-booking signal**: backend-computed indication that the presented proof/contact already holds an active booking for the target day.
- **UX parity matrix**: committed document mapping user tasks to OSS/production status.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A first-time customer completes a booking in under 3 minutes on a 360 px viewport, and the journey is completable keyboard-only.
- **SC-002**: Rendered browser tests cover the complete customer journey at 320, 360, 768 and 1440 px with zero horizontal overflow and passing WCAG 2.1 A/AA automated checks on every customer page.
- **SC-003**: A default single-location, no-provider deployment renders zero adapter-related UI and requires no step that the pre-change flow did not require.
- **SC-004**: Stale-slot, capacity-spent and duplicate-booking situations each have an explicit rendered recovery path covered by browser tests.
- **SC-005**: The UX parity matrix is committed and every production task it lists is marked parity / exceeds / deferred-with-reason.
- **SC-006**: The full existing check suite (core, worker including race suites, browser, typecheck, build, audits) stays green throughout.

## Assumptions

- Issue #11's checklists plus issue #1's decision comment are the product intent; where they conflict with `docs/PARITY.md` v0.2 exclusions, the exclusions win for backend scope (no multi-location model, no identity/notification adapter, no staff roles in this feature).
- The identity-adapter and location surfaces are delivered as *documented, test-asserted absence* (slots), not as new configuration switches; issue #1 defines the contracts later.
- FR-006's duplicate signal is the only backend addition, and it is a read-only, provider-neutral computation over existing data (no schema change, no new write path).
- The current single-page customer implementation may be restructured freely as long as URLs that customers may have bookmarked (booking entry, management page, legal pages) keep working.
- Existing browser-suite conventions (shared installation, ordered specs, harness helpers) remain the testing substrate; specs are extended/adjusted rather than replaced wholesale.
- Japanese remains the customer-facing language with the existing polite tone; code and documentation stay in English.
