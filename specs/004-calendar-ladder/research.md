# Research: Calendar ladder (S2)

**Date**: 2026-08-13 · **Feature**: 004-calendar-ladder · **Stage**: S2 of
[the roadmap](../../docs/ROADMAP.md)

All external mechanism facts below were re-checked against primary sources on 2026-08-13. No live
Cloudflare or Google resource was created; all implementation verification remains local and
fixture-only.

## R1 — Reuse the transactional outbox; add one calendar authority

**Decision**: Extend the released `ReservationDay` outbox with a `calendar` consumer and add one
installation-singleton `CalendarAdapter` SQLite Durable Object. Do not add Queues, a second Worker,
a provider registry, or an interface with only one implementation.

**Rationale**:

- S1 already proves the only delivery property that matters to the booking transaction: an event is
  written in the same synchronous SQLite transaction as the reservation change, then handed off
  after commit. Reusing it removes the commit→enqueue loss window without introducing another hop.
- The existing `AdapterDelivery` object is deliberately LINE-specific: it owns LINE subjects,
  links, webhook deduplication, and push delivery. Putting provider credentials and calendar
  projections into it would couple two independently disabled modes and enlarge a sensitive data
  store. One calendar authority keeps its alarm and storage isolated while using the same day-side
  transport.
- Cloudflare documents one alarm per Durable Object, at-least-once invocation, and automatic retry
  up to six times. The calendar authority stores all due work and schedules its one alarm, just as
  the released LINE authority does.
- Calendar volume is bounded by the existing single-location limits. Queues would not remove the
  required transactional outbox or the reconciliation store, so it would add infrastructure and
  tests without deleting code.

**Alternatives considered**:

- Extend `AdapterDelivery`: rejected because its lifecycle and schema are LINE identity/recipient
  state, not a shared provider-neutral store.
- Cloudflare Queues: viable but redundant at current volume.
- Compute the ICS feed by synchronously fanning out to every day object: rejected because it would
  make feed latency proportional to the full horizon and cannot satisfy the Free-plan request
  budget predictably.

**Sources**:

- <https://developers.cloudflare.com/durable-objects/api/alarms/>
- <https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/>
- <https://developers.cloudflare.com/workers/platform/limits/>

## R2 — Event shape and reconciliation

**Decision**: The day outbox gains the minimum provider-neutral calendar facts on every new row:
`endTime` and reservation schedule state, in addition to its existing date, start time, service
label, reservation reference, event type, sequence, and retention boundary. Calendar gets a new
`create` event; LINE does not receive it. The calendar authority materializes current active
pending/approved events and a separate Google desired-state queue.

**Rationale**:

- Calendar needs a non-inclusive end; the existing LINE payload intentionally did not.
- A complete desired schedule fact lets dead post-commit handoffs recover solely by draining the
  durable outbox. No adapter must poll private booking details on the hot path.
- The public/owner create transaction is the only place a pending/approved event can originate, so
  `create` must join that same commit. Approval and reschedule replace the desired projection;
  reject/cancel/expire remove it. Completion/no-show do not alter schedule representation.
- A bounded owner-only reconciliation route reads each day through a new safe projection method.
  That read applies the existing lazy-expiry rule before returning only schedule facts, then hands
  those facts to the calendar authority. This is used after initial configuration or a credential
  gap; routine recovery remains the automatic outbox sweep.
- Reconciliation is cursor-based in batches of seven days. It stays far below the Workers Free
  external subrequest limit (50) and the separate internal-service allowance, and avoids one
  90-day request that is slow even if technically allowed.

**Released-schema compatibility**:

- `__adapter_outbox` already exists in deployed S1 installations. `CREATE TABLE IF NOT EXISTS`
  cannot add columns, so `ReservationDay` checks `PRAGMA table_info` and applies additive nullable
  columns before inserting the first S2 event. Old LINE rows remain valid with null calendar-only
  fields; new calendar rows require them.
- `calendar` has an independent consumer generation and sequence. LINE disable/purge continues to
  delete only `line` rows and never touches calendar work.

**Alternatives considered**:

- Derive end time in the calendar object from current private day state: rejected because the
  consumer should need only the committed event and because terminal state may already hide it.
- Backfill automatically by scanning every day inside the calendar alarm: rejected because it
  would need to duplicate the installation→day configuration builder and could observe pending
  expiry without the authoritative config. The owner reconciliation route reuses the Worker path.

## R3 — ICS wire contract and authentication

**Decision**: Serve one `text/calendar; charset=utf-8` feed at
`GET /api/adapters/calendar/feed.ics?token=<capability>`. The optional
`CALENDAR_FEED_TOKEN` Worker secret is the entire activation/authentication gate. Invalid,
missing, or unconfigured requests return the same 404 response. Valid responses use
`Cache-Control: private, no-store` and never redirect.

