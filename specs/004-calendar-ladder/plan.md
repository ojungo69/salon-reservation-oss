# Implementation Plan: Calendar ladder (S2)

**Branch**: `feat/calendar-ladder` | **Date**: 2026-08-13 |
**Spec**: [spec.md](spec.md) | **Research**: [research.md](research.md)

**Input**: Roadmap S2 and issue #1's authenticated ICS + optional Google outbound decision. This
plan is the sole implementation plan for the slice.

## Summary

Extend S1's post-commit outbox with a second consumer and the minimum schedule facts required by a
calendar projection. A new installation-singleton `CalendarAdapter` Durable Object materializes an
authenticated RFC 5545 feed, stores latest-desired Google mutations, retries them from its own
alarm, and exposes redacted owner diagnostics. ICS and Google are independently activated by two
optional Worker secrets. Google uses a provisioned OAuth refresh token and direct fixed REST
endpoints; no runtime dependency, provider registry, live account, deployment, or inbound calendar
read is added.

## Technical Context

**Language/Version**: TypeScript 7.0, ECMAScript 2024, Node.js 24 for tooling

**Primary Dependencies**: Cloudflare Workers/SQLite Durable Objects and platform Web APIs only;
no runtime npm dependencies

**Storage**: existing per-date `ReservationDay` SQLite DO outbox plus one new installation-scoped
`CalendarAdapter` SQLite DO

**Testing**: Node test runner, Vitest Workers pool, Playwright, TypeScript, Wrangler dry-run,
release audit, npm audit

**Target Platform**: one Cloudflare Worker on Workers Free, Static Assets, SQLite Durable Objects;
local Miniflare/workerd for required verification

**Project Type**: self-hosted web application with Worker API, static browser UI, and optional
in-process adapters

**Performance Goals**: no external call on booking paths; unconfigured path performs no calendar
DO RPC/write; feed reads one bounded local projection; reconciliation processes seven dates per
owner request; alarm sends at most the existing bounded adapter batch

**Constraints**: one Worker, 10 ms Free-plan HTTP CPU target, 128 MB memory, 50 external and 1,000
internal subrequests per Free-plan invocation, six simultaneous outgoing connections, existing
90-day horizon/365-day retention caps, no required new secret, no live provider in CI

**Scale/Scope**: one location, at most 96 reservations created per day partition, 457-day shared
outbox sweep superset, 90-day forward reconciliation, 2,000 bounded calendar projections/mutations
per installation, one Google target calendar

## Constitution Check

*GATE: passed before research; re-checked after design.*

- **I. Production isolation**: no sibling source edit, production resource, provider account,
  Cloudflare account, migration, seed, or deployment. All endpoints use fictional fixtures.
- **II. Audited/public-safe material**: implementation is clean from the public contract and
  primary standards; no private source or history is copied. New files are allowlisted and scanned.
- **III. Public-safe by default**: both secrets are optional. On a never-configured or fully purged
  installation, the calendar descriptor is absent, no outbox row/projection/DO RPC/outbound request
  exists, public shapes stay unchanged, and the entire application builds/tests. A previously
  active installation may retain bounded cleanup state until its final purge; it exposes no feed or
  provider call and keeps the exact privacy disclosure visible until the residual state is gone.
- **IV. Small, verified steps**: reuse the released outbox, retry constants, secret pattern, owner
  gate, redacted ledger idiom, and native Web/SQLite APIs. One new DO is the smallest isolation unit
  that prevents calendar alarms/credentials from entering the LINE authority. No provider factory,
  queue, package, or OAuth UI is scaffolded.
- **V. Specification before migration**: spec, clarification pass, this plan, research, data model,
  contracts, tasks, and verify-task report precede completion. Abuse, data-loss, race, rollback, and
  secret handling are explicit below and in `research.md`.
- **Security gate**: feed capability comparison, secret parsing, token exchange, provider response
  bounds, retry classification, owner routes, diagnostics, and retention receive focused tests,
  static security scan, adversarial review, and secret/release audit.

### Risk design

| Risk | Control and verification |
|---|---|
| Feed URL leaks | Dedicated 256-bit token, digest comparison, uniform 404, no-store, immediate rotation, documentation; invalid/missing tests |
| OAuth secret leaks | One optional Worker secret, exact/bounded parser, no echo/log/storage, bounded response parser, redirect refusal; scan fixtures and diagnostics |
| Lost/duplicate handoff | transactional outbox, consumer sequence/generation, accept dedup, desired-state replacement, fixed sweep; dead-poke and duplicate tests |
| Provider uncertain write | deterministic event ID, update→insert, 409→update, delete 404/410 success; lost-response fixtures |
| Provider outage/quota | per-row claim, bounded backoff, retryable classification, terminal ledger, no booking wait; 429/5xx/exhaustion tests |
| Mutation capacity | retain a terminal event's day outbox row or stale projection until its Google delete fits; never evict the only desired-absence record |
| Configuration gap | no new external call while invalid; retained committed source plus owner cursor reconciliation after restore |
| Data retention | every projection/mutation carries parent purge boundary; pre-send check, terminalize/delete at boundary, bounded ledger/counters |
| Disable/rotation race | descriptor lease validated in day transaction; missing configuration stops new descriptors; old-generation rows cancel/purge after the lease window |
| Availability coupling | calendar data is never read by availability/core; byte-equality tests before/after enable, outage, retry, reconcile |
| Backout/data loss | new DO kept by forward backout until drain; no namespace tombstone; day schema change additive and legacy LINE rows accepted |

