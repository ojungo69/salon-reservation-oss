## Summary

Describe the user-visible or security-relevant change and why it is needed.

## Scope

- What changed:
- What intentionally did not change:

## Production-parity provenance

Complete this section for every pull request. Follow the quality-led selection rule in
`docs/ADR-0001-REUSE-FIRST-PORTING.md`: evaluate reuse, generalization, and replacement on evidence,
not a reuse percentage or work already invested.

- Applies to a production-parity capability: yes / no

When `yes`, copy this declaration once per capability. When `no`, omit capability declarations.
Split mixed-provenance capabilities into smaller declarations.

### Capability declaration

- Capability ID:
- Capability:
- Current disposition (keep exactly one): Copied / Generalized / Reimplemented / Excluded-private
- Private porting ledger updated with exact source/test mapping, rights status, sanitization, and evidence owner: yes / no
- Reused or mapped public tests:
- Outcome comparison, invariant differences, migration/rollback effects, and equivalent-evidence gaps (when applicable):
- ADR for storage, transaction authority, identity, or delivery semantic changes (when applicable):

- [ ] Public diff contains no private coordinates, data, credentials, identifiers, assets, runbooks, denylist terms, or history

## Image-first UI evidence

- New or substantially redesigned UI: yes / no
- Actual generated design image reference and selection record (required when yes; not just a brief):
- Loading, empty, error, conflict, keyboard, and narrow-screen behavior specified before implementation:
- Real browser screenshots compared with the selected design after implementation:

Use fictional data only. A design image is not evidence that its planned features work.

## Verification

- [ ] `npm run check`
- [ ] Relevant focused tests added or updated
- [ ] Browser/UI behavior checked when rendered behavior changed
- [ ] No real customer data, credentials, Cloudflare account identifiers, or production dumps are included

## Review closure before merge

- Reviewed head SHA:
- Current-head CI/check results:
- Current-head bot review evidence:
- Finding dispositions and regression evidence:

- [ ] Bot comments, inline threads, check annotations, and CI failures have been inspected
- [ ] Every valid in-scope finding is fixed and reverified; declined findings have concrete reasons
- [ ] A fresh review covers the changed head, with no requested review outstanding
- [ ] No valid unresolved finding remains and required checks pass
- [ ] Merge uses the verified head SHA without bypassing repository protections

Repeat fix, test, and review until these conditions hold. Do not mark a quota refusal,
unavailable check, or incomplete review as success.

## Security and privacy

- [ ] Authorization/trust-boundary effects were reviewed
- [ ] Idempotency, retry, race, and failure behavior were reviewed where applicable
- [ ] Data collection, retention, logging, and disclosure behavior were reviewed where applicable
- [ ] External provider changes are optional by default or the scope change is explicitly documented

## Documentation and operations

- [ ] README/spec/operator docs were updated when behavior or setup changed
- [ ] Migration, rollback, and recovery implications were considered
- [ ] Release/parity claims remain supported by concrete evidence
