# Data Model: Reuse-First Porting Boundary

This feature stores no application data. These records are Markdown governance data with a private source of truth and a public projection.

## Enumerations

### PortingDisposition

| Value | Meaning | Minimum evidence |
|---|---|---|
| `Copied` | Publishable implementation or tests carried over without semantic change | Content identity, approved boundary, mapped tests |
| `Generalized` | Production implementation retained while installation-specific details moved behind configuration or adapters | Source mapping, unchanged invariants, generalized fields, mapped tests |
| `Reimplemented` | Independent replacement accepted or currently present | Reason, invariant comparison, migration/rollback effect, evidence gaps |
| `Excluded-private` | Installation-only or sensitive material intentionally remains private | Exclusion reason and public-boundary check |

Every assessed capability has exactly one current disposition. Mixed provenance requires smaller capability rows.

### RightsStatus

| Value | Meaning |
|---|---|
| `Confirmed` | Explicit evidence permits the recorded public use |
| `Pending` | No additional copying is allowed until a maintainer confirms rights |
| `Not applicable` | The row is excluded-private and no publication is proposed |

### AssessmentStatus

| Value | Meaning |
|---|---|
| `Verified` | Paths, revisions, tests, and disposition were checked at `lastVerified` |
| `Stale` | A bound revision changed after verification |
| `Blocked` | Required rights, evidence, or decision is missing |

### MigrationReadiness

| Value | Meaning |
|---|---|
| `Not assessed` | No compatibility or migration claim exists |
| `Blocked` | A named schema, invariant, rights, or rollback gap prevents migration |
| `Evidence mapped` | Representative compatibility and rollback evidence exists, but cutover is not approved |
| `Ready` | The capability has accepted import, verification, rollback, and operational evidence |

`Implemented` is not a migration-readiness value. Capability status stays in `docs/PARITY.md`.

## Private PortingLedgerEntry

| Field | Required | Rules |
|---|---:|---|
| `capabilityId` | yes | Stable, public-safe identifier; unique in the ledger |
| `capability` | yes | Bounded capability description; split mixed-provenance rows |
| `sourceRevision` | yes | Exact verified private revision; never projected publicly |
| `sourcePaths` | yes | One or more exact implementation/schema paths; never projected publicly |
| `sourceTests` | yes | Exact regression/concurrency test paths, or an explicit `none found` gap |
| `publicRevision` | yes | Exact verified public revision; never projected publicly |
| `publicPaths` | yes | Current public implementation/evidence paths |
| `rightsStatus` | yes | `RightsStatus`; `Pending` blocks new copying |
| `rightsEvidence` | yes | Exact private evidence reference or `not applicable`; never projected publicly |
| `currentDisposition` | yes | Exactly one `PortingDisposition` |
| `preferredFutureMethod` | yes | `Copy`, `Generalize`, `Reimplement`, `Keep private`, or `Decision pending`; not a current claim |
| `invariants` | yes | Preserved, changed, missing, or not-applicable behavior |
| `testRelationship` | yes | Reused, mapped, equivalent, missing, or not applicable |
| `sanitization` | yes | Required removals/generalizations and completed checks |
| `migrationReadiness` | yes | `MigrationReadiness` |
| `nextGate` | yes | One concrete evidence or decision needed next |
| `evidenceOwner` | yes | Accountable maintainer; one primary owner |
| `assessmentStatus` | yes | `AssessmentStatus` |
| `lastVerified` | yes | ISO calendar date |

### Validation rules

- `Copied` requires `rightsStatus: Confirmed` and content-identity evidence.
- `Generalized` requires named unchanged invariants and generalized installation-specific fields.
- `Reimplemented` requires a reason and cannot imply migration readiness by itself.
- `Excluded-private` requires `rightsStatus: Not applicable` or a documented reason that publication remains prohibited.
- A revision change moves `Verified` to `Stale` until paths, tests, and evidence are rechecked.
- Secret values, customer data, raw provider payloads, private denylist terms, and proprietary assets are forbidden even in the private ledger; it records coordinates and evidence, not sensitive contents.

## PublicProvenanceEntry

| Field | Required | Source |
|---|---:|---|
| `capabilityId` | yes | Private row |
| `capability` | yes | Private row, sanitized |
| `currentDisposition` | yes | Private row |
| `evidenceClass` | yes | Public-safe summary of identity, mapped behavior, independent implementation, or exclusion |
| `preferredFutureMethod` | yes | Private row, sanitized |
| `migrationReadiness` | yes | Private row |
| `nextGate` | yes | Private row, sanitized |

### Projection denylist

The public entry never contains `sourceRevision`, `sourcePaths`, `sourceTests`, `publicRevision`, `rightsEvidence`, private workspace coordinates, customer or account identifiers, deployment details, credentials, private history, or raw denylist terms.

## ParityPullRequestDeclaration

| Field | Required for parity work | Rule |
|---|---:|---|
| `applies` | yes | Explicit yes/no; non-parity changes may mark the section not applicable |
| `currentDisposition` | yes | Exactly one value when `applies` is yes |
| `ledgerUpdated` | yes | Confirms private evidence update without linking private coordinates |
| `testsReusedOrMapped` | yes | Names public tests and states private mapping was recorded |
| `sanitizationChecked` | yes | Confirms public diff contains no private material |
| `reimplementationReason` | conditional | Required for `Reimplemented` |
| `decisionRecord` | conditional | Required when storage, transaction, identity, or delivery semantics change |

## Relationships

```text
PortingLedgerEntry (private source of truth)
├── projects allowed fields into exactly one PublicProvenanceEntry
└── is updated by each applicable ParityPullRequestDeclaration

docs/PARITY.md capability status
└── links to PublicProvenanceEntry; it does not derive migration readiness
```

## State transitions

```text
Pending assessment
  -> Verified        evidence complete and revision bound
  -> Blocked         rights or required decision missing

Verified
  -> Stale           either bound revision changes
  -> Blocked         evidence or rights are withdrawn

Stale / Blocked
  -> Verified        complete reinspection and evidence update
```

Disposition changes require a new evidence review; they never change automatically with assessment status.
