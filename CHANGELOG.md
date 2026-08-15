# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Every published version resolves to an immutable Git tag and a GitHub Release. See
[docs/RELEASING.md](docs/RELEASING.md) for the release procedure.

## [Unreleased]

### Added

- Staff accounts with their own credentials, so operating the installation no longer means holding
  the deployment secret. An owner adds people on the setup screen, gives each one either the `owner`
  or the `staff` role, and hands them a credential shown exactly once. `staff` covers the day-to-day
  booking work — the schedule, taking and moving reservations, closures — and reaches nothing else.
  Stopping someone takes effect on their next request and does not delete them: the record stays so
  past attribution keeps resolving. Reactivation issues a new credential, because the old one was
  destroyed rather than suspended. Up to 200 records, stopped ones included.
- `GET`/`POST /api/admin/staff` and `POST /api/admin/staff/:id/{rotate,deactivate,reactivate}`, all
  owner-only. `POST /api/admin/staff` accepts `dryRun: true` to validate a migration without writing.
- Attribution for operator-initiated reservation changes: creating, transitioning, and opening or
  removing a closure now record which account made the change, kept alongside that day's data and
  deleted with it. The stored value is the account identifier, never the display name, so editing a
  name does not rewrite history. Nothing reads this back in the interface yet.
- The privacy documents and the served privacy page describe what a staff record holds, what it
  deliberately does not, and the two retention terms — a staff record for the life of the
  installation, attribution for the life of the day it belongs to.
- Issue forms for bug reports, feature requests, and non-sensitive support questions, plus a pull
  request checklist covering verification, security and privacy, idempotency, documentation, and
  rollback.
- Weekly Dependabot checks for root npm dependencies and commit-pinned GitHub Actions.
- `CHANGELOG.md` and `docs/RELEASING.md`.
- A branch ruleset protecting `main` (pull request required, `check` must pass, branch must be up to
  date, review conversations must be resolved, force pushes and deletion blocked, linear history),
  and a tag ruleset protecting `v*` tags against deletion and rewriting.
- A lifetime for bookings awaiting approval, configurable in the setup screen between 15 minutes and
  7 days and defaulting to 24 hours. A request that is neither approved nor rejected within it
  becomes `expired`, and the time it was holding goes back on sale — until now an abandoned request
  blocked its slot until the day itself was purged. The customer's status page and the operator's
  schedule both show the deadline while a request is still waiting.
- Optional schedule-only iCalendar subscription and Google Calendar outbound adapters, with
  owner-only reconciliation, bounded retries and retention, and no effect on booking availability.

- `.nvmrc` pinning the exact Node.js version, which CI now reads as its single source of truth.
- A CI assertion that fails when an installed package has an install script outside the
  `allowScripts` allowlist.

### Changed

- The operator screen's credential field accepts a staff credential as readily as the deployment
  secret. The deployment secret keeps working on every route, including when the roster is empty,
  unreadable, or has no active owner — it is never checked against the roster and cannot be revoked
  from it.
- Dependabot no longer proposes `@types/node` major updates, which track Node.js majors and have to
  move together with `.nvmrc` and `engines.node`. `CONTRIBUTING.md` now also explains why every
  Dependabot npm pull request starts red — the release audit pins each direct dependency's version
  in `docs/THIRD_PARTY_LICENSES.md`, which Dependabot does not update — and what to do about it.

- The install-script policy is now enforced rather than declared. CI installs npm 12 explicitly
  (Node 24.16.0 bundles npm 11.13.0, which recognizes neither the `allowScripts` field nor
  `strict-allow-scripts`) and keeps `--ignore-scripts`, so no third-party install code runs in CI,
  while a separate step fails the build if any installed package has an install script outside the
  reviewed allowlist. `.npmrc` gains `engine-strict=true`, and `package.json` declares the supported
  npm range.
- The release audit now pins the CI workflow itself, line for line, with only the action SHAs left
  free so Dependabot's digest bumps stay quiet. Removing or neutralising the install-script policy,
  granting the job write permissions, or keeping the checkout credentials fails the audit instead of
  passing quietly.
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
