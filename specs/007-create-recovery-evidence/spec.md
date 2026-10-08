# Feature specification: create recovery evidence

**Feature**: 007-create-recovery-evidence
**Date**: 2026-10-08
**Status**: Approved bounded scope
**Input**: Prove recovery of the existing booking-creation transaction and select its storage authority for the current single-location, day-bounded, accountless product. Preserve the existing implementation unless a meaningful new check demonstrates a defect.

## User scenarios and testing

### US1: retry a failed booking safely (P1)

As a customer or operator, I can retry a booking after a persistence failure without losing the original schedule or creating duplicate bookings or deliveries.

**Independent test**: Inject failure after earlier booking writes. Every persisted value stays equal to the baseline. Remove the failure, retry the identical command, then replay it. Only the retry commits a booking and one calendar creation event; the replay changes nothing.

Acceptance scenarios:

1. Given an existing booking and a new free interval, when receipt persistence or the final calendar sequence update fails, the existing booking, schedule, acceptance budgets, receipts, attribution, and queued events remain unchanged.
2. Given that failed command, when persistence recovers, the identical command creates exactly one booking with the server-derived facts.
3. Given the successful retry, when the identical command is repeated, the original result is returned and no persisted value changes.
4. Both public and operator creation preserve their existing pending/approved behavior and attribution. LINE creation events remain absent; the calendar receives one creation event.

### US2: understand the storage decision and its limits (P2)

As a maintainer, I can identify the transaction authority for this bounded product and the evidence still required before expanding into multiple locations or migrating data.

**Independent test**: A comparison decision names one authority for this slice, maps the implemented invariants and tests, and explicitly states unverified migration, cross-location, recovery, cost, and performance claims.

## Edge cases

- Failure after earlier singleton updates must not pass merely because table row counts stay unchanged.
- A failed command must not consume a receipt, acceptance budget, attribution entry, or calendar sequence.
- Optional LINE and calendar delivery retain different event contracts.
- Existing expiry, consent, catalog, and horizon replay rules remain valid.
- Unverified contact details must not silently become a global customer identity.
- A public license reference must not be described as the maintainer's personal attestation about private material.

## Requirements

- **FR-001**: Add exact-value recovery checks against the real local Worker storage runtime, reusing existing fictional fixtures and creation methods.
- **FR-002**: Cover public and operator creation, receipt-write and final calendar-sequence failures, successful retry of the identical command, and a stable replay.
- **FR-003**: Verify booking facts, state revision, details, receipts, partition budgets, attribution, and calendar queue/sequence values rather than only counts.
- **FR-004**: Preserve accountless operation, provider optionality, server-authoritative catalog facts, pending expiry, and existing replay behavior.
- **FR-005**: Record a scoped storage comparison and one canonical authority for this slice without claiming measured superiority or production migration readiness.
- **FR-006**: Map relevant publicly licensed reference tests and update the existing provenance records without changing historical private rights assessments or inflating implementation provenance.
- **FR-007**: Change runtime code only if the new checks demonstrate a reproducible defect. Passing checks alone are a valid test/documentation result.
- **FR-008**: Add no dependency, backend interface, identity policy, UI, environment/provider setting, deployment, data migration, or production operation.
- **FR-009**: Complete standing checks, browser tests, release auditing, independent correctness and simplicity reviews, and task verification.

## Key entities

- **Recovery baseline**: the complete persisted values related to the existing and attempted booking.
- **Creation command**: the unchanged customer or operator input retried after failure.
- **Committed result**: one booking, receipt, budget increment, operator attribution when applicable, and permitted adapter events.
- **Evidence mapping**: current public reference revision, relevant behavior/tests, independent target checks, and explicit limits.

## Success criteria

- **SC-001**: Every injected failure leaves all baseline values unchanged.
- **SC-002**: Every identical retry commits once; every subsequent replay returns the same booking and changes zero values.
- **SC-003**: One storage decision states the supported scope and all known expansion/migration evidence gaps.
- **SC-004**: All required checks pass and no valid review finding remains.

## Assumptions and scope

The existing create implementation already provides transactions, snapshots, expiry, and replay. This feature strengthens their verification; it does not presume a bug or promise new production functionality. Existing publication safeguards remain in force. Publicly licensed source may inform new, independently authored tests; private material and historical rights assessments remain separate.
