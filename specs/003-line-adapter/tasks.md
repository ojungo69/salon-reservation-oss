# Tasks: Optional LINE identity and notifications (S1)

**Input**: [plan.md](plan.md) (authoritative design), [spec.md](spec.md), [research.md](research.md)

**Organization**: Phases follow the plan's dependency order (foundation → lifecycle → linking →
delivery → polish). Story labels map tasks back to spec.md user stories: US1 = customer
notifications (P1), US2 = safe linking (P2), US3 = operator configuration and health (P3).
Execution order is dependency order — US3's lifecycle authority must exist before US2's links,
which must exist before US1's deliveries — while each story keeps its own independent test
criteria (listed per phase). The deactivation saga carries the [US3] label but lives in Phase 6
because it drains structures Phases 4–5 create.

**Tests**: mandated (constitution quality gates; spec SC-001..005 require fixture-proven
behavior). Every phase lands with its tests in the same commit range; the existing race suites
must stay green untouched throughout.

## Constants (single authority — `src/adapter-constants.ts`)

Every number the plan deferred to tasks.md. One exported frozen object; DOs, the adapter core,
and tests import it — no literal re-statements elsewhere.

| Constant | Value | Basis |
|---|---|---|
| `RETRY_OFFSETS_S` | `[0, 60, 360, 1260, 4860, 15660, 37260]` | plan's 7-attempt schedule (t0…+10h21m); total 10.35 h < 24 h retry-key validity |
| `OUTBOUND_TIMEOUT_MS` | 10000 | plan: 10 s cap on every LINE API call |
| `TOKEN_CACHE_TTL_S` | 840 | < 900 s stateless-token `expires_in` with 60 s skew |
| `TOKEN_CACHE_SAFETY_MS` | 60000 | cached tokens are never served within 60 s of their granted expiry |
| `WEBHOOK_BODY_MAX_BYTES` | 262144 | pre-HMAC byte cap (defensive; LINE batches are far smaller) |
| `WEBHOOK_EVENTS_MAX` | 50 | post-signature event-count cap |
| `VERIFY_RESPONSE_MAX_BYTES` | 16384 | bounded reader for verify/token responses |
| `ID_TOKEN_MAX_BYTES` / `ACCESS_TOKEN_MAX_BYTES` | 4096 / 4096 | allowlist schema field caps |
| `LIFF_STATE_MAX_CHARS` | 512 | untrusted `liff.state` bound (same-origin relative path only) |
| `INTENT_NONCE_TTL_S` | 600 | link intent validity |
| `PROVISIONAL_LINK_TTL_S` | 900 | two-phase link: provisional row lifetime (finalize or expire) |
| `DESCRIPTOR_LEASE_WINDOW_S` | 30 | InstallationConfig-minted lease `notAfter − issuedAt`; day validates in-transaction |
| `FINAL_PASS_LEASE_WAIT_S` | 60 | ≥ 2× lease window; disable saga waits this after projection clear before the final zero pass |
| `SAGA_REDRIVE_DELAY_S` | 5 | coordinator alarm delay pre-armed before a lifecycle command commits |
| `OUTBOX_DRAIN_BATCH` | 32 | events per `drainOutbox` pull |
| `SWEEP_DAY_BATCH` | 16 | day objects per sweep alarm run |
| `SWEEP_REARM_DELAY_S` | 60 | delay between sweep alarm runs while work remains |
| `SWEEP_RPC_DEADLINE_MS` | 5000 | per drain/ack RPC; a timeout counts as one fault-budget failure |
| `SWEEP_MAX_BATCH_RUNTIME_S` | 300 | 16 days × up to 3 RPC × 5 s + local work; a deactivating visit adds `purgeConsumer` to drain/ack |
| `ALARM_LATENESS_ALLOWANCE_S` | 60 | platform's documented ~1 min worst case |
| `ALARM_RETRY_BACKOFF_ALLOWANCE_S` | 300 | per-attempt allowance for platform alarm retry backoff |
| `FAULT_BUDGET_F` | 3 | allowed batch failures per sweep cycle; beyond F is out-of-model |
| `SWEEP_RPC_MARGIN_S` | 300 | fullCycleBound additive margin |
| `HANDOFF_TERMINAL_LEAD_S` | 43200 (12 h) | > worst `fullCycleBoundS(WORST_CASE_PARTITIONS)` ≈ 6.48 h (below); < 24 h retry-key validity |
| `WEBHOOK_DEDUP_TTL_S` / `WEBHOOK_DEDUP_CAP` | 259200 (72 h) / 5000 | installation-scoped `webhookEventId` dedup; cap evicts into aggregate counter |
| `LEDGER_TTL_S` / `LEDGER_CAP` | 2592000 (30 d) / 500 | redacted terminal ledger; cap evicts into aggregate counter |
| `DELIVERY_QUEUE_CAP` | 2000 | pending deliveries per installation; overflow terminalizes oldest with reason `overflow` |
| `SWEEP_PAST_DAYS` / `SWEEP_FUTURE_DAYS` | 366 / 90 | Fixed sweep window `[today−366, today+90]` — a deliberate superset of every configurable retention/horizon window (365+1 and 90 at their caps), so the authority needs no config read; out-of-window days simply hold no outbox. |
| `WORST_CASE_PARTITIONS` | `SWEEP_PAST_DAYS + 1 + SWEEP_FUTURE_DAYS` = 457 | Inclusive fixed sweep window: 366 past days + today + 90 future days; derived so the cycle bound cannot drift from the window. |
| `SEND_BATCH` | 8 | Deliveries attempted per alarm run (each ≤ 1 token mint + 1 push at 10 s timeouts — bounded well inside the alarm invocation budget). |
| `SEND_CLAIM_LEASE_S` | 30 | In-flight send claim lease; a claim older than this recovers to `queued` with the same retry key (byte-identical rebuild makes the repeat safe). |
| `CONFIG_RECHECK_S` | 300 | Re-check cadence for `awaiting-configuration` recovery while the secret is absent. |
| `RETRY_KEY_SAFETY_MARGIN_S` | 3600 | First-pushed `awaiting-configuration` deliveries terminalize (`configuration-lost`) this margin before the 24 h retry-key window ends. |
| `RECEIPT_CAP` / `RECEIPT_TTL_S` | 50 / 7776000 (90 d) | lifecycle command receipts |
| `SIGFAIL_WINDOW_S` | 86400 | bounded webhook signature-failure counter window |