## Project Structure

### Documentation (this feature)

```text
specs/004-calendar-ladder/
├── checklists/requirements.md
├── contracts/calendar-api.md
├── data-model.md
├── plan.md
├── quickstart.md
├── research.md
├── security-scan.md       # implementation/review evidence
├── spec.md
├── tasks.md
└── verify-tasks-report.md # post-implementation evidence
```

### Source Code (repository root)

```text
src/
├── adapter-constants.ts    # reuse shared retry/sweep/deadline bounds; calendar caps only
├── adapter-delivery.ts     # LINE consumer behavior unchanged
├── calendar-adapter.ts     # new: ICS, OAuth/Google client, projection/queue/DO
├── reservation-day.ts      # additive calendar consumer/event fields + safe projection
└── worker.ts               # optional descriptors and feed/owner calendar routes

test/
├── adapter-delivery.test.ts # regression: LINE ignores calendar create/fields
├── calendar-adapter.test.ts # new protocol/authority/security/race fixtures
├── reservation-day.test.ts # outbox migration, two consumers, projection/availability
└── worker.test.ts           # routes, gating, reconcile, redaction, zero-provider shape

tests-browser/
└── owner.spec.ts            # owner diagnostics/reconcile and customer-surface absence

docs/
├── CALENDAR-SETUP.md        # new operator setup/rotation/recovery/live optional check
├── CLOUDFLARE.md            # optional secrets and backout boundary
├── PARITY.md                # two calendar rows → Implemented with evidence
├── PRIVACY.md               # exact schedule facts and URL/provider risks
├── RELEASING.md             # CalendarAdapter forward-backout rule
└── ROADMAP.md               # S2 → Complete after all gates

wrangler.jsonc               # new optional binding/export; required secrets unchanged
worker-configuration.d.ts    # generated binding type
.dev.vars.example            # fictional optional local placeholders only
release/public-files.txt     # sorted registration of new public files
scripts/release-audit.mjs    # required new operator doc/source/test where appropriate
```

**Structure Decision**: Keep the current single application layout. `calendar-adapter.ts` is one
module because its pure protocol functions and DO share one private wire model and one concrete
provider. Split only if a second provider is approved; no provider interface/factory exists now.

## Design Decisions

### 1. Two independent configuration gates

- `CALENDAR_FEED_TOKEN`: exactly 43 base64url characters (256 bits). Presence + validity enables
  feed projection and the feed endpoint.
- `GOOGLE_CALENDAR_CREDENTIALS`: exact JSON object of bounded strings:
  `clientId`, `clientSecret`, `refreshToken`, `calendarId`. Presence + validity enables Google
  delivery. The required-secret list remains only owner and Turnstile.
- `CalendarAdapter.descriptor()` returns an active generation/30-second lease when either mode is
  valid. Worker calls it only when a local secret-shape hint says at least one mode may be active;
  exceptions or a 250 ms local deadline omit the calendar descriptor, so booking continues and the
  bounded active sweep recovers any missed post-commit handoff.
- Each alarm/status/feed call re-evaluates both bindings. A transition from zero valid modes starts
  cleanup; a later valid configuration mints a generation above the persistent high-water and
  starts reconciliation/sweep. Google false→true or credential-fingerprint change requeues every
  current projection. Secret values and calendar ID never enter lifecycle storage.

### 2. Generic day outbox extension, not a replacement

- Keep `DayConfig.adapter` as the released LINE descriptor and add optional
  `DayConfig.calendarAdapter`. This avoids renaming the CRITICAL shared configuration surface.
- Widen only consumer validators from `line` to `line | calendar`.
- Add `create` to the generic event vocabulary; emit it only to calendar. All later state-change
  events go to every active consumer.
- Add nullable `end_time` and `reservation_status` columns with an explicit additive migration.
  Old LINE rows may be null; calendar rows must have canonical values.
- `#emitAdapterEvents` loops the two optional descriptors within the existing transaction. A stale
  LINE lease keeps the released one-refresh retry. A stale optional calendar lease skips only that
  outbox emission; the committed day projection remains available to owner reconciliation, so
  calendar rotation or disable cannot roll back a reservation.
- `#adapterHandoff` independently pokes `ADAPTER_DELIVERY` and `CALENDAR_ADAPTER` after commit.
  The reservation-day retention alarm is untouched.

### 3. Calendar authority state machine

