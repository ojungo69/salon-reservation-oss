## Summary

Describe the user-visible or security-relevant change and why it is needed.

## Scope

- What changed:
- What intentionally did not change:

## Production-parity provenance

Complete this section when the pull request implements or alters a production-parity capability.

- [ ] Not applicable: this pull request does not implement or alter a production-parity capability

When applicable, leave "Not applicable" unchecked and copy this declaration once per capability.
Split mixed-provenance capabilities into smaller declarations.

### Capability declaration

- Capability ID:
- Capability:
- Current disposition (keep exactly one): Copied / Generalized / Reimplemented / Excluded-private
- Private porting ledger updated with exact source/test mapping, rights status, sanitization, and evidence owner: yes / no
- Reused or mapped public tests:
- Reimplementation reason, invariant differences, migration/rollback effects, and equivalent-evidence gaps (when applicable):
- ADR for storage, transaction authority, identity, or delivery semantic changes (when applicable):

- [ ] Public diff contains no private coordinates, data, credentials, identifiers, assets, runbooks, denylist terms, or history

## Verification

- [ ] `npm run check`
- [ ] Relevant focused tests added or updated
- [ ] Browser/UI behavior checked when rendered behavior changed
- [ ] No real customer data, credentials, Cloudflare account identifiers, or production dumps are included

## Security and privacy

- [ ] Authorization/trust-boundary effects were reviewed
- [ ] Idempotency, retry, race, and failure behavior were reviewed where applicable
- [ ] Data collection, retention, logging, and disclosure behavior were reviewed where applicable
- [ ] External provider changes are optional by default or the scope change is explicitly documented

## Documentation and operations

- [ ] README/spec/operator docs were updated when behavior or setup changed
- [ ] Migration, rollback, and recovery implications were considered
- [ ] Release/parity claims remain supported by concrete evidence
