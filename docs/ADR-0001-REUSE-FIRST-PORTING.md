# ADR 0001: Quality-Led Reuse and Production Porting

- **Status**: Accepted
- **Date**: 2026-08-26
- **Revised**: 2026-09-12, by the maintainer's explicit development direction
- **Decision owner**: Project maintainer
- **Related**: issue #60, issue #1, [capability parity](PARITY.md), [public provenance](PORTING.md)

## Context

Capability parity does not show how an implementation was produced. A public project can expose behavior similar to a production system while independently maintaining different schema, transaction, identity, delivery, and recovery rules. That creates duplicate bugs, incompatible migrations, and evidence gaps hidden behind a single `Implemented` label.

The project needs one public-safe rule for future parity work and one private evidence record for exact source coordinates. It must preserve the provider-neutral, self-hostable core and must not publish installation data, credentials, identifiers, branding, operational details, or private history.

## Decision

The objective is a better reservation product, not a maximum reuse percentage. Evaluate the production-tested implementation first as evidence, not as an architecture that must be retained. For each capability:

1. Reuse or generalize production-tested implementation and tests when this provides the best supported outcome and publication rights, public safety, and compatibility are confirmed.
2. Reimplement when the replacement demonstrably improves correctness, usability, accessibility, operability, maintainability, or measured performance/cost, or when reuse is unsafe, legally unavailable, or technically incompatible. Carry forward the important behavioral tests even when the implementation changes.
3. Record the comparison, preserved or deliberately changed invariants, evidence, and migration/rollback consequences. A prettier mockup is not correctness evidence; a smaller source file is not by itself a product improvement.
4. Keep customer data, staff data, credentials, account/resource identifiers, deployment output, installation branding, private runbooks, proprietary assets, private history, and raw denylist terms private.

Existing plans, completion labels, and work already invested do not justify keeping an inferior design. The maintainer authorizes replacing them when the evidence supports a better product. This does not authorize deleting production data, rewriting published history, changing live deployments, bypassing security gates, or purchasing services.

The terms `reuse-first` in older issue and planning records mean inspection-first and evidence-preserving, not mandatory code reuse. This revision governs future selection decisions. It does not change the historical provenance recorded in PORTING.md or claim any capability newly implemented.

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

Release audit enforces the ledger boundary across the Git-visible working tree, staged index, reachable file history, and reachable commit messages. It fails closed when Git cannot be inspected or the checkout is shallow; CI therefore fetches complete history. Message scanning detects the mandatory ledger marker without printing the matching message; it is not a claim to detect every possible unmarked secret.

## Contribution gate

Every pull request that implements or alters a production-parity capability must:

1. select exactly one disposition for each capability;
2. update the private ledger with exact source/test mapping and an evidence owner;
3. name reused or mapped public tests;
4. confirm the public diff contains no private material;
5. document the outcome comparison and equivalent-evidence gaps for a reimplementation; and
6. link an ADR when storage, transaction authority, identity, or delivery semantics change.

Non-parity changes use the explicit not-applicable path.

## Review-to-merge loop

Before merging any PR, read bot comments, inline review threads, check annotations, and CI results for the current head. Reproduce or inspect each finding rather than accepting or dismissing it because a bot wrote it.

Fix every valid in-scope finding, add a regression test where applicable, rerun the affected tests and standing quality gates, and obtain a fresh review of the changed head. Repeat until no valid unresolved finding remains. Reply with evidence before resolving a thread. A false positive may be declined with a concrete explanation; an unrelated pre-existing issue may be tracked separately only when it does not invalidate this PR's safety or acceptance criteria.

Do not merge while required checks fail or are pending, a valid finding remains, or a requested current-head review is outstanding. A bot outage, quota refusal, or unavailable verification is a reported blocker, not a clean review. Do not bypass protections or weaken tests to obtain a green check. Re-read the head and merge with an expected-head SHA so an unreviewed concurrent change cannot slip in.

## Image-first design gate

Generate actual visual design images before implementing a new or substantially redesigned UI. Compare customer booking and operator work separately: the customer needs a calm, mobile-first journey; the operator needs a legible, information-dense schedule and reliable recovery controls.

Select and refine a direction using the maintainer's delegated design judgment, recording who selected it without claiming personal approval the maintainer did not give. Record the actual image reference, supported task flows, typography, spacing, color/contrast, responsive behavior, and loading/empty/error/conflict states before writing the corresponding UI. A brief without a generated image does not satisfy this gate.

Use fictional data and neutral branding only. Do not send private screens or customer data to an image service. A concept may show planned functionality only when labeled as a target, not as delivered software. After implementation, compare real browser screenshots with the selected reference and run keyboard, accessibility, narrow-screen, and end-to-end checks. An attractive image does not substitute for those checks.

## Pause boundary

Architecture-expanding parity work is blocked until its ledger row, disposition, mapped tests, and required ADR exist. Security fixes and work required to complete the porting audit may proceed, but still record their disposition and remain inside their stated scope. Bounded comparison experiments may proceed with fictional data and explicit acceptance questions; they are not production migrations and must not become an indefinite documentation-only substitute for delivery.

This decision does not select the canonical storage model. Compare the relational production model, the current day-partitioned model, and a hybrid only if representative requirements justify it. Use multi-location, cross-day, migration, backup/restore, querying, observability, cost, and concurrency evidence. Neither D1 nor Durable Objects wins by default. Select one canonical transaction authority for the first production-capable slice rather than committing to permanent parallel backends.

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

- why the replacement is preferable to reuse/generalization;
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
- Production-tested behavior and tests inform decisions without freezing architecture or design.
- Public reviewers can audit conclusions without receiving private coordinates.
- Provider-neutral and secret-free operation remains mandatory.
- Product quality, not sunk cost or a reuse percentage, determines what is retained.

### Costs

- Maintainers must update a private ledger and public projection together.
- Current independent implementations are labeled honestly even when their behavior is useful and well tested.
- Some parity work pauses while rights, source mapping, or architecture evidence is incomplete.
- Visual selection and current-head review add explicit gates before implementation and merge.

### Residual risk

The pull-request declaration is reviewer-enforced, not parsed by custom CI. Automation may be added only if missed declarations become a measured problem.

## Alternatives rejected

- **Clean-room by default**: rejected because it discards useful production evidence and risks long-term dual maintenance.
- **Mandatory reuse or preservation of the current OSS architecture**: rejected because either can retain inferior behavior for sunk-cost reasons.
- **Capability matrix only**: rejected because capability status cannot prove code/schema/test reuse.
- **Publish exact source coordinates**: rejected because it violates the public/private boundary.
- **Add a provenance generator or CI parser now**: rejected because eight initial rows do not justify a new subsystem.
- **Choose storage authority in this ADR**: rejected because representative architecture evidence belongs in a separate decision.

## Rollback

Reverting this decision requires reverting its public summary, parity/roadmap references, pull-request declaration, and required release paths together. The private ledger remains evidence and records the superseding decision; history is not erased.