**Derived bound (computed by `fullCycleBoundS`, tested in T033)**:
`partitions = SWEEP_PAST_DAYS + 1 + SWEEP_FUTURE_DAYS = 366+1+90 = 457` →
`fullCycleBound = (ceil(partitions / SWEEP_DAY_BATCH) + FAULT_BUDGET_F) × (SWEEP_MAX_BATCH_RUNTIME_S + SWEEP_REARM_DELAY_S + ALARM_LATENESS_ALLOWANCE_S + ALARM_RETRY_BACKOFF_ALLOWANCE_S) + SWEEP_RPC_MARGIN_S`
= (29+3) × (300+60+60+300) + 300 = **23,340 s ≈ 6.48 h** <
`HANDOFF_TERMINAL_LEAD_S` (43,200 s).

**Inequalities a test must assert (T033)**: retry total < 24 h retry-key validity; token cache
< 900 s; worst fullCycleBound < `HANDOFF_TERMINAL_LEAD_S`; `FINAL_PASS_LEASE_WAIT_S` ≥ 2 ×
`DESCRIPTOR_LEASE_WINDOW_S`; every TTL/cap > 0.

## Phase 1: Setup and pre-implementation gates

- [X] T001 **Pre-implementation docs gate (blocks all code)**: verified against current Cloudflare docs — findings in research.md **R5** (declarative `exports` mechanism, not `new_sqlite_classes`; a backout is a forward `wrangler deploy` retaining the class/export/binding/entry, deletion only via explicit `deleted` tombstone; alarm retry = exponential from 2 s, ≤ 6 retries ≈ 126 s < `ALARM_RETRY_BACKOFF_ALLOWANCE_S`). Constants unchanged.
- [X] T002 Create src/adapter-constants.ts with the table above (single frozen export, doc comments carrying each basis + the derived-bound formula).
- [X] T003 wrangler.jsonc: add `AdapterDelivery` DO binding + live `exports` entry `{"type": "durable-object", "storage": "sqlite"}` (research R5); add `LINE_MESSAGING_CHANNEL_SECRET` to secrets **optional** docs (never `secrets.required`); run `npm run types` and commit regenerated worker-configuration.d.ts; `npm run types:check` green.
- [X] T004 Test plumbing: vitest.config.ts include += test/adapter-delivery.test.ts, test/line-adapter.test.ts and miniflare binding `LINE_MESSAGING_CHANNEL_SECRET` (fixture value); playwright.config.ts webServer += `--var LINE_MESSAGING_CHANNEL_SECRET:<fixture>` (existing `--var` pattern).

