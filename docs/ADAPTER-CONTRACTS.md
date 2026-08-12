# Adapter extension contracts

This document defines the obligations between the reservation core and every optional external
adapter, for the four seams issue #1 names: identity, notifications, calendar synchronization, and
audit/event delivery. It is the contract a future adapter implementation is reviewed against.
Capability *status* lives in [the parity matrices](PARITY.md); delivery *order* lives in
[the roadmap](ROADMAP.md); this file holds only obligations.

## Shared invariants (all seams)

These hold for every adapter, in addition to each seam's table below.

1. **Provider-neutral core.** The booking path works with zero external services. No adapter is
   required for any customer or operator task the implemented matrix records.
2. **Disabled by default, invisible until configured.** An adapter activates only through explicit
   configuration. While unconfigured it leaves no customer-facing or booking-path trace: no
   customer UI element, no stored external identifier, no booking-path dependency, no outbound
   request. The operator's setup and diagnostics surfaces may show the adapter as available and
   disabled — that is how it gets configured at all.
3. **One Worker.** Adapters ship as configuration-gated modules inside the single Worker — never as
   separate deployables — so the Free-plan budget and the five-minute deploy story survive.
4. **Post-commit events only.** Adapters consume explicit events emitted after a reservation
   state change has committed — the constitution's invariant, unweakened. Every projection or
   delivery of reservation state therefore derives only from committed state, and an uncommitted
   or in-flight change is never observable through an adapter. Outbound deliveries consume the
   events directly. A served read projection (the authenticated ICS feed of issue #1's recorded
   2026-08-11 decision) must be **observationally equivalent** to a projection maintained from
   that event stream — whether the implementation materializes it from events or computes it from
   committed state at read time, a consumer can never distinguish the two, never sees an
   uncommitted change, and nothing is gated. Booking acceptance never waits on an adapter: no
   synchronous external call sits on the booking path in any seam or mode. Two seams have defined, bounded exceptions to "adapters never touch
   the journey": identity operates at session boundaries (login, account link) *outside* the
   reservation transaction, and the calendar contract's mode 3 — if ever scheduled — affects
   availability only through a local snapshot refreshed out-of-band, per its own contract row.
5. **Failure is visible, never blocking.** An adapter failure may degrade the adapter's own feature
   and must surface to the operator; it must not reject, delay, or roll back a reservation. The
   one recorded availability effect is calendar mode 3's fail-close from invariant 4: a stale
   snapshot shrinks bookable inventory for the affected slots ahead of any booking attempt — it
   never touches an accepted reservation.

Each seam's table states, per dimension, what the core guarantees, what the adapter must guarantee,
and what the operator sees.

## Identity

The accountless path — per-reservation management keys, no accounts — remains the default and is
complete on its own. External identity is a convenience layer for installations that configure it,
never a requirement for booking.

| Dimension | Core guarantee | Adapter obligation | Operator-visible outcome |
|---|---|---|---|
| Configuration gating | Booking and booking management never require identity; unconfigured means no login UI and no stored external subject | Render no sign-in surface and store no external identifier until a provider is explicitly configured | Setup shows the identity adapter as off by default with its provider unconfigured |
| Event and trigger model | Identity participates at session boundaries (login, account link), never inside the reservation transaction; the core exposes where a verified subject may attach to a customer-held proof | Verify every assertion server-side (token or signature verification against the provider) before trusting a subject; treat client-supplied identity as untrusted input | Linked/unlinked state is inspectable per installation, not per customer, in diagnostics |
| Failure semantics | Provider outage leaves the accountless path fully working; no booking is rejected for identity reasons | Degrade to the accountless flow with a clear message when login or linking fails; never hold the journey hostage to a provider | A failing provider shows as adapter degradation, while bookings continue to arrive |
| Idempotency | Link state is single-valued per proof: re-linking the same subject is a no-op, not a duplicate | Make login callbacks and link requests replay-safe; a repeated callback must not create a second link or overwrite a different subject silently | Duplicate link attempts appear as one link, with conflicts surfaced instead of absorbed |
| Retry and terminal-failure visibility | Login flows are interactive: the user retries; the core requires no background queue for identity | Bound any automatic retry (for example token refresh) and surface terminal link failures in-flow to the user and in diagnostics to the operator | Terminal link failures are countable in diagnostics rather than silently swallowed |
| Privacy and data minimization | Nothing identity-related is stored while unconfigured; the customer data model does not grow by default | Store at most the minimum stable subject identifier after an explicit link; no profile harvesting; unlink deletes the stored identifier | The privacy notice can state exactly which identifier is stored, and unlink verifiably removes it |
| Observability | Adapter health is part of operator diagnostics, not customer UI | Report configured/unconfigured state and link-failure counts without writing subjects into logs | Operator sees whether identity works without any customer identifier appearing in logs |

