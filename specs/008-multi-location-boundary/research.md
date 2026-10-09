# Research decisions — S4

## R1. Booking transaction authority

**Decision:** retain one existing day DO per location/date, with one root settings/roster authority. **Rationale:** S4 needs independent location capacity/configuration/operator rights, not global customer identity or cross-day moves. Existing create/recovery tests already establish the bounded transaction; D1 adds no required cross-partition invariant here. **Alternatives:** public relational D1 reference provides stronger same-batch actor revocation and global customer/time locks, but adopting it requires a mapper and recovery work not authorized in S4. Hybrid writes add reconciliation without a requirement.

Public behavioral reference is the openly licensed application at [revision d2307b0](https://github.com/ojungo69/reservation-line-homepage-source/tree/d2307b036973a6a9422d015f2fc65c7841141aca), already assessed in ADR0002. Relevant public evidence: `migrations/0001_initial.sql` store/resource/slot uniqueness; `migrations/0056_store_reference_integrity.sql` catalog/store consistency; `src/admin/write-authorization.ts` commit-time authorization; `test/admin-store-scope-fail-closed.test.ts` absent scope refusal. Preserve equivalent location isolation/fail-closed outcomes with independently authored tests. No source, fixture, test or DDL was copied.

## R2. Names, old data and alarms

**Decision:** default addresses/JSON unchanged, additions in lazy side tables/new names. **Rationale:** current strict serialized-state readers would reject indiscriminate new defaults; existing `__` side-table pattern already solves additive features. A disposable installed-workerd probe with compatibility date 2026-08-08 confirmed `ctx.id.name` for fetch and actual alarms for both `installation` and `location:studio-east`. [Cloudflare documents](https://developers.cloudflare.com/durable-objects/api/id/) name availability and missing-name exceptions. Verify the exact legacy ID for fallback; reject other nameless objects. No persistent name migration is required.

## R3. Staff and browser identity

**Decision:** owners global, legacy staff default-only, explicit empty grant none; new projection endpoints avoid altering old response JSON. Keep existing reservation authorization timing (S3 R13) and recheck rights mutations under their root transaction. Namespaced browser keys preserve exact old proof/draft/pending shapes. Explicit unknown URL never selects another location. **Rejected:** universal staff grant from absent data, proof lookup by current selector, persistent operator tokens, and a global customer/contact hash.

## R4. Optional providers

**Decision:** complete per-location actors, one shared LINE realm and existing Google credential set. **Rationale:** local links/friendship/send claims retain their current atomic boundary; webhook fanout is bounded by four locations. Root lifecycle multiplexing needs one earliest-due scheduler. Shared identity RPCs would introduce a revocation-to-send race; multiple provider accounts are unnecessary scope. Current Calendar implements direct refresh-token use, not OAuth callback onboarding.

Named feed tokens are random/digest-only; deriving them from the already-shared default feed capability would broaden that capability. Named Google target is immutable once bound to avoid redirecting old queued writes/deletes. [LIFF login](https://developers.line.biz/en/reference/liff/#login) permits query differences on the same endpoint path; preserve fixed same-origin returns and SDK initialization rules. [LINE webhook guidance](https://developers.line.biz/en/docs/messaging-api/receiving-messages/) describes signature verification and bot destination identity; the shared callback remains one realm.

## R5. Resource evidence and optimization

**Decision:** four-location product bound; keep 60-second sweep baseline and publish conditional cost scenarios. **Rationale:** each actor still scans its own window, but aggregate quotas are shared. Nominal empty 24-hour arithmetic at current cadence is 22,697 day-drain RPCs + 1,440 alarms = 24,137 requests per actor, excluding all other work. This is neither measured live traffic nor a worst-case delivery bound; `more`/pending consumes additional batch slots. [Current pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) counts RPC calls/alarms and alarm writes. Multiple locations do not inherit the former single-location Free-plan claim.

**Alternative:** idle-only 300 seconds may lower empty work, but a shared-constant change delays Calendar retry/claim polling and changes LINE late-terminal behavior. Defer this optimization beyond S4; any later proposal requires tests of earliest due work, cold restart, lost handoff, full outbox backlog, retention and disable.

## R6. Design and readiness

**Decision:** use the two selected generated references and the existing ink/native-control UI. **Rationale:** adding location choice/context/grants requires real usable flows without redesigning the app. Exact image hashes/prompts/limitations are in `design/`. New named calendar controls follow the same setup panels. Implementation screenshots, accessibility and end-to-end tests remain pending. Data migration, provider/account changes and production operations are excluded; migration requires separate confirmation.
