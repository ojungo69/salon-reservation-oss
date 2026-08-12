# Capability parity matrices

This file is the single authority for capability status. It holds two matrices, describing the
current repository candidate at this commit and maintained against [roadmap](ROADMAP.md) document
version 1.0.0 (whose baseline release is 0.2.0):

- the **implemented capability matrix** — what the current repository candidate delivers, with
  public-safe implementation paths and acceptance evidence (a row becomes a *release* claim only
  when its evidence passes in the standalone public candidate of a tagged release);
- the **production-parity target matrix** — every capability a production salon reservation
  product depends on, each resolved to exactly one status.

Neither matrix is a source comparison, and neither contains private identity, data, asset,
configuration, provider account, or deployment detail; the production system is referenced only by
user task and capability. Delivery order lives in [the roadmap](ROADMAP.md); adapter obligations
live in [the extension contracts](ADAPTER-CONTRACTS.md).

## Implemented capability matrix

| Sanitized must-have | Public-safe implementation path | Acceptance evidence |
|---|---|---|
| Clean-room release boundary | `README.md`, `release/public-files.txt`, `scripts/assemble-public-release.sh`, `scripts/release-audit.mjs` | Public-tree audit: exact allowlist, one root commit/ref, license/content/history/secret checks, no remote or private input |
| Mobile booking journey | `public/index.html`, `public/app.js`, `public/journey.js` | `test/journey.test.ts`; `tests-browser/customer.spec.ts` renders the journey against a running Worker and asserts the recorded result, the editable summary card and confirmation panel, the compact selection past eight services, in-place slot refresh, the operator availability notice, the same-day duplicate acknowledgement, adapter-surface absence, keyboard reach, and no horizontal overflow at 320/360/768/1440 (task-level detail in `docs/UX-PARITY.md`) |
| Authoritative multi-service choice | `src/installation-config.ts`, `src/worker.ts`, `src/reservation-day.ts` | Configuration/API tests: compatible services, server totals, eligible resources, stale-selection recovery |
| Pending capacity hold and safe retry | `src/reservation-core.ts`, `src/reservation-day.ts`, `src/worker.ts` | Core/day/API tests: one accepted request, existing-receipt-only `replayOnly`, stale-slot refusal, 50-way race |
| Accountless customer return/cancel | `public/bookings.html`, `public/app.js`, `src/worker.ts` | Journey/API tests: opt-in local proof, uniform unknown-proof response, one cancellation effect; `tests-browser/customer.spec.ts` renders a remembered booking and opens its cancellation dialog |
| Bounded operator schedule | `public/admin.html`, `public/app.js`, `src/worker.ts`, `src/reservation-day.ts` | Day/week tests: attention projection, owner auth, status actions, private-detail cache control; `tests-browser/owner.spec.ts` signs in, books on a customer's behalf, opens the detail, and signs out |
| Same-day move and closures | `src/reservation-core.ts`, `src/reservation-day.ts`, `src/worker.ts` | Transaction/race tests: stable reference, atomic capacity swap, original unchanged on conflict, shared overlap rule |
| Immutable history | `src/installation-config.ts`, `src/reservation-day.ts`, `src/worker.ts` | Snapshot/version tests: day-pinned catalog/schedule, current accepted consent, fixed partition address window, pinned purge, and booking facts remain interpretable after edits |
| No-integration operator fallback | `src/reservation-day.ts`, `src/worker.ts`, `public/admin.html` | Bounded attention/schedule acceptance flow works with no external notification credential |
| Guided commissioning | `public/setup.html`, `public/admin.html`, `public/app.js`, `src/installation-config.ts`, `src/worker.ts` | Setup tests: owner-only changes, explicit setup-to-closure-management link, optimistic conflict, secret-free receipt, demo-mode mutation refusal, customer-screen settings pair (availability notice, resource-choice flag) round-trip; `tests-browser/install.spec.ts` completes an installation through the rendered form |
| Deployable fictional demo | `README.md`, `docs/CLOUDFLARE.md`, `wrangler.jsonc` | Structural Deploy-button check and Wrangler dry-run; no manual database/schema step, real account mutation, deployment, or Free-plan telemetry |
| Live-readiness gates | `src/installation-config.ts`, `public/setup.html`, `docs/CLOUDFLARE.md` | Tests: owner, Turnstile hostname/widget/secret, legal/source identity, capacity, and final confirmation all fail closed until complete |
| Privacy, retention, and proof handling | `docs/PRIVACY.md`, rendered notice pages, browser controller, day retention alarm | Browser-storage checks, key-digest/non-disclosure checks, whole-day deletion test, reviewed editable notices |
| Accessible public shell | shared `public/styles.css` and public pages | `tests-browser/customer.spec.ts` and `tests-browser/owner.spec.ts`: axe-core WCAG 2.1 A/AA on every public page, the setup screen and the operator screen, keyboard reach through the skip link, and no horizontal overflow at 320/360/768/1440. Reduced motion, forced colours and transparency stay on the manual checklist below |
| Bounded Free-plan target | `src/installation-config.ts`, `src/reservation-day.ts`, `src/worker.ts`, `docs/CLOUDFLARE.md` | 96 creates plus independently 192 non-create lifecycle actions; local maximum fixture and documented static request/write budget remain below the threshold, while deployment and Free-plan telemetry remain unverified |
| AGPL corresponding source | `LICENSE`, `README.md`, setup source URL, release audit | The authorized public source URL resolves to corresponding source; ownership/licensing confirmation is recorded outside the app |