## Phase 2: Foundational — post-commit event foundation (plan decision 2–5)

- [X] T005 src/reservation-day.ts: lazy `__adapter_outbox` (+ `__adapter_meta` sequence row) created only inside an active-generation event commit; per-{consumer,generation} rows; dedicated monotonic event sequence; deterministic event IDs; the legacy `sqlite_master` exact-set check stays untouched (its `NOT GLOB '__*'` filter is load-bearing).
- [X] T006 src/reservation-day.ts: in-transaction outbox write on the five transitions (approve/reject/reschedule/cancel/expire) gated by the forwarded descriptor lease — validated inside the same transaction; expired/absent lease → uniform internal retry-config outcome, zero rows; **the day alarm and its handler are untouched** (diff-reviewed as such).
- [X] T007 src/reservation-day.ts: `drainOutbox` (bounded `OUTBOX_DRAIN_BATCH`, deletes nothing, existence-check-and-return on uninitialized days — creates no schema/alarm), idempotent `ackOutbox(eventIds)`, `readEventSequence`.
- [X] T008 src/worker.ts + src/reservation-day.ts: post-commit `waitUntil` handoff to `AdapterDelivery` + lazy re-poke on next day use.
- [X] T009 src/adapter-delivery.ts (new DO): storage schema (links, deliveries, webhook dedup, ledger, counters, authoritative generation high-water), idempotent event accept + dedup, the disposition-function skeleton (T027 fills the full priority order; one implementation from day one), pre-arm-before-commit alarm pattern for every timed behavior, and the invariant **no alarm remains scheduled once state = `disabled` and all TTL stores are empty** (tested).
- [X] T010 Foundational tests in test/adapter-delivery.test.ts, with the existing test/reservation-day.test.ts suite unchanged: legacy invisibility (adapter tables present → legacy exact-set check passes; unknown non-`__` table still refused), old-code rollback simulation over configured storage (every reservation API unchanged), crash windows (post-commit death → re-poke; accept-then-ack-loss → dedup), purge-boundary refusal, race suites untouched and green.

**Checkpoint**: adapter tables invisible to legacy code; events flow day → AdapterDelivery with at-least-once + dedup.

## Phase 3: [US3] Operator lifecycle and configuration (plan decisions 6, 8; state table)

