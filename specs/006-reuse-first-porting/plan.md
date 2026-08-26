# Reuse-First Porting Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox syntax in `tasks.md` for tracking.

**Branch**: `feat/reuse-first-porting` | **Date**: 2026-08-26 | **Spec**: [spec.md](spec.md)

**Goal:** Establish the Phase 0 evidence and contribution boundary that makes production-tested reuse the default without changing runtime behavior.

**Architecture:** Keep exact source coordinates and rights evidence in one tracked private ledger in the non-public development workspace. Publish only an allowlisted projection: one ADR, one provenance summary, parity/roadmap links, and a pull-request declaration gate. Existing release auditing remains the enforcement point for public-file inclusion; no second generator, schema, or runtime abstraction is added.

**Tech Stack:** Markdown governance artifacts; existing Node.js 24 release-audit script; Git and npm 12 verification.

**Spec:** `specs/006-reuse-first-porting/spec.md`

## Global Constraints

- Issue #60 Phase 0 only; storage-model selection and source-code porting remain later slices.
- No runtime, storage schema, public API, authentication, deployment, or external-resource change.
- The production system and all production resources remain read-only.
- No private repository name or path, private commit identifier, customer data, account or deployment identifier, credential, branding asset, raw denylist term, or private history may enter the public tree.
- A current provenance disposition and a preferred future porting method are separate fields.
- Preserve existing local changes in the private workspace.
- No commit, push, pull request, merge, deployment, migration, message, or publication is authorized by this plan.

---

## Summary

The only verified exact implementation reuse is the audited date parser. The current reservation kernel, day-partitioned storage, customer journey, LINE adapter, calendar adapter, and staff-role boundary were implemented independently or by reusing patterns inside the public project; they must therefore be labeled `Reimplemented` until stronger source evidence proves otherwise. Phase 0 records that fact honestly, preserves exact mapping privately, and prevents later parity work from silently adding another independent implementation.

## Technical Context

**Language/Version**: Markdown; existing ECMAScript module syntax in `scripts/release-audit.mjs`; Node.js 24

**Primary Dependencies**: Node.js standard library, existing npm scripts, Git; no new package

**Storage**: Tracked Markdown files in two local repositories; no application storage change

**Testing**: `npm run check`, focused `npm run release:audit`, `git diff --check`, exact content hash comparison, public/private scope inspection

**Target Platform**: Public GitHub repository plus its separate private development workspace

**Project Type**: Documentation and governance slice for an existing Cloudflare Worker application

**Performance Goals**: No runtime effect; release-audit asymptotics and network behavior unchanged

**Constraints**: Public projection is allowlisted; private evidence is never copied into the public repository; no browser verification because rendered behavior does not change

**Scale/Scope**: Eight initial provenance rows, two new public documents, one existing pull-request template, two existing parity documents, release manifest/audit registration, and one private ledger

## Constitution Check

*GATE: Passed before research; re-checked after design.*

- **Provider-Neutral Core**: PASS. No booking or adapter runtime changes.
- **Adapters Invisible Until Configured**: PASS. Adapter behavior and configuration remain untouched.
- **Accessibility and Semantics**: PASS. No rendered UI changes.
- **Transactional Integrity**: PASS. No command, storage, or transaction code changes.
- **Public-Safe Surface**: PASS. Exact private evidence stays in the private workspace; public artifacts use capability descriptions only.
- **Quality Gates**: PASS. Full baseline is green; final `npm run check`, release audit, diff inspection, correctness review, and over-implementation review are required.

## Project Structure

### Documentation (this feature)

```text
specs/006-reuse-first-porting/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── provenance-record.md
├── checklists/
│   └── requirements.md
├── tasks.md
└── verify-tasks-report.md
```

### Public repository changes

```text
.github/pull_request_template.md       # contributor provenance declaration
CHANGELOG.md                           # unreleased governance change
docs/ADR-0001-REUSE-FIRST-PORTING.md  # durable decision and exceptions
docs/PORTING.md                        # sanitized current-provenance summary
docs/PARITY.md                         # capability/provenance distinction and link
docs/ROADMAP.md                        # Phase 0 gate before architecture expansion
release/public-files.txt               # public release registration
scripts/release-audit.mjs              # new durable public documents are REQUIRED
test/release-audit-denylist.test.ts    # canonical-path and renamed-ledger rejection
```

