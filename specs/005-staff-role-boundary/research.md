# Phase 0 Research: Staff and role boundary (S3)

Every question below was open when the specification was written and is closed here. Each entry
cites the code that decided it, because in this slice the constraints come from what the storage
layer will and will not tolerate rather than from a choice of library.

---

## R1. How does the acting identity reach the attribution record?

FR-014 hedges — "whether or not that change executes a command through the reservation command
kernel". **The hedge is unnecessary: there is no operator-initiated state change outside the
kernel.**

`ReservationDay` has exactly five mutating paths, and all five call `#commandGate` and then
`#writeReceipt` inside one `transactionSync`:

| Method | `src/reservation-day.ts` | Reached by |
|---|---|---|
| `#create` | gate 2278, receipt 2343 | public booking **and** `POST /api/admin/reservations` |
| `transitionOwner` | gate 2625, receipt 2684 | `POST /api/admin/reservations/:id/transition` |
| `#cancel` (via `cancelPublic`) | gate 2842, receipt 2892 | customer cancellation, management key |
| `createClosure` | gate 2999, receipt 3052 | `POST /api/admin/closures` |
| `removeClosure` | gate 3107, receipt 3137 | `POST /api/admin/closures/:id/remove` |

`#applyOwnerTransitionAction`, `#applyOwnerCancelTransition`, `#applyOwnerOutcomeTransition`, and
`#applyOwnerRescheduleTransition` are pure helpers called from inside `transitionOwner`; they compute
the next state and never write. There is no side door. The only other state change is `#expire`,
the pending-booking sweep, which has no operator and is out of FR-014's scope by its own wording.

**Decision**: thread an `actor` field through the DO input of the three operator-initiated
mutations (`transitionOwner`, `createClosure`, `removeClosure`) and through `#create` when the call
came from the owner route. Write it inside the same transaction that writes the receipt, into a
`__attribution` table keyed by `command_id`.

**Rationale**: writing attribution beside the receipt gets three properties for free rather than
engineering them.

- **Replay does not re-attribute** (FR-028). `#commandGate` returns the cached response *before* any
  write, so a replayed command never reaches the attribution insert. Nothing extra is required.
- **Attribution is atomic with the change it describes.** Both writes are in one
  `transactionSync`; a state change with no actor row is not reachable.
- **The record is not the subject's to erase** (FR-016). It lives in the day partition, which only
  the day's own purge alarm deletes.

**Alternatives considered**:

- *A new column on `adapter_receipts`.* Rejected on a hard constraint: that table is created with
  `CREATE TABLE IF NOT EXISTS` and validated against an exact table list, so a new column would
  never appear in an already-provisioned Durable Object. The codebase states this explicitly at
  `src/reservation-day.ts:966-972`, where the pending-expiry deadline is derived rather than stored
  for exactly this reason.
- *A field inside `booking_details.snapshot_json`.* Same class of problem — the snapshot is
  validated against an exact key list — and it would only cover reservations, not closures.
- *Extending `reschedule_history_json`.* Covers one of six transition actions. Rejected as partial.
- *A separate audit Durable Object.* Adds a binding that, once real installations exist, can only be
  deployed forward and never cleanly removed — the same argument the specification already used to
  keep the roster out of a new object.

**Consequence to state plainly**: attribution is retained for the life of the day partition and is
purged with it, like the command receipts it sits beside. That is the correct retention for an
operational accountability record and it must be written into `docs/PRIVACY.md` rather than left
implied.

---

## R2. Is the actor part of the command fingerprint?

**Decision**: no. The fingerprint stays exactly as it is, at version `2`, with no actor term.

**Rationale**: FR-028 requires that "the same command identifier and fingerprint from any authorized
actor still returns the cached outcome". Fingerprints are computed as
`sha256Hex(JSON.stringify([2, "owner-transition", commandId, date, ...]))`
(`src/reservation-day.ts:2600`). Adding the actor would mean a retry of the same operation by a
different authorized person is a *fingerprint mismatch*, which the kernel refuses — turning a
harmless duplicate into an error. It would also force a version bump on every command type, which
invalidates in-flight receipts on already-provisioned days for no gain.

**Consequence**: the attribution of a replayed command is the actor who issued it *first*. That is
the accurate record, and it is the behaviour FR-028's final clause asks for.

**Alternative considered**: include the actor and bump to version `3`. Rejected — it breaks a
requirement to gain nothing.

---

## R3. How is a presented credential resolved to an actor?

**Decision**: a two-step resolution in `ownerGate`, ordered so the deployment secret never needs
storage.

