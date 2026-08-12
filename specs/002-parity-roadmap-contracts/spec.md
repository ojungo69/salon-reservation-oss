# Feature Specification: Production-Parity Roadmap and Adapter Extension Contracts

**Feature Branch**: `feat/parity-roadmap-contracts`

**Created**: 2026-08-12

**Status**: Draft

**Input**: Slice 1 of issue #1 ([P0] Define production-parity roadmap and add an optional LINE integration adapter): replace the single sanitized parity matrix with two clearly named matrices, commit a versioned roadmap that stages the remaining issue #1 scope, define documentation-level extension contracts for the four adapter seams, and make the README parity claim unambiguous. No adapter implementation in this slice.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Evaluator sees exactly what exists versus what production parity requires (Priority: P1)

A salon operator or OSS adopter evaluating this repository can determine, from the documentation alone, which capabilities the current release actually implements with evidence, which capabilities a production reservation product additionally requires, and the status of each — without mistaking the current release for production parity.

**Why this priority**: This is the gap issue #1 names first: the current matrix is honest but singular, so a reader can mistake "everything in the matrix passes" for "this replaces a production system". Splitting implemented reality from the parity target is the cheapest change that removes the misreading, and every later slice reports its progress against the target matrix this story creates.

**Independent Test**: Give a reader only the repository documentation and a list of capability questions spanning both matrices (for example "does v0.x send booking notifications?", "is same-day duplicate warning implemented?"). Every question is answerable with implemented (with evidence) / partial (with implemented evidence and the remaining gap) / planned (with stage) / deliberately excluded (with rationale), and the README alone classifies the release as core-feature parity, not production parity.

**Acceptance Scenarios**:

1. **Given** the repository documentation after this feature, **When** a reader looks up any capability named in issue #1 (identity, notifications, calendar synchronization, audit/event delivery, multi-location, staff roles, migration/import), **Then** the target matrix resolves it to one or more atomic capability rows — a decomposition recorded in the matrix itself where a named capability has distinct parts with different statuses (for example calendar synchronization's three integration modes) — and each atomic row carries exactly one status: implemented (with evidence), partial (with implemented evidence and the remaining gap both referenced), planned (with a roadmap stage), or deliberately excluded (with rationale). No atomic row appears twice, and the union of a capability's rows covers everything issue #1 names under it.
2. **Given** the implemented-capabilities matrix, **When** a reader checks any row, **Then** the row still names its public-safe implementation path and acceptance evidence, exactly as the current sanitized matrix does today — no implemented row loses its evidence in the split.
3. **Given** only the README, **When** a reader asks "is this release production-parity or core-feature parity?", **Then** the README states the answer explicitly and links to the two matrices for the detail.

---

### User Story 2 - Adapter implementer has binding contracts for the four seams (Priority: P2)

