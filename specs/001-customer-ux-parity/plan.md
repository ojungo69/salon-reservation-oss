# Implementation Plan: Customer UI/UX Production Parity

**Branch**: `feat/customer-ux-parity` | **Date**: 2026-08-11 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/001-customer-ux-parity/spec.md`, Phase-0 inventory from [research.md](./research.md)

## Summary

The customer flow already has the three-step shell, draft persistence, and success surface; this plan closes the residual parity gaps found in research D2: an editable booking-summary card on the details step, a stronger final-confirmation presentation, a scalable service-selection surface with chips and running totals, slot refresh and operator availability notices, a proof-bound duplicate-booking warning, an operator flag for resource-choice exposure, success-copy polish, absence-tested adapter slots, and the committed UX parity matrix. Two bounded backend touchpoints (a settings notice field + resource-choice flag, and one read-only duplicate signal) ride existing mechanisms; reservation transaction semantics stay untouched.

## Technical Context

**Language/Version**: TypeScript 5.x (Workers), vanilla ES-module JavaScript for `public/` (no framework), HTML/CSS

**Primary Dependencies**: Cloudflare Workers + Durable Objects (SQLite), Turnstile; no new dependencies planned

**Storage**: existing Durable Object SQLite (no schema change); browser `localStorage` via `journey.js` records

**Testing**: `node --test` (journey/core), vitest workers pool (day/API), Playwright + axe-core (`tests-browser/`)

**Target Platform**: Cloudflare Workers Free plan; browsers at 320/360/768/1440 px

**Project Type**: single Worker serving static `public/` + API

**Performance Goals**: no additional request on the happy path; duplicate check adds at most one read-only call before submission

**Constraints**: Free-plan budget (existing request/write budgets unchanged), settings-version compatibility for drafts, AGPL public-safe surface

**Scale/Scope**: ~6 public files + 2 src files + tests + 1 doc; catalog cap 16 services / 4 selected (unchanged, research D5)

## Constitution Check

- **I. Provider-neutral core**: no external service enters the booking path; duplicate signal is proof-bound and local (research D4). ✅
- **II. Adapters invisible until configured**: location/identity/notification surfaces ship as documented insertion points plus absence tests only. ✅
- **III. Accessibility regression-protected**: every new surface specifies keyboard/SR behavior; browser suite + axe extended; manual checklist rows unchanged. ✅
- **IV. Transactional integrity**: no change to command kernel, budgets, receipts; duplicate signal is read-only. ✅
- **V. Public-safe surface**: no production branding; polite Japanese customer text; matrix references production by task only. ✅

No violations → Complexity Tracking not needed.

## Project Structure

### Documentation (this feature)

```text
specs/001-customer-ux-parity/
├── spec.md
├── research.md          # Phase 0 (done)
├── plan.md              # this file
└── tasks.md             # /speckit-tasks output (after plan approval)
```

Contracts and data shapes are small enough to live in this plan (below) instead of separate `contracts/`/`data-model.md` files.

### Source Code (repository root)

```text
public/
├── index.html       # summary card markup (details stage), confirmation panel, refresh button, notice slot, duplicate-warning dialog
├── app.js           # startCustomer: card rendering, compact service surface, refresh, duplicate check, ack flow; startSetup: notice + resource-flag inputs
├── journey.js       # pure additions: selection-summary derivation, duplicate-ack state, compact-surface filter state
├── styles.css       # chips, card, confirmation panel, notice styles (all themes, forced-colors, reduced-motion)
├── bookings.html    # entry-point copy polish
└── setup.html       # notice text + resource-choice flag fields

src/
├── installation-config.ts  # optional availabilityNotice (bounded text), exposeResourceChoice flag — versioned settings
└── worker.ts               # expose new settings in /api/config; POST /api/reservations/active-check (proof-bound duplicate signal)

