# ADR 0001: Reuse-First Production Porting

- **Status**: Accepted
- **Date**: 2026-08-26
- **Decision owner**: Project maintainer
- **Related**: issue #60, issue #1, [capability parity](PARITY.md), [public provenance](PORTING.md)

## Context

Capability parity does not show how an implementation was produced. A public project can expose behavior similar to a production system while independently maintaining different schema, transaction, identity, delivery, and recovery rules. That creates duplicate bugs, incompatible migrations, and evidence gaps hidden behind a single `Implemented` label.

The project needs one public-safe rule for future parity work and one private evidence record for exact source coordinates. It must preserve the provider-neutral, self-hostable core and must not publish installation data, credentials, identifiers, branding, operational details, or private history.

## Decision

Production-parity work follows this order:

1. Reuse a production-tested implementation and its tests when publication rights, public safety, and technical compatibility are confirmed.
2. Otherwise generalize that implementation by moving installation-specific names, identifiers, providers, defaults, branding, and operations behind configuration or optional adapters while preserving its invariants.
3. Reimplement only when reuse or generalization is unsafe, legally unavailable, technically incompatible, or demonstrably inferior.
4. Keep customer data, staff data, credentials, account/resource identifiers, deployment output, installation branding, private runbooks, proprietary assets, private history, and raw denylist terms private.

Smaller or cleaner code is not enough reason to replace production-tested behavior.

## Dispositions

Every assessed capability has exactly one current disposition:

- **Copied**: Publishable implementation or tests carried over without semantic change.
- **Generalized**: Production implementation retained while installation-specific details moved behind configuration or adapters.
- **Reimplemented**: Independent replacement, with its reason and compatibility evidence recorded.
- **Excluded-private**: Installation-only or sensitive material intentionally remains private.

Mixed provenance requires smaller rows. A disposition describes current provenance; it does not by itself establish publication rights, preferred future design, or migration readiness.

## Evidence system

Exact source/test coordinates, bound revisions, rights evidence, sanitization work, and evidence ownership live in one tracked private porting ledger outside the public repository. [The public provenance summary](PORTING.md) is a field-allowlisted projection of that ledger.

The public summary may contain only generic capability descriptions, current disposition, evidence class, preferred future method, migration-readiness status, and next gate. It never contains private repository/workspace coordinates, private revisions/history, exact private source/test paths, rights-evidence coordinates, customer/account/deployment identifiers, credentials, raw denylist terms, or proprietary assets.

## Contribution gate

Every pull request that implements or alters a production-parity capability must:

1. select exactly one disposition for each capability;
2. update the private ledger with exact source/test mapping and an evidence owner;
3. name reused or mapped public tests;
4. confirm the public diff contains no private material;
5. document the reason and equivalent-evidence gaps for a reimplementation; and
6. link an ADR when storage, transaction authority, identity, or delivery semantics change.

Non-parity changes use the explicit not-applicable path.

## Pause boundary

Architecture-expanding parity work is blocked until its ledger row, disposition, mapped tests, and required ADR exist. Security fixes and work required to complete the porting audit may proceed, but still record their disposition and remain inside their stated scope.

This decision does not select the canonical storage model. The relational production model and the current day-partitioned model require a separate ADR with representative multi-location, cross-day, migration, backup/restore, querying, observability, cost, and concurrency evidence.

## Canonical-core direction

The desired end state is one provider-neutral public core consumed or tracked by installation-specific deployments. Branding, credentials, customer data, deployment identifiers, and installation-only operations stay outside that core. Equivalent booking rules must not remain independently maintained in two repositories after an accepted porting slice.

## Required evidence by disposition

### Copied

- confirmed publication boundary and rights;
- reproducible content identity;
- source and public tests mapped; and
- no additional private path, fixture, history, or value copied.

### Generalized

- exact source and test mapping;
- unchanged invariants named;
- installation-specific fields and providers named;
- compatibility tests; and
- sanitization evidence.

### Reimplemented

- reason reuse/generalization was rejected;
- old and new invariants, including deliberate differences;
- data migration and rollback consequences;
- equivalent-or-better unit, integration, browser, concurrency, and failure evidence as applicable; and
- performance/cost evidence when efficiency is part of the reason.

### Excluded-private

- exclusion reason;
- public substitute, if any; and
- release-boundary verification.

## Consequences

### Positive

- Capability claims no longer hide implementation provenance or migration gaps.
- Production-tested behavior and tests become the default input to parity work.
- Public reviewers can audit conclusions without receiving private coordinates.
- Provider-neutral and secret-free operation remains mandatory.

### Costs

- Maintainers must update a private ledger and public projection together.
- Current independent implementations are labeled honestly even when their behavior is useful and well tested.
- Some parity work pauses while rights, source mapping, or architecture evidence is incomplete.

### Residual risk

The pull-request declaration is reviewer-enforced, not parsed by custom CI. Automation may be added only if missed declarations become a measured problem.

## Alternatives rejected

- **Clean-room by default**: rejected because it guarantees long-term dual maintenance.
- **Capability matrix only**: rejected because capability status cannot prove code/schema/test reuse.
- **Publish exact source coordinates**: rejected because it violates the public/private boundary.
- **Add a provenance generator or CI parser now**: rejected because eight initial rows do not justify a new subsystem.
- **Choose storage authority in this ADR**: rejected because representative architecture evidence belongs in a separate decision.

## Rollback

Reverting this decision requires reverting its public summary, parity/roadmap references, pull-request declaration, and required release paths together. The private ledger remains evidence and records the superseding decision; history is not erased.
