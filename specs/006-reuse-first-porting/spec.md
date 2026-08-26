# Feature Specification: Reuse-First Porting Boundary

**Feature Branch**: `feat/reuse-first-porting`

**Created**: 2026-08-26

**Status**: Approved

**Input**: User description: "Read the GitHub issues and development design documents, continue the work, and verify whether the existing reservation system is being reused effectively. Reuse it where useful, but do not force reuse where it is unnecessary." This slice implements Phase 0 of issue #60 only.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Classify Existing Implementation Provenance (Priority: P1)

As a maintainer, I can see how each implemented production-parity capability reached the public project, so I can distinguish proven reuse from an independent implementation before extending it.

**Why this priority**: Without an explicit provenance record, capability parity can hide duplicated implementations and incompatible invariants.

**Independent Test**: Review the private porting ledger and public-safe summary for every currently implemented parity capability and confirm that each assessed row has one disposition, an evidence owner, and supporting evidence appropriate to its visibility.

**Acceptance Scenarios**:

1. **Given** a capability already implemented in the public project, **When** its provenance is reviewed, **Then** it has exactly one current disposition: Copied, Generalized, Reimplemented, or Excluded-private.
2. **Given** an exact-copy claim, **When** its evidence is checked, **Then** content identity and the approved source boundary are independently verifiable without publishing private evidence.
3. **Given** a reimplementation, **When** its row is reviewed, **Then** the reason, preserved or changed invariants, test relationship, migration consequence, and evidence gap are visible.
4. **Given** private source coordinates or ownership evidence, **When** the public summary is generated or reviewed, **Then** no private path, repository name, account identifier, customer information, deployment detail, or private history appears.

---

### User Story 2 - Prevent Silent Parallel Reimplementation (Priority: P2)

As a contributor, I am prompted to state the source disposition and test relationship for every production-parity change before it can be reviewed as complete.

**Why this priority**: A durable contribution gate prevents the project from returning to two independently maintained implementations after the initial audit.

**Independent Test**: Start a hypothetical production-parity change and verify that the contribution checklist requires a disposition, private-ledger update, reused or mapped tests, sanitization statement, and any required reimplementation justification.

**Acceptance Scenarios**:

1. **Given** a parity pull request, **When** the contributor completes the checklist, **Then** it identifies exactly one disposition and the tests reused or mapped.
2. **Given** a proposed reimplementation, **When** no reason or equivalent evidence is supplied, **Then** the checklist leaves the change visibly incomplete.
3. **Given** a security fix, **When** the porting audit is still open, **Then** the fix may proceed while still recording its disposition and public-safety boundary.

---

### User Story 3 - Read Capability and Provenance Separately (Priority: P3)

As a public user or maintainer, I can tell whether a capability exists, whether its implementation came from production-tested material, and whether migration readiness has been established without seeing private development details.

**Why this priority**: Capability status, implementation provenance, and migration readiness answer different questions and must not be collapsed into one parity claim.

**Independent Test**: Read the public parity and porting documents alone and correctly identify one copied capability, the current independently implemented foundations, the excluded-private boundary, and the work that remains blocked pending later decisions.

**Acceptance Scenarios**:

1. **Given** an implemented capability, **When** a reader views the parity documentation, **Then** capability status links to a separate public-safe provenance record.
2. **Given** a capability marked Reimplemented, **When** migration readiness has not been proved, **Then** the documentation does not imply that production data or behavior can already migrate safely.
3. **Given** architecture-expanding parity work, **When** its source disposition and required decision record are absent, **Then** the roadmap identifies it as blocked rather than ready.

### Edge Cases

