# Feature Specification: Optional LINE identity and notifications (S1)

**Feature Branch**: `feat/line-adapter`

**Created**: 2026-08-12

**Status**: Implemented; PR #37 ready for review

**Input**: Roadmap stage S1 — "Optional LINE identity and notifications" — implementing issue #1's
LINE adapter scope: LIFF bootstrap and login, server-side token verification, account-link state,
webhook raw-body signature verification, event deduplication and follow/unfollow handling, push
notification queueing with retry/backoff and terminal-failure visibility. Part of #1; this slice
does not close it.

## Context

This is the first *adapter* stage: it builds the shared post-commit event delivery foundation the
adapter contracts stage with the first consumer, then consumes it for the identity and
notifications seams. The governing documents are
[the adapter contracts](../../docs/ADAPTER-CONTRACTS.md) (identity + notifications tables and the
five shared invariants), [the roadmap's S1 row](../../docs/ROADMAP.md) (completion criteria), and
[the mechanism research](research.md) (verified endpoints and the substrate decision). The
constitution's principles I, II, IV, and V bind directly; the whole adapter core is security scope
under the quality gates.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Customer receives LINE notifications for their reservation (Priority: P1)

A customer books at a salon whose installation has configured the LINE adapter. From their
reservation management surface (which they hold via their management key), they choose to receive
LINE notifications, approve the link inside LINE (LIFF), and from then on receive a LINE message
when the salon accepts, rejects, or reschedules their reservation, when it is cancelled, or when
their pending request expires unanswered. Booking itself never requires any of this: the
accountless path stays complete and untouched.

**Why this priority**: This is the production task issue #1 names — the production system's
customers live on LINE. Everything else in the stage (webhook, dedup, queueing) exists so this
journey is trustworthy.

**Independent Test**: With the adapter configured against fixture LINE endpoints, link a
reservation to a fixture LINE subject, drive each committed state change (approve, reject,
reschedule, cancel, expire), and observe exactly one correctly addressed push delivery per event.

**Acceptance Scenarios**:

1. **Given** a linked reservation, **When** the owner approves it, **Then** one acceptance
   notification is delivered to the linked LINE subject, traceable to that committed transition.
2. **Given** a linked reservation, **When** the same committed event is delivered to the adapter
   more than once (redelivery), **Then** the customer receives exactly one message for it.
3. **Given** an unconfigured installation, **When** a customer books and manages a reservation,
   **Then** no LINE UI element, no stored LINE identifier, and no outbound LINE request exists
   anywhere on their journey.
4. **Given** a linked reservation whose customer has blocked the salon's official account
   (unfollow), **When** an event for it commits, **Then** the delivery is not attempted blindly
   forever: the link's deliverability state reflects the unfollow and the outcome is visible to
   the operator, never to the booking path.

---

### User Story 2 - Customer links their LINE account safely (Priority: P2)

The customer initiates linking only from their reservation management surface (proof: management
key). The LIFF page bootstraps inside LINE, obtains an ID token, and the server verifies that
token against the LINE Platform before trusting any subject. The link is single-valued and
replay-safe: re-linking the same subject is a no-op; a different subject over an existing link is
a surfaced conflict, never a silent overwrite. Unlinking removes the stored identifier.

**Why this priority**: The identity seam is the trust boundary for P1 — without verified linking
there is nothing safe to notify. It is P2 only because its value is realized through P1.

**Independent Test**: Exercise the link endpoint with a valid fixture ID token, an expired one, a
wrong-audience one, a replayed one, and a conflicting re-link; verify stored state and responses
per the identity contract's idempotency row.

**Acceptance Scenarios**:

1. **Given** a customer holding a reservation's management proof, **When** they complete the LIFF
   login and the server-side verification succeeds, **Then** the minimum stable subject identifier
   is stored for that reservation and nothing else of the profile is persisted.
2. **Given** a forged, expired, or wrong-audience ID token, **When** it is presented to the link
   endpoint, **Then** the link is refused and nothing is stored.
3. **Given** an established link, **When** the same subject links again (including a replayed
   request), **Then** the state is unchanged (no duplicate, no error surfaced to the customer).
4. **Given** an established link, **When** unlink is requested with the management proof, **Then**
   the stored identifier is verifiably gone.
5. **Given** a LINE provider outage, **When** a customer attempts to link or log in, **Then** the
   flow degrades with a clear message and the accountless path (booking, status, cancel) is fully
   unaffected.

---

### User Story 3 - Operator configures the adapter and sees its health (Priority: P3)

The operator creates their LINE channels (a Mini App or LINE Login channel for the LIFF surface, a
Messaging API channel for messaging), enters the non-secret identifiers in setup, provides the one
channel secret through the installation's secret mechanism, and points the LINE webhook at the
installation. Diagnostics answer "is LINE working?": configured state, webhook signature failures,
pending and failed deliveries, and terminally failed notifications with reason and time.

**Why this priority**: Without it the adapter cannot be turned on, but it serves the other two
stories rather than a customer task of its own.

**Independent Test**: Configure fixture channel identifiers, drive deliveries into retry and
terminal failure, and read every count and terminal record from the operator diagnostics surface.

**Acceptance Scenarios**:

1. **Given** a fresh installation, **When** the operator opens setup, **Then** the LINE adapter is
   visible as available and off, and nothing about it appears on any customer surface.
2. **Given** partial configuration (identifiers without the secret, or the reverse), **When**
   the operator inspects setup, **Then** the adapter reports itself not active and which half is
   missing, and no outbound LINE request is ever made.
3. **Given** a delivery that exhausted its retry budget, **When** the operator opens diagnostics,
   **Then** the notification appears as terminally failed with reason and time.

---

### Edge Cases

- Webhook POST with a missing or invalid `x-line-signature` over any body: rejected before any
  parsing of the body's claims; no state change; failure counted in diagnostics.
- Webhook redelivery (`webhookEventId` already seen, or `deliveryContext.isRedelivery` true with a
  seen ID): acknowledged without repeating side effects.
- Two LINE events for the same subject arriving out of order (unfollow then a stale follow, by
  `timestamp`): deliverability state resolves by event timestamp, not arrival order.
- Push attempt against a subject who never added / has blocked the official account: the LINE API
  refusal is a delivery failure for that recipient — bounded retry only where retry can help,
  terminal visibility otherwise; other recipients and events unaffected.
- The LINE token endpoint or push endpoint returns 5xx or times out mid-delivery: retried with the
  same idempotency key (`X-Line-Retry-Key`) and bounded backoff; a `409` counts as accepted.
- Link completion commits but its response is lost: an identical same-subject retry within the
  intent's original TTL returns success without another link mutation; a different subject still
  conflicts, and unlink makes the old nonce unusable.
- A reservation is unlinked (or its retention purge removes it) while deliveries for it are still
  pending: pending deliveries for that reservation are discarded or terminally parked without
  error loops, and no identifier outlives the link contractually promised to be removable.
- The pending-expiry sweep commits an expiry while the adapter is unconfigured: no event is
  queued then or later (configuration gating is evaluated at commit time; no backfill on later
  enablement).
- Storage pressure: the outbox and dedup records are bounded (retention-purged with the day and
  size-capped) so the adapter cannot grow a day object without bound.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001 (gating)**: The adapter MUST activate only when its explicit configuration is complete
  (channel identifiers present and the channel secret present). In every other state the
  installation MUST be **behaviorally indistinguishable** from one without the adapter on every
  customer-facing and booking-path surface: no customer UI element, no LINE-related network
  request (the adapter's frontend module is never fetched — and is itself served 404 — while
  inactive), no stored external identifier, no outbound request, nothing queued, and API
  responses byte-identical to their pre-adapter shapes. The one necessary exception is that the
  shipped static bundle contains the gated module and its inert guard — absence is asserted at
  the served-response, DOM, and network level, not on repository bytes. **Cleanup exception**:
  while previously created LINE data may still exist (a degraded or deactivating installation),
  a proof-bound, cleanup-only surface (link status + unlink, no LINE UI or LINE traffic) MUST
  remain reachable — a customer's ability to see and remove their link never depends on the
  adapter being healthy. The operator setup surface MAY show the adapter as available and off.
- **FR-002 (post-commit events)**: Reservation state changes MUST record adapter-consumable events
  atomically with the committing transaction (transactional outbox), and every adapter delivery
  MUST derive from those committed events only. Booking acceptance MUST NOT wait on any adapter
  step; no synchronous external call may sit on the booking path.
- **FR-003 (event set)**: The notification-worthy committed events are: acceptance (approve),
  rejection, reschedule (the same-day move), cancellation (owner- or customer-initiated), and
  pending expiry. Post-visit bookkeeping transitions (completed, no-show) are NOT notified.
- **FR-004 (identity verification)**: Every identity assertion MUST be verified server-side
  against the LINE Platform (`POST /oauth2/v2.1/verify` with the configured channel ID as
  `client_id`) before any subject is trusted; client-supplied profile data MUST never be trusted
  or stored. Only the minimum stable subject identifier is stored, only after an explicit link,
  only bound to a reservation whose management proof authorized the link. The LINE Login or
  LINE Mini App channel and the Messaging API channel MUST belong to the same LINE provider,
  because subject identifiers are provider-scoped.
- **FR-005 (link semantics)**: Link state MUST be single-valued per reservation: same-subject
  re-link (including replayed requests) is a no-op; different-subject link over an existing link
  is refused and surfaced as a conflict; unlink (with management proof) MUST verifiably delete the
  stored identifier. The ID-token replay window is bounded by these semantics plus the token's
  `exp` — a replayed token can at most re-assert an existing link.
- **FR-006 (webhook trust boundary)**: The webhook endpoint MUST verify
  `base64(HMAC-SHA256(channel secret, raw body))` against `x-line-signature` on the exact received
  bytes before any other processing, MUST reject on mismatch or absence without state change, and
  MUST exist only while the adapter is configured. Signature verification failures are counted in
  diagnostics.
- **FR-007 (webhook dedup and follow state)**: Processed `webhookEventId`s MUST be recorded and
  redeliveries acknowledged without repeated side effects. `follow`/`unfollow` events MUST update
  subject deliverability by event `timestamp` (out-of-order arrivals resolve to the newest).
- **FR-008 (delivery queueing)**: Deliveries MUST be queued per event × recipient × channel with
  deduplication so redelivered events never double-notify. Retries MUST use bounded exponential
  backoff, carry the same `X-Line-Retry-Key` from the first attempt of a given delivery, retry
  only on retryable outcomes (5xx / timeout), and finish strictly within that retry key's 24-hour
  validity window. They MUST treat `409` as accepted and park the delivery as terminally failed
  after the bound with reason and time visible to the operator. A failing
  delivery MUST never affect reservation state, other deliveries, or the booking path.
- **FR-009 (minimal payloads)**: Outbound messages MUST carry only what the message needs (time,
  service label, state) and MUST NOT include secrets, management keys, links containing a
  management key, or contact records. Stored adapter data is limited to:
  configuration, link records (reservation ↔ subject + deliverability), outbox events, delivery
  records, and webhook dedup records — each bounded and removed with its parent's retention.
- **FR-010 (operator observability)**: Operator diagnostics MUST report: configured/active state
  (and which half of configuration is missing), webhook signature-failure count, pending and
  failed delivery counts, and the terminal failures with reason and time — without any LINE
  subject identifier appearing in logs.
- **FR-011 (frontend surfaces)**: The LIFF page (bootstrap via `liff.init`, login, link consent)
  and the management-surface entry point MUST meet the constitution's accessibility principle
  (III) like every customer surface; the notification opt-in MUST NOT appear unless the adapter is
  active. Customer-visible text is polite natural language in the installation's language.
- **FR-012 (zero live dependency in CI)**: Every test MUST run against fixtures: fixture channel
  identifiers and secrets in test bindings, in-test HMAC signing for webhook fixtures, and mocked
  LINE endpoints (verify / token / push). No real channel secret, channel ID, or LIFF ID may enter
  the repository; live-channel verification is documented as an operator-side step.
- **FR-013 (existing guarantees)**: All existing suites MUST pass unchanged in behavior: the
  no-provider booking path, the race suites, the absence tests for the default success surface,
  and the release audit (with the new files registered).

### Key Entities

- **Adapter configuration**: channel identifiers (LIFF ID, login channel ID, messaging channel
  ID) held in installation settings; the messaging channel secret held only by the secret
  mechanism, never in settings or storage.
- **Link**: reservation ↔ verified LINE subject, with deliverability state (followed / not) and
  timestamps; at most one per reservation; deleted on unlink and on reservation purge.
- **Outbox event**: committed reservation transition recorded atomically with its transaction;
  the shared foundation later stages (calendar outbound, audit delivery) reuse.
- **Delivery**: one queued notification per event × recipient × channel with attempt count,
  next-retry time, idempotency key, and terminal state with reason.
- **Webhook event record**: processed `webhookEventId` with timestamp, for dedup.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Issue #1's four end-to-end criteria pass as fixture tests with zero live LINE
  dependency: login verification (valid / expired / wrong-audience / replayed), invalid webhook
  signature rejection, duplicate webhook delivery (single side effect), and notification retry
  (backoff, idempotency key reuse, terminal parking).
- **SC-002**: With the adapter unconfigured, the full existing suite plus the absence tests pass
  with no observable difference on any customer or booking surface.
- **SC-003**: Every cell of the identity and notifications contract tables has either a test or a
  recorded operator-side verification step; none is contradicted by the implementation.
- **SC-004**: The security review battery (rule-based static analysis plus an adversarial
  security-focused review) passes for the webhook endpoint, token verification, link endpoint,
  secret handling, and queue logic.
- **SC-005**: `docs/PARITY.md` target rows "LINE identity (LIFF login + server-side verification)"
  and "LINE notifications (push with retry and terminal-failure visibility)" flip to Implemented
  with evidence, and the roadmap's S1 row flips to Complete with a revision-log line — in the same
  change that delivers the evidence.

## Assumptions

- The operator can create LINE channels (Mini App or LINE Login, plus Messaging API) and obtain
  identifiers and the channel secret; the walkthrough is operator documentation in this slice.
- LINE's current mechanism facts are as verified in [research.md](research.md) on 2026-08-12; the
  implementation pins none of them harder than the research records.
- The stateless channel access token (15-minute, unlimited issuance) removes any need to store a
  long-lived messaging credential; the messaging channel secret is the single new secret.
- Notification language follows the installation's existing customer-facing language conventions;
  message templates are part of the slice.
- The shared outbox foundation is scoped to what S1 consumes; later stages extend rather than
  redesign it (contracts' staging note).