- [X] T011 [US3] src/installation-config.ts: `__line_lifecycle` table (draft identifiers, generation/operationId/phase, monotonic `lifecycleVersion`, bounded receipts `RECEIPT_CAP`/`RECEIPT_TTL_S`); existing settings JSON/STATE_KEYS/receipts byte-untouched.
- [X] T012 [US3] Lifecycle command pipeline (one implementation for settings/enable/disable): receipt match (fingerprint replay / 409) → phase + `expectedLifecycleVersion` CAS → execute; version bumps exactly once per accepted external command; settings writable only while `disabled`.
- [X] T013 [US3] Enable saga (InstallationConfig alarm re-driven): mint generation strictly above the **authoritative high-water read from `AdapterDelivery`** (non-authoritative copy kept in `__line_lifecycle` for diagnostics), two-phase activate with sequence watermark from `readEventSequence`, refuse while secret binding absent.
- [X] T014 [US3] `lineAdapterStatus` projection + public `/api/config` derivation (local projection only; capability object / cleanup marker / property omitted byte-identically) + descriptor-lease minting (`DESCRIPTOR_LEASE_WINDOW_S`) in the projection read; `Cache-Control: no-store` on state-dependent responses.
- [X] T015 [US3] src/worker.ts admin routes: `POST /api/admin/line/settings|enable|disable` (owner-gated, same-origin, rate-limited like existing admin commands) + admin diagnostics extension (adapter state, TTL countdowns, terminal/ledger counters, missing-secret indicator).
- [X] T016 [US3] Missing-secret handling: effective-activity check flips surfaces to cleanup marker while state stays `active`; documented rotation path disable → rotate → enable.
- [X] T017 [US3] Tests in test/adapter-delivery.test.ts (Vitest Workers pool) for `__line_lifecycle`, receipts, and CAS storage: draft/partial states reload-stable with zero subjects/outbox/egress, receipt replay + 409 boundary + post-eviction CAS refusal (old enable vs `disabled`, old disable vs `active`, concurrent settings-vs-enable), version single-bump per command, legacy read-compat of `__line_lifecycle` presence, state-table conformance for never-configured / secret-only / draft.

**Independent test (US3)**: operator can draft, enable, see health, and disable — every surface matching the plan's state table row for its state, with zero LINE egress in every non-active state.

## Phase 4: [US2] Safe linking (plan decisions 6, 7; LINE core verify half)

- [X] T018 [US2] src/line-adapter.ts: webhook signature verify — pre-HMAC `WEBHOOK_BODY_MAX_BYTES` cap on raw bytes, strict base64 decode of `x-line-signature`, HMAC-SHA256(channel secret) via WebCrypto, constant-time compare; then strict UTF-8/JSON parse with `WEBHOOK_EVENTS_MAX` + per-field bounds (`webhookEventId`, `timestamp`, `source.userId`); unknown event types → 200, zero side effects.
- [X] T019 [US2] src/line-adapter.ts: ID-token verify — fixed `POST https://api.line.me/oauth2/v2.1/verify`, form-encoded, `OUTBOUND_TIMEOUT_MS`, `redirect: "manual"` (any 3xx terminal protocol error), bounded reader (`VERIFY_RESPONSE_MAX_BYTES`), allowlist schema (required claims strict; optional claims bounds-checked then discarded; only `sub` survives).
- [X] T020 [US2] Link intent + completion: `POST /api/reservations/:id/line/link-intent` (path id + `{date, managementKey}` body, active-check before touching `AdapterDelivery`, nonce `INTENT_NONCE_TTL_S`); `POST /api/adapters/line/link` (nonce + ID token; nonce existence/TTL/generation pre-checked before any LINE fetch and re-checked in the completing transaction); two-phase provisional (`PROVISIONAL_LINK_TTL_S`) → finalize with watermark; same-subject re-link no-op; different-subject conflict surfaced, never overwritten.
- [X] T021 [US2] Unlink + status: `POST /api/reservations/:id/line/unlink` (management proof alone, works in every degraded state); `POST /api/reservations/:id/line/status` (presence only, 404 with no link and no history); existing status/management responses untouched.
- [X] T022 [US2] Webhook endpoint `POST /api/adapters/line/webhook`: 404 while inactive; signature verify → `webhookEventId` dedup (`WEBHOOK_DEDUP_TTL_S`/`_CAP`) → follow/unfollow subject housekeeping ordered by `timestamp`; bounded signature-failure counter (`SIGFAIL_WINDOW_S`); disposition priority 0 (disabled → ack/refuse, zero persistence — via the single T009/T027 disposition function, no inline duplicate).
- [X] T023 [US2] Frontend: public/line.html LIFF page (CDN `@line/liff`, page-scoped CSP override in public/_headers, `liff.init` → login → consent → `liff.getIDToken` → link; `liff.state` untrusted — same-origin relative path ≤ `LIFF_STATE_MAX_CHARS`, external/protocol-relative/oversized rejected); Worker-first serving for `/line.html` + every alias, 404 in non-active states.
- [X] T024 [US2] Frontend: management-page dynamic opt-in module (loaded only when `/api/config` carries capability or cleanup marker; cleanup mode = status + unlink only, no LIFF, no LINE fetches); polite customer-visible Japanese text.
- [X] T025 [US2] Tests in test/line-adapter.test.ts + test/adapter-delivery.test.ts: signature fixtures (valid/invalid/oversized/bad-base64, constant-time path), verify fixtures (expired/wrong-audience/oversized/missing-field/type-mismatch/profile-claims-present, redirect fixtures cross-origin + same-origin), duplicate webhook delivery, replay posture (re-link no-op, conflict, theft-resistance: token alone insufficient without nonce), intent expiry, provisional expiry outcome, enable/disable/partial-config on existing days.

