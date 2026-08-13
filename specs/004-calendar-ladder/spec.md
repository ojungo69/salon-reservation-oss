# Feature Specification: Calendar ladder (S2)

**Feature Branch**: `feat/calendar-ladder`

**Created**: 2026-08-13

**Status**: Implemented; PR #48 ready for review

**Input**: Roadmap stage S2 and issue #1's recorded calendar decision: deliver an authenticated
outbound ICS subscription feed, then an optional outbound Google event synchronization adapter.
Both are independent, disabled by default, and never affect booking availability. Bidirectional
calendar import is explicitly outside this slice and every currently scheduled stage.

## Context

The governing sources are [the calendar extension contract](../../docs/ADAPTER-CONTRACTS.md#calendar-synchronization),
[the roadmap's S2 row](../../docs/ROADMAP.md), and issue #1's 2026-08-11 design decision. S1's
post-commit event delivery foundation is already present and is the required substrate. This slice
must preserve the provider-free application, the single-Worker deployment model, and the bounded
Free-plan target. No deployment or live Google account is needed for implementation or CI.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Subscribe to bookings from any common calendar (Priority: P1)

An operator explicitly enables an ICS feed, copies its private subscription URL, and subscribes to
it from Google Calendar, Apple Calendar, Outlook, or another standards-compatible client. Pending
and approved bookings appear with a stable identity, their schedule changes update the same event,
and rejection, cancellation, or expiry removes them. Completion and no-show bookkeeping keeps the
confirmed schedule entry. The feed exposes time, service label, reservation state, and only the
opaque UID/creation stamp required by the calendar protocol; it never exposes the customer's name,
contact details, management proof, or internal notes.

**Why this priority**: This is the lowest-cost calendar rung and satisfies the common task of seeing
bookings in an existing calendar without a provider account or OAuth setup.

**Independent Test**: Enable the feed with a fixture authentication token, create and transition
fixture reservations, fetch and parse the feed, and confirm stable event identity, state, schedule,
privacy, authentication, and standards conformance without any external service.

**Acceptance Scenarios**:

1. **Given** a fresh installation, **When** no feed credential is configured, **Then** no feed URL
   is disclosed and the feed endpoint behaves as absent.
2. **Given** an enabled feed and a committed pending booking, **When** an authenticated calendar
   client reads it, **Then** it receives one tentative event with the correct start, end, service
   label, and stable identity, and no customer-identifying field.
3. **Given** that booking is approved or rescheduled, **When** the feed is read again, **Then** the
   same event identity carries the confirmed state and current committed interval.
4. **Given** that booking is rejected, cancelled, expired, or retention-purged, **When** the feed is
   read again, **Then** the active feed no longer contains it.
5. **Given** a missing or invalid feed credential, **When** the endpoint is requested, **Then** no
   calendar content or installation state is disclosed and the failure is counted only in redacted
   operator diagnostics.

---

### User Story 2 - Mirror bookings into Google Calendar (Priority: P2)

An operator who wants provider-side events independently enables Google outbound synchronization
with a target calendar and least-privilege credential. A committed pending booking creates one
tentative event; approval or same-day rescheduling updates that same event; rejection,
cancellation, expiry, or retention purge deletes it. Duplicate delivery and uncertain responses
converge on one stable provider event. Calendar failures never change a booking or its availability.

**Why this priority**: It gives operators prompt provider-side event mutations and reconciliation,
while building on the universal feed rather than making Google a core dependency.

**Independent Test**: Run the full create/update/delete sequence against fixture token and Calendar
HTTP endpoints, inject duplicate events, timeouts, 4xx, 429, and 5xx responses, and verify one stable
external identity, bounded retry, terminal visibility, and unchanged reservation availability.

**Acceptance Scenarios**:

1. **Given** Google synchronization is explicitly configured, **When** a pending booking commits,
   **Then** one event create is queued after the commit and the booking response does not wait for
   Google.
2. **Given** the same committed event is delivered more than once or the create response is lost,
   **When** reconciliation runs, **Then** exactly one Google event represents the reservation.
3. **Given** an existing mirrored reservation is approved or rescheduled, **When** delivery
   succeeds, **Then** the same Google event is updated rather than duplicated.
4. **Given** an existing mirrored reservation is rejected, cancelled, or expired, **When** delivery
   succeeds or the event was already absent, **Then** the reservation is reconciled as deleted.
5. **Given** Google is unavailable or rate-limits requests, **When** retries reach their bound,
   **Then** the reservation remains unchanged and the unsynchronized mutation is visible to the
   operator with a redacted reason and time.
6. **Given** the ICS feed is disabled, **When** Google synchronization is enabled, **Then** Google
   synchronization still works; the inverse independence also holds.
7. **Given** the mutation queue is full, **When** a previously mirrored reservation is removed,
   **Then** its source event or projection remains recoverable until the required Google delete can
   be retained; the delete is never silently discarded.

---

### User Story 3 - Configure, rotate, and diagnose calendar modes safely (Priority: P3)

The operator sees ICS and Google as two separate optional modes. Each surface reports whether its
configuration is absent, incomplete, active, or degraded, without displaying provider credentials.
The operator can rotate or revoke feed access, remove provider credentials to stop outbound calls,
and reconcile current committed reservations after an outage or configuration gap.

**Why this priority**: The first two stories require a safe lifecycle and enough visibility to
operate them without making the reservation schedule secondary to an external calendar.

**Independent Test**: Exercise independent enable/disable, feed-token rotation, missing provider
credential, outage, backlog, reconciliation, and recovery using only fixture credentials and
redacted diagnostics.

**Acceptance Scenarios**:

1. **Given** neither mode is configured, **When** the operator opens setup, **Then** both modes are
   shown separately as off while every customer surface remains unchanged.
2. **Given** feed access is rotated, **When** the old and new subscription URLs are requested,
   **Then** only the new credential works and reservation state is unchanged.
3. **Given** Google configuration is incomplete or revoked, **When** delivery would otherwise run,
   **Then** no credential is logged or persisted as reservation data, no outbound mutation is made
   with incomplete configuration, one shared rejection parks all work for that non-secret
   fingerprint until rotation or reconciliation, an inaccessible target calendar is treated the
   same way, and the operator sees the configuration problem.
4. **Given** an outage left mutations pending, **When** the provider recovers and reconciliation
   runs, **Then** current committed reservation state wins and the backlog converges without
   duplicates, including a retained failed delete whose projection row is already absent.

### Edge Cases

- Two feed requests run while a reservation is committing: each response contains only a complete
  committed projection; neither can expose an in-flight state.
- A UTF-8 service label contains commas, semicolons, backslashes, newlines, or enough bytes to
  require line folding: the feed remains standards-conformant and round-trips the label safely.
- A reservation crosses midnight only in its UTC representation: clients see the correct
  `Asia/Tokyo` local interval and a non-inclusive end time.
- An event create succeeded at Google but the response was lost: retry uses the same stable event
  identifier and converges through update/duplicate handling rather than creating another event.
- Google reports an event already deleted: deletion is accepted as reconciled, not retried forever.
- The optional calendar authority stalls while a reservation request is running: its descriptor
  lookup fails open after a 250 ms local deadline, the reservation transaction retains an unbound
  calendar outbox event, and the bounded sweep adopts it under the active generation.
- A permanent request/configuration error and a transient outage occur simultaneously for different
  reservations: each item is isolated; the transient item retries and the permanent one becomes
  visible without stalling the queue.
- Configuration is removed while a send is in flight: no new sends begin, the response cannot
  mutate reservation state, and later reconfiguration reconciles from committed source state.
- A day partition is retention-purged while a calendar mutation is pending: the local projection is
  removed, no initial or chained provider request starts at or beyond the parent boundary, and any
  required provider deletion is driven or surfaced before derived local data is discarded.
- Queue or projection bounds are reached: new reservation commits still succeed; calendar work is
  terminally visible rather than growing storage without bound.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001 (independent gating)**: ICS and Google outbound synchronization MUST be independently
  configured, disabled by default, and absent from customer surfaces until configured. With both
  never configured or disabled-and-purged, no calendar projection, feed URL, external identifier,
  outbound request, or booking-path dependency may be created. **Cleanup exception**: after a
  previously active mode loses its credential, bounded derived rows and reconciliation state may
  remain only while deactivation/purge finishes; the feed and new provider calls stay disabled,
  booking/customer journeys stay unchanged, and operator diagnostics plus the calendar privacy
  disclosure continue to report the residual state until it is gone. Operator setup MAY show both
  capabilities as available and off.
- **FR-002 (post-commit source)**: Every feed projection and outbound mutation MUST derive only
  from committed reservation state through the shared post-commit event foundation. Booking
  acceptance MUST NOT wait on calendar work. Calendar state MUST NOT influence availability,
  capacity, reservation status, or any retry result.
- **FR-003 (reservation mapping)**: A committed pending booking maps to one tentative calendar
  event; approval maps it to confirmed; same-day rescheduling changes its interval; rejection,
  cancellation, expiry, and retention purge remove it. Completion and no-show bookkeeping do not
  change its schedule representation. Each reservation MUST have one stable calendar identity
  across feed reads, provider retries, approval, and rescheduling.
- **FR-004 (schedule facts only)**: Calendar projections MUST contain only the reservation's start,
  non-inclusive occupied end, configured service label, tentative/confirmed state, and the opaque
  identity/creation stamp required by the calendar protocol. Customer name, contact, management
  proof, notes, resource identifiers, secrets, and provider credentials MUST never enter a feed,
  provider event body, log, diagnostic record, or test fixture.
- **FR-005 (authenticated ICS)**: The feed MUST require a dedicated high-entropy subscription
  credential compatible with URL-based calendar clients, reject missing/invalid credentials
  without disclosing whether an installation or feed exists, support revocation/rotation, and
  prevent caching of authenticated responses. Feed authentication failures MUST be countable in
  redacted operator diagnostics.
- **FR-006 (ICS interoperability)**: The feed MUST conform to the current iCalendar standard,
  including stable `UID`, `DTSTAMP`, start/end values, state, required CRLF line endings, text
  escaping, and UTF-8-safe line folding. Repeated reads MUST be naturally idempotent and suitable
  for Google Calendar, Apple Calendar, and Outlook subscription import.
- **FR-007 (Google credential boundary)**: Google credentials MUST be supplied only through the
  deployment's secret mechanism, scoped to the target calendar and event operations needed by this
  feature, never returned by setup/diagnostics, never persisted with reservations, and never
  written to logs or provider-error records. Incomplete or rejected credentials MUST stop new
  outbound calls and surface a redacted configuration state.
- **FR-008 (idempotent Google mutations)**: Google create/update/delete MUST use a deterministic
  provider-valid event identity derived from the reservation identity. Duplicate or uncertain
  delivery MUST converge on one event; "already exists" converges through update and "already
  absent" converges as a successful delete.
- **FR-009 (retry and isolation)**: Transient network, rate-limit, and provider-server failures
  MUST retry with bounded backoff. Permanent payload/auth/configuration failures MUST not be
  retried blindly. Exhaustion MUST park the reservation for reconciliation with a redacted reason,
  provider status where safe, and time. One failed item MUST NOT stall other items. A full mutation
  queue MUST retain the source outbox event or existing projection until a required delete fits;
  Google capacity MUST NOT keep a cancelled item in the ICS projection. Failed upserts MAY yield
  capacity to newer work, but unresolved delete rows and live upserts MUST NOT be evicted.
- **FR-010 (reconciliation)**: The operator MUST be able to reconcile the adapter's projection and
  provider state against current committed reservations after duplicate delivery, missed handoff,
  outage, or configuration gap. Current committed state wins; reconciliation MUST NOT mutate a
  reservation or import provider busy time. An outbox event captured before the authoritative day
  projection MUST NOT overwrite that reconciliation if its delivery completes later, and a
  reconciliation snapshot MUST NOT overwrite an event accepted after that snapshot was read. A date
  replacement MUST remain unchanged and deferred unless every required Google upsert and delete fits.
  With valid Google configuration, reconciliation MUST requeue retained failed or
  configuration-blocked deletes even after their projection rows have been removed.
- **FR-011 (observability)**: Owner-only diagnostics MUST show each mode's configured/active state,
  last successful reconciliation, pending/failed counts, feed authentication-failure count, and a
  bounded redacted terminal ledger. Customer identifiers, reservation identifiers, credential
  values, provider bodies, and authorization headers MUST not appear.
- **FR-012 (bounded retention and storage)**: Local calendar events, accepted-event deduplication,
  queue rows, and diagnostics MUST be size- and/or time-bounded and MUST not outlive the source
  reservation's configured retention boundary. The boundary MUST be checked immediately before
  every outbound Calendar mutation, including after OAuth and between fallback requests. Storage
  pressure MUST degrade only the adapter and become visible; it MUST never reject a reservation.
  Optional descriptor acquisition on a reservation path MUST fail open within 250 ms; automatic
  sweep/reconciliation owns recovery.
- **FR-013 (fixture-only verification)**: Automated tests MUST use fictional data, fixture
  credentials, and mocked token/Calendar endpoints. CI MUST require no Google or Cloudflare account,
  no network access to Google, and no live deployment. A live provider smoke test remains an
  optional operator-side step after deployment.
- **FR-014 (existing guarantees)**: All existing reservation, race, security, browser, build,
  release-audit, and no-provider tests MUST continue to pass. The final change MUST demonstrate
  explicitly that calendar failure and enablement do not change availability results.
- **FR-015 (documentation/status)**: Setup and privacy documentation MUST explain the two independent
  modes, credential handling, exposed schedule fields, revocation, recovery, and the exclusion of
  inbound availability. When the evidence passes, the calendar target rows in `docs/PARITY.md`
  MUST become Implemented and roadmap S2 MUST become Complete in the same change.

### Key Entities

- **Calendar mode configuration**: independent ICS and Google enablement facts plus redacted health;
  credential values remain outside persisted configuration.
- **Calendar projection event**: one stable reservation-derived event containing only date/time,
  service label, tentative/confirmed state, source version, and retention boundary.
- **Subscription credential**: a dedicated revocable high-entropy capability authenticating the
  ICS URL; it grants feed read access only.
- **Provider mutation**: the desired create/update/delete operation for one stable reservation
  identity, with attempt schedule and reconciliation state but no credential or customer record.
- **Reconciliation record**: bounded per-reservation state (`synced`, `pending`, or `failed`) and a
  redacted reason/time that lets the operator find gaps without making Google authoritative.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Fixture tests parse the generated feed and prove, across create, approve, reschedule,
  cancel/reject/expire, duplicate delivery, UTF-8 escaping/folding, and token rotation, that every
  reservation has at most one current event and no forbidden field appears.
- **SC-002**: Fixture Google tests prove exactly one stable provider identity across create/update/
  delete, lost-response duplicate, 429/5xx outage, permanent 4xx, already-exists, already-absent,
  retry exhaustion, and recovery/reconciliation cases, with zero live provider calls in CI.
- **SC-003**: For an installation with both modes off, public response shapes, customer DOM/network
  behavior, reservation results, and external call counts remain identical to the pre-S2 baseline.
- **SC-004**: Availability fixtures are byte-for-byte identical before and after calendar enablement,
  provider outage, retry exhaustion, and reconciliation.
- **SC-005**: Every calendar contract row has automated evidence or an explicit optional
  operator-side verification, and the security review battery passes for feed authentication,
  secret parsing, outbound requests, retry classification, diagnostics redaction, and retention.
- **SC-006**: The full required check and browser suites pass; `docs/PARITY.md` records both outbound
  calendar rows as Implemented and `docs/ROADMAP.md` records S2 Complete with evidence.

## Assumptions

- Pending requests are useful calendar facts and therefore appear as tentative events; approval
  updates the same event to confirmed. This follows issue #1's create/update/delete decision.
- The occupied interval includes configured cleanup time, matching the reservation system's
  committed capacity interval; the calendar remains informational and never feeds availability.
- A URL-carried capability credential is necessary because common subscription clients cannot be
  relied upon to attach an HTTP authorization header. It is separate from the owner credential and
  can be rotated without changing reservation state.
- The operator grants the Google credential write access only to the chosen calendar. Provider
  account creation, consent, calendar sharing, deployment, and a live smoke test are operator-side
  steps, not prerequisites for this implementation.
- Existing retained reservations are reconciled when a mode is first enabled or recovers; no
  provider-side change is imported back into the booking system.
- The first provider is Google, but the reservation event shape and state transitions contain no
  Google-specific field. A second provider is not scaffolded until it is actually requested.