**Wire rules**:

- `VCALENDAR` contains one `VEVENT` per active projection.
- `UID` is a stable reservation-derived opaque value under a non-real `.invalid` authority.
- `DTSTAMP`, UTC `DTSTART`, and UTC non-inclusive `DTEND` use canonical basic UTC date-time form.
- pending maps to `STATUS:TENTATIVE`; approved maps to `STATUS:CONFIRMED`.
- `SUMMARY` is the service label only; no description, attendee, organizer, contact, URL, resource,
  or customer field is emitted.
- Content lines use CRLF. TEXT escapes backslash, comma, semicolon, and newlines. Lines longer than
  75 octets are folded on UTF-8 code-point boundaries with CRLF plus one space.

**Authentication rationale**:

- Common subscription clients cannot be assumed to attach a caller-selected Authorization header,
  so a revocable capability URL is the interoperable rung recorded in issue #1.
- The token must be an independently generated 256-bit base64url value, never the owner token.
  The Worker compares fixed-length digests without an early-exit byte comparison.
- URL capability leakage is the main residual risk. Documentation requires redaction from tickets,
  logs, screenshots, and analytics; rotation invalidates the prior URL immediately.

**Sources**:

- RFC 5545: <https://www.rfc-editor.org/rfc/rfc5545>
- iCalendar media type registry: <https://www.iana.org/assignments/media-types/text/calendar>

## R4 — Google authentication: OAuth refresh token, no service-account private key

**Decision**: Use one optional `GOOGLE_CALENDAR_CREDENTIALS` Worker secret containing an exact JSON
object with `clientId`, `clientSecret`, `refreshToken`, and `calendarId`. The operator obtains
offline access with the narrow `https://www.googleapis.com/auth/calendar.events` scope. The Worker
exchanges the refresh token at `https://oauth2.googleapis.com/token`, caches only the short-lived
access token in isolate memory, and sends it only in the Authorization header.

**Rationale**:

- Google documents offline refresh tokens for server-side work when the user is absent and advises
  storing them in secure long-term storage. Cloudflare secrets are encrypted bindings whose values
  are not displayed after definition.
- Google advises avoiding long-lived service-account keys when possible and strongly recommends a
  client library if an application must construct/sign service-account JWTs. This repository has
  no runtime npm dependencies and preserves that boundary. A refresh-token exchange uses standard
  form encoding and removes custom JWT construction and RSA-key parsing.
- Workload Identity Federation is Google's preferred external-cloud alternative when ambient
  identity exists, but current Cloudflare Workers documentation provides no deploy-portable
  ambient identity contract that a self-hosted installation can exchange without additional
  platform-specific provisioning. Making it the default would break the five-minute deployment
  story.
- `calendar.events` is narrower than full Calendar access and permits event operations. The target
  calendar ID stays in the secret so setup/diagnostics never echo an address-like identifier.

**Credential behavior**:

- Exact keys, field types, and size bounds are validated before any request.
- Redirects are manual and rejected. Token and Calendar response bodies are bounded and parsed only
  for allowlisted status/reason fields; bodies and headers are never logged or persisted.
- Removing or invalidating the secret stops new Google calls. Restoring it and running owner
  reconciliation re-drives current desired state.
- Changing the target `calendarId` cannot delete events from the former target without the former
  grant. The documented safe sequence is reconcile/delete while the old credential is present,
  then rotate; otherwise the operator performs manual old-calendar cleanup. Credential rotation
  for the same calendar is transparent.

**Alternatives considered**:

- Service-account JSON and a handwritten signed JWT: rejected for long-lived-key and cryptographic
  implementation risk.
- Add `google-auth-library`: rejected because it creates the first runtime dependency and is much
  larger than the two fixed HTTP exchanges needed here.
- Full in-app OAuth consent/callback flow: deferred. It adds callback state, credential persistence,
  revocation UI, and app-verification obligations; the self-hosted operator can provision the one
  secret explicitly for this outbound-only stage.

**Sources**:

- OAuth web-server/offline access:
  <https://developers.google.com/identity/protocols/oauth2/web-server>
- Calendar scopes: <https://developers.google.com/workspace/calendar/api/auth>
- Service-account guidance:
  <https://developers.google.com/identity/protocols/oauth2/service-account>
- Google service-account security:
  <https://cloud.google.com/iam/docs/best-practices-service-accounts>
- Cloudflare secrets: <https://developers.cloudflare.com/workers/configuration/secrets/>

## R5 — Stable Google identity and mutation protocol

**Decision**: Derive a Google event ID as `sr` plus the lowercase SHA-256 hex digest of the
reservation UUID. Hex characters are a subset of Google's base32hex event-ID alphabet, the result
is within the 5–1024 character limit, the same reservation always maps to the same ID, and the
provider cannot reverse the value to the internal reservation identifier.