**Independent test (US2)**: a customer can link from the management page and unlink from any state; invalid signature / duplicate webhook / replayed token all provably rejected with fixtures only.

## Phase 5: [US1] Notifications end to end (plan decisions 2, 3, 8; LINE core push half)

- [X] T026 [US1] src/line-adapter.ts: stateless token mint (`POST /oauth2/v3/token`, cache `TOKEN_CACHE_TTL_S`, keyed generation + channel ID + secret discriminator) + push client (`POST /v2/bot/message/push`, persisted `X-Line-Retry-Key` minted before first attempt, byte-identical retries, 5xx/429/timeout retryable, 409 accepted, 401 parked as `awaiting-configuration`, other 4xx terminal, `redirect:"manual"`, wire-format v1 serializer — subject resolved at send from the link row).
- [X] T027 [US1] src/adapter-delivery.ts: common disposition function with the plan's priority order 0–6 (disabled no-persist → stale-gen canceled → past-lead terminal → provisional held → seq≤watermark ignored-prelink → delivery/awaiting-configuration → no-link ignored-no-recipient); delivery rows (canonical fragment + link ID/version + retry key), `RETRY_OFFSETS_S` schedule on the DO alarm, `DELIVERY_QUEUE_CAP` overflow terminalization.
- [X] T028 [US1] Durable sweep: cursor over the fixed `[today−SWEEP_PAST_DAYS, today+SWEEP_FUTURE_DAYS]` window, `SWEEP_DAY_BATCH`/`SWEEP_REARM_DELAY_S`/`SWEEP_RPC_DEADLINE_MS` (timeout = one `FAULT_BUDGET_F` failure, batch re-drives), with up to three RPCs per day in a deactivating cycle (drain, conditional ack, and purge); `HANDOFF_TERMINAL_LEAD_S` terminalization for events whose next guaranteed visit falls past their lead; runs only while active/deactivating.
- [X] T029 [US1] Terminal visibility: redacted ledger (reason + time, `LEDGER_TTL_S`/`LEDGER_CAP`, aggregate-counter eviction), webhook-dedup eviction likewise; unfollow parks that subject's pending deliveries; a credential rejection parks the delivery as awaiting-configuration and counts as an attempt; diagnostics counters wired into T015's endpoint.
- [X] T030 [US1] Message templates for the five events (approve/reject/reschedule/cancel/expire) — short polite Japanese, minimal payload per FR-009 (time, service label, state only — no notes/history/contact/management URL; asserted by a payload-field test), fragment-only storage, no retroactive delivery for pre-link events.
- [X] T031 [US3] Deactivation saga (here because it drains Phases 4–5 structures): disable → `deactivating` (cleanup surfaces) → cancel stale-generation day rows (`canceled`, acked+deleted) → projection clear → `FINAL_PASS_LEASE_WAIT_S` → full-window zero pass → purge complete → `disabled`; final pass removes every LINE-owned row/sequence/meta, drops tables only when no consumer remains; re-drive from InstallationConfig alarm; on completion `AdapterDelivery` disarms its alarm once TTL stores drain (T009 invariant; a compatible forward backout retains the class to service any remaining TTL alarms).
- [X] T032 [US1] Pipeline tests in test/adapter-delivery.test.ts: accept → resolve → queue → push → terminal with fetchMock; sustained 5xx through the full retry ladder; timeout; 409-accepted; disposition matrix (all 7 branches, byte-identical store for branch 0 across accept/finalize/webhook); follow/unfollow ordering; watermark ignored-prelink; awaiting-configuration under missing secret then recovery; overflow; deactivation saga incl. mid-saga death + re-drive; clock-tested sweep cycle with per-batch lateness + mid-batch death + parked pull + parked ack in one run.
- [X] T033 [US1] Constants inequality self-check test (the assertions listed in the Constants section) in test/line-adapter.test.ts.

