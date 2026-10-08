# ADR 0003: bounded multi-location authority

- Status: Accepted design; implementation and acceptance evidence pending
- Date: 2026-10-09
- Selection: maintainer-delegated design under [ADR0001](ADR-0001-REUSE-FIRST-PORTING.md)
- Related: [bounded create authority](ADR-0002-CREATE-STORAGE-AUTHORITY.md), [provenance](PORTING.md), [capability status](PARITY.md), feature 008-multi-location-boundary

## Decision

Support at most four locations including the existing default. Retain one SQLite-backed day Durable Object as the single booking transaction authority for each location/date. Keep one root InstallationConfig authority for settings, staff identity and location grants. Reuse complete optional LINE/calendar actors per location; these own post-commit delivery/projections, not booking capacity. No D1, hybrid writes, alternative repository backend or new DO namespace is introduced.

Default object names, serialized settings/roster/day records, request/response bodies, browser proof keys and queued notification v1 bytes remain compatible. Additional locations use new names and lazy side tables; reading the new application does not convert or backfill existing data. New locations begin in demo with integrations off. Location IDs and bound named calendar targets are immutable in this feature; display names/settings remain editable. Retained bookings remain manageable after a location is paused.

Owners remain installation-wide; legacy staff retain default-only scope, and explicit empty scope means no location. Rights changes check current authority within the root transaction. Reservation requests already authorized may finish under the existing S3 boundary; this design does not claim atomic revocation across separate objects. Customer contact text is unverified, so identical contact at different locations is allowed and never becomes a global customer/time lock.

## Comparison reopening ADR0002

| Requirement | Location/day DO extension | Public relational reference | Decision |
| --- | --- | --- | --- |
| Same local resource/time in separate salons | Independent transactions, receipts and budgets | Unique store/resource/time locks | Preserve isolation and prove two concurrent fifty-way races |
| Resource/catalog ownership | Selected location catalog plus existing immutable day snapshot | Store-reference integrity guards | Map outcome with colliding local IDs and wrong-location tests |
| Scoped staff and revocation | Root grants; existing in-flight reservation boundary | Same-batch actor/store authorization can be stronger | Preserve stated boundary; prove next-request and rights-write behavior |
| Global customer identity/cross-day moves | Deliberately unsupported | Shared relational identity/locks/batches | Reopen authority selection if these requirements are accepted later |
| Failure/retry/history | Existing exact rollback/receipt/outbox/alarm recovery reused | Relational failed-batch evidence | Expand independent public tests; no mapper or migration claim |
| Querying and cost | One selected-location seven-day schedule; bounded directory/fanout | Broader joins/aggregation possible | No cross-location report needed; no measured backend cost winner |

The openly licensed [application reference at d2307b0](https://github.com/ojungo69/reservation-line-homepage-source/tree/d2307b036973a6a9422d015f2fc65c7841141aca) supplies behavioral evidence already documented in ADR0002. No source, fixture, test or DDL is copied. Relevant invariants are store/resource lock isolation, catalog/store consistency and missing-scope refusal. A hybrid solves no additional requirement and would add reconciliation. Runtime provenance remains Reimplemented, with exact evidence mapping retained privately.

## Optional integrations and privacy

Use one shared LINE messaging/login/LIFF realm and the current Google OAuth credential set. Each LINE actor keeps consent links, friendship, queue and send claim together so a remote identity snapshot cannot weaken unlink/unfollow checks. A single authenticated webhook fans out to at most four configured active or still-draining actors with per-actor dedup; root lifecycle scheduling preserves the earliest pending wake-up, and the same accepting transaction checks realm agreement against in-flight enabling operations too. Named notifications add a stored location label in a versioned fragment; prior v1 retries remain exact. There is no global customer record or cross-location consent.

Named calendar feeds receive independent random capabilities; only digests are stored. A default feed reader gains no other feed. Google writes use distinct immutable named targets with existing refresh credentials; no new OAuth onboarding/callback is needed. Configuration errors fail/retry and never mean disabled. Named calendar actors persist the highest applied root configuration version and check it at claim time so a delayed old response cannot undo a newer applied state. Already-started sends retain the existing completion boundary; this is not instantaneous cross-object revocation. All alarms, outboxes, reconciliation and retention stay location-scoped. New owner controls make named setup usable while default environment-managed settings remain unchanged.

## Bounds, evidence and cost

The four-location limit bounds discovery, webhook and lifecycle work; it is not a platform-capacity claim. Keep current 60-second sweep behavior in S4. A slower idle poll is deferred because retry/claim deadlines, drain backlog and LINE late-terminal rules need separate proof. Empty-window arithmetic cannot establish a full-backlog deadline: a day returning more/pending consumes repeated batch slots.

Nominal empty polling with both optional adapters at four locations is approximately 193,000 DO requests/day before customer/operator/provider/configuration work. This already exceeds the currently documented Free-plan daily request allowance. Therefore S4 does not claim that all supported multi-location configurations fit the Free plan. Record local measured scenarios separately from source-derived arithmetic; no live quota, billing or performance verification is asserted. See [Cloudflare pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/).

The installed-runtime experiment confirms canonical names reach actual DO alarm handlers. [Cloudflare's ID contract](https://developers.cloudflare.com/durable-objects/api/id/) also documents missing-name cases; fallback is allowed only when the object ID equals the known legacy default ID. Unknown names/locations fail closed. This experiment is a routing prerequisite, not proof that the feature is implemented.

## Acceptance and backout

Implementation must pass exact legacy compatibility, cross-location races/rollback/proof isolation, the full staff route matrix, stale browser response protection, local provider consent/delivery/feed/target isolation, lifecycle/retention/restart tests and all standing quality/security/browser/current-head review gates. Generated design references precede UI code; actual browser evidence remains required. Capability stays Planned until that evidence exists.

Use a forward backout retaining named-location readers/routes, namespaces and alarms until retained data can be served and expire safely. A pre-S4 code rollback is not a data rollback. No existing-system import, migration, export, restore, cutover, production or provider-account operation is included. Actual data migration requires separate user confirmation and remains unstarted; this design is not a migration tool or readiness claim.
