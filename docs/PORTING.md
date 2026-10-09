# Implementation provenance and migration readiness

[Capability parity](PARITY.md) says what the project does. This document says how each assessed implementation was produced and whether migration evidence exists. These are separate claims:

- **Capability status**: implemented, partial, planned, or deliberately excluded.
- **Implementation provenance**: Copied, Generalized, Reimplemented, or Excluded-private.
- **Migration readiness**: not assessed, blocked, evidence mapped, or ready.

The governing rule is [ADR 0001](ADR-0001-REUSE-FIRST-PORTING.md): inspect production-tested implementation, schema, tests, and operational invariants as evidence first, then select reuse, generalization, or replacement by the best supported outcome. Record the comparison and equivalent-or-better behavioral evidence for replacements. Neither existing architecture nor work already invested is a reason to retain an inferior component.

## Independent development and optional migration

This is a historical provenance and migration assessment, not the definition of OSS completion. Ordinary independently authored development does not require a private ledger or migration evidence. The private-ledger gate applies to actual ports and changes to the assessed records below, under ADR0001's 2026-10-09 revision.

Migration readiness describes a possible future transfer only. A Blocked or Not assessed migration row does not prevent a standalone OSS release. S5 is optional and outside the current delivery scope. No mapper or transfer is claimed, and any real-data step still requires specific prior confirmation.

## Current assessed provenance

| Capability ID | Capability | Current disposition | Evidence class | Preferred future method | Migration readiness | Next gate |
|---|---|---|---|---|---|---|
| `date-parsing` | Strict JST calendar-date parsing | Copied | Audited byte identity; focused public contract tests | Retain the exact copy | Evidence mapped | Revalidate identity when either implementation changes |
| `reservation-command-kernel` | Reservation command kernel | Reimplemented | Independent command/race suites plus exact-value failed-create recovery and public-reference behavioral mapping | Retain the bounded create contract under [ADR0002](ADR-0002-CREATE-STORAGE-AUTHORITY.md); compare extensions by evidence | Blocked | Map remaining critical invariants and prove application migration/backout before cutover |
| `storage-transaction-authority` | Storage and transaction authority | Reimplemented | Location/day transactions, two fifty-way races, exact recovery and scoped adapter cleanup; public relational comparison in ADR0002/ADR0003 | Retain one location/day Durable Object under [ADR0003](ADR-0003-MULTI-LOCATION-BOUNDARY.md) | Blocked | Separately confirm and prove migration/backout; reopen authority for global identity or cross-day operations |
| `customer-booking-journey` | Customer booking journey | Reimplemented | Independent scoped selection, immutable proof/recovery and rendered browser evidence | Retain the public journey and location-bound storage/navigation contract | Not assessed | Assess existing-system data/identity mapping only in a separately confirmed migration slice |
| `line-identity-notifications` | Optional LINE identity and notifications | Reimplemented | Independent per-location consent/claim, stored v1/v2 bytes and partial shared-webhook retry fixtures | Retain complete local actors and one shared provider realm | Blocked | Map existing consent/delivery states and verify a separately approved transfer/backout |
| `calendar-integration` | Calendar feed and outbound synchronization | Reimplemented | Independent capabilities/targets, configuration epochs, stale completion, outage and restart/backlog fixtures | Retain outbound projections and independent feeds under ADR0003 | Blocked | Prove separately approved mapping/backout; inbound synchronization remains outside the scheduled target |
| `staff-role-boundary` | Staff and role boundary | Reimplemented | Root-atomic grants/current-owner checks, total scoped route matrix and authenticated browser recovery | Retain installation-wide identity with explicit location grants and the S3 in-flight boundary | Blocked | Map existing accounts/grants and verify revocation/backout before a separately confirmed migration |
| `installation-private-material` | Installation data, credentials, branding, deployment details, private operations, and private history | Excluded-private | Public-release allowlist, fictional defaults, and private-boundary audits | Keep private; expose only generic guidance and fictional examples | Not assessed | Repeat boundary checks for every new release surface |

No current row is labeled `Generalized`. Behavioral similarity or reuse of patterns already inside this repository is not evidence that a production implementation was retained.

## Bounded create assessment

[ADR0002](ADR-0002-CREATE-STORAGE-AUTHORITY.md) records the current authority and maps independently authored recovery checks to a pinned, publicly licensed application reference. It verifies failed-create exact-value rollback, identical retry, and stable replay for the existing bounded product. It does not establish application migration readiness, cross-location customer identity, measured backend superiority, or copied implementation provenance. Historical rights assessments of unpublished material remain separate and unchanged.

## Bounded multi-location assessment

[ADR0003](ADR-0003-MULTI-LOCATION-BOUNDARY.md) extends the existing public implementation to four locations: independent location/day booking authority, scoped operators and complete per-location optional adapters. The publicly licensed relational reference informed isolation, catalog ownership and missing-scope comparisons. No source, tests, fixtures or DDL were copied; each affected extension remains **Reimplemented**.

The coordinating evidence owner retains the exact source/test mapping, rights/sanitization record and execution artifacts privately. Public acceptance evidence is in [Spec008 verification](../specs/008-multi-location-boundary/verification.md): default compatibility, location races/recovery, scoped authorization, provider fixtures, generated-image/rendered-browser comparison and the standing checks/reviews. These are candidate capability evidence, not live-provider or migration attestations.

Migration readiness remains **Blocked**. S5 has no mapper, data conversion or existing-system transfer. Any migration-purpose read/export/import/restore/cutover requires the specific confirmation in [AGENTS.md](../AGENTS.md#existing-system-data-migration). Historical rights assessments of unpublished material remain unchanged.

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

A pull request that imports existing implementation/tests or changes an assessed provenance record must select exactly one disposition, update the private ledger, name reused or mapped tests, confirm sanitization, document a reimplementation reason when applicable, and link an ADR when storage, transaction, identity, or delivery semantics change. Independently authored OSS work uses the not-applicable path and public evidence; it does not require private-ledger access.

Actual porting without that evidence remains blocked. Security fixes within that porting scope and work required to complete its audit may proceed and still record their disposition. Independently authored security fixes use public evidence.

## Updating this document

1. Reverify the private ledger row against its bound source and public revisions.
2. Split mixed-provenance capabilities before assigning a disposition.
3. Update the private row first, including rights, tests, sanitization, owner, and next gate.
4. Project only the allowed public fields here.
5. Update [capability parity](PARITY.md) only when capability status changed.
6. Run the full release and project verification gates.
