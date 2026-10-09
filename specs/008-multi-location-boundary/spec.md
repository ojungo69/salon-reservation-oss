# Feature Specification: Multi-location boundary

**Feature Branch**: `feat/multi-location-s4`
**Created**: 2026-10-09
**Status**: Implemented candidate; verification and publication evidence in verification.md
**Input**: Deliver roadmap S4 for up to four locations, preserving the existing location and booking contracts. Existing-system data migration is excluded and requires separate user confirmation.

## User Scenarios & Testing

### User Story 1 — Configure another salon safely (Priority: P1)

An owner adds a named salon, edits its catalog/hours/notices and checks readiness before accepting bookings. The existing salon keeps operating.

**Independent Test**: Add three fictional locations beside the existing one; configure and enable one. Its hours/menu change independently, repeated creation creates one location, and a fifth location is refused.

**Acceptance Scenarios**:

1. **Given** an existing installation, **when** its owner adds a location, **then** the new location begins in demo with external integrations off and the existing location/data stay intact.
2. **Given** independently configured locations, **when** one is paused or its settings change, **then** other locations keep their configuration and retained bookings remain manageable.
3. **Given** concurrent additions for the last available place, **when** they complete, **then** the installation never exceeds four locations and no existing location is overwritten.

### User Story 2 — Book and manage the correct salon (Priority: P1)

A customer chooses an accepting salon before services, sees that choice through confirmation, and later manages each remembered booking at its own salon.

**Independent Test**: Book the same time/resource identifier at two fictional salons, recover an uncertain submission, then cancel only one using its saved proof. Repeat with one salon paused.

**Acceptance Scenarios**:

1. **Given** two accepting salons, **when** fifty customers contend for one slot at each, **then** exactly one succeeds at each salon and the salons do not block one another.
2. **Given** an explicit unknown salon, **when** the customer follows its link, **then** an error appears without selecting or submitting to another salon.
3. **Given** a booking saved for A while B is selected, **when** its status/cancel action runs, **then** it uses A and its own proof; a proof presented for the wrong salon reveals nothing.
4. **Given** a retained or uncertain booking at a now-paused salon, **when** the customer returns, **then** its status/retry/cancellation remains available under the existing rules.

### User Story 3 — Limit staff to assigned salons (Priority: P1)

An owner grants a staff member specific salons. That person switches among only those salons and operates the existing day/week board, proxy booking and closures.

**Independent Test**: Staff assigned only to B signs in without needing access to A, operates B, and is refused on every private A action. An owner removes B and the next request is refused.

**Acceptance Scenarios**:

1. **Given** a legacy staff account, **when** locations are added, **then** its access remains the existing salon only; an explicit empty assignment grants no salon.
2. **Given** a staff member switching salons, **when** an old response arrives late, **then** neither the previous salon's personal details nor its pending actions appear under the new selection.
3. **Given** a simultaneous grant edit or owner revocation, **when** a rights-changing command commits, **then** it checks current owner authority and refuses stale changes.
4. **Given** an owner-role account or deployment credential, **when** it operates any salon, **then** it retains installation-wide authority under existing role restrictions.

### User Story 4 — Enable optional integrations per salon (Priority: P2)

Owners independently enable LINE notifications, calendar feeds and outbound calendar events. Customers explicitly choose LINE for each booking, while booking continues during provider failures.

**Independent Test**: With provider fixtures, enable two salons, link only A's booking, deliver/retry events, disable A, and verify B continues with its own feed and calendar destination.

**Acceptance Scenarios**:

1. **Given** a shared LINE brand, **when** a customer links A's booking, **then** B is not automatically linked and notifications identify their salon.
2. **Given** a feed capability for A, **when** it is presented for B, **then** access is refused; rotating A's capability leaves B and the existing feed unchanged.
3. **Given** an integration outage or repeated delivery, **when** bookings are created or changed, **then** availability is unchanged and delivery remains bounded, retryable and diagnosable.
4. **Given** multiple integration lifecycle changes, **when** processing restarts, **then** every pending operation resumes, no earlier scheduled recovery is lost, and disabling one salon cannot purge another.

### Edge Cases

Explicit unknown/duplicate/empty location selection; only a named salon accepting bookings; default uncertain submission while default is paused; identical local service/resource/command identifiers; identical unverified contact across salons; lost create/token responses; no staff assignments; permission removed during a slow request; late screen responses; shared LINE webhook partially acknowledged; configuration read failure; missing actor name after restart; integration backlog; retention expiry and disabled locations.

