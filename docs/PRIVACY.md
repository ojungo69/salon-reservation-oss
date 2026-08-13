# Privacy and retention template

This is a public-safe application-behavior template, not legal advice or a complete notice. The
initial installation is a fictional demo and refuses booking mutations. Before accepting real data,
the operator must replace fictional identity/contact text and publish notices appropriate to its
customers, jurisdiction, Cloudflare account, and actual configuration.

## Application data and purpose

For an accepted booking, the application may store the customer's name and contact value, selected
service/resource, date and time, displayed-price and consent snapshots, status, reference, a
SHA-256 digest of the management key, and bounded idempotency receipts. It uses these data only to
operate the booking, show the customer their proved booking status, prevent duplicate effects, and
perform the requested cancellation or operator action.

The plaintext management key is generated in the browser and is not stored by the server. The owner
secret is a Worker secret and is not stored in application data or installation receipts. Public
availability exposes only public configuration and unoccupied times; it does not provide name,
contact, or unauthenticated booking search.

## Browser storage and proofs

- A short-lived journey draft can retain non-sensitive service, resource, date, time, and step
  choices for up to 24 hours. It contains no name, contact value, Turnstile response, owner secret,
  management key, or authority.
- After final confirmation starts, that browser tab can temporarily retain the exact request,
  command ID, and management key for up to 24 hours so a lost response can be retried safely. It
  contains no Turnstile response or owner secret and is removed after a definitive outcome.
- Only if the customer chooses to remember a booking, the browser can retain its reference/date and
  management key as local proof. The customer can remove it. Anyone able to use the same unlocked
  browser profile may be able to use that proof, so shared-device users should copy it privately and
  remove the browser record.
- The operator token is held only in page memory and is cleared on refresh, close, or logout. It is
  not written to cookies, URLs, local storage, session storage, or application logs.

## Retention, deletion, and requests

Each JST date has its own application database. At the configured retention point (1–365 days), the
whole date database is deleted: bookings, customer data, key digests, snapshots, closures, command
receipts, and its cleanup alarm. Cancellation changes booking status; it does not by itself erase a
record before the configured purge.

Platform recovery windows can differ from application retention. The deployer must state the actual
retention, backup/export, recovery, deletion, and customer-request process in its final notice. See
[Cloudflare operations](CLOUDFLARE.md) for the limits of export, recovery, rollback, and resource
deletion.

## Providers and optional adapters

By default, the application does not send booking data to a messaging service, calendar, payment
provider, external identity provider, CRM, or analytics provider. Its Cloudflare deployment does
use Workers, Durable Objects, Static Assets, Rate Limiting, and Turnstile to process the request;
placement is not a guarantee of Japan-only residency.

Two independently optional calendar modes are available. An authenticated iCalendar subscription
stores and publishes only the reservation start/end, selected service label, pending/approved
state, stable opaque event UID, and event creation timestamp. Its capability URL grants read access
to those fields; keep it out of logs, analytics, screenshots, issues, and messages, and rotate its
dedicated token after suspected disclosure. Optional Google outbound synchronization sends the
same schedule facts plus a stable, non-reversible event identifier. It does not send the customer
name/contact, resource, management key, reservation reference, attendee, location, description, or
management URL. Google then processes the event under the operator's Google configuration and
terms.

Calendar projections, desired outbound mutations, deduplication evidence, and aggregate operational
records are bounded and never become the reservation system of record. Rejected, cancelled,
expired, and retention-purged reservations leave the feed; completion/no-show bookkeeping keeps
the confirmed schedule entry. Google deletion is retried within a bounded ladder. Removing both
secrets stops new feed access and provider calls immediately, while local cleanup continues through
the descriptor-lease and fixed sweep window. The rendered customer disclosure remains visible until
that residual state is purged, then disappears. If abuse limiting, an authority error, or the 250 ms
lookup deadline prevents a residual-state answer, the Worker conservatively keeps the bounded,
conditional disclosure visible; the abuse-limited path performs no Calendar storage work. See
[calendar setup](CALENDAR-SETUP.md) for rotation and recovery.

Any additional provider adapter must be disabled by default, have a stated purpose and data
boundary, and update the operator's notice, contracts, security review, and customer rights process
before it receives personal data. The core booking path remains usable without every adapter.

## Operator checklist: edit before live use

The setup wizard renders editable privacy, terms, and cancellation notices from installation
configuration. Replace the fictional defaults and keep the served pages and this repository notice
consistent with:

- legal operator name, contact route, effective date, and revision process;
- purposes, lawful basis or equivalent explanation, and the exact data categories collected;
- chosen retention, export, recovery, deletion, and correction/access request process;
- Cloudflare processing, international transfers, and any enabled adapter or subprocessor; and
- incident response, security controls, and the person responsible for customer inquiries.

The operator—not this template—determines whether the notice, consent, records, contracts, and
cross-border safeguards satisfy applicable law.
