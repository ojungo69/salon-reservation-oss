# Contract: Provenance Record and Public Projection

## Private ledger contract

The private ledger is the only record containing exact source coordinates. Its first non-heading
line MUST be an HTML comment whose content is `PRIVATE-PORTING-` immediately followed by
`EVIDENCE: DO NOT PUBLISH`, with no space or formatting delimiter between those fragments in the
private file. The release audit rejects the assembled marker even after the file is renamed.

Each capability section MUST contain these labels once:

```markdown
### <capabilityId> — <capability>

- Source revision:
- Source paths:
- Source tests:
- Public revision:
- Public paths:
- Rights status:
- Rights evidence:
- Current disposition:
- Preferred future method:
- Invariants:
- Test relationship:
- Sanitization:
- Migration readiness:
- Next gate:
- Evidence owner:
- Assessment status:
- Last verified:
```

Rules:

1. The sentinel is mandatory and is never removed, including when the ledger is renamed or split.
2. `Current disposition` is exactly one of `Copied`, `Generalized`, `Reimplemented`, or `Excluded-private`.
3. Multiple source or test paths are allowed; every path is exact and relative to its bound repository revision.
4. No secret value, customer record, raw provider payload, private denylist term, or proprietary asset content is recorded.
5. A revision change makes the row stale until the full row is reverified.

## Public projection contract

Every assessed private row produces one public table row with only these columns:

```markdown
| Capability ID | Capability | Current disposition | Evidence class | Preferred future method | Migration readiness | Next gate |
```

Allowed content:

- Generic capability descriptions.
- The four disposition names.
- Public file or document links.
- Sanitized evidence classes such as `audited byte identity`, `independent implementation`, or `intentionally private`.
- Public issue and ADR links.

Forbidden content:

- Private repository or workspace names and paths.
- Private revision identifiers or history.
- Exact private source and test coordinates.
- Rights-evidence coordinates.
- Customer, staff, store, account, domain, resource, deployment, or provider identifiers.
- Credentials, secret names unique to an installation, raw denylist terms, private runbook steps, or proprietary assets.

Projection verification fails closed: when a conclusion cannot be stated without forbidden content, publish only `Evidence retained privately` and the next public-safe gate.

## Pull-request declaration contract

The existing pull-request template gains one conditional section:

```markdown
## Production-parity provenance

- Applies to a production-parity capability: yes / no

### Capability declaration

- Capability ID:
- Capability:
- Current disposition (keep exactly one): Copied / Generalized / Reimplemented / Excluded-private
- Private porting ledger updated with exact source/test mapping, rights status, sanitization, and evidence owner: yes / no
- Reused or mapped public tests:
- Reimplementation reason, invariant differences, migration/rollback effects, and equivalent-evidence gaps (when applicable):
- ADR for storage, transaction authority, identity, or delivery semantic changes (when applicable):

- [ ] Public diff contains no private coordinates, data, credentials, identifiers, assets, or history
```

Review rule: copy the capability declaration once per capability when `Applies` is `yes`. Selecting more than one disposition requires splitting that declaration. A non-parity pull request records `no` and omits capability declarations.

## Consistency contract

- `docs/PARITY.md` owns capability status.
- `docs/PORTING.md` owns public provenance and migration-readiness statements.
- The private ledger owns exact mapping and rights evidence.
- The ADR owns the decision rule.
- A pull request may update multiple records, but it MUST NOT create another source of truth.