test/journey.test.ts         # new pure-function cases
tests-browser/customer.spec.ts (+ possibly one new spec file)  # card, chips, refresh, duplicate ack, absence tests, viewports
docs/UX-PARITY.md            # user-task parity matrix (FR-014)
```

**Structure Decision**: stay inside the existing single-Worker layout; new client logic goes into `journey.js` pure functions wherever it is state, `app.js` only wires DOM (research risk mitigation).

## Delivery phases (map to spec user stories)

1. **US1 (P1) — summary card + confirmation presentation**: `index.html` details-stage card with per-field edit links (jump to selection/details), review-stage panel styling and CTA isolation; `journey.js` summary derivation; browser tests at 4 viewports.
2. **US2 (P2) — scalable service selection**: threshold 8 (research D6): ≤8 renders today's list byte-for-byte; >8 renders filter input + checkbox list + selected chips + running duration/price total (server-derived values already in config/availability responses); full keyboard/SR paths; unit tests for filter state, browser test with an >8 fixture catalog.
3. **US3 (P2) — freshness & duplicate recovery**: slot-refresh button reusing the sequenced availability loader; `availabilityNotice` settings field (bounded text, versioned) surfaced near availability; proof-bound duplicate check (contract below) with acknowledgement gate before submit; CAPACITY_REACHED / stale-slot copy verified inside the shell.
4. **US4 (P3) — key comfort**: one-sentence key explanation, copy affordance kept, bookings entry copy check.
5. **US5 (P3) — adapter slots**: `docs/UX-PARITY.md` documents the three insertion points; browser tests assert absence in default config.
6. **Matrix + closure**: fill `docs/UX-PARITY.md` per user task (parity / exceeds / deferred-with-reason), update `docs/PARITY.md` acceptance rows touched, run the manual keyboard/mobile review, close #11.

Each phase lands as an independently green commit on `feat/customer-ux-parity`; one PR at the end (or split PRs if review size demands — decided at review time).

## Backend contracts (the only two)

**Settings additions** (`installation-config.ts`, versioned like existing fields):
- `availabilityNotice`: optional string, trimmed, 1–200 chars, plain text; absent by default; editable in setup; exposed in public config.
- `exposeResourceChoice`: boolean, default `true` (today's behavior). When `false`, the resource select is hidden, the best eligible resource is auto-assigned (existing single-eligible logic generalized), and the assignment is shown on summary/confirmation.

**Duplicate signal** (`worker.ts`): `POST /api/reservations/active-check` with `{ date, entries: [{ reservationId, managementKey }] (≤16) }` → `{ activeReservationIds: [...] }`. Verifies each key digest against the stored booking exactly like the existing cancel path, returns only IDs that are active on that date. Read-only, rate-limited like other public endpoints, uniform response for unknown proofs (no oracle). Client warns + requires acknowledgement when non-empty; cross-device duplicates documented as deferred (research D4).

## Test plan

- Pure: `journey.js` additions (summary derivation, filter state, ack state) in `test/journey.test.ts`.
- API: worker tests for config exposure, notice bounds, active-check (valid proof / wrong key / cancelled booking / foreign reservationId → uniform behavior).
- Browser: extend customer spec(s) — card edit-jump, chips + totals via keyboard, refresh re-render, duplicate ack path (create → remember → attempt second same-day booking), absence tests, axe + overflow at 320/360/768/1440.
- Full `npm run check` + browser suite green per phase (constitution gates).

## Judgment calls batched for plan approval

1. Duplicate warning is **proof-bound** (remembered bookings only), not contact-matching — privacy trade (research D4). OK?
2. Compact service surface activates **above 8 services**; below that the UI stays byte-identical (research D6). OK?
3. Catalog cap 16 stays; raising it is out of scope (research D5). OK?
4. `exposeResourceChoice` default **true** (no behavior change for existing installs). OK?
5. Notice field is **one plain-text string** (no per-resource/per-day scoping in this feature). OK?