A contributor (or a later slice of issue #1) implementing an external integration — identity, notifications, calendar synchronization, or audit/event delivery — can read a contract that states what the core guarantees, what the adapter must guarantee, and what happens on failure, before writing any code, so adapters are buildable without renegotiating the core's invariants.

**Why this priority**: The LINE adapter (slice 2) is the immediate consumer: its plan starts from these contracts. Without them, each adapter would improvise its own failure, retry, and privacy posture, and the constitution's "adapters are invisible until configured" principle would live only in prose.

**Independent Test**: For each of the four seams, audit the contract document against a fixed checklist of required dimensions (activation/configuration gating, event model, failure semantics, idempotency, retry/backoff with terminal-failure visibility, privacy/data minimization, observability). Every cell is filled for every seam; a reviewer can name, for any adapter failure mode, what the booking path does — it never waits synchronously on an external call, and outbound delivery failure never rolls back an accepted booking; the one deliberate availability effect is that a calendar adapter explicitly configured as an inbound availability authority whose local availability snapshot is unconfirmed or stale blocks the affected slots (fail-closed), which is a property of the pre-synchronized data the booking path reads, not of an in-flight external call — ICS-feed and outbound-only calendar configurations never affect availability.

**Acceptance Scenarios**:

1. **Given** the contract document, **When** a reviewer checks any of the four seams (identity, notifications, calendar synchronization, audit/event delivery), **Then** the contract states requirements for all seven dimensions: configuration gating, event/trigger model, failure semantics, idempotency, retry and terminal-failure visibility, privacy/data minimization, and observability.
2. **Given** any contract, **When** the adapter it describes is unconfigured, **Then** the contract requires that the core behaves exactly as today: no UI trace, no booking-path dependency, no stored external identifiers.
3. **Given** any contract, **When** outbound delivery to the external service fails permanently (for example the external service rejects the event), **Then** the contract requires that already-accepted bookings are never rolled back, the booking path never waits synchronously on the external call, and the failure is visible to the operator rather than silent; for a calendar adapter configured as an inbound availability authority specifically, unconfirmed or stale synchronized availability additionally fail-closes the affected slots per FR-005 — an inbound-data property distinct from outbound delivery failure.
4. **Given** the calendar-synchronization contract, **When** an adapter explicitly configured as an inbound availability authority cannot confirm external availability, **Then** the contract requires fail-closed availability semantics for the affected slots and a visible reconciliation status, as issue #1 specifies — while ICS-feed and outbound-only modes are defined as never affecting availability.

---

### User Story 3 - Migration planner sees the staged path and the fixed boundaries (Priority: P3)

An operator planning to move an existing production salon system onto this OSS can read a versioned roadmap that orders the remaining issue #1 scope into stages, states what each stage delivers and requires, and separates it from what the project deliberately will not do — so they can decide when (and whether) migration becomes viable.

**Why this priority**: Valuable but derivative: the roadmap is assembled from decisions the two matrices and the contracts already record. It closes issue #1's "tracked explicitly" requirement and gives later slices a fixed order to report against.

**Independent Test**: Starting from the roadmap, a reader can answer: which stage delivers the LINE adapter, what must exist before it, what stage (if any) delivers multi-location and staff roles, where the import/migration path is defined, and — following the roadmap's explicit pointer to the authoritative exclusions record — which capabilities are deliberately excluded from the current production-parity target, reconsiderable only through a recorded roadmap or boundary revision. Each stage lists its completion criteria. (Status and exclusions have a single authority the roadmap links to; the roadmap itself carries order and stage status only.)

**Acceptance Scenarios**:

1. **Given** the roadmap, **When** a reader checks the remaining issue #1 scope (LINE adapter, calendar adapter, multi-location and staff/role boundaries, import/migration path), **Then** each item — or, where the target matrix decomposes it into atomic parts, each part — appears in exactly one stage with prerequisites and completion criteria, or in the authoritative exclusions record with rationale.
2. **Given** the roadmap, **When** a later slice completes, **Then** the roadmap records status per stage in a form that can be updated by a documentation-only change (no restructuring needed to mark progress).
3. **Given** the deliberate-exclusions documentation, **When** a reader checks any excluded capability, **Then** the exclusion states its rationale and what a future change would require — preserving the current matrix's "future boundary" content.

---

### Edge Cases

- A capability is implemented but only partially covers the production task (for example the operator schedule exists but notifications do not): the target matrix must support a partial status with a note naming the gap, not force a false binary.
- Issue #1 lists a capability that a stage later splits or reorders: the roadmap is versioned, so a revision updates the stage table and records the change; the matrices are the source of truth for status, the roadmap for order.
- Documentation drift after this slice: every later feature that changes a capability's status must update the target matrix row in the same change; the roadmap update is part of that feature's closure checklist (mirroring how `docs/PARITY.md` rows are updated today).
- A reader lands on the old `docs/PARITY.md` path from an external link or the README of a past release: the path must keep resolving to current content (the file evolves in place or leaves a pointer; no dead link).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The documentation MUST present two clearly named matrices in place of the single sanitized parity matrix: (a) an implemented-capabilities matrix recording what the current OSS v0.x delivers, keeping every existing row's public-safe implementation path and acceptance evidence; (b) a production-parity target matrix recording, for every capability a production salon reservation product depends on (at minimum every capability issue #1 names), a status of implemented, partial, planned, or deliberately excluded.
- **FR-002**: Every planned row in the target matrix MUST reference the roadmap stage that delivers it; every deliberately-excluded row MUST reference its rationale; every implemented or partial row MUST reference its evidence (directly or via the implemented matrix).
- **FR-003**: The repository MUST contain a versioned roadmap that orders the remaining issue #1 scope into stages; each stage MUST list what it delivers, its prerequisites, and its completion criteria, and MUST be updatable to record progress without restructuring.
- **FR-004**: The documentation MUST define extension contracts for four seams — identity, notifications, calendar synchronization, and audit/event delivery — and each contract MUST state requirements for: configuration gating (disabled by default, no trace when unconfigured), event/trigger model (adapters consume explicit post-commit events; every projection of reservation state derives only from committed state and remains observationally equivalent to one maintained from those events; booking acceptance never waits on an adapter), failure semantics, idempotency (safe under duplicate event delivery), retry with terminal-failure visibility to the operator, privacy and data minimization (what the adapter may read, store, and transmit), and observability (how the operator sees adapter health and outcomes).
- **FR-005**: The calendar-synchronization contract MUST distinguish the three integration modes issue #1's recorded design decision (2026-08-11) ladders them into — an authenticated outbound ICS feed, outbound event synchronization, and inbound availability authority — and MUST specify fail-closed availability semantics only for an adapter explicitly configured as an inbound availability authority (unconfirmed or stale synchronized availability blocks the affected slots, never silently double-books) together with a reconciliation status visible to the operator; ICS-feed and outbound-only configurations MUST never affect booking availability.
- **FR-006**: The identity contract MUST preserve the accountless customer path as the default: external identity is an optional addition for installations that configure it, never a requirement for booking.
- **FR-007**: The README MUST state unambiguously whether the current release is production-parity or core-feature parity and MUST link to the matrices; the wording MUST survive future releases by deriving the claim from the target matrix rather than restating a fixed capability list.
- **FR-008**: The capabilities that remain intentionally out of scope MUST be documented with rationale and future boundary, preserving the current exclusions table's content.
- **FR-009**: This feature MUST NOT change runtime behavior: the no-provider booking path, all existing tests, and the release audit MUST pass unchanged.
- **FR-010**: All new and changed documentation MUST remain public-safe under constitution principle V: no production branding, credentials, customer data, provider account identifiers, or proprietary history; the production system is referenced only by user task and capability.

### Key Entities

- **Implemented-capabilities matrix**: The record of delivered v0.x capability rows — capability, public-safe implementation path, acceptance evidence. Successor of today's sanitized matrix rows.
- **Production-parity target matrix**: The record of every capability production parity requires — capability, status (implemented / partial / planned / deliberately excluded), reference (evidence, roadmap stage, or exclusion rationale).
- **Roadmap stage**: An ordered unit of future delivery — name, delivered capabilities, prerequisites, completion criteria, status.
- **Extension contract**: A per-seam statement of obligations between core and adapter across the seven dimensions of FR-004.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Every capability named in issue #1 is accounted for: 100% of them resolve to atomic target-matrix rows (with any decomposition recorded in the matrix) whose every row carries exactly one status, zero atomic rows appear in both "planned" and "excluded", and no part of a named capability is left without a row.
- **SC-002**: A seven-dimension audit of the four extension contracts (28 cells) finds every cell specified — no contract is missing failure, idempotency, retry, privacy, observability, configuration-gating, or event-model requirements.
- **SC-003**: The full verification suite (`npm run check` and the browser suite) passes with zero behavioral diff — the slice is documentation-only.
- **SC-004**: A reader who sees only the README correctly classifies the release as core-feature parity (not production parity) — verified by review against the README text.
- **SC-005**: No existing implemented-capability row loses its acceptance evidence in the restructuring: row-for-row accounting shows every current matrix row present in the successor documents.

## Assumptions

- This is slice 1 of issue #1. It deliberately delivers only documentation: matrices, roadmap, contracts, README wording. The LINE adapter (slice 2) and any calendar/multi-location/staff/migration implementation are later features staged by the roadmap; issue #1 therefore stays open when this slice merges (the pull request references issue #1 without closing it).
- Extension contracts are documentation-level commitments in this slice. Code-level interfaces (types, event payload schemas) land with the first adapter stage to be implemented — the LINE adapter in the recommended order, with whichever stage starts first building the shared event delivery foundation — so the contract is proven by an implementation rather than speculative. The contract document records this staging decision.
- The current `docs/PARITY.md` path keeps resolving to current content after the restructuring (the file evolves in place or carries a pointer), because the README of the tagged v0.2 release links to it.
- The roadmap's stage ordering follows issue #1's own emphasis: contracts and matrices first (this slice), the LINE adapter second, calendar synchronization and the remaining scope after — subject to revision at plan review.
- The production system referenced by "parity" remains described only by user task and capability, consistent with how `docs/UX-PARITY.md` already does this; no new information about the production system is required to write the target matrix.