**Independent test (US1)**: with an active fixture channel and a finalized link, each of the five transitions produces exactly one push (dedup + retry-key proven); destination failure retries on schedule and terminalizes visibly; zero silent drops across every tested crash window.

## Phase 6: Polish, docs, release

- [X] T034 [P] docs/LINE-SETUP.md operator walkthrough: Mini App recommendation + LINE Login alternative (research R2), channel creation with placeholder identifiers only, secret via `wrangler secret put`, **the 200-messages/month free-plan quota warning** (research R3), live-channel verification steps (operator-side, never CI), rotation path.
- [X] T035 [P] public/privacy.html: LINE disclosure section rendered per the state rule (active / missing-secret / deactivating); permanent generic operational-records + TTL paragraph.
- [X] T036 docs/PARITY.md + docs/ROADMAP.md: flip S1 row with evidence links; docs/RELEASING.md backout note (**never use `wrangler rollback` to a pre-adapter deployment**; reach `disabled`, then forward-deploy while retaining the class, binding, export, and live `exports` entry; never deploy a `deleted` tombstone — research R5); docs/ADAPTER-CONTRACTS.md crosswalk references if drifted; release/public-files.txt += new public files; `npm run release:audit` green.
- [X] T037 Browser suite in tests-browser/line.spec.ts: state invisibility across never-configured / active / deactivating-cleanup (DOM, network, `/api/config`, privacy section), LIFF page CSP + liff.state negative navigation tests, opt-in + cleanup-mode journeys, full LINE-origin interception + zero-egress assertion, accessibility checks (keyboard, focus, live regions) at documented viewports; existing specs untouched. The two states a single dev-server process cannot reach live at the Workers-test level instead: missing-secret (the env binding cannot be removed at runtime) and post-purge byte-identity (the purge clock needs driving) are asserted in test/line-adapter.test.ts's privacy state-rule suite and the lifecycle suite's config byte-identity tests.
- [X] T038 Gates (in order): `npm run check` (exit code read directly — never piped to tail) + `npm run test:browser`; manual keyboard-only + 320 px review of the new customer surfaces; **semgrep pinned scan**: `semgrep scan --metrics=off --error --config p/default --config p/owasp-top-ten src/ public/` with semgrep 1.172.0 — record version, invocation, and per-finding disposition in specs/003-line-adapter/security-scan.md; correctness review (codex-review, resume discipline + independent fresh session); `ponytail-review`; security battery (`codex-review mode=security` + adversarial review); SonarCloud quality gate incl. new-duplication ceiling on the PR.
- [X] T039 Task-completion verification (speckit-verify-tasks equivalent — run speckit-analyze + manual sweep): every `[X]` above has landed implementation + tests and every SC-003 contract-crosswalk cell (plan.md table) resolves to a test or doc; then PR "Part of #1" (issue #1 stays open).

## Dependencies

- Phase 1 → Phase 2 → Phase 3 → Phase 4 → Phase 5 → Phase 6 (T001 blocks all code; T031 needs T020–T029).
- Within phases, tasks are same-file-sequential; [P] only where files are disjoint (T034/T035).
- MVP checkpoint = end of Phase 5 (all three stories independently testable); Phase 6 makes it shippable.
