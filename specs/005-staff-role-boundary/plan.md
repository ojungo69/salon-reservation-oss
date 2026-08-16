# Implementation Plan: Staff and role boundary (S3)

**Branch**: `feat/s3-staff-role-design` | **Date**: 2026-08-16 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/005-staff-role-boundary/spec.md`

## Summary

Today one shared `OWNER_TOKEN` is the entire operator identity, and thirteen rate-limiter buckets
sit behind it. This slice adds a per-person roster so that access can be granted and withdrawn one
person at a time, splits the operator surface into a `staff` half and an `owner` half, and records
who performed each operator-initiated reservation change.

The technical approach is to add nothing new architecturally and reuse three patterns the codebase
already runs:

1. **Storage**: a `__staff_roster` singleton-JSON table inside `InstallationConfig`, created on
   first write, modelled line for line on `__line_lifecycle` — the mechanism by which the LINE
   lifecycle state reached already-provisioned installations without a schema bump.
2. **Credentials**: the management-key shape — 32 random bytes, base64url, 43 characters, only the
   SHA-256 digest stored, compared with the existing constant-time `equalBytes(sha256(a), sha256(b))`.
   Generated in the Worker instead of the browser, because the system must show it once.
3. **Attribution**: written inside the same `transactionSync` that writes the command receipt, into
   a `__attribution` table in `ReservationDay` — the `__`-prefix trick that object already uses for
   `__adapter_meta` / `__adapter_outbox`.

The authorization change is confined to `ownerGate`: it grows from "does this bearer token equal the
deployment secret" into "resolve this bearer token to an actor, then check the actor's role against
this route's requirement". `OWNER_TOKEN` is still tried first, from the environment, with no I/O —
so the break-glass path works when the roster is unreachable and today's hot path is unchanged.

## Technical Context

**Language/Version**: TypeScript 5.x targeting the Cloudflare Workers runtime (`workerd`), ES2022
modules. No transpilation step beyond `wrangler`'s own.

**Primary Dependencies**: `@cloudflare/workers-types`, `wrangler`, `vitest` +
`@cloudflare/vitest-pool-workers`, `@playwright/test`. This slice adds none.

**Storage**: Durable Object SQLite. `InstallationConfig` (singleton `installation`) holds settings
and the LINE lifecycle; `ReservationDay` (one per `single-location:<date>`) holds reservations,
details, closures, receipts, and the adapter outbox. No relational database, and the constitution
forbids adding one.

**Testing**: `npm run test:core` (`node --test`, pure modules), `npm run test:worker` (`vitest` in
the Workers pool, including the 50-way race and 96-create lifecycle suites), `npm run test:browser`
(Playwright, Chromium, `workers: 1`, `fullyParallel: false`). CI runs the browser suite as its own
step at `.github/workflows/ci.yml:86`.

**Target Platform**: A single Cloudflare Worker with three Durable Object classes, deployed by the
deploy button. One required secret (`OWNER_TOKEN`); everything else is adapter configuration.

**Project Type**: Web service with a server-rendered static front end (`public/`), no build step and
no framework.

**Performance Goals**: No numeric target. The binding constraint is qualitative: the operator gate
may add at most one Durable Object round trip, and only on the path where the presented credential
is *not* the deployment secret. Public routes gain nothing at all.

**Constraints**:

- `booking_details`, `adapter_receipts`, `closures`, `core_state`, and `partition_meta` are created
  with `CREATE TABLE IF NOT EXISTS` and validated against an exact table list, so **a new column on
  any of them would never reach an already-provisioned Durable Object**
  (`src/reservation-day.ts:966-972` states this for the pending deadline). Every new field in this
  slice therefore lands in a `__`-prefixed table.
- Command fingerprints are versioned and hashed (`src/reservation-day.ts:2600`). The acting identity
  must stay **out** of the fingerprint, or FR-028 breaks: the same command replayed by a different
  authorized actor would become a fingerprint mismatch instead of a receipt replay.
- No authorization decision may be cached (FR-010), so the roster is read per request.
- No new required secret, service, or configuration step (FR-027).

**Scale/Scope**: One salon. A roster of a few to a few tens of people — small enough that resolving
a credential by scanning every entry with a constant-time compare is both fast and the cheapest way
to get FR-005's indistinguishable timing.

## Constitution Check

*GATE: evaluated before Phase 0 and re-evaluated after Phase 1 design. Both passes below.*

| Principle | Pre-design | Post-design |
|---|---|---|
| **I. Provider-Neutral Core** | At risk in principle — identity is exactly where projects reach for an external IdP. | **PASS.** The spec puts SSO, email invitation, and external identity out of scope; the roster is Durable Object storage and the credential is locally generated. Zero external services, and the deploy story gains no step because the roster is opt-in (FR-017). |
| **II. Adapters Are Invisible Until Configured** | Not implicated: the roster is core, not an adapter. | **PASS.** With no roster, no staff UI renders and no route behaves differently. The design also refuses to pretend revocation reaches an in-flight adapter saga (spec assumption; alarms never consult the gate) rather than quietly changing saga behaviour. |
| **III. Accessibility Regression-Protected** | At risk — this slice adds an operator screen. | **PASS with an obligation.** The roster screen ships with a browser test in `tests-browser/`, which CI already runs (`ci.yml:86`), plus the standing keyboard and 320 px review. Recorded as a task, not an aspiration. |
| **IV. Transactional Integrity** | The real risk: attribution touches the command kernel. | **PASS.** Attribution is written inside the existing `transactionSync`, after the command gate, so a replay returns the cached receipt and does not re-attribute. The actor is excluded from the fingerprint so replay semantics are literally unchanged. No new command type, no change to the acceptance budgets. |
| **V. Public-Safe Surface** | At risk — fixtures for a staff roster are exactly where a real name leaks. | **PASS.** FR-025 forbids real names, credentials, and identifiers anywhere in the tree; fixtures use invented names, and the release audit already scans for private terms. |

**Quality gates** (constitution's own list) all apply unchanged, and because this slice is in
security scope it additionally passes the security review battery. No violation needs justification,
so Complexity Tracking below stays empty.

## Project Structure

### Documentation (this feature)

```text
specs/005-staff-role-boundary/
├── spec.md              # Feature specification (complete)
├── checklists/
│   └── requirements.md  # Specification quality checklist (complete)
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/
│   ├── roster-api.md    # Phase 1 output — the roster HTTP surface
│   └── authorization.md # Phase 1 output — route-by-route role table
└── tasks.md             # Phase 2 output (/speckit-tasks — NOT created here)
```

### Source Code (repository root)

```text
src/
├── worker.ts             # ownerGate → actor resolution + role check; roster routes
├── installation-config.ts# __staff_roster storage, roster commands, resolveActor RPC
├── reservation-day.ts    # __attribution table; actor threaded through the five mutations
└── (adapter-*.ts, reservation-core.ts, calendar-adapter.ts, line-adapter.ts unchanged)

public/
├── app.js                # roster panel on the operator screen; staff sign-in
└── (index.html, setup.html, styles as needed for the roster panel)

test/                     # node --test: roster shape and role-table pure logic
tests-browser/            # Playwright: roster screen, staff sign-in, staff refusal
docs/
├── PRIVACY.md            # staff data category + operator retention checklist
├── PARITY.md             # staff accounts row Planned → shipped
└── ROADMAP.md            # S3 row status
```

**Structure Decision**: Single Worker, unchanged. This is the layout the repository already has —
three Durable Object classes in `src/`, a static front end in `public/`, and three test suites. The
slice adds no directory and no module: the roster is storage plus RPC on the existing installation
object, and the boundary is a change to one existing function.

## Complexity Tracking

> No Constitution Check violations. Nothing to justify.
