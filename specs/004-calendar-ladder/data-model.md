# Data model: Calendar ladder (S2)

The reservation core remains authoritative. Every calendar row is a disposable, bounded projection
of a committed reservation event. No customer name, contact, management proof, resource identifier,
provider credential, response body, or authorization header is stored here.

## ReservationDay additions

### Day calendar descriptor (transient, never pinned)

| Field | Rule |
|---|---|
| `consumer` | literal `calendar` |
| `generation` | positive safe integer minted by `CalendarAdapter` |
| `phase` | `active` or `deactivating`; only active writes new rows |
| `leaseIssuedAt` / `leaseNotAfter` | safe integers; window no longer than shared 30-second descriptor bound |

It is optional and independent of the released LINE descriptor. Neither descriptor enters
`schedule_json`; mode changes apply to current commands without changing a day's pinned catalog.

### `__adapter_outbox` additive columns

| Column | Type | Rule |
|---|---|---|
| `end_time` | nullable `TEXT` | canonical `HH:mm`; null is accepted only on pre-S2 LINE rows |
| `reservation_status` | nullable `TEXT` | `pending`, `approved`, `rejected`, `cancelled`, or `expired`; null only on pre-S2 LINE rows |

Calendar rows require both fields. A `create` event is calendar-only. Existing event types retain
their meaning. Primary key, per-consumer generation sequence, retention boundary, and LINE rows are
unchanged.

### Safe day projection (RPC result; not stored)

```text
date
purgeAt
watermark:
  generation           current calendar generation
  seq                  emitted outbox high-water
events[]:
  reservationId       internal transfer only
  startTime            HH:mm
  endTime              HH:mm
  serviceLabel         1..323 bounded text
  status               pending | approved
```

The method validates a normal `DayConfig`, applies lazy pending expiry in the same transaction, and
then maps only active pending/approved details. Worker strips every private owner-list field before
calling the calendar authority.

## CalendarAdapter SQLite schema

### `meta` (one row)

| Field | Rule |
|---|---|
| `state` | `active`, `deactivating`, or `disabled`; no row represents never configured |
| `generation` | current generation |
| `high_water` | monotonic across disable/re-enable |
| `mode_fingerprint` | SHA-256 of the parsed Google credential object or null; never the secret |
| `google_blocked_fingerprint` | fingerprint whose shared authorization/configuration rejection parks outbound work, or null |
| `google_configured` / `google_seen` | current Google validity and whether cleanup may be required |
| `begin_disable_at` | epoch ms or null |
| `purge_completed_at` | epoch ms or null |
| `sweep_cursor` | canonical date or null |
| `last_reconciled_at` | canonical UTC timestamp or null |
| `reconcile_cursor` | next canonical date or null |

State transitions:

```text
never --valid mode--> active
active --no valid mode--> deactivating --lease wait + purge sweep--> disabled
disabled --valid mode--> active (generation = high_water + 1)
active --Google false→true or fingerprint change--> active + requeue projections
```

The purge sweep carries the retiring generation into each day transaction. A concurrent
reactivation therefore preserves newer outbox rows, and final authority cleanup commits only when
state and generation still match the retiring snapshot. Entering deactivation clears any active
sweep cursor so the post-lease purge begins at the fixed window boundary. The sweep also revalidates
state and generation after every awaited day RPC before it advances that cursor.

Calendar outbox sequence numbers are monotonic across generations within one day. If descriptor
lookup exceeds its 250 ms budget, or an active lease expires before commit, the day atomically
writes the event with recovery generation `0`. This is not an authority generation: the adapter
binds it to the current active generation while accepting it, and leaves it unacknowledged if a
lifecycle transition races that acceptance. Its accepted-event key remains `0:eventId` so an ack
retry cannot be adopted twice across reactivation; the accepted generation column records the
generation that applied it. Normal later events keep the shared sequence order.

### `accepted_events`

| Field | Rule |
|---|---|
| `event_key` | primary key `generation:eventId` |
| `reservation_id` / `generation` / `seq` | validated source identity and ordering evidence |
| `accepted_at` / `purge_at` | canonical timestamp and parent deadline |

This table is dedup/order evidence only. Rows are pruned at the parent deadline. At the hard cap,
live rows are not evicted: new adapter work remains unacknowledged and a bounded overflow record is
surfaced until retention frees evidence. Reservation commits remain unaffected.

### `projections`

| Field | Rule |
|---|---|
| `reservation_id` | internal primary key; never returned in diagnostics/feed/provider body |
| `external_id` | `sr` + domain-separated SHA-256 hex; provider-valid and non-reversible |
| `uid` | domain-separated opaque iCalendar UID under `.invalid` |
| `date`, `stamp_at`, `start_at`, `end_at` | canonical date/UTC instants; immutable feed stamp; `start_at < end_at` |
| `service_label` | bounded schedule label only |
| `status` | `tentative` or `confirmed` |
| `purge_at` | parent retention deadline |