## Notifications

| Dimension | Core guarantee | Adapter obligation | Operator-visible outcome |
|---|---|---|---|
| Configuration gating | The default success surface promises no delivery channel (absence-tested today); nothing is queued while no channel is configured | Activate per explicitly configured channel; make no channel promise in customer-visible text until that channel is live | Setup lists each channel off by default; the success screen only mentions a channel once configured |
| Event and trigger model | Committed reservation events only — acceptance, status change, reschedule (the same-day move the core already implements as its own transaction), cancellation — emitted after the transaction commits | Subscribe to those events; never poll private state, never inject into the booking transaction | Every notification is traceable to exactly one committed state change the operator can see in the schedule; the number of deliveries per event follows the configured recipients and channels (event × recipient × channel) |
| Failure semantics | Delivery failure has no effect on reservation state; each event's delivery fails independently | Isolate failures per event and per channel; a dead channel must not stall other channels or events | A failed notification never implies a failed booking; the schedule view remains authoritative |
| Idempotency | The event stream may deliver an event more than once | Deduplicate per event × recipient × channel so a redelivered event never double-notifies a customer | Duplicate suppression is verifiable in the delivery record, not dependent on luck |
| Retry and terminal-failure visibility | The core defines terminal failure as an operator-attention condition, not a silent drop | Retry with bounded backoff; after the bound, park the notification as terminally failed and surface it | Terminally failed notifications appear in the operator's attention surface with reason and time |
| Privacy and data minimization | Events carry references and the minimum facts, not full customer records | Send only what the message needs (time, service label, state); store channel addresses only while the channel is configured and the customer is linked to it | The privacy notice can enumerate exactly what leaves the installation per channel |
| Observability | Adapter health belongs in operator diagnostics | Expose per-channel health, pending/failed counts, and the last terminal failures | Operator can answer "are notifications working?" from the diagnostics surface alone |

## Calendar synchronization

Issue #1's recorded decision (2026-08-11) ladders this seam into three modes, contracted separately:

- **Mode 1 — ICS subscription feed**: one authenticated outbound read endpoint serving committed
  reservations as a calendar feed. No OAuth, no provider account.
- **Mode 2 — outbound event synchronization**: reservation create/update/cancel mirrored to an
  external calendar as event create/update/delete.
