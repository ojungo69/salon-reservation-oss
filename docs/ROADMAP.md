# Production-parity roadmap

**Roadmap document version**: 1.0.0 · **Baseline release**: 0.2.0 · **Updated**: 2026-08-12

This file records **order only**: the stages in which the remaining production-parity work lands.
Capability *status* has a single authority — [the production-parity target matrix](PARITY.md) — and
this file links to it rather than restating it. What a production salon system needs that this
project deliberately does **not** target is recorded in
[the deliberate exclusions](PARITY.md#deliberate-exclusions), one link away; nothing there is a
permanent verdict — an exclusion is "excluded from the *current* target", reconsiderable only
through a recorded revision of this roadmap and that matrix.

**Stage status** is exactly one of `Not started`, `In progress`, `Complete`. Recording progress
means editing that one status cell (plus a revision-log line); `Complete` requires the row's
completion evidence to exist. Restructuring the table — adding, splitting, or reordering stages —
is a versioned revision of this document, not a status update.

**Every stage's completion criteria are in addition to the project's standing quality gates**,
stated here so they are self-contained: the full `npm run check` and browser suites; a correctness
review plus a separate over-implementation review for every diff; and, for changes in security
scope (authentication, secrets, validation, hashing, payment-like paths), a security review
battery — rule-based static analysis plus an adversarial security-focused review. No stage is
completable on feature tests alone.

**Dependencies versus recommended order**: `Prerequisites` distinguishes *hard* dependencies (must
exist first) from *recommended* order (priority, revisable by recorded revision). The hard
dependency graph is: S0 before everything; S3 and S4 Complete before S5. The rest of the ordering
(S1 before S2, S2 before S3) is priority, set by issue #1's emphasis.

**Production-parity predicate**: a release may claim production parity only when every row of the
target matrix is `Implemented` or `Deliberately excluded`. Completing stages S0–S5 does not
automatically confer the claim — it is read from the matrix as it stands at that time, never from
this table — and the README derives its claim from the matrix for the same reason.

## Stages

| Stage | Status | Delivers | Prerequisites | Completion criteria |
|---|---|---|---|---|
| **S0 — Documentation foundation** | Complete | The two parity matrices, this roadmap, the [adapter extension contracts](ADAPTER-CONTRACTS.md) (four seams × seven dimensions), the README parity classification, cross-document reference alignment (RELEASING, UX-PARITY), release-allowlist registration of the new documents | None | Delivered by the change that merges this document (see the revision log): matrices account for every issue #1 capability, 28 contract rows substantive, existing suites green with zero runtime change |
| **S1 — Optional LINE identity and notifications** | Not started | LIFF bootstrap and login (issue #1's decision fixes LIFF as the frontend surface; check current LIFF versus LINE Mini App branding guidance in-stage), server-side token verification, account-link/friendship state where required, webhook raw-body signature verification, event deduplication and follow/unfollow handling, push notification queueing with retry/backoff and terminal-failure visibility | Hard: S0. In-stage: mechanism research (push-retry mechanism, current LIFF and token-verification endpoints) before the design commits | Issue #1's end-to-end criteria — login verification, invalid webhook signature, duplicate webhook delivery, notification retry — fixture-tested with **zero live LINE dependency in CI** (public repository: no channel secrets; live-channel verification is an operator-side step); security review battery |
| **S2 — Calendar ladder (ICS feed + Google outbound sync)** | Not started | The two unconditional rungs of issue #1's decision: an authenticated outbound ICS subscription feed, then an optional outbound event-synchronization adapter whose **first delivered provider is Google** (the recorded decision names it; the contract stays provider-neutral), with reconciliation visibility. Neither rung affects booking availability. **Bidirectional inbound import is not part of this or any scheduled stage** — see [its target-matrix row](PARITY.md#production-parity-target-matrix) for status and boundary; scheduling it here is a recorded revision of this roadmap | Hard: S0. In-stage: the shared post-commit event delivery foundation, if it does not exist yet — whichever adapter stage starts first builds it (S1 in the recommended order). Recommended: after S1 (priority only) | Feed and Google outbound adapter fixture-tested including duplicate, outage, and reconciliation cases; verified zero availability effect; security review battery for the authenticated feed endpoint and provider-credential handling |
| **S3 — Staff and role boundary** | Not started | Migration path from the single owner secret; authorization, revocation, offboarding, privacy design; the accountless customer path preserved | Hard: S0. Recommended: after S2 (priority only). In-stage: an authorization/migration/offboarding/privacy design precedes implementation | Design recorded, implementation landed with the security review battery |
| **S4 — Multi-location boundary** | Not started | Location partitioning, transaction isolation, configuration, operator scoping. Cross-day moves are **not** implied by this stage and no stage schedules them — see [their target-matrix row](PARITY.md#production-parity-target-matrix) | Hard: S0. In-stage: a partition/transaction design precedes implementation | Design recorded, implementation landed with isolation/race evidence and the security review battery for the operator-scoping authorization surface |
| **S5 — Import and migration** | Not started | Stable mapping from an existing production system, dry run, verification, idempotent resume, backup/rollback, auditability, privacy | Hard: S3 **and** S4 Complete — the schemas and storage paths migration writes into must be implemented and verified, not merely designed | Dry-run, backup/rollback, and privacy evidence; security review battery for external-input parsing and personal-data handling |

## Revision log

| Date | Version | Change |
|---|---|---|
| 2026-08-12 | 1.0.0 | S0 status → Complete (delivered by the change that merges this document) |
| 2026-08-12 | 1.0.0 | Initial roadmap: stages S0–S5 established from issue #1 and its recorded 2026-08-11 design decision (adapter direction, LIFF frontend, calendar ladder) |
