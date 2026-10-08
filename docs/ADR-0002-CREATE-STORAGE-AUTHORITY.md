# ADR 0002: transaction authority for bounded booking creation

- Status: Accepted for the scope below
- Date: 2026-10-08
- Selection: maintainer-delegated implementation decision under [ADR0001](ADR-0001-REUSE-FIRST-PORTING.md)
- Related: [provenance](PORTING.md), [roadmap](ROADMAP.md), feature 007-create-recovery-evidence

## Decision and supported scope

Retain the existing SQLite-backed day Durable Object as the single transaction authority for the current one-location, Asia/Tokyo, day-bounded, accountless booking application. Creation, resource capacity, receipts, booking details, acceptance budgets, operator attribution, and adapter event insertion remain inside its existing synchronous transaction.

This decision follows the implemented contract and recovery evidence. It does not select a universal backend or establish a performance/cost advantage. No second backend, repository interface, hybrid write, storage schema, or application runtime change is introduced.

Before adding global customer identity, multiple locations, cross-day moves, or production-data import, reopen the comparison with those requirements and their concurrency, recovery, migration, querying, and operational evidence. D1 remains a candidate for that later boundary. Existing day partitions are not a design requirement that a better-supported replacement must preserve forever.

## Compared evidence

The separately published [application reference at revision d2307b0](https://github.com/ojungo69/reservation-line-homepage-source/tree/d2307b036973a6a9422d015f2fc65c7841141aca) provides a relational D1 implementation. Its original application code is explicitly [AGPL-3.0-only](https://github.com/ojungo69/reservation-line-homepage-source/blob/d2307b036973a6a9422d015f2fc65c7841141aca/LICENSE); [third-party notices](https://github.com/ojungo69/reservation-line-homepage-source/blob/d2307b036973a6a9422d015f2fc65c7841141aca/THIRD_PARTY_NOTICES.md) retain separate material terms. Here it is behavioral reference evidence, with no source, test, fixture, or DDL copied.

| Question | Current day Durable Object | Public relational reference | Consequence |
| --- | --- | --- | --- |
| Resource capacity and creation authority | Existing real-Worker fifty-way race and synchronous transaction | Reservation and slot-lock writes are one batch, with unique store/resource/slot locks | The current bounded product already has one working authority; a second create implementation would duplicate it |
| Server catalog and history | Service selection, resource eligibility, totals, immutable day snapshots, current consent, and accepted receipts are tested | Relational service snapshots and store/resource/service reference guards | Preserve the existing bounded contract; no migration equivalence is claimed |
| Customer conflict across locations | No global customer model; contact is unverified text and management proof belongs to a booking | Global customer/time locks, plus explicit customer and identity records | Global customer exclusion requires an identity/privacy decision, not hashing arbitrary contact text |
| Expiry and replay | Lazy pending expiry and stable successful receipts for the day-retention window | Stored pending deadlines and lock expiry; idempotency TTL reclamation is part of the booking batch | These are deliberately different lifetimes, not interchangeable schemas |
| Failed writes and recovery | Exact table values and retention alarm remain unchanged; identical retry commits once and replay adds nothing | Failed-batch tests check prior field values; expiry/lock tests retry the actual booking | Map the recovery principle and test the current runtime instead of replacing it without evidence |
| Cross-day operations and querying | One day is the atomic partition; operator queries are bounded | Shared relational model is a candidate for broader queries/transactions | Cross-day and multi-location authority need new representative tests before selection |
| Migration, backup and restore | Existing DO data, bindings, receipts, and alarms stay intact; application export/import is not implemented | Migration files exist; no mapper from this DO model is supplied | Neither application migration nor restore compatibility is ready |
| Performance, cost and observability | Bounded lifecycle tests check finite local timing, not a latency threshold or live quota | Source and local SQLite-shaped test evidence only | No live benchmark, billing comparison, or backend superiority claim |

A hybrid has no demonstrated need in this slice. It would add two authorities, reconciliation, and failure windows while solving no missing part of the supported create contract.

## Public behavioral test mapping

References below are relative to the pinned public reference above. Target paths are relative to this repository. All new target recovery tests are independently authored using this repository's existing fixtures.

| Reference evidence | Current target evidence | Limit |
| --- | --- | --- |
| `test/migrations-store-integrity.test.ts`, failed D1-shaped batch preserves the earlier customer-field value | `test/reservation-day.test.ts`, `recovers an identical ... create after ... persistence fails`, compares exact persisted values after receipt/final calendar-sequence failure | Different schema and runtime; this is the rollback principle, not copied SQL or proof of live D1 behavior |
| `test/reservation-submit.test.ts`, expired idempotency row can be reclaimed and the booking succeeds | Identical failed-command retry creates once; later replay preserves the exact committed snapshot | The target retains successful receipts with its day partition, without the reference's idempotency TTL |
| Same reference suite, stranded expired slot/customer locks are reclaimed and rebooking succeeds | Existing `T012 pending expiry` tests release capacity, arbitrate deadline races, preserve replay, and survive restart | No extra target lock table is needed; global customer identity is absent |
| Same reference suite, consent-version change still replays the accepted booking | Existing target tests accept current consent against a pinned schedule and replay earlier successful receipts | No wholesale journey or identity reuse claim |
| Same reference suite, customer overlap in another store is rejected; store-integrity tests reject mismatched references | Current service/resource eligibility and catalog-drift checks; cross-location customer exclusion remains unsupported | This gap is recorded for the next scope decision and is not implemented here |

The new recovery cases cover public and operator creation. Each starts with a committed booking and compares `core_state`, `booking_details`, `adapter_receipts`, `partition_meta`, `closures`, `__attribution` when present, `__adapter_meta`, `__adapter_outbox`, and the retention alarm. Counts alone would miss changes to singleton revision, state JSON, or budgets.

After an injected failure, removing the trigger and retrying the identical command creates one booking with server-derived snapshot facts. Repeating it returns the accepted receipt and changes none of the captured values. Calendar creation adds one event; LINE creation adds none under the existing adapter contract. These assertions do not claim exactly-once external provider delivery.

## Provenance, safety and rollback

Runtime provenance remains Reimplemented. Behavioral mapping does not turn the existing runtime or independently written tests into Copied or Generalized implementations. The public-reference license record is separate from historical assessments of unpublished material; no personal ownership attestation is inferred and no historical Pending assessment is changed.

No identity, authorization, input boundary, secret, provider, endpoint, data schema, binding, or deployment changes. The failure triggers exist only in fictional local test objects and are removed in `finally`. Reverting this test/documentation change requires no data conversion. Worker code rollback and data recovery remain separate operations as documented in [Cloudflare operations](CLOUDFLARE.md#retention-export-recovery-rollback-and-deletion).

Application migration readiness remains Blocked in [PORTING.md](PORTING.md). The next expansion decision needs explicit customer/tenant ownership, partition/transaction tests, import verification, idempotent resume, backout, and recovery evidence before any cutover. Local recovery tests do not establish live provider integration, production performance, backup completeness, or production parity.
