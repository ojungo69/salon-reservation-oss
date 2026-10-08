# Implementation plan: create recovery evidence

**Date**: 2026-10-08 | **Spec**: [spec.md](spec.md)

## Summary

Strengthen the existing create transaction with four real-Worker recovery cases. Compare current day-partitioned storage with the publicly licensed relational reference, then retain one authority for the present bounded scope. No runtime rewrite is planned.

## Technical context

Existing TypeScript, Node 24/npm 12, Vitest Workers pool, SQLite Durable Objects, and Playwright. Reuse `test/reservation-day.test.ts` fixtures and calendar configuration. No package, schema, API, or UI change. No benchmark or live-provider claim.

## Constitution check

Production isolation and public-safety pass: fictional fixtures, no external changes, no private source copied. Existing publication gates remain. Specification precedes implementation. The current maintainer-approved scope and ADR0001 govern selection; no new approval flow is needed. Recheck after implementation.

## Project structure

- `test/reservation-day.test.ts`: public/owner × receipt/final calendar-sequence failure; exact baseline comparison, identical retry, unchanged replay.
- `docs/ADR-0002-CREATE-STORAGE-AUTHORITY.md`: scoped comparison and selected authority.
- `docs/PORTING.md`, `docs/PARITY.md`, `docs/ROADMAP.md`: consistent evidence links and limits.
- `release/public-files.txt`: include the new ADR.
- `specs/007-create-recovery-evidence/`: this feature's spec, plan, research, data model, quickstart, tasks, verification report.
- Existing private evidence ledger: append a new public-reference evaluation; preserve historical Pending rights records. This file is never part of the public diff.

## Execution

1. Inspect existing test coverage and the public reference's license/test contracts. Record an evidence row without asserting personal ownership attestation.
2. Add focused recovery tests. Snapshot all booking-related tables in stable order, including attribution and adapter values. Abort receipt INSERT or the calendar-meta UPDATE that follows outbox INSERT. Remove the trigger in `finally`.
3. Assert failure leaves exact values and availability unchanged. Retry the same command successfully, then replay it with no new row, revision, budget, attribution, event, or sequence.
4. If tests pass unchanged runtime, retain the runtime. If a reproducible defect appears, assess and fix only its shared cause.
5. Record comparison, mappings, rollback implications, and unsupported multi-location/migration/performance claims. Run standing checks and browser tests, independent code review and simplicity review, then task verification.

## Risks and rollback

Tests use real local storage and mock only optional external delivery. Clock behavior and asynchronous handoffs must not make snapshots nondeterministic; do not weaken assertions to hide changes. Any runtime/data-contract expansion requires a separate decision. A test/docs revert needs no data migration. No production data is modified.