## Requirements

### Functional Requirements

- **FR-001**: Support one to four locations including the existing location. Stable identifiers cannot be renamed, deleted or reused in this feature.
- **FR-002**: Only owners may add/configure locations. New locations start in demo with all integrations off; existing readiness rules control fresh acceptance.
- **FR-003**: Catalog, hours, settings history, capacity, receipts, mutations, closures and retention MUST be isolated by location. Existing day-bounded behavior stays intact.
- **FR-004**: Customers MUST choose an accepting location before dependent selections. Show the location through review/result, legal notices and remembered booking actions. Unknown explicit choices never fall back.
- **FR-005**: Retained proofs and uncertain requests MUST keep their original location even when it is paused or another location is selected. Existing default-location storage and wire behavior remain compatible without conversion.
- **FR-006**: Public discovery MUST include all known locations with name and effective bookability, without personal/operator/provider data. Private discovery MUST be limited to current staff assignments.
- **FR-007**: Owner-role accounts and the deployment credential retain all-location authority. Legacy staff remain default-only; explicit empty grants mean no access. Staff cannot read or mutate another location by changing a request.
- **FR-008**: Scope changes and scoped staff creation MUST be atomic, reject stale edits and recheck current owner authority. Revocation applies to subsequent requests; already-authorized reservation operations retain the existing completion boundary.
- **FR-009**: Customer and operator location switches MUST invalidate old dependent state and late responses. Unresolved mutations retain their original scope and cannot be resubmitted elsewhere.
- **FR-010**: Optional LINE integrations MUST support one shared provider realm with independent per-location consent/delivery/lifecycle. Verified shared events reach only configured active or still-draining locations and retries do not duplicate effects.
- **FR-011**: Optional calendar integrations MUST isolate feeds, destinations, reconciliation and deletion/retention. Named destinations use the existing credential set and become immutable once bound; multiple provider accounts and destination migration are excluded.
- **FR-012**: New feed capabilities are independently random, disclosed once to an owner and never returned by a read. Existing capabilities and previously queued notification bytes remain compatible.
- **FR-013**: Provider/configuration failures MUST NOT alter reservation capacity or imply integration disable. Recovery, retry, retention and earliest scheduled work MUST remain correct after restart.
- **FR-014**: Preserve the existing accessibility, keyboard, narrow-screen, theme, reduced-motion, privacy and no-integration behavior. Implement against actual generated references, then verify rendered flows.
- **FR-015**: State resource limits and cost scenarios from measured/source-backed evidence. Do not claim that four fully integrated locations fit a free plan without evidence. Cost optimization is not a prerequisite for feature delivery.
- **FR-016**: Existing-system data import/migration/export/restore/cutover, live provider/account changes, production changes, global customer identity and cross-day/cross-location moves MUST NOT be performed by this feature. Data migration needs separate user confirmation.

### Key Entities

Location; location-specific settings/history; staff location grant; booking and management proof; per-location integration lifecycle/delivery; calendar feed capability. Contact text remains unverified booking data, not a global customer identity or cross-location exclusion key.

## Success Criteria

### Measurable Outcomes

- **SC-001**: Four fictional locations can be configured independently; attempts to create a fifth or reuse an existing identifier preserve existing state.
- **SC-002**: Two fifty-way concurrent booking attempts at separate locations produce exactly one winner per location; failure/retry/replay and purge leave the other location unchanged.
- **SC-003**: Every private operation refuses unassigned staff, and removal is effective on the next request, including after restart. Wrong-location customer proofs reveal no booking.
- **SC-004**: Customers complete selection, submission, recovery, return and cancellation at the correct location; staff switch and operate without stale personal details. Keyboard and 320/360/768/1440-width checks pass.
- **SC-005**: Two configured locations independently pass fixture-backed LINE/feed/calendar success, duplicate, outage, disable and retention scenarios; existing default records and notification bytes pass unchanged compatibility fixtures.
- **SC-006**: All standing verification/review gates pass on the final change; published capability status reflects actual evidence and migration remains unstarted.

## Assumptions

One installation, one timezone (Asia/Tokyo), existing owner/staff roles, one LINE brand/realm and one existing Google credential set are sufficient. Integration setup is optional; provider behavior is fixture-tested. Design selection is delegated to the agent and does not imply personal approval of generated images. S4 work is authorized; actual migration remains a separately confirmed task.