1. Compare the bearer token against `OWNER_TOKEN` from the environment, with the existing
   `equalBytes(await sha256(provided), await sha256(expected))`. On a match the actor is the
   break-glass identity with role `owner`, and **no Durable Object call is made**.
2. Otherwise call `InstallationConfig.resolveActor(digest)` with the SHA-256 of the presented
   credential. The object scans every roster entry, compares each stored digest in constant time
   *without early exit*, and returns `{ staffId, role } | null`. Nothing but the verdict crosses the
   RPC boundary.

**Rationale**:

- **Story 3 (break-glass) falls out of the ordering.** If the roster is corrupt, unreachable, or has
  had its last owner deactivated, step 1 has already succeeded and step 2 is never reached. This is
  the property the specification called load-bearing, and it is satisfied by control flow rather
  than by a recovery procedure.
- **Today's hot path is unchanged.** An installation with no roster pays nothing: the owner token
  matches at step 1, or step 2 finds an absent table and returns `null` immediately.
- **The scan gives FR-005 for free.** Comparing every entry with no early exit means an unknown
  credential and a known-but-wrong one do the same work. A salon-sized roster makes the cost
  irrelevant, so the naive loop is also the correct one.
- **Digests do not leave the object.** Resolution happens inside `InstallationConfig`, so a Worker
  bug cannot spill the roster's digests into a log or a response.

**Alternatives considered**:

- *Credential carries the identifier (`<staffId>.<secret>`), lookup is O(1).* Rejected: an unknown
  identifier short-circuits before any compare, so refusals become timing-distinguishable, which
  FR-005 forbids. The saved work is invisible at this scale.
- *Return the whole roster to the Worker and resolve there.* Rejected: ships every digest over RPC
  on every operator request for no benefit.
- *Cache the resolution per isolate for a second or two.* Rejected outright: FR-010 forbids it, and
  it is precisely the mechanism that would delay a revocation.

---

## R4. What does a `staff` credential get on an owner-only route?

**Decision**: `401 UNAUTHORIZED` with the `www-authenticate: Bearer` header — byte-identical to the
response for a garbage credential. Not `403`.

**Rationale**: FR-005 requires that an insufficient-role refusal not be distinguishable from a
bad-credential refusal in a way that reveals the credential is valid elsewhere. A `403` announces
"this credential is real, just not enough here", which is exactly the disclosure the requirement
names. Both refusals also take the same path — step 2 of R3 — so they are in the same timing class.

This is a deliberate departure from the usual `401`/`403` split, and it needs a comment at the
refusal site saying so, or a later reader will "fix" it.

**Alternative considered**: `403` for role, `401` for credential, on the grounds that it is more
honest to a legitimate operator. Rejected — the operator UI knows the signed-in role and can say
"this needs owner rights" from the client side, without the server confirming it to an attacker.

---

## R5. What happens when `OWNER_TOKEN` is absent but a roster exists?

**Decision**: unchanged from today — `503 TEMPORARILY_UNAVAILABLE`, before the roster is consulted.

**Rationale**: `ownerAuthenticated` returns `"unavailable"` when the secret is missing or is still
the placeholder (`src/worker.ts:259-273`), and `ownerGate` turns that into `503`. Keeping it means
an installation that loses its deployment secret is in the same broken-but-obvious state it is in
today, rather than a new state where staff can still operate an installation nobody can administer.
FR-009 makes the break-glass credential permanent; an installation without it is already
misconfigured, and the readiness surface (`runtimeFor` → `ownerSecretPresent`) already reports so.

**Alternative considered**: fall through to the roster so staff keep working. Rejected — it converts
a loud misconfiguration into a quiet one and creates the exact window FR-011 exists to prevent.

---

## R6. Where does the roster live, and does it reach provisioned installations?

**Decision**: a `__staff_roster` table inside `InstallationConfig`, singleton row, JSON blob,
created by its first write. Read returns `null` when the table does not exist.

**Rationale**: this is not a new idea in this codebase, it is a copy of one that already shipped.
`InstallationConfig` validates its user tables against an exact list but excludes double-underscore
names — the `sqlite_master` query at `src/installation-config.ts:1523` ends
`AND name NOT GLOB '__*'`. `__line_lifecycle` (`src/installation-config.ts:1576-1624`) uses that
exemption to reach installations provisioned before the LINE adapter existed: `#lineTableExists()`
returns `false` on an old installation, `#readLineLifecycle()` answers `null`, and
`#writeLineLifecycle()` runs `CREATE TABLE IF NOT EXISTS` on the first operator command. The roster
mirrors that shape exactly, which also delivers FR-017 without any migration step: no table means no
roster means today's behaviour.

