# Implementation Plan: Multi-location boundary

**Branch**: `feat/multi-location-s4` | **Date**: 2026-10-09 | **Spec**: [spec.md](spec.md)
**Input**: Accepted S4 direction; maximum four locations, exact default compatibility, migration excluded.

## Summary

Keep the existing SQLite-backed day Durable Object as the sole booking transaction authority, addressed by location/day. Extend the existing root configuration with lazy named-location/grant/lifecycle records and reuse command reducers. Reuse complete LINE/calendar actor classes per location; one shared LINE realm and one Google credential set suffice. Add usable customer/operator/setup controls and prove isolation through real Worker and browser fixtures. The storage comparison and bounds are recorded in [ADR0003](../../docs/ADR-0003-MULTI-LOCATION-BOUNDARY.md).

## Technical Context

**Language/Version**: Existing TypeScript 7.0.2, Node 24.16.0 tooling, browser ES modules.
**Primary Dependencies**: Existing Workers runtime/Wrangler/Vitest/Playwright only; no new package.
**Storage**: Existing SQLite DO namespaces, lazy root `__` tables, location-suffixed browser keys.
**Testing**: Existing pure tests, real Workers tests, fixture-only provider clients, rendered browser/axe suites.
**Target Platform**: Existing single Worker and static pages; compatibility date 2026-08-08.
**Project Type**: Existing reservation web application, not new scaffolding.
**Performance Goals**: Bounded four-entry directories/fanout, one selected-location seven-day schedule, existing per-day budgets. Record measured resource scenarios; no unmeasured latency/free-tier guarantee.
**Constraints**: Default keys/serialized records/API bodies/v1 delivery bytes unchanged; 16 KiB input bounds; 200-member roster, 0–4 staff scopes; no new provider accounts/DO classes/bindings; no S5 or real-data operation.
**Scale/Scope**: Four locations including default; per-location existing 8 resources/16 services/96 creates/192 mutations per day; one timezone and provider realm.

## Constitution Check

| Gate | Design result / implementation proof |
| --- | --- |
| Provider-neutral core | Booking rules and transaction authority remain provider-independent; outage/byte-equivalence tests required |
| Invisible optional adapters | New locations off by default; capability-gated UI/routes; default behavior preserved |
| Accessibility | Actual generated references selected; browser/keyboard/viewport checks remain required |
| Transactional integrity | Existing reducers/receipts/budgets reused; cross-location races and exact rollback proofs required |
| Public-safe surface | Public reference evidence only; no copied source/tests/DDL; separate private ledger maintained by coordinating agent |
| Standing quality gates | Full check/browser, correctness, over-implementation, static security/adversarial reviews and current-head CI required |

Pre-design and post-design review: no constitutional exception. This design commit establishes contracts, not implementation completion. Runtime work starts only after the private evidence row and this ADR exist. Do not relabel capability status from tests that have not run.

## Project Structure

Feature artifacts: `spec.md`, `research.md`, `data-model.md`, `quickstart.md`, `contracts/{http-api,location-rpc,adapters,browser-state}.md`, `design/{customer-reference.png,operator-reference.png,calendar-reference.png,selection.md,prompts.json}`, `tasks.md`.

Keep current source layout. Add only `src/location.ts` for canonical backend addresses and parsing. Reuse `src/installation-config.ts`, `worker.ts`, `reservation-day.ts`, `adapter-delivery.ts`, `calendar-adapter.ts`, `line-adapter.ts`. Browser changes stay in existing `public/` modules/pages/styles. Tests stay in existing `test/` and `tests-browser/` suites or narrowly named location suites.

## Contracts and implementation sequence

1. Preserve current compatibility fixtures before changing runtime. Implement helper and root state/grant/context contracts in [location-rpc.md](contracts/location-rpc.md); no new table on reads.
2. Worker resolves canonical scope once, keeps existing body/response parsers and gates, and addresses matching day/adapter actors. New projections carry directory/grant data. Bind named Turnstile verification to location.
3. Integrate scoped actors, root lifecycle scheduler and shared webhook fanout. Preserve local consent/send-claim atomicity. Named calendar configuration errors cannot trigger disable. Keep target IDs immutable in S4.
4. Implement real browser flows from selected images: booking selector, own-location proof management, scoped operator boards, location/grant setup, and a small named-only calendar panel with one-time capability display. Preserve default presentation and pending records; ignore stale response generations.
5. Integrate, prove failure/race/retention behavior, run full quality/browser/security/release gates, then update capability claims from evidence.

Budget baseline stays at current 60-second sweep. Idle-sweep optimization is deferred beyond S4; any later change needs independently proven retry/claim/retention/disable scheduling and backlog evidence. No universal cycle bound is inferred from empty 457-day sweeps.

## Three writers and merge order

| Writer | Exclusive implementation files | Depends on |
| --- | --- | --- |
| Config/location | `src/location.ts`, `src/installation-config.ts`, `test/installation-config.test.ts`, `test/staff-roster.test.ts`, `test/location.test.ts`, `test/location-config.test.ts`, `vitest.config.ts` | This design commit and private evidence gate |
| HTTP/adapters | `src/worker.ts`, `reservation-day.ts`, `adapter-delivery.ts`, `calendar-adapter.ts`, `line-adapter.ts`, `adapter-constants.ts`, Worker/day/adapter tests | Contracts immediately; config commit before combined execution |
| UI/browser | `public/*`, `tests-browser/*`, `test/journey.test.ts` when needed | Contracts and images; combined backend before final browser proof |

Coordinator alone handles manifest/audit/package test registration, public document status, generated types, integration and release checks. Every branch has one writer. Contract changes are communicated before implementations diverge. Do not share-edit `worker.ts`, `installation-config.ts`, `public/app.js`, or integration metadata. Merge config first, then HTTP/adapters, then UI; parallel preparation is allowed in disjoint worktrees. Standalone stubs do not complete browser acceptance.

## Completion and backout

Complete only after all four user stories and standing checks pass. Preserve new namespaces/side-table readers/alarm handlers in forward backout; pausing named locations does not delete their retained data. No pre-S4 rollback/import/restore is executed. ROADMAP edits are reserved for the coordinating agent's separate integration to avoid conflicting with the migration-confirmation policy change; recommend S4 In progress only after the architecture/evidence gate, Complete only after implementation evidence. S5 remains Not started.