## Manual checks at each tagged release

Automated evidence above is what CI enforces. These are the checks a browser cannot assert for us,
and they are run once per tagged release and recorded in the release notes.

| Check | How |
|---|---|
| Reduced motion | Enable the operating system's reduce-motion setting and confirm no transition or transform animates on the booking journey |
| Forced colours | Open the booking journey and the operator screen in Windows high-contrast mode and confirm every control keeps a visible boundary and label |
| Colour rendering | Confirm each of the three themes reads correctly in both light and dark appearance |
| Screen reader | Complete one booking with a screen reader and confirm each step change and the result are announced |

## Production-parity target matrix

Status is exactly one of four atomic values — **Implemented**, **Partial**, **Planned**,
**Deliberately excluded** — one per row. Where a named capability has parts with different
statuses, it appears as several atomic rows (the decomposition is visible in the row names; the
calendar capability, for example, follows the three modes of
[the calendar contract](ADAPTER-CONTRACTS.md#calendar-synchronization)). A planned row's stage
column names the [roadmap](ROADMAP.md) stage that delivers that row; an excluded row's boundary
column points into [the deliberate exclusions](#deliberate-exclusions) below.

### Core reservation operations

| Capability | Production task it serves | Status | Current evidence / remaining gap | Roadmap stage / exclusion boundary |
|---|---|---|---|---|
| Mobile booking journey | Customers book from a phone without help | Implemented | Implemented matrix: Mobile booking journey | — |
| Multi-service selection with authoritative totals | Customers combine services and see true duration/price | Implemented | Implemented matrix: Authoritative multi-service choice | — |
| Capacity hold and safe retry | Two customers never win the same slot; retries are safe | Implemented | Implemented matrix: Pending capacity hold and safe retry | — |
| Accountless booking return and cancellation | Customers review or cancel without an account | Implemented | Implemented matrix: Accountless customer return/cancel | — |
| Operator schedule and attention view | The operator runs the day without external tools | Implemented | Implemented matrix: Bounded operator schedule; No-integration operator fallback | — |
| Same-day move and closures | The operator reshuffles a day safely | Implemented | Implemented matrix: Same-day move and closures | — |
| Immutable internal history | Past bookings stay interpretable after edits | Implemented | Implemented matrix: Immutable history | — |
| Guided commissioning and live-readiness | A new installation reaches live safely | Implemented | Implemented matrix: Guided commissioning; Live-readiness gates | — |
| Privacy, retention, and proof handling | Customer data is minimal, bounded, and deletable | Implemented | Implemented matrix: Privacy, retention, and proof handling | — |
| Accessible public shell | Every customer can operate the screens | Implemented | Implemented matrix: Accessible public shell | — |
| Bounded free-tier budget target | Load stays within the documented request/write budgets of the platform's free plan (deployment and free-plan telemetry remain unverified, as the evidence row states) | Implemented | Implemented matrix: Bounded Free-plan target | — |
| Verifiable public release (clean room, demo, AGPL) | Adopters can trust and legally reuse what they deploy | Implemented | Implemented matrix: Clean-room release boundary; Deployable fictional demo; AGPL corresponding source | — |

### External identity and staff

| Capability | Production task it serves | Status | Current evidence / remaining gap | Roadmap stage / exclusion boundary |
|---|---|---|---|---|
| External identity login (LINE via LIFF) | Customers reuse an existing identity instead of a management key | Implemented (optional adapter) | Nonce-scoped link intents with management-key proof, server-side ID-token verification, two-phase provisional→final linking (`src/worker.ts`, `src/adapter-delivery.ts`, `src/line-adapter.ts`; tests in `test/line-adapter.test.ts`, `tests-browser/line.spec.ts`); the accountless path stays the default and the adapter is invisible until configured ([setup](LINE-SETUP.md)) | Stage S1 |
| Staff accounts and role boundaries | Multiple staff operate with scoped permissions | Planned | Single owner secret is the implemented boundary | Stage S3 |

### Notifications

| Capability | Production task it serves | Status | Current evidence / remaining gap | Roadmap stage / exclusion boundary |
|---|---|---|---|---|
| LINE notifications (booking events, push with retry) | Customers hear about acceptance/changes without checking back | Implemented (optional adapter) | Transactional outbox with post-commit handoff and a durable sweep, absolute retry ladder under the 24 h retry key, terminal-failure visibility in the redacted ledger, webhook signature verification and dedup (`src/reservation-day.ts`, `src/adapter-delivery.ts`; tests in `test/adapter-delivery.test.ts`); fixture-only in CI per the [notifications contract](ADAPTER-CONTRACTS.md#notifications) | Stage S1 |
| Other notification channels (email, SMS, unspecified providers) | Same task over channels the operator prefers | Deliberately excluded | Seam and contract exist; no concrete channel decided | [Exclusions](#deliberate-exclusions): unspecified providers |

### Calendar synchronization

| Capability | Production task it serves | Status | Current evidence / remaining gap | Roadmap stage / exclusion boundary |
|---|---|---|---|---|
| ICS subscription feed (outbound, authenticated) | The operator sees bookings inside their own calendar | Planned | Contract defined ([calendar, mode 1](ADAPTER-CONTRACTS.md#calendar-synchronization)) | Stage S2 |
| Outbound calendar event synchronization (first implementation: Google, per issue #1's recorded decision) | Bookings appear as events in an external calendar | Planned | Contract defined (calendar, mode 2); the contract stays provider-neutral while the first delivered provider is Google | Stage S2 |
| Inbound availability authority (external busy → blocked slots) | External appointments block salon slots automatically | Deliberately excluded | Contract seam defined (calendar, mode 3); no implementation scheduled | [Exclusions](#deliberate-exclusions): inbound calendar authority |

### Audit and event delivery

| Capability | Production task it serves | Status | Current evidence / remaining gap | Roadmap stage / exclusion boundary |
|---|---|---|---|---|
| External audit/event delivery | Reservation events reach an external system of record | Deliberately excluded | Nothing of the external pipeline (dispatcher, checkpointing, sink) is implemented; the [delivery contract](ADAPTER-CONTRACTS.md#auditevent-delivery) defines the seam, and the internal immutable history is a separate implemented row above | [Exclusions](#deliberate-exclusions): external audit delivery |

### Locations and migration

| Capability | Production task it serves | Status | Current evidence / remaining gap | Roadmap stage / exclusion boundary |
|---|---|---|---|---|
| Multiple locations | One installation serves several salons | Planned | Requires the partition/transaction design recorded as an S4 prerequisite | Stage S4 |
| Cross-day moves | The operator moves a booking to another day | Deliberately excluded | Needs its own transaction design; not implied by multi-location | [Exclusions](#deliberate-exclusions): cross-day moves |
| Import/migration from an existing system | A production installation moves its data in | Planned | Hard-depends on S3/S4 schemas existing first | Stage S5 |

### Out of target

| Capability | Production task it serves | Status | Current evidence / remaining gap | Roadmap stage / exclusion boundary |
|---|---|---|---|---|
| Payments, refunds, tax, accounting | Money is collected and accounted for | Deliberately excluded | Displayed price is informational | [Exclusions](#deliberate-exclusions): payments |
| CRM, medical notes, customer search | The operator keeps customer records | Deliberately excluded | No customer data model beyond the booking | [Exclusions](#deliberate-exclusions): CRM and records |
| Custom production operations | Domain, monitoring, export, recovery are operated | Deliberately excluded | Operator-side responsibility after authorization | [Exclusions](#deliberate-exclusions): custom operations |

## Deliberate exclusions

An exclusion is a decision about the **current** parity target, never a permanent verdict: each row
records why it is out and what a future change would require, and moving one into the target is a
recorded revision of [the roadmap](ROADMAP.md) and this matrix.

| Exclusion | Rationale (current decision) | Future boundary |
|---|---|---|
| Unspecified notification providers (email, SMS, others) | The notifications seam and contract exist, but no channel beyond LINE has a recorded decision; each provider carries its own delivery, consent, and privacy profile | A concrete provider needs a recorded decision, then rides the [notifications contract](ADAPTER-CONTRACTS.md#notifications): post-commit events, dedup, bounded retry, terminal-failure visibility |
| External audit delivery (dispatcher, checkpointing, external sink) | The internal immutable history serves the auditability need today; no stage schedules an external sink, and a contract without any scheduled implementation is a seam, not a plan | Scheduling it is a recorded roadmap revision; the [delivery contract](ADAPTER-CONTRACTS.md#auditevent-delivery) already defines the obligations a future stage must meet |
| Inbound calendar authority (external busy → blocked slots) | Issue #1's 2026-08-11 decision gates it on demonstrated demand; watch-channel renewal, sync tokens, and echo suppression are the heaviest part of the machinery and need a job/queue substrate the core does not yet have | Schedule only by recorded roadmap revision once demand is real and a substrate exists; the [calendar contract's mode 3](ADAPTER-CONTRACTS.md#calendar-synchronization) (fail-closed, reconciliation visibility) is the waiting seam |
| Payments, refunds, tax, and accounting | Displayed price is informational; money flows carry authorization, reconciliation, failure, and legal obligations far beyond the booking core | A payment adapter needs its own authorization, reconciliation, failure, and legal flow before any row moves |
| CRM, medical notes, and customer search | Excluded; the data model stays booking-minimal on purpose | Any future customer-record model requires a separate privacy/retention and access-control review |
| Cross-day moves | Same-day move is implemented; crossing a day boundary breaks the day-partition transaction model | Design a new partition/transaction model before adding it (independent of multi-location, which S4 covers) |
| Custom production operations | Operators configure their own domain, secrets, monitoring, export, recovery, and notices after authorization; the release does not operate installations | Remains operator-side; the release documents interfaces, not operations |

**Cross-cutting adapter boundary** (not an exclusion row — it applies to planned and excluded
providers alike): every external provider is optional and disabled by default, per the constitution
and [the shared adapter invariants](ADAPTER-CONTRACTS.md#shared-invariants-all-seams). Every new
provider documents its purpose and data flow, updates the notices and contracts, and keeps the core
fully usable when absent.

## Update rule

Capability status lives **only here**. A change that alters any capability's status must update the
affected target-matrix row in the same change; when a roadmap stage completes, its stage status
changes in [ROADMAP.md](ROADMAP.md) but capability status still changes here, never there. Other
documents (README, RELEASING, UX-PARITY) derive from or reference these matrices and must not
restate status independently. Adding a capability requires a new target row, implementation and
acceptance evidence for implemented claims, a privacy/security review, and an updated
public-candidate audit.
