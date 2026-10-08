# Implementation provenance and migration readiness

[Capability parity](PARITY.md) says what the project does. This document says how each assessed implementation was produced and whether migration evidence exists. These are separate claims:

- **Capability status**: implemented, partial, planned, or deliberately excluded.
- **Implementation provenance**: Copied, Generalized, Reimplemented, or Excluded-private.
- **Migration readiness**: not assessed, blocked, evidence mapped, or ready.

The governing rule is [ADR 0001](ADR-0001-REUSE-FIRST-PORTING.md): inspect production-tested implementation, schema, tests, and operational invariants as evidence first, then select reuse, generalization, or replacement by the best supported outcome. Record the comparison and equivalent-or-better behavioral evidence for replacements. Neither existing architecture nor work already invested is a reason to retain an inferior component.

## Current assessed provenance

| Capability ID | Capability | Current disposition | Evidence class | Preferred future method | Migration readiness | Next gate |
|---|---|---|---|---|---|---|
| `date-parsing` | Strict JST calendar-date parsing | Copied | Audited byte identity; focused public contract tests | Retain the exact copy | Evidence mapped | Revalidate identity when either implementation changes |
| `reservation-command-kernel` | Reservation command kernel | Reimplemented | Independent command/race suites plus exact-value failed-create recovery and public-reference behavioral mapping | Retain the bounded create contract under [ADR0002](ADR-0002-CREATE-STORAGE-AUTHORITY.md); compare extensions by evidence | Blocked | Map remaining critical invariants and prove application migration/backout before cutover |
| `storage-transaction-authority` | Storage and transaction authority | Reimplemented | Day-partitioned transaction and exact-value recovery evidence; public relational comparison in [ADR0002](ADR-0002-CREATE-STORAGE-AUTHORITY.md) | One day Durable Object for the current single-location/accountless scope | Blocked | Reopen the comparison before multi-location, global identity, cross-day operations, or import; prove recovery, migration, queries, cost, and concurrency for that scope |
| `customer-booking-journey` | Customer booking journey | Reimplemented | Independent public journey and browser coverage; no implementation carryover evidence | Generalize reusable states and failure behavior; retain public branding/accessibility system | Not assessed | Map production journey states, recovery cases, and tests before the next customer-parity slice |
| `line-identity-notifications` | Optional LINE identity and notifications | Reimplemented | Independent provider-neutral adapter and delivery tests | Generalize production-tested retry, deduplication, quota, and failure-visibility behavior | Blocked | Confirm rights and map job states plus representative production tests |
| `calendar-integration` | Calendar feed and outbound synchronization | Reimplemented | Independent feed/outbound adapter and reconciliation tests | Generalize production-tested outbound, retry, retention, and recovery behavior | Blocked | Confirm rights; separate targeted outbound behavior from unscheduled inbound scope; map tests |
| `staff-role-boundary` | Staff and role boundary | Reimplemented | Independent generated-credential and recovery design with public role tests | Generalize reusable authorization, scoping, revocation, recovery, and audit behavior | Blocked | Resolve canonical identity/storage contracts and map authorization cases |
| `installation-private-material` | Installation data, credentials, branding, deployment details, private operations, and private history | Excluded-private | Public-release allowlist, fictional defaults, and private-boundary audits | Keep private; expose only generic guidance and fictional examples | Not assessed | Repeat boundary checks for every new release surface |

No current row is labeled `Generalized`. Behavioral similarity or reuse of patterns already inside this repository is not evidence that a production implementation was retained.

## Bounded create assessment

[ADR0002](ADR-0002-CREATE-STORAGE-AUTHORITY.md) records the current authority and maps independently authored recovery checks to a pinned, publicly licensed application reference. It verifies failed-create exact-value rollback, identical retry, and stable replay for the existing bounded product. It does not establish application migration readiness, cross-location customer identity, measured backend superiority, or copied implementation provenance. Historical rights assessments of unpublished material remain separate and unchanged.

## Planned S4 extension

[ADR0003](ADR-0003-MULTI-LOCATION-BOUNDARY.md) selects a bounded four-location extension of the existing public implementation: independent location/day booking authority, scoped operators and per-location optional adapters. This is an accepted design, not delivered capability. Current affected runtime provenance remains **Reimplemented**; no source, tests, fixtures or DDL were copied. The public relational reference informs isolation, catalog ownership and missing-scope tests.

The coordinating evidence owner maintains the required source/test mapping, rights/sanitization record and current public projection separately. Implementation acceptance still requires exact default compatibility, location races/recovery, scoped authorization, provider isolation, rendered browser evidence and standing security/review gates. Migration readiness remains **Blocked**; no mapper, data conversion or existing-system migration has been started or authorized by this design.

## How to read the table

### Current disposition

- **Copied**: implementation or tests carried over without semantic change.
- **Generalized**: production implementation retained while installation-specific details moved behind configuration or optional adapters.
- **Reimplemented**: independent replacement; similarity does not establish reuse.
- **Excluded-private**: installation-only or sensitive material intentionally remains private.

A broad capability with mixed provenance is split until each row has one disposition.

### Preferred future method

This is a planning direction, not a current provenance claim. `Generalize` does not authorize copying and does not pre-decide the storage, identity, or delivery architecture.

### Migration readiness

- **Not assessed**: no compatibility or migration claim exists.
- **Blocked**: a named rights, schema, invariant, test, or rollback gap prevents migration.
- **Evidence mapped**: representative compatibility evidence exists, but cutover is not approved.
- **Ready**: accepted import, verification, rollback, and operational evidence exists.

An implemented capability can still be migration-blocked. A copied helper can have evidence mapped without making the whole application migration-ready.

## Evidence boundary

Exact source/test coordinates, bound revisions, publication-rights evidence, sanitization work, and evidence owners live in a tracked private ledger outside this repository. This page exposes only a field-allowlisted conclusion.

Release audit rejects the canonical private-ledger path or mandatory marker in Git-visible current files, the staged index, and reachable history. A shallow checkout cannot prove that history and fails closed.

Public provenance evidence never includes private repository/workspace coordinates, private revisions/history, exact private source/test paths, rights-evidence coordinates, customer or account identifiers, deployment details, credentials, raw denylist terms, private runbooks, or proprietary assets.

If a conclusion cannot be supported without disclosing private material, the public row states only that evidence is retained privately and names the next public-safe gate.

## Contribution rule

Every pull request that implements or alters a production-parity capability must select exactly one disposition, update the private ledger, name reused or mapped tests, confirm sanitization, document a reimplementation reason when applicable, and link an ADR when storage, transaction, identity, or delivery semantics change.

Architecture-expanding parity work without that evidence remains blocked. Security fixes and work required to complete the porting audit may proceed within scope and still record their disposition.

## Updating this document

1. Reverify the private ledger row against its bound source and public revisions.
2. Split mixed-provenance capabilities before assigning a disposition.
3. Update the private row first, including rights, tests, sanitization, owner, and next gate.
4. Project only the allowed public fields here.
5. Update [capability parity](PARITY.md) only when capability status changed.
6. Run the full release and project verification gates.