There is at most one row per reservation. ICS serializes only these rows ordered by start/external ID.
Rejection, cancellation, expiry, or retention purge deletes this row without waiting on Google
capacity. If the mutation table cannot retain the provider delete, the transactional day outbox
event remains unacknowledged as recovery evidence. Reconciliation, which has no such event to rely
on, leaves the entire date unchanged unless every required Google mutation fits. Completion/no-show
bookkeeping keeps the confirmed schedule row.

### `projection_watermarks`

| Field | Rule |
|---|---|
| `date` | canonical reservation date; one row per touched day |
| `generation` / `seq` | calendar outbox high-water captured with the authoritative day projection |
| `purge_at` | parent retention deadline |

The calendar authority advances this ordering watermark whenever it accepts an event or replaces a
day from reconciliation. A delayed event at or below the watermark is recorded and acknowledged
without rewriting that date, and an older reconciliation cannot overwrite a newer event. Rows are
bounded by touched dates and removed at the parent deadline or adapter purge.

### `google_mutations`

| Field | Rule |
|---|---|
| `reservation_id` | primary key; one latest desire per reservation |
| `external_id` | stable opaque Google event ID |
| `operation` | `upsert` or `delete` |
| `payload_json` | versioned canonical minimal schedule object for upsert; null for delete |
| `desired_version` | monotonically increments whenever desired state changes |
| `generation` | current adapter generation |
| `attempt` / `next_attempt_at` / `first_attempt_at` | bounded absolute retry state |
| `claimed_at` / `claimed_version` | dead-send lease and stale-outcome guard |
| `status` | `queued`, `sending`, `awaiting-configuration`, `failed` |
| `created_at` / `purge_at` | pending-age source and parent deadline |

A newer projection replaces an older queued/failed mutation and increments `desired_version`.
Settle applies only when both generation and claimed version still match. Delete success removes the
mutation; upsert success removes it because the projection itself is the desired-state record.
Owner reconciliation with valid Google configuration resets every retained failed or
configuration-blocked delete to a new queued version, because its projection row is already absent.
One shared OAuth or Calendar authorization/configuration rejection stores the current non-secret
fingerprint and parks every current-generation mutation. New desired state joins that parked queue;
no further provider call starts for the same fingerprint. Credential rotation clears the marker and
requeues current projections plus retained deletes. Explicit reconciliation also clears it and
requeues the refreshed desired state, so a recovered provider can be retried without secret churn.
At the hard cap, the oldest terminal failed upsert may be discarded to admit newer work; delete
rows and live upserts are never evicted for that purpose, and the prior terminal reason remains in
the bounded ledger.

### `ledger`

| Field | Rule |
|---|---|
| `entry_id` | autoincrement primary key |
| `reason` | allowlisted internal code |
| `operation` | `upsert`, `delete`, `feed-auth`, or `lifecycle` |
| `http_status` | provider status or null |
| `occurred_at` | canonical UTC timestamp |

No reservation/external ID or provider body. Capped to the shared ledger limit and time-pruned.

### `counters`

Name/value aggregates for feed authentication failures, dispositions, delivery success, retry,
terminal reason, sweep faults, overflow, and reconciliation. Names are allowlisted by code; values
are non-negative integers.

## Secrets (bindings, never database rows)

### `CALENDAR_FEED_TOKEN`

- 43-character unpadded base64url, encoding 32 random bytes.
- Compared through fixed-length SHA-256 digests.
- Used only to authenticate the feed URL; rotation invalidates the former URL immediately.

### `GOOGLE_CALENDAR_CREDENTIALS`

Exact JSON object:

```json
{
  "clientId": "fixture.apps.googleusercontent.com",
  "clientSecret": "fixture-only",
  "refreshToken": "fixture-only",
  "calendarId": "fixture@example.invalid"
}
```

Every string is non-empty and bounded; unknown/missing keys reject the entire binding. This clear
object exists only in request/alarm memory. Only a digest discriminator may be persisted.

## Retention and bounds

- Projection, accepted event, projection-watermark, and mutation rows carry the day
  partition's frozen `purgeAt`.
- No provider call begins at/past `purgeAt`; unresolved cleanup is terminalized before local delete.
- `projections` and `google_mutations` each cap at 2,000 rows. Overflow affects calendar only and is
  visible in counters/ledger. A terminal event remains unacknowledged after its local ICS row is
  removed, or reconciliation retains its stale date projection set, until every required Google
  upsert and delete for that date fits. Failed upserts yield to newer work before either path defers.
- The ledger uses the released 500-row/30-day bounds; reconciliation/sweep cursors are scalars.
- When both modes are absent and the final purge sweep completes, projection/mutation/event rows and
  calendar outbox consumer rows are gone; bounded aggregate diagnostics drain to quiescence.
