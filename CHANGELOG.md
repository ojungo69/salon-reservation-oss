# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Every published version resolves to an immutable Git tag and a GitHub Release. See
[docs/RELEASING.md](docs/RELEASING.md) for the release procedure.

## [Unreleased]

### Added

- Issue forms for bug reports, feature requests, and non-sensitive support questions, plus a pull
  request checklist covering verification, security and privacy, idempotency, documentation, and
  rollback.
- Weekly Dependabot checks for root npm dependencies and commit-pinned GitHub Actions.
- `CHANGELOG.md` and `docs/RELEASING.md`.
- A branch ruleset protecting `main` (pull request required, `check` must pass, branch must be up to
  date, review conversations must be resolved, force pushes and deletion blocked, linear history),
  and a tag ruleset protecting `v*` tags against deletion and rewriting.

### Changed

- `SECURITY.md`, `CONTRIBUTING.md`, and `CODE_OF_CONDUCT.md` now describe the repository's private
  security advisory form as the concrete private reporting route. Private vulnerability reporting is
  enabled, so the form is available to any GitHub user.
- `CONTRIBUTING.md` documents the branch and merge policy and the two-file procedure for updating
  the install-script allowlist.

## [0.2.0] - 2026-08-10

First public release.

### Added

- Japanese, responsive customer, customer-status, setup, and operator pages.
- A guarded three-stage booking journey with server-derived duration, price, eligibility, and an
  availability recheck before submission.
- Pending capacity holds, idempotent approve/reject/cancel, same-day reschedule, closures, and
  bounded day and week operator views.
- Browser-generated 256-bit management keys; only SHA-256 digests are stored.
- Owner-guided configuration with a demo/live latch, legal-copy readiness checks, and a secret-free
  installation receipt.
- Whole-day retention deletion, focused race and security checks, and allowlisted release auditing.

### Known limitations

One `Asia/Tokyo` location, 1–8 capacity-one resources, 1–16 services, 1–4 services per request,
same-day rescheduling only, and a bounded seven-day operator view. Payments, notifications, external
identity, calendar synchronization, customer CRM or medical notes, multiple locations, staff roles,
and cross-day moves are intentionally absent. See [docs/PARITY.md](docs/PARITY.md).

[Unreleased]: https://github.com/ojungo69/salon-reservation-oss/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/ojungo69/salon-reservation-oss/releases/tag/v0.2.0