**Desired present**:

1. `PUT events.update` the complete allowlisted event body to the stable ID.
2. On 404, `POST events.insert` with that ID.
3. A 409 duplicate after an uncertain insert converges by returning to update, never by minting a
   second ID.

**Desired absent**:

- `DELETE` the stable ID. 2xx, 404, and an already-deleted 410 all mean reconciled absence.

**Payload**:

- `summary`: service label only.
- `start.dateTime` / `end.dateTime`: canonical RFC 3339 UTC instants. The redundant `timeZone`
  field is omitted; Google's documented UTC form uses the `Z` offset alone.
- `status`: `tentative` or `confirmed`; `visibility`: `private`; `transparency`: `opaque`.
- no attendees, description, location, conference data, attachments, reminders, contact, or
  extended property containing the reservation ID.
- `sendUpdates=none` is explicit on mutations.

**Rationale**: Google explicitly recommends client-supplied event IDs to synchronize local entities
and prevent duplicate creation after an uncertain response. Full update is cheaper and simpler than
patch (patch consumes three quota units), and the adapter owns the entire minimal event body.

**Sources**:

- Create events and client-supplied IDs:
  <https://developers.google.com/workspace/calendar/api/guides/create-events>
- Event ID format: <https://developers.google.com/workspace/calendar/api/v3/reference/events>
- Update: <https://developers.google.com/workspace/calendar/api/v3/reference/events/update>
- Delete: <https://developers.google.com/workspace/calendar/api/v3/reference/events/delete>
- Event UTC/time-zone forms:
  <https://developers.google.com/workspace/calendar/api/concepts/events-calendars>

## R6 — Retry, terminal classification, and bounded state

**Decision**: Persist one latest desired mutation per reservation. A newer committed event replaces
older pending work, so recovery sends current state rather than replaying obsolete intermediate
updates. Use the existing bounded absolute retry ladder and alarm batch/deadline constants where
they already fit; add only calendar-specific queue/projection caps.

**Classification**:

- retry: network/timeout, token 408/429/5xx, Calendar 408/429/5xx, and 403 only when a bounded
  parsed reason is `rateLimitExceeded` or `userRateLimitExceeded`;
- configuration/authorization: other token 4xx, Calendar 401, and non-rate-limit 403 — park visibly
  until credentials are corrected/reconciliation is requested;
- permanent payload/not-found target: Calendar 400 and other non-idempotent 4xx — terminal ledger;
- success/convergence: 2xx, create 409→update, delete 404/410.

Google recommends truncated exponential backoff for time-based quota errors and warns against
indefinite retry. One failed reservation is claimed and settled independently, so it cannot block
other due rows. Every row carries the parent `purgeAt`; no send begins at or beyond it. Projection,
dedup, queue, counters, and ledger are capped/pruned. At retention, an unresolved external deletion
is terminally recorded before the local reference is discarded; external Calendar never becomes
the system of record.

**Sources**:

- Error handling: <https://developers.google.com/workspace/calendar/api/guides/errors>
- Quotas/backoff: <https://developers.google.com/workspace/calendar/api/guides/quota>

## R7 — No deployment is required

**Decision**: Complete S2 through local Durable Object integration tests, mocked fixed Google
endpoints, parsed ICS fixtures, type/build/release audits, browser absence/owner-route checks,
security review, and diff review. Do not create a temporary Cloudflare or Google account.

**Rationale**:

- The repository already documents that GitHub publication is sufficient and deployment is
  optional.
- All S2 protocol behavior is deterministic at the HTTP boundary and can be tested with fixtures.
- A temporary account would add credentials, external state, quota/account setup, cleanup, and a
  false sense of production validation while adding no evidence for transactional ordering,
  duplicate delivery, retry classification, or redaction.
- A live smoke test remains an operator-side optional step after an adopter configures their own
  deployment and target calendar.

## R8 — Rollback and namespace boundary

**Decision**: Add `CalendarAdapter` as a declarative SQLite Durable Object export/binding. A
compatible backout is a forward deployment that retains the class, binding, and export until its
bounded data and alarms drain. Never tombstone the namespace or roll back to a version that lacks
the class while state remains.

The new authority creates its full first-release schema. Future column changes require explicit
additive migrations; `CREATE TABLE IF NOT EXISTS` is not a migration. The released
`ReservationDay` outbox gets the explicit additive column check described in R2. The reservation
day alarm stays the existing unconditional retention `deleteAll()` and is never repurposed for
calendar scheduling.

**Sources**:

- <https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/>
- <https://developers.cloudflare.com/changelog/post/2026-06-30-declarative-do-class-exports/>
- <https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/>