`ReservationDay` uses the same exemption for `__adapter_meta` and `__adapter_outbox`
(`src/reservation-day.ts:1043`, `1145-1180`), and even performs an `ALTER TABLE … ADD COLUMN`
upgrade on a `__` table there — so the pattern is proven on both objects, including for later
evolution.

**Alternative considered**: a `staffRoster` key inside `installation_state.state_json`. Storable, but
that state is round-tripped through `parseInstallationState` and compared byte-for-byte against the
stored JSON (`src/installation-config.ts:1568`); the roster would then be rewritten by every settings
save and would ride the settings CAS loop, coupling two unrelated write paths. Rejected.

---

## R7. How are concurrent roster edits refused?

**Decision**: reuse `executeCommand`'s compare-and-swap. The roster write is
`UPDATE __staff_roster SET roster_json = ? WHERE singleton = 1 AND roster_json = ?`; zero rows
written means someone else wrote first.

**Rationale**: `executeCommand` already does exactly this for installation settings
(`src/installation-config.ts:1956-1974`) — read, compute, conditional update on the previous JSON,
retry. The edge case in the specification asks for "the same shape as the existing settings-version
conflict", and this *is* that shape. Roster commands differ from settings in one way worth stating:
they must **refuse** rather than retry, because a blind retry of "deactivate Alice" against a roster
someone else just changed can silently do the wrong thing. So the loop becomes a single attempt that
returns a conflict result.

**Alternative considered**: a monotonically increasing `rosterVersion` echoed by the client.
Rejected as a second concurrency mechanism where one already exists.

---

## R8. What does FR-020's "dry run" mean when there is nothing to migrate?

**Decision**: a `dryRun: true` field on the roster-create command. The command validates the input
and the resulting roster shape, reports what would be created — including whether this would be the
first entry and what role it would hold — and returns before any write.

**Rationale**: there is no data to migrate. An installation without a roster has no staff records to
convert; the "migration" is a first creation. So the risk FR-020 protects against is not a bad
conversion but a bad *first* write to a live installation — a malformed roster on the one object
that also holds the settings. Validating the exact bytes that would be stored, without storing them,
is what addresses that, and it costs one branch in a command handler.

**Alternative considered**: a standalone migration script under `scripts/`. Rejected — the repository
has two scripts, both about release safety, and neither talks to a live installation. A script that
did would need deployment credentials and a network path that does not exist today, to migrate data
that does not exist either.

---

## R9. The CI gap the specification named

**Status: already closed; the specification's worry is stale, its observation is not.**

The observation is correct — `npm run check` is `test && typecheck && types:check && build && audit
&& release:audit` and does not include `test:browser`. But CI does not rely on `check` alone:
`.github/workflows/ci.yml` installs Chromium at line 83 and runs `npm run test:browser` at line 86 as
its own step, with the report uploaded as an artifact.

**Decision**: the roster screen ships with Playwright coverage in `tests-browser/`, and no CI change
is needed. Two constraints on writing it, both learned the hard way in this repository:

- The installation bootstrap test must stay **first** in `tests-browser/install.spec.ts`. The suite
  runs `workers: 1` with `fullyParallel: false` and the specs share one installation, so ordering is
  load-bearing; new cases go at the end of the file.
- A new browser test must be checked against *unfixed* code once, to prove it fails for the reason
  intended, before it is trusted as coverage.

---

## R10. Where is the staff credential generated?

**Decision**: in the Worker, on the roster-create and rotate paths: 32 bytes from
`crypto.getRandomValues`, base64url, 43 characters — the same construction as
`newManagementKey()` (`public/app.js:131-136`) — hashed with SHA-256, digest sent to the object,
plaintext returned once in the response and never stored.

**Rationale**: the management key is generated in the *browser* precisely so the server never sees
it. That cannot hold for a staff credential, because FR-007 requires the system to generate it and
show it once. The Worker is the right place: the plaintext exists for the duration of one request
and only the digest crosses the RPC boundary, so the credential is never at rest anywhere — not in
the object, not in a log, not in the settings state.

Matching the management key's shape also means the credential is indistinguishable from any other
opaque 43-character token, and `DIGEST`/`MANAGEMENT_KEY` style validation regexes already exist to
copy.

**Alternative considered**: let the browser generate it, as the customer path does. Rejected: the
owner creates the account for someone else, so the credential has to come back in the response
anyway — browser generation would only move the entropy source to the less trustworthy side while
keeping the exposure.

---

## Resolved: no NEEDS CLARIFICATION remain

Every unknown in the Technical Context is closed above. The specification's own Assumptions section
already settled the product-level questions (two roles, no sessions, staff can see customer contact
details, attribution outlives the account, break-glass is permanent, sagas are not aborted), and
none of them changed under research.
