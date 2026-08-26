# Research: Reuse-First Porting Boundary

## R1. Where does issue #60 split into reviewable work?

**Decision**: This feature completes Phase 0 only: policy, evidence boundary, initial current-state classification, contribution gate, and public/private documentation. The storage/transaction comparison is the next feature.

**Rationale**: Selecting a canonical storage authority requires representative multi-location, cross-day, migration, recovery, query, cost, and concurrency evidence. Mixing that architecture decision into a governance slice would make the result harder to review and would violate the approved scope.

**Alternatives considered**:

- Include the storage ADR now. Rejected because the user approved Phase 0 only.
- Publish only an audit report. Rejected because it would not prevent future parallel reimplementation.

## R2. What counts as current implementation reuse?

**Decision**: Claim `Copied` or `Generalized` only when source identity or retained implementation evidence exists. Similar behavior, shared product requirements, or reuse of patterns already inside the public project is not production-code reuse and is classified `Reimplemented`.

**Rationale**: The exact date parser has reproducible byte-identity evidence and an approved one-file boundary. The reservation kernel's original plan explicitly prohibited additional source inspection or copying. The day-partitioned storage differs materially from the relational production model. Later customer, LINE, calendar, and staff slices reused the public project's own primitives and specifications, but no evidence shows that the production implementation, schema, or regression tests were carried over.

**Initial current dispositions**:

- Date parser: `Copied`.
- Reservation command kernel: `Reimplemented`.
- Storage and transaction authority: `Reimplemented`.
- Customer booking journey: `Reimplemented`.
- LINE identity and notification adapter: `Reimplemented`.
- Calendar feed and outbound adapter: `Reimplemented`.
- Staff and role boundary: `Reimplemented`.
- Customer data, credentials, installation branding, deployment identifiers, private runbooks, and private history: `Excluded-private`.

**Alternatives considered**:

- Call behaviorally similar slices `Generalized`. Rejected because that would overstate implementation provenance.
- Leave every non-copied row unclassified. Rejected because the current independent implementation is itself a verifiable disposition.

## R3. Where does exact evidence live?

**Decision**: Keep one tracked private ledger in the separate non-public development workspace. Publish a field-allowlisted projection in `docs/PORTING.md`.

**Rationale**: The private workspace already holds migration and audit evidence and is never the publication artifact. A tracked ledger is durable; an ignored temporary file is not. A separate public projection makes accidental disclosure visible in review.

**Alternatives considered**:

- Store the ledger in an ignored directory inside the public clone. Rejected because ignored evidence is easy to lose and hard to review over time.
- Put exact source paths in the public ADR. Rejected because issue #60 explicitly excludes private repository coordinates and history.
- Make the public summary authoritative and keep only private fields in an augmentation file. Rejected because issue #60 requires the private ledger itself to bind disposition and evidence, and splitting one record across authorities still requires a two-file consistency review.
- Build a projection generator. Rejected for eight initial rows; manual projection plus review is smaller and sufficient.

## R4. How are stale mappings detected?

**Decision**: The private ledger records verified source and public revisions, last verification date, evidence owner, and assessment status. Any later source revision makes the corresponding mapping stale until rechecked.

**Rationale**: A file path alone does not prove that the reviewed implementation still occupies that path. Revision binding makes the race between inspection and documentation explicit without exposing private history publicly.

**Alternatives considered**:

- Record only paths. Rejected because paths survive semantic rewrites.
- Copy source snippets into the ledger. Rejected because paths, revisions, and tests are sufficient evidence and snippets create another stale copy.

## R5. Which public artifacts must never disappear?

**Decision**: Register `docs/ADR-0001-REUSE-FIRST-PORTING.md` and `docs/PORTING.md` in both the public manifest and the release audit's required-path set.

**Rationale**: The ADR controls future implementation choices, and the summary prevents capability parity from being mistaken for implementation reuse. Losing either silently would reopen the divergence problem.

**Alternatives considered**:

- Add only the manifest entries. Rejected because a later manifest edit could remove the documents without failing the required-path check.
- Add every feature planning artifact to the release manifest. Rejected because existing feature specs are development history, not required runtime-release documentation.

## R6. How is the policy enforced on contributions?

**Decision**: Extend the existing pull-request template with a conditional production-parity provenance section. Do not add a workflow or parser in Phase 0.

**Rationale**: Review conversations already use the template. A custom parser would need a machine-readable source of truth, exception rules, and maintenance before evidence shows that reviewers cannot enforce the gate.

**Alternatives considered**:

- Add a mandatory CI job now. Rejected as speculative automation.
- Document the rule only in the ADR. Rejected because contributors would not see it at the point of change.

## R7. How does architecture-expanding work pause without blocking security fixes?

**Decision**: The roadmap requires a private ledger row, one disposition, mapped tests, and any required ADR before architecture-expanding parity work starts. Security fixes and work needed to complete the porting audit remain exempt from the pause, but still record their disposition.

**Rationale**: The pause prevents deeper divergence while preserving the project's ability to fix vulnerabilities promptly.

**Alternatives considered**:

- Freeze all changes. Rejected because delaying a security fix would create greater risk.
- Treat the gate as advice only. Rejected because issue #60 explicitly asks to pause divergence-expanding work.

## R8. How are rights and provenance kept separate?

**Decision**: Current disposition, publication-rights status, preferred future porting method, and migration readiness are separate fields. Only the previously approved exact-copy boundary begins as rights-confirmed; all additional copying remains blocked until explicitly confirmed.

**Rationale**: Knowing where code came from does not prove permission to publish it, and permission does not prove migration compatibility.

**Alternatives considered**:

- Infer rights from repository ownership. Rejected because issue #60 requires explicit ownership confirmation.
- Hide current provenance until rights are confirmed. Rejected because that would preserve the maintenance-risk blind spot.

## R9. What verification is proportional for a documentation-only slice?

**Decision**: Run the full existing check, the release audit, the exact date-parser identity comparison, public/private scope scans, GitNexus change detection, correctness review, and ponytail review. Skip browser tests and runtime security scans because no rendered or executable application behavior changes.

**Rationale**: The executable change is limited to two required-path literals in an existing release audit. Full project checks and focused release evidence cover that risk; browser execution cannot add evidence for prose-only changes.

**Alternatives considered**:

- Run only Markdown inspection. Rejected because release registration is executable behavior.
- Add a new test framework or snapshot suite for documents. Rejected because the existing release audit already tests presence, sorting, regular-file status, and public scanning.

## Resolved

No unresolved technical question remains. Storage authority, schema porting, and production-consumption mechanics are explicitly deferred to later specifications.
