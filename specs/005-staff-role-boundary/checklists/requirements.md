# Specification Quality Checklist: Staff and role boundary (S3)

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-08-16
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for a non-technical stakeholder where it can be
- [x] All mandatory sections completed

Note on the first item: the specification names existing code locations in its Context section and
names the storage convention a migration must follow. Both are constraints the design has to satisfy
rather than choices about how to build it — a design that ignores the strict-schema check would be
wrong, not merely differently implemented — so they are stated rather than deferred to planning.

## Requirement Completeness

- [x] No `[NEEDS CLARIFICATION]` markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified

## Roadmap Alignment

- [x] Covers every element of the S3 row: migration path off the single owner secret (FR-017 to
      FR-021), authorization (FR-001 to FR-005), revocation (FR-010, FR-011), offboarding (FR-012,
      FR-013), privacy (FR-022 to FR-025), accountless customer path preserved (FR-026, User Story 5)
- [x] States the completion gates the implementation slice must pass
- [x] Does not change any capability status; the target matrix stays the single authority
- [x] Does not change the roadmap stage status, which flips only when implementation has landed

## Constitution Alignment

- [x] I. Provider-Neutral Core: FR-027 — no new required secret, service, or configuration step
- [x] II. Adapters Are Invisible Until Configured: FR-017 — an installation with no roster is
      unchanged and shows nothing new
- [x] III. Accessibility and Semantics Are Regression-Protected: the implementation-gate section
      requires a browser test for any staff-facing screen and names the CI gap that would otherwise
      let it go unrun
- [x] IV. Transactional Integrity: FR-028 — replay semantics and the command pipeline are unchanged
- [x] V. Public-Safe Surface: FR-025 — no real staff data in the repository

## Open Items

None. Every question the recon surfaced is answered either as a functional requirement or as a
recorded assumption. The Assumptions section states each decision and why the alternative was not
taken, so a reviewer who disagrees has a specific claim to argue with.
