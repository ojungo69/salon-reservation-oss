# Sanitized parity matrix

This finite matrix records generic, public-safe v0.2 must-haves. It is not a source comparison and
contains no private identity, data, asset, configuration, provider account, or deployment detail. A
row becomes a release claim only when its listed acceptance evidence passes in the standalone public
candidate.

| Sanitized must-have | Public-safe implementation path | Acceptance evidence |
|---|---|---|
| Clean-room release boundary | `README.md`, `release/public-files.txt`, `scripts/assemble-public-release.sh`, `scripts/release-audit.mjs` | Public-tree audit: exact allowlist, one root commit/ref, license/content/history/secret checks, no remote or private input |
| Mobile booking journey | `public/index.html`, `public/app.js`, `public/journey.js` | `test/journey.test.ts`; keyboard/focus and 320/360/768/1440 render checks |
| Authoritative multi-service choice | `src/installation-config.ts`, `src/worker.ts`, `src/reservation-day.ts` | Configuration/API tests: compatible services, server totals, eligible resources, stale-selection recovery |
| Pending capacity hold and safe retry | `src/reservation-core.ts`, `src/reservation-day.ts`, `src/worker.ts` | Core/day/API tests: one accepted request, existing-receipt-only `replayOnly`, stale-slot refusal, 50-way race |
| Accountless customer return/cancel | `public/bookings.html`, `public/app.js`, `src/worker.ts` | Journey/API tests: opt-in local proof, uniform unknown-proof response, one cancellation effect |
| Bounded operator schedule | `public/admin.html`, `public/app.js`, `src/worker.ts`, `src/reservation-day.ts` | Day/week tests: attention projection, owner auth, status actions, private-detail cache control |
| Same-day move and closures | `src/reservation-core.ts`, `src/reservation-day.ts`, `src/worker.ts` | Transaction/race tests: stable reference, atomic capacity swap, original unchanged on conflict, shared overlap rule |
| Immutable history | `src/installation-config.ts`, `src/reservation-day.ts`, `src/worker.ts` | Snapshot/version tests: day-pinned catalog/schedule, current accepted consent, fixed partition address window, pinned purge, and booking facts remain interpretable after edits |
| No-integration operator fallback | `src/reservation-day.ts`, `src/worker.ts`, `public/admin.html` | Bounded attention/schedule acceptance flow works with no external notification credential |
| Guided commissioning | `public/setup.html`, `public/admin.html`, `public/app.js`, `src/installation-config.ts`, `src/worker.ts` | Setup tests: owner-only changes, explicit setup-to-closure-management link, optimistic conflict, secret-free receipt, demo-mode mutation refusal |
| Deployable fictional demo | `README.md`, `docs/CLOUDFLARE.md`, `wrangler.jsonc` | Structural Deploy-button check and Wrangler dry-run; no manual database/schema step, real account mutation, deployment, or Free-plan telemetry |
| Live-readiness gates | `src/installation-config.ts`, `public/setup.html`, `docs/CLOUDFLARE.md` | Tests: owner, Turnstile hostname/widget/secret, legal/source identity, capacity, and final confirmation all fail closed until complete |
| Privacy, retention, and proof handling | `docs/PRIVACY.md`, rendered notice pages, browser controller, day retention alarm | Browser-storage checks, key-digest/non-disclosure checks, whole-day deletion test, reviewed editable notices |
| Accessible public shell | shared `public/styles.css` and public pages | Current render inspection: 320-pixel layout, visible focus, keyboard flow, live announcements, reduced-motion/transparency, forced colors |
| Bounded Free-plan target | `src/installation-config.ts`, `src/reservation-day.ts`, `src/worker.ts`, `docs/CLOUDFLARE.md` | 96 creates plus independently 192 non-create lifecycle actions; local maximum fixture and documented static request/write budget remain below the threshold, while deployment and Free-plan telemetry remain unverified |
| AGPL corresponding source | `LICENSE`, `README.md`, setup source URL, release audit | The authorized public source URL resolves to corresponding source; ownership/licensing confirmation is recorded outside the app |

## Intentional exclusions and future adapter boundary

| Capability | v0.2 decision | Future boundary |
|---|---|---|
| External login and staff roles | Excluded; one owner secret is the bounded operator boundary | Add only with a separate authorization, migration, offboarding, and privacy design |
| Messaging, email, push, and calendar synchronization | Excluded; the operator schedule/attention view is the fallback | Consume explicit post-commit events; never make booking acceptance depend on delivery |
| Payments, refunds, tax, and accounting | Excluded; displayed price is informational | A payment adapter needs its own authorization, reconciliation, failure, and legal flow |
| CRM, medical notes, and customer search | Excluded | Any future data model requires a separate privacy/retention and access-control review |
| Multiple locations and cross-day moves | Excluded; one JST location and same-day move only | Design a new partition/transaction model before adding either capability |
| Custom production operations | Excluded from the release | Operators configure their own domain, secrets, monitoring, export, recovery, and notices after authorization |
| External providers generally | Optional and disabled by default | Document purpose/data flow, update notices/contracts, and keep the core usable when the adapter is absent |

The matrix deliberately stops here. Adding a capability requires a new sanitized row, implementation
and acceptance evidence, a privacy/security review, and an updated public-candidate audit.