- A broad capability contains mixed provenance. It must be split into smaller rows until each row has one disposition.
- Ownership or publication rights are not confirmed. The row remains blocked and no source material is copied, even when its current disposition can be described.
- Production behavior is useful but its implementation is unsafe or unsuitable for publication. The row may be Generalized or Reimplemented only after recording the reason and compatibility evidence.
- A public-safe summary cannot support a claim without revealing private coordinates. The public row states the conclusion and evidence class only; exact coordinates stay in the private ledger.
- A security fix is urgent while architecture-expanding parity work is paused. The security fix proceeds with the smallest required provenance record and does not expand unrelated architecture.
- A capability has not yet been assessed or implemented. It is listed as pending assessment, not assigned a false disposition.
- The private ledger and public summary disagree. Verification fails until the public statement is corrected or the private evidence is updated.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The project MUST record a durable decision that makes reuse and generalization of production-tested code, schema, tests, and operational invariants the default for production-parity work.
- **FR-002**: The decision MUST permit reimplementation only when reuse is unsafe, legally unavailable, technically incompatible, or demonstrably inferior, with the reason and compatibility evidence recorded.
- **FR-003**: The decision MUST preserve the provider-neutral, self-hostable core and MUST keep optional integrations non-blocking and inactive until configured.
- **FR-004**: The project MUST maintain a private porting ledger outside the public release surface.
- **FR-005**: Each assessed ledger row MUST include capability, exact source mapping, ownership or publication-rights status, one disposition, source-test mapping, public evidence mapping, sanitization work, evidence owner, assessment status, and last verification date.
- **FR-006**: A broad capability with mixed provenance MUST be split until every assessed row has exactly one disposition.
- **FR-007**: The initial ledger MUST cover the exact copied date parser; reservation command kernel; storage and transaction authority; customer booking journey; LINE identity and notification adapter; calendar adapter; staff-role boundary; and excluded-private data, credentials, branding, deployment identifiers, and private history.
- **FR-008**: The project MUST publish a sanitized provenance summary that reports disposition, evidence class, and migration-readiness status without private coordinates or sensitive data.
- **FR-009**: The public summary MUST distinguish current implementation provenance from the preferred disposition for a future port.
- **FR-010**: Capability parity documentation MUST link to the provenance summary and state that capability status does not prove implementation reuse or migration readiness.
- **FR-011**: The roadmap MUST pause architecture-expanding parity work that lacks a ledger entry and required decision record, except for security fixes and work needed to complete the porting audit.
- **FR-012**: The pull-request checklist MUST require the contributor to state one disposition, the private-ledger update, tests reused or mapped, sanitization result, and any reimplementation justification.
- **FR-013**: Copied claims MUST be backed by reproducible content-identity evidence and an approved publication boundary.
- **FR-014**: Generalized claims MUST identify which production invariants remain unchanged and which installation-specific details moved behind configuration or adapters.
- **FR-015**: Reimplemented claims MUST identify why reuse was rejected, which invariants are preserved or changed, migration and rollback consequences, and equivalent-or-better evidence that still remains to be supplied.
- **FR-016**: Excluded-private rows MUST remain outside public files, fixtures, issue evidence, release artifacts, and public history.
- **FR-017**: This slice MUST NOT alter runtime behavior, storage schemas, public APIs, authentication, deployment configuration, or external resources.
- **FR-018**: The next storage/transaction comparison and any code-porting slice MUST use this ledger and decision as inputs rather than creating a second provenance system.
- **FR-019**: Public release checks MUST fail if new public governance artifacts are absent from the release manifest or if a private ledger enters the public surface.
- **FR-020**: The feature MUST preserve existing local changes and MUST make no production-repository write, deployment, migration, secret change, message, merge, or publication.

### Key Entities *(include if feature involves data)*

- **Porting Ledger Entry**: Private evidence record for one capability with exact source and test coordinates, rights status, disposition, sanitization work, owner, and verification state.
- **Public Provenance Entry**: Sanitized projection of one ledger entry containing only capability, current disposition, evidence class, migration-readiness status, and next gate.
- **Parity Pull-Request Declaration**: Contributor statement connecting a proposed parity change to one disposition, its ledger update, tests, sanitization, and any required justification.
- **Reuse-First Decision**: Durable project rule defining the disposition vocabulary, decision order, exceptions, pause gate, and relationship between the public project and installation-specific overlays.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of the initially enumerated implemented capability rows have exactly one current disposition and an evidence owner.
- **SC-002**: A reviewer can distinguish capability status, implementation provenance, and migration readiness for every public summary row without access to the private ledger.
- **SC-003**: The exact copied date parser remains byte-identical to its approved source, while every independently implemented foundation is labeled without overstating reuse.
- **SC-004**: Every future production-parity pull request is prompted for disposition, ledger evidence, test relationship, and sanitization before review completion.
- **SC-005**: Public scans find zero private repository names or paths, credentials, customer information, account or deployment identifiers, raw denylist terms, proprietary assets, or private history in the new public artifacts.
- **SC-006**: The complete existing verification command and public release audit pass with all new public artifacts represented in the release boundary.
- **SC-007**: The final change contains zero runtime, schema, API, authentication, or deployment behavior changes.
- **SC-008**: Architecture-expanding parity work without a recorded disposition and required decision is visibly blocked, while security fixes remain allowed.

## Assumptions

- Issue #60 is the authoritative product requirement for this slice; issue #1 remains authoritative for capability parity and optional adapter direction.
- This feature closes only Phase 0 of issue #60. Storage-model selection, representative transaction tests, schema porting, and production-consumption design require later specifications.
- The existing production repository remains read-only; its current source, migrations, tests, and documents may be inspected only to build private evidence.
- The current public project is the code source of truth; the separate private development workspace is the correct home for the private ledger.
- A disposition describes current implementation provenance. A future preferred porting method and migration-readiness status are recorded separately.
- Unconfirmed ownership or publication rights block copying but do not prevent recording a private assessment.