No row represents `never`; persisted state moves `active → deactivating → disabled`, and re-enable
increments `highWater`. Active persists only a non-secret SHA-256 fingerprint of the parsed Google
credential object to detect rotation; no secret/config field is stored. During deactivation the authority waits for all issued
leases to expire, purges `calendar` outbox rows over the fixed sweep, clears projection/mutations,
and stops its alarm when bounded diagnostics have expired.

Every ingress goes through one desired-state upsert:

- pending/approved projection: upsert active ICS row and replace the Google mutation with latest
  complete desired event (if Google configured);
- rejected/cancelled/expired: retain desired Google absence before removing the ICS row; when the
  mutation cap is full, keep the outbox event or stale projection for the next sweep/reconciliation;
- duplicate/lower sequence: no-op;
- stale generation/past retention/overflow: redacted disposition/terminal record, never booking
  failure.

### 4. Feed renderer

The feed method first rejects an unconfigured mode without creating storage, then authenticates a
configured mode before reading any projection. A configured invalid attempt may increment only its
aggregate failure counter. A valid request reads a bounded ordered snapshot
from one DO transaction and calls a pure RFC 5545 serializer. UID and Google ID use domain-separated
SHA-256 derivatives of the reservation UUID; the clear/reversible reservation ID is never emitted. Responses are CRLF, UTF-8,
escaped/folded, `private, no-store`, and `X-Content-Type-Options: nosniff`. Uniform 404 covers every
inactive/auth failure. Owner diagnostics expose only an aggregate failure count.

### 5. Google delivery

- Token exchange: fixed HTTPS URL, form body, manual redirects, 10-second timeout covering the full
  bounded response body, exact allowlist. Memory cache is keyed by a SHA-256 discriminator of current
  credentials and ends before provider expiry.
- Event endpoint: fixed Google host and percent-encoded secret calendar ID/path event ID; no caller
  can supply a URL/host. Mutation body is reconstructed canonically from the stored minimal desired
  event for every attempt.
- Claim commits before outbound fetch; a lease recovers dead sends. Settle verifies claim/generation
  before update. Newer desired state invalidates the older outcome.
- Retry uses the existing absolute offsets and send batch. `Retry-After` is not trusted to grow the
  bound; safe HTTP/reason classification is in `research.md` R6.
- No inbound list/sync/watch/free-busy method exists in code or credentials.

### 6. Reconciliation

`POST /api/admin/calendar/reconcile` is owner-authenticated, same-origin, and rate-limited. Input is
an optional canonical cursor date; absent starts today. One call covers at most seven dates through
the existing `toDayConfig` and new `ReservationDay.calendarProjection(config)`, which applies lazy
expiry transactionally and returns only schedule facts. The calendar authority replaces those
dates' projection and Google desired state, including deletion of previously projected rows no
longer present. The projection carries the calendar outbox generation/sequence observed by the day;
the authority advances that watermark for both event delivery and replacement, so neither a
delayed older handoff nor an older replacement can undo newer committed calendar state. Response
returns only `processedDates`, `nextCursor | null`, and aggregate counts. Repeated calls are
idempotent. If every required Google delete cannot fit, the whole date replacement remains unchanged
without advancing its watermark. With valid Google configuration, reconciliation also requeues
retained failed or configuration-blocked deletes that no longer have a projection row. Status
exposes last completed reconciliation and next cursor.

### 7. Owner and public routes

- `GET /api/adapters/calendar/feed.ics?token=...`: uniform 404 except valid active feed; never owner
  auth because the capability is its auth.
- `GET /api/admin/calendar/status`: owner gate; two redacted mode states plus aggregate authority
  health/ledger.
- `POST /api/admin/calendar/reconcile`: owner gate + mutation-origin gate; bounded cursor job.
- Public `/api/config`, booking responses, customer DOM, and asset paths gain no calendar property.
  Calendar is an operator-only adapter, so no new customer runtime module is needed. The existing
  privacy response normally gains a disclosure only while a mode is active or residual cleanup
  state exists; a rate-limited or unavailable residual lookup conservatively renders conditional
  disclosure. It disappears after disabled-and-purged when state can be checked.

### 8. Completion and status changes

Only after feature, full, browser, security, review, and release gates pass:

- add evidence rows to the implemented matrix;
- flip the two calendar target rows to `Implemented (optional adapter)`;
- flip S2 to `Complete` with a dated revision line;
- document exact optional setup, privacy, recovery, credential rotation, safe target-calendar
  change, forward backout, and optional post-deploy smoke check;
- keep inbound availability explicitly excluded.

## Post-Design Constitution Check

Passed. No production access or unclassified source is needed. Two optional secrets and one new
isolated DO are justified by explicit S2 requirements. There is no new runtime dependency,
external infrastructure requirement, customer surface, provider abstraction, or availability
read. Every security/data/race/backout risk has a concrete task and runnable fixture gate.

## Complexity Tracking

No constitution violation requires an exception. The new `CalendarAdapter` namespace is necessary
stateful isolation, not speculative architecture: authenticated feed projection, durable retry,
deduplication, reconciliation, and bounded diagnostics cannot live in a stateless function, and the
released LINE authority has a different credential/data lifecycle.