- **Mode 3 — inbound availability authority**: external busy time projected into blocked slots.
  Whether this mode is targeted, and its current status, live in
  [the target matrix](PARITY.md#production-parity-target-matrix) — this contract defines the seam
  so that a future recorded revision has defined obligations waiting. Modes 1 and 2 never affect
  booking availability; fail-closed semantics apply to mode 3 only.

| Dimension | Core guarantee | Adapter obligation | Operator-visible outcome |
|---|---|---|---|
| Configuration gating | Each mode is configured independently; with none configured there is no feed URL, no outbound call, no calendar trace | Keep the feed endpoint absent (not merely empty) until configured; make no outbound call before mode 2 is explicitly enabled | Setup shows each mode separately, all off by default |
| Event and trigger model | The booking path never calls an external calendar API in any mode; modes 1–2 project committed state (the feed is observationally equivalent to a projection maintained from the post-commit event stream, mode 2 consumes the events directly); mode 3, if ever scheduled, refreshes a local availability snapshot out-of-band and the booking path reads only that snapshot | Serve the feed from committed state only; emit external event mutations only after commit; never write external busy data directly into slot decisions — only into the snapshot the core reads | Under modes 1–2, calendar effects always lag commits, never precede them; under mode 3 only the out-of-band snapshot precedes bookings; the schedule view stays the source of truth |
| Failure semantics | Feed unavailability affects feed consumers only; a mode 2 delivery failure never rolls back the reservation and becomes a reconciliation entry; under mode 3 a stale or unconfirmed snapshot fail-closes the affected slots only — bookable inventory shrinks, it never silently double-books | Record every unreconciled external mutation; under mode 3, mark snapshot staleness honestly rather than serving stale data as confirmed | Reconciliation status per reservation (synced/pending/failed); under mode 3, blocked-by-staleness is distinguishable from booked |
| Idempotency | Post-commit events may be redelivered | Map each reservation to a stable external event identity so redelivery updates rather than duplicates; feed reads are naturally idempotent; snapshot refreshes replace, not append | No duplicate external events for one reservation, verifiable by the stable mapping |
| Retry and terminal-failure visibility | Terminal outbound failure is an operator-attention condition; under mode 3, a snapshot that cannot be refreshed is treated as stale, which fail-closes the affected slots rather than serving stale data | Retry mode 2 mutations with bounded backoff; after the bound, park the reservation in the reconciliation view; surface feed authentication failures; retry mode 3 snapshot refreshes with bounded backoff and, beyond the bound, mark the snapshot stale and surface the refresh failure | Operator sees which reservations did not reach the external calendar and why; under mode 3, also sees that slots are blocked because the snapshot could not be refreshed |
| Privacy and data minimization | Committed reservations, not customer records, are the projection source; inbound external data is bounded the same way | Expose in the feed and external events only schedule facts (time, configured service label); no contact details unless the operator explicitly enables them; authenticate every feed access. Under mode 3, read and store only busy/free intervals (start and end times) from the external calendar — never event titles, descriptions, attendees, or any contact data — and keep only the interval snapshot | The privacy notice can state both what an external calendar learns and what the installation reads from it; unauthenticated feed access is impossible |
| Observability | Adapter health belongs in operator diagnostics | Report reconciliation backlog, feed access failures, and (mode 3) snapshot age — the staleness signal that drives fail-closed | Operator can see sync health and, under mode 3, why a slot is blocked |

## Audit/event delivery

The core's immutable internal history (day-pinned snapshots, receipts) is always on and remains the
source of truth. This seam adds optional *external* delivery of the committed event stream.

| Dimension | Core guarantee | Adapter obligation | Operator-visible outcome |
|---|---|---|---|
| Configuration gating | Internal immutable history exists regardless; nothing is delivered externally until a sink is configured | Make no external write before a sink is explicitly configured; deactivation stops delivery without touching internal history | Setup shows external delivery off by default; internal history is not presented as deliverable |
| Event and trigger model | The same post-commit event stream feeds this seam; external delivery is a projection of internal history, never a replacement | Deliver events in commit order per partition; treat internal history as authoritative when the two disagree | External consumers can be reconciled against internal history at any time |
| Failure semantics | Sink failure has no effect on reservation processing or on internal history | Contain failures to the delivery pipeline; never drop an event silently to make progress | A dead sink shows as delivery lag, while the installation keeps operating and recording |
| Idempotency | Events carry stable identifiers | Checkpoint delivery position; make redelivery safe for consumers via those identifiers; detect and report gaps instead of skipping them | Gap and duplicate windows are reportable, not discovered by consumers |
| Retry and terminal-failure visibility | Terminal delivery failure is an operator-attention condition | Retry with bounded backoff from the checkpoint; after the bound, surface the stuck checkpoint and the failure reason | Operator sees checkpoint lag and terminal failures with enough detail to act |
| Privacy and data minimization | The event stream contains references and facts, not secrets | Apply a payload allowlist with redaction: an external sink receives only allowlisted fields. Secrets are unconditionally excluded — no configuration can allowlist them. Full contact records are never deliverable; at most, individual minimal fields may be allowlisted, each tied to a stated purpose and reflected in the privacy notice | The privacy notice can enumerate exactly which fields leave the installation, and secrets are provably not among them |
| Observability | Adapter health belongs in operator diagnostics | Expose checkpoint position, delivery lag, failure counts, and gap warnings | Operator can answer "is the audit trail flowing?" from diagnostics alone |

## Staging of code-level contracts

This document is the semantic contract. Event names, payload schemas, TypeScript types, queue
mechanics, and concrete retry counts are deliberately **not** fixed here: they land with the first
consumer — whichever adapter stage is implemented first (the LINE adapter, stage S1, in the
roadmap's recommended order) builds the shared post-commit event delivery foundation the later
seams reuse — so the contract is proven by an implementation rather than speculated ahead of one. Until then, a change to this document is a documentation
change reviewed against issue #1 and the constitution; after the first consumer lands, a change
here is a compatibility decision.
