# Feature Specification: Staff and role boundary (S3)

**Feature Branch**: `feat/s3-staff-role-design`

**Created**: 2026-08-16

**Status**: Draft — design slice. No runtime change lands with this document.

**Input**: Roadmap stage S3: "Migration path from the single owner secret; authorization, revocation,
offboarding, privacy design; the accountless customer path preserved." The stage's own completion
criteria require this design to be recorded before any implementation.

## Context

Today the whole operator surface is protected by one shared secret. `ownerAuthenticated`
(`src/worker.ts:268`) reads `OWNER_TOKEN` from the environment, SHA-256 hashes both sides, and
compares them in constant time; `ownerGate` (`src/worker.ts:283`) wraps that with a per-route rate
limiter and answers `503` when the secret is absent. Thirteen routes sit behind it. Nothing else in
the installation records who an operator is: there is no roster, no per-person credential, and no
attribution of an action to a person.

That single secret is the whole problem this stage exists to solve. A salon with three staff shares
one string. Removing one person's access means rotating the secret and redistributing it to
everyone who stays — the system cannot express "Alice leaves, Bob keeps working". Every comparable
self-hostable system studied (Cal.com's per-membership grants, Easy!Appointments' per-provider
accounts, Booked's per-user deactivation) makes revocation individually addressable, and all of
them root it in a users table in a real database. This project has no database and
[must not add one](../../.specify/memory/constitution.md); per-person state has to live in storage
that already exists.

The governing sources are [the roadmap's S3 row](../../docs/ROADMAP.md), the
[production-parity target matrix row](../../docs/PARITY.md) for staff accounts and role boundaries
(status `Planned`), [the privacy document](../../docs/PRIVACY.md), and the constitution's
Provider-Neutral Core and Public-Safe Surface principles.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The owner gives a staff member their own way in (Priority: P1)

The owner, still holding the deployment's `OWNER_TOKEN`, opens the operator screen and adds a staff
member: a display name and a role. The system generates that person's credential once, shows it
once, and stores only its digest. The owner hands the credential to the staff member out of band.
The staff member signs in on their own device and can run the day — see the schedule, take a
booking, approve or reject one, close a slot — without ever holding the deployment secret.

**Why this priority**: This is the whole point of the stage. Until one person can work without the
shared secret, nothing else in S3 has any value, and the roadmap's later stages (S4 operator
scoping, S5 migration) have no identity to scope to.

**Independent Test**: With a fixture installation, create a staff member through the owner-gated
roster endpoint, sign in with the returned credential, and confirm the staff credential is accepted
on the operations routes and refused on the roster and installation-settings routes — with no
`OWNER_TOKEN` in the staff member's possession at any point.

---

### User Story 2 - A staff member leaves and loses access immediately (Priority: P1)

A staff member leaves. The owner deactivates them in the roster. Their next request — and every
request after it — is refused. Everyone else keeps working, unchanged, with the credentials they
already have. Nobody has to rotate anything or redistribute anything.

**Why this priority**: Equal in priority to Story 1, because it is the property the shared secret
structurally cannot provide. Shipping accounts without individual revocation would reproduce today's
problem with more moving parts.

**Independent Test**: Create two staff members, deactivate one, and confirm the deactivated
credential is refused on the very next request while the other credential is unaffected. Confirm the
refusal survives a restart of the object that holds the roster.

---

### User Story 3 - The installation still has a way in when everything else fails (Priority: P1)

The roster is unreachable, or the last owner-role account was deactivated by mistake, or the
credential was lost. The person who controls the deployment sets `OWNER_TOKEN` and gets in with full
rights, exactly as today, and repairs the roster from there.

**Why this priority**: The migration must never open a window in which nobody can sign in. Because
`OWNER_TOKEN` lives in the platform's secret store rather than in Durable Object storage, it is the
one credential that survives a corrupted or mis-edited roster — and
[the release document](../../docs/RELEASING.md) is explicit that a code rollback does not undo
Durable Object writes, so a bad roster state can only be repaired forward, by someone who is already
inside.

**Independent Test**: With a roster whose only owner-role account is deactivated, confirm the
`OWNER_TOKEN` holder is still accepted on every owner-gated route and can reactivate an account.

---

### User Story 4 - An operator can tell who did what (Priority: P2)

A booking was rejected and the owner wants to know by whom. Each operator-initiated state change
records the acting identity, so the reservation's history answers the question without anyone having
to trust a memory of who was on shift.

**Why this priority**: Accountability is what makes individual accounts worth more than a shared
secret operationally, and the privacy design cannot be written without deciding what is recorded.
It is P2 rather than P1 because the boundary is enforceable, testable, and useful before attribution
is readable in the interface.

**Independent Test**: With two staff identities, perform one transition as each, and confirm the
recorded history attributes each change to the acting identity and that the attribution survives
that staff member's later deactivation.

---

### User Story 5 - A customer books without an account, exactly as before (Priority: P1)

A customer opens the booking page, picks a service and a time, submits, and manages their booking
with the management key they were given. Nothing about staff accounts is visible to them, and
nothing about the booking path changed.

**Why this priority**: Named explicitly in the roadmap row and in the constitution's first
principle. A regression here is a stage failure, not a defect to fix later.

**Independent Test**: The existing customer browser suite passes unchanged, and the public routes
answer identically whether the staff roster is empty, populated, or entirely absent.

---

### Edge Cases

- The roster is empty (an installation that has not migrated). Every owner-gated route continues to
  accept `OWNER_TOKEN` and nothing else; the operator screens behave exactly as they do today.
- The last owner-role account is being deactivated. The system refuses, so the roster can never
  reach a state where nobody can administer it; `OWNER_TOKEN` remains the recovery path regardless.
- A staff member is deactivated while a booking command they issued is in flight. The command
  completes or fails on its own terms — authorization was decided when the request was accepted —
  and the attribution records the identity that issued it.
- A staff member is deactivated while an adapter lifecycle operation they started is mid-saga. The
  saga is driven by alarms that never consult the gate, so it keeps redriving to completion. The
  design states this rather than pretending revocation reaches it.
- A credential is presented that matches no roster entry and is not `OWNER_TOKEN`. Indistinguishable
  refusal: the same status, the same body, and the same timing class as a wrong `OWNER_TOKEN`, so an
  attacker cannot learn whether an identifier exists.
- Two owners edit the roster concurrently. The later write is refused rather than silently
  overwriting, in the same shape as the existing settings-version conflict.
- The same person is both a staff member and a customer of the salon. Their staff record and their
  bookings are separate subjects with separate identifiers and no link between them.

## Requirements *(mandatory)*

### Functional Requirements

**Authorization**

- **FR-001**: Every route that is owner-gated today MUST remain behind at least owner-equivalent
  authorization. This design may only add finer checks; it may not move a route out of the gate,
  and it may not gate a route that is public today.
- **FR-002**: The system MUST define exactly two roles for the first slice: `owner` and `staff`.
  `owner` may do everything. `staff` may do the day-to-day operations — read availability, read the
  schedule, create a booking, transition a booking, create and remove a closure — and nothing else.
- **FR-003**: The system MUST refuse a `staff` credential on the installation-settings surface
  (setup read and write, the live toggle, the installation receipt), on the adapter lifecycle and
  adapter status surface, and on the roster itself.
- **FR-004**: The rate limiter and the same-origin mutation check MUST run before and independently
  of any role decision, keeping their current per-route buckets. Neither is an authorization
  decision and neither may be bypassed by any role.
- **FR-005**: A refusal for insufficient role MUST NOT be distinguishable to the caller from a
  refusal for a bad credential in a way that reveals whether a credential is valid for some other
  route.

**Identity and credentials**

- **FR-006**: The system MUST store, per staff member: a stable opaque identifier, a display name, a
  role, an active flag, the digest of exactly one credential, and the timestamps at which the record
  was created and last deactivated. It MUST NOT store a contact address, and it MUST NOT store the
  credential itself.
- **FR-007**: A staff credential MUST be generated by the system with at least the entropy of the
  existing management key, MUST be returned exactly once at creation or rotation, and MUST be
  compared using the same constant-time digest comparison the owner secret uses.
- **FR-008**: The owner MUST be able to rotate one staff member's credential without affecting any
  other credential, and rotation MUST invalidate the previous credential on the next request.
- **FR-009**: `OWNER_TOKEN` MUST continue to authenticate with full `owner` rights permanently. It
  is the break-glass credential, not a migration artefact to be retired.

**Revocation and offboarding**

- **FR-010**: Deactivating a staff member MUST take effect on their next request. No authorization
  decision may be cached anywhere that would delay it.
- **FR-011**: The system MUST refuse any roster operation that would leave the installation with no
  active `owner`-role account — deactivation today, and equally any role-change or record-removal
  operation a later slice adds.
- **FR-012**: The offboarding procedure MUST be documented as covering the credentials that
  deactivation does not reach: the calendar feed token, the LINE channel secret, and the Google
  calendar credentials are installation-level secrets that an offboarded person may still hold a
  copy of. The document MUST say so plainly rather than implying deactivation revokes them.
- **FR-013**: A deactivated record MUST be retained with its identifier and role so past attribution
  stays resolvable, with its credential digest cleared so the record cannot authenticate again.

**Attribution**

- **FR-014**: Every operator-initiated reservation state change MUST record the acting identity,
  whether or not that change executes a command through the reservation command kernel, subject to
  FR-015 and FR-016. How the identity reaches the record is a planning decision; the requirement is
  that no operator-initiated state change is recorded without one.
- **FR-015**: Attribution MUST record the staff identifier, never the display name, so a later
  change or removal of the name does not rewrite history and the history does not itself become a
  second copy of personal data.
- **FR-016**: Attribution MUST NOT be deletable by the person it records.

**Migration**

- **FR-017**: An installation that has never had a roster MUST keep working with no operator action
  at all. Adding staff is opt-in.
- **FR-018**: The first staff account MUST be creatable only by a caller already authorized as
  `owner` — in practice, the `OWNER_TOKEN` holder — so there is no window in which the roster can be
  seeded by an unauthenticated caller.
- **FR-019**: The stored roster MUST be added in a way that an already-provisioned installation
  tolerates without a coordinated schema bump, following the convention the existing installation
  object already exempts from its strict table check.
- **FR-020**: The migration MUST offer a dry run that reports what would be created and validates
  the stored shape, without writing to the live installation.
- **FR-021**: The rollback story MUST be stated as forward-only, matching the existing adapter
  precedent: a bad roster is repaired by a subsequent deploy plus break-glass access, never by
  rolling the Worker back.

**Privacy**

- **FR-022**: The privacy document and the served privacy page MUST gain a staff data category
  stating what a staff record contains, why, how long it is kept, how the credential is protected,
  and what deactivation deletes and retains.
- **FR-023**: The operator checklist in the privacy document MUST gain staff retention terms,
  including what leaving does and does not remove, so an installation cannot go live with staff
  accounts without stating them.
- **FR-024**: A deletion or export request scoped to someone's customer record MUST NOT reach their
  staff record or the attribution of their operator actions, and the reverse MUST also hold.
- **FR-025**: No real staff name, credential, or identifier may enter this repository, including in
  fixtures, tests, and documentation examples.

**Preserved behaviour**

- **FR-026**: The public booking, status, cancellation, LINE customer, calendar feed, and privacy
  routes MUST be unchanged in behaviour and in authorization.
- **FR-027**: The default deployment MUST gain no new required secret, no new external service, and
  no new required configuration step.
- **FR-028**: The idempotent command pipeline MUST keep its replay semantics: the same command
  identifier and fingerprint from any authorized actor still returns the cached outcome rather than
  re-executing, and a replay does not re-attribute the original action.

### Key Entities

- **Staff member**: one person who operates this installation. Opaque identifier, display name,
  role, active flag, credential digest, created and deactivated timestamps. Bounded in count by the
  size of a single salon. No contact details, no customer link.
- **Role**: `owner` or `staff`. Determines which operator routes the holder may reach. Not
  user-definable in this slice.
- **Staff credential**: a high-entropy secret the system generates and shows once. Only its digest
  is stored. One live credential per staff member; rotation replaces it.
- **Break-glass credential**: the deployment's `OWNER_TOKEN`. Always `owner`, never in the roster,
  never revocable from inside the application.
- **Attribution**: the acting identity recorded on an operator-initiated state change — the staff
  identifier, or the break-glass identity when the deployment secret was used.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: One staff member can be removed without any other operator changing, re-entering, or
  learning a new credential. Measured as: after deactivation, zero other credentials are invalidated.
- **SC-002**: A deactivated credential is refused on the first request made after deactivation, with
  no upper bound on delay to measure because no caching is permitted.
- **SC-003**: An installation with no roster behaves identically to today across the full existing
  test suites: the customer browser suite, the worker suite, and the race suites pass unchanged.
- **SC-004**: A `staff`-role credential is refused on every installation-settings, adapter, and
  roster route, and accepted on every day-to-day operations route — verified route by route, with no
  route unaccounted for.
- **SC-005**: Every operator-initiated reservation state change in a fixture run resolves to exactly
  one acting identity, including changes made with the break-glass credential.
- **SC-006**: The installation can always be administered: no sequence of roster operations reaches
  a state with zero ways in, and the break-glass path is verified against a deliberately broken
  roster.
- **SC-007**: A reviewer can read the privacy document and answer, without reading code, what is
  stored about a staff member, for how long, and what leaving removes.

## Assumptions

These were chosen where the roadmap row and the code did not settle the question. Each is a decision
this specification makes, not an open item.

- **Two roles, not a permission matrix.** A salon-sized installation does not need custom roles, and
  a permission system with one shape of consumer is speculative. A third role is added when a real
  need for it appears, not before. This assumption was accepted with reservation rather than
  conviction, so the cost of being wrong is worth stating: because the role is a stored field on each
  roster record and the route check is a total function over the role and the route, adding a third
  role later is a new value in the union, a new column in the route table, and an option in the
  operator screen. Existing records keep the role they already hold, and no stored data is migrated.
  The decision is cheap to revisit, which is why it is safe to make now.
- **Static per-person credentials, not sessions.** A session layer would add issuance, expiry,
  storage, and refresh for a property the roster already provides: deactivation is what ends access,
  and it takes effect on the next request. The existing management-key pattern — generate once,
  store only the digest, compare in constant time — is reused rather than reinvented.
- **The roster lives beside the installation settings, not in a new object.** The installation object
  already excludes double-underscore-prefixed tables from its strict schema check, which is how the
  LINE lifecycle state shipped into already-provisioned installations. A new Durable Object class
  would add a binding that, once real installations exist, can only ever be deployed forward and
  never cleanly removed.
- **Staff can see customer contact details.** The schedule route is the only operator route that
  exposes a customer's name and contact, and a staff member cannot run the day without it. Hiding it
  from the role that does the work would make the role useless.
- **Attribution is by identifier, and it outlives the account.** The accountability record is not
  the staff member's to erase, and recording the identifier rather than the name keeps the history
  from becoming a second store of personal data.
- **Staff records follow the installation's own retention, not a booking date's.** Booking retention
  is driven by a per-date purge that a staff record has no place in. A staff record is retained for
  the life of the installation; deactivation is the only end-of-service operation this slice defines,
  and deactivation is not deletion — the record survives with its identifier and role per FR-013. A
  delete operation, if one is ever wanted, is a later decision that has to be reconciled with FR-013
  and FR-016 first.
- **The break-glass credential is permanent.** Retiring `OWNER_TOKEN` would remove the only recovery
  path that survives a corrupted roster, in a system where storage cannot be rolled back with code.
- **In-flight adapter sagas are not aborted by revocation.** They are alarm-driven and never consult
  the gate. Adding an abort path is a separate decision with its own failure modes; this design
  documents the behaviour instead of quietly changing it.

## Out of Scope

- Multi-location scoping of staff. That is stage S4, and it hard-depends on this stage existing.
- Importing staff from an existing system. That is stage S5, which hard-depends on both S3 and S4.
- Staff capability, nomination, and assignment models — [issue #52](https://github.com/ojungo69/salon-reservation-oss/issues/52).
  Those describe what a staff member can *do for a customer*; this stage decides only who may
  operate the installation.
- Any external identity provider, single sign-on, or email-based invitation or recovery. The
  installation has no mail path and gains no required external service.
- Customer accounts of any kind.

## Gates for the implementation slice

This stage completes only when the design here is recorded **and** an implementation has landed. The
implementation slice is in security scope — it is authorization, credential handling, and secret
storage — so it passes, in addition to the standing gates:

- The full `npm run check` and the browser suites.
- A correctness review and a separate over-implementation review of the diff.
- The security review battery: rule-based static analysis, a security-focused review that iterates
  to a clean verdict, and an adversarial review of the design.
- Implementation by this project's own hands rather than delegated to an external tool, because the
  change is in security scope.

One gap is worth naming here so the implementation slice can decide about it deliberately: the
composite `check` command does not run the browser suites, so operator-screen behaviour reaches CI
only through the separately invoked browser run. Any staff-facing screen this stage adds needs a
browser test, and the slice should say how that test is made to run in CI.
