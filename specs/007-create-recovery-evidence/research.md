# Research: create recovery evidence

## Decision: preserve current create until new evidence requires a fix

The existing Worker tests cover server-derived facts, pinned snapshots, consent replay, fifty-way capacity races, expiry, and SQL failure rollback. The rollback assertion counts rows; singleton values, budget contents, the failed command's recovery, and calendar sequence atomicity need stronger evidence. Four cases exercise the two shared creation paths and two late failure points. No failing production behavior is presumed.

## Decision: compare within the current product boundary

The reference's relational locks and store-reference triggers address requirements broader than the current accountless day partition. Arbitrary contact text is not a verified global customer. Multiple locations, cross-day moves, imported data, live recovery, and measured backend cost/performance remain separate evidence requirements. ADR0002 records the scoped authority after the recovery checks.

## Decision: distinguish public license evidence from private attestation

The reference is bound to public revision `d2307b036973a6a9422d015f2fc65c7841141aca` and explicitly publishes AGPL-3.0-only plus third-party notices. Newly authored target tests map its behavioral evidence without copying source, fixtures, or DDL. Existing historical private rights assessments are unchanged.

## Alternatives considered

A new create implementation duplicates working behavior. Global customer locks require a new identity/privacy contract. Permanent backend interfaces or hybrid writes add unproved obligations. Row counts alone miss singleton-update failures. A full benchmark is unnecessary to decide whether to preserve the supported bounded implementation and cannot be replaced by finite local timing assertions.