### Private workspace change

```text
private development workspace/
└── docs/PRIVATE_PORTING_LEDGER.md      # exact source, test, rights, and sanitization evidence
```

**Structure Decision**: Use existing flat `docs/` conventions and the existing pull-request/release gates. One private ledger and one public projection avoid two competing provenance systems. No generator is justified for eight rows.

## Research Decisions

Detailed evidence and rejected alternatives are in [research.md](research.md).

1. Scope Phase 0 separately from the storage/transaction ADR.
2. Treat absent exact-copy/generalization evidence as `Reimplemented`, never infer reuse from similar behavior.
3. Keep private mapping in the non-public development workspace and publish an explicit field allowlist.
4. Make both public governance documents required release files.
5. Use the current pull-request template as the contribution gate; add no bot or workflow.
6. Bind private evidence to verified source and public revisions to prevent stale mapping.

## Design Artifacts

- [data-model.md](data-model.md) defines disposition, assessment, and migration-readiness states.
- [contracts/provenance-record.md](contracts/provenance-record.md) defines private fields, public projection allowlist, and pull-request declaration.
- [quickstart.md](quickstart.md) defines the end-to-end verification sequence.

## Implementation Sequence

### 1. Establish public decision and projection

Create `docs/ADR-0001-REUSE-FIRST-PORTING.md` and `docs/PORTING.md`. The ADR defines the decision ladder, four dispositions, pause/security exception, evidence requirements, and future canonical-core goal. The summary contains only sanitized current dispositions and migration-readiness gates.

**Independent check:** A reader with no private access can distinguish capability status, provenance, and migration readiness; date parsing is the only `Copied` implementation.

### 2. Record exact private evidence

Create `docs/PRIVATE_PORTING_LEDGER.md` in the private workspace. Bind the ledger to the verified revisions, map exact production source/migration/test paths to the current public files, record rights status, sanitization, evidence owner, current disposition, preferred future method, and next gate. Never read or copy secret values.

**Independent check:** Every initial public summary row projects from one private row, and no private coordinate appears in the public worktree diff.

### 3. Install contribution and roadmap gates

Extend `.github/pull_request_template.md`, `docs/PARITY.md`, and `docs/ROADMAP.md`. Parity pull requests must declare one disposition, ledger update, test relationship, sanitization, and reimplementation evidence. Architecture-expanding work without the record remains blocked; security fixes remain allowed.

**Independent check:** A hypothetical parity pull request cannot complete the template while omitting provenance or tests.

### 4. Register durable public artifacts

Add both new public documents to `release/public-files.txt` and the `REQUIRED` set in `scripts/release-audit.mjs`; record the change in `CHANGELOG.md`. Run GitNexus impact on `REQUIRED` before editing and `detect_changes` after the public diff.

**Independent check:** Removing either document makes the release audit fail with `required public path is missing`.

### 5. Verify and review once

Run the quickstart commands, inspect both repository scopes, reconcile every checked task with evidence, and write `verify-tasks-report.md`. Run correctness review, optional independent review for the governance boundary, then ponytail over-implementation review. Do not commit or publish.

## Security and Operational Risk Review

- **Abuse**: A template is a visible review gate, not a branch-protection enforcement mechanism. Phase 0 deliberately adds no custom CI parser; reviewers enforce it until evidence shows automation is needed.
- **Data loss**: The private ledger is tracked only in the non-public workspace. Public release registration includes only the ADR and sanitized summary.
- **Race/drift**: The private ledger records both verified revisions and date. Any later source change marks mappings stale until rechecked.
- **Rollback**: Public changes are documentation plus two required-path entries and can be reverted together. The private ledger remains evidence and records supersession instead of deleting history.
- **Secrets**: Verification checks paths and schemas only. It never opens environment files or records credential values.
- **External effects**: None. GitHub settings, issues, pull requests, remotes, Cloudflare resources, and production data remain unchanged.

## Post-Design Constitution Check

All pre-research gates still pass. The contract explicitly forbids private evidence in the public projection, preserves provider-neutral operation, and adds no runtime or dependency. No complexity exception is required.

## Complexity Tracking

No constitution violation or new abstraction is introduced.
