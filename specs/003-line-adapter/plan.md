# Implementation Plan: Optional LINE identity and notifications (S1)

**Branch**: `feat/line-adapter` · **Spec**: [spec.md](spec.md) · **Research**: [research.md](research.md)

**Created**: 2026-08-12 · **Status**: Implemented; PR #37 ready for review

## Constitution check

- **I. Provider-Neutral Core**: every new module is dead code until configured; the booking path
  gains one in-transaction outbox write plus a pending-row check that are no-ops while
  unconfigured; the day alarm and its handler are untouched.
  The five-minute deploy story is unchanged — no new required secret, no new manual provisioning
  step.
- **II. Adapters Invisible Until Configured**: FR-001's boundary — **API responses
  byte-identical** to their pre-adapter shapes; **behavioral absence** on served assets, DOM, and
  network in the `never-configured`, `draft-disabled`, and `disabled-purged` states (the LINE
  frontend module is never fetched and is served 404; zero outbound requests; no LINE-owned outbox rows, sequence, or meta exist — the physical
  table is absent when LINE was the only consumer). FR-001 carries two explicit exceptions: the shipped `app.js` inert guard
  (absence asserted at the served-response level, not repository bytes) and the **cleanup-only
  surface** of the `missing-secret`/`deactivating` states — both reachable only **after an
  activation and until its purge completes**, the window in which residual LINE data can
  exist (the state table below is the single authority).
- **III. Accessibility**: the LIFF page and the management-surface opt-in are customer UI and ship
  with the same semantic/browser-test coverage as existing pages.
- **IV. Transactional Integrity**: the outbox write joins the existing `transactionSync` commit;
  no command semantics change; race suites stay green untouched.
- **V. Public-Safe Surface**: fixture identifiers only, no real channel data; operator walkthrough
  uses placeholders.
- **Security scope**: webhook, token verification, link/intent endpoints, secret handling, queue
  logic — Claude Code implements directly; the security review battery gates the diff.

## Structure (files touched)

| Area | Files | Change |
|---|---|---|
| Event foundation | `src/reservation-day.ts`, `src/adapter-delivery.ts` (new DO), `src/worker.ts`, `wrangler.jsonc`, `worker-configuration.d.ts` | `__adapter_outbox` + event sequence (lazily created, invisible to the legacy schema check — decision 4; **the day alarm and its handler are untouched**); post-commit handoff + lazy re-poke; `AdapterDelivery` DO (event accept/dedup, links, subject index, deliveries with persisted attempt/`nextAttemptAt`, webhook dedup, lifecycle authority, diagnostics, retention sweep — all timed work on its own reservation-core-isolated alarms); new DO binding + a live `exports` entry (`{"type": "durable-object", "storage": "sqlite"}` — the repository uses the declarative `exports` mechanism, mutually exclusive with the legacy `migrations` array; see research R5); generated types refreshed via `npm run types` so `types:check` passes with the `AdapterDelivery` binding present |
| LINE adapter core | `src/line-adapter.ts` (new) | ID-token verify (POST, fixed URL), stateless token minting (memory cache < `expires_in`, **keyed by generation + messaging channel ID + an in-memory discriminator of the current secret value** — an out-of-band secret rotation never reuses a stale token; the documented rotation path stays disable → rotate → enable), webhook signature verify (bounded raw bytes, strict base64, constant-time compare), push client with persisted `X-Line-Retry-Key` + canonical serializer, backoff table; all three outbound calls use `redirect: "manual"` — any 3xx is a terminal provider protocol error (negative fixtures for cross-origin and same-origin redirects). **Trust-boundary parsing is bounded end to end**: webhook body byte cap before HMAC, post-signature strict UTF-8/JSON parse with an event-count cap and per-field bounds (`webhookEventId`, `timestamp`, `source.userId`), unknown event types acknowledged with 200 and zero side effects; verify/token responses read through a bounded reader into allowlisted schemas — for verify: required claims (`iss`/`sub`/`aud`/`exp`/`iat`) validated strictly, LINE's documented optional claims (`nonce`, `auth_time`, `amr`, `name`, `picture`, `email`) bounds-checked then **discarded** (never stored beyond `sub`), unknown fields tolerated per LINE's own tolerant-backend guidance (research R3) — for token: `token_type` fixed, `expires_in` bounds + skew, `access_token` length cap; oversized, missing-field, type-mismatch, and profile-claims-present fixtures for each |
| Config | `src/installation-config.ts` | **The existing settings JSON, `STATE_KEYS`, `settingsVersions`, and receipts are completely untouched** — no `lineAdapter` settings key exists. The dedicated **`__line_lifecycle`** table holds: **draft desired identifiers** (writable by an owner-gated configure command **only while `disabled`** — this is how the spec's IDs-without-secret partial state exists and survives reload), server-owned activation metadata (generation, operation ID, saga phase), a **monotonic `lifecycleVersion`** (CAS field, below), and the bounded lifecycle command receipts — written only by the lifecycle commands; the settings command cannot touch it, and settings replay cannot return stale lifecycle data. **Reservation-core rollback is safe**: both DOs' schema checks exclude `__*` tables (verified: the `sqlite_master` queries filter `NOT GLOB '__*'`), so a pre-adapter Worker reads the storage exactly as before. Tests: legacy read-compat (old-code simulation over configured storage), draft/partial states after reload (IDs-only, secret-only, complete — with zero subject, outbox, or outbound in any partial state), lifecycle survival across settings edits and restarts. A **separate** `lineAdapterStatus` projection serves the admin surface — the existing installation `readiness` is untouched. The **public** `/api/config` response derives from the **local projection only** (never an `AdapterDelivery` call — a stalled authority can never delay or 503 the booking journey): the minimal LINE capability object while effectively active, or a **cleanup-only marker** while residual LINE data may exist (missing-secret, `deactivating`) — while neither, the property is omitted entirely so the existing JSON shape is byte-identical |
| Routes | `src/worker.ts` | **Lifecycle**: `POST /api/admin/line/enable` (body: the three identifiers + `commandId` + `expectedLifecycleVersion`) and `POST /api/admin/line/disable` (body: `commandId` + `expectedLifecycleVersion`) — both owner-gated, same-origin, rate-limited like existing admin commands. A third owner-gated command, `POST /api/admin/line/settings` stores draft identifiers while disabled. Customer routes keep status/unlink proof-bound and available during cleanup, while link completion verifies a nonce plus ID token. The webhook is signature-gated and absent while inactive. LIFF aliases and privacy disclosure are Worker-first. Never-configured, active, and deactivating states are browser-tested; missing-secret and post-purge states are Worker-tested because one browser server cannot remove its secret binding or drive the purge clock. |
| Frontend | `public/line.html`, `public/line-liff.mjs`, `public/line-link.mjs` (new), `public/app.js`, `public/privacy.html`, `public/styles.css`, `public/_headers` | LIFF bootstrap page; the opt-in behavior lives in the separate `line-link.mjs` module, dynamically imported by `app.js` when public config carries the **capability or the cleanup marker** (cleanup mode = proof-bound status + unlink only). In `never-configured`, `draft-disabled`, `activating`, and `disabled-purged` the guard stays inert and the module (like `/line.html` and its aliases) is served 404 Worker-first, so absence is assertable at the network level. A stalled or failed optional-module fetch cannot block the existing management journey; cancellation remains usable and replacement booking cards are enhanced after re-render. The LIFF page uses `line-liff.mjs` and a page-scoped CSP override. |
| Secrets | `wrangler.jsonc`, `worker-configuration.d.ts` | `LINE_MESSAGING_CHANNEL_SECRET` is an **optional binding on `AppEnv`** — `secrets.required` stays `[OWNER_TOKEN, TURNSTILE_SECRET]`; operator registers it via `wrangler secret put` (documented) |
| Tests | `test/line-adapter.test.ts`, `test/adapter-delivery.test.ts`, `test/line-helpers.ts` (new), `tests-browser/line.spec.ts` (new), `tests-browser/harness.ts`, `vitest.config.ts`, `playwright.config.ts` | New Worker tests cover the LINE core, outbox, lifecycle, delivery authority, retry/race behavior, and payload privacy; shared fictional fixtures live in `line-helpers.ts`. The browser suite uses the real Worker and Durable Objects for lifecycle, intent, cleanup, and management flows, while intercepting browser-originated LINE SDK/navigation requests so CI has zero live LINE dependency. Existing harness/config files are extended only for the optional binding and shared hostname/fixture setup. The fixture secret reaches the webServer as `--var LINE_MESSAGING_CHANNEL_SECRET:...` (the existing `--var` pattern, not process env). |
| Docs & release | `docs/PARITY.md`, `docs/ROADMAP.md`, new `docs/LINE-SETUP.md`, `docs/PRIVACY.md`, `docs/RELEASING.md` (backout/deployment note, decision 4), `public/privacy.html`, `release/public-files.txt`, `scripts/release-audit.mjs` | Status flips with evidence (SC-005); operator walkthrough (Mini App recommended — unverified ones are open to individuals in Japan — LINE Login channel equally supported; **both channels under one provider**, stated as a non-machine-checkable constraint; Official Account quota: free plan = 200 push messages/month, delivery stops at the cap; deactivation order); privacy surfaces enumerate stored subject, per-message facts, retention, unlink; allowlist + REQUIRED registration |

## Design decisions (from research and review; the plan gate confirms them)

1. **Push-retry substrate = DO outbox + `AdapterDelivery` alarm**, not Queues (research R1: the
   transactional outbox is required either way; free-tier 24 h retention; test determinism;
   recorded upgrade path).
2. **Event handoff — the day alarm is never touched** (a rollback-safety requirement, found by
   review): the existing `ReservationDay.alarm()` is an unconditional `deleteAll()` whose sole
   trigger is the retention purge; the retention design trusts the *alarm time itself*. Any
   "pre-armed" earlier alarm would, after a code rollback, fire that unconditional wipe **before
   retention** — deleting live reservation data. So:
   - Outbox rows are written inside the day commit, only when the adapter is configured at
     command time. Gating and consumer set are computed from **current** settings per command
     and passed transiently (never persisted into the pinned `scheduleJson` — enable/disable
     must take effect now, not at day-pin time). Lazy expiry commits inside read transactions
     (`#expire`), and its events join the same outbox write with the same captured `now`.
   - **The day object never schedules an alarm other than the retention purge, and the alarm
     handler is not modified.** Handoff runs post-commit (`waitUntil`:
     `AdapterDelivery.accept` → ack → delete rows; accept is idempotent by event ID). While
     pending rows remain, **every subsequent day-object use re-pokes them** (a cheap
     pending-rows check on entry — the repo's lazy idiom).
   - **All timed retry machinery lives in `AdapterDelivery`'s own alarms**, which are
     reservation-core-isolated: whatever happens to that class or its alarms on a rollback,
     no reservation data is touched (the adapter-data retention consequence is scoped in
     decision 4). Once an event is accepted, delivery retries never depend on the
     day object again.
   - **The residual crash window is closed by the durable sweep** (decision 8): a handoff whose
     `waitUntil` died is re-drained by the `AdapterDelivery` sweep within one cycle even if the
     day is never used again — no silent drop, no dependence on traffic or on diagnostics being
     opened; worst-case handoff latency is one sweep cycle.
   - **No send at or past the retention boundary**: `AdapterDelivery` enforces this itself, at
     the two points where it can. Accept refuses inside its transaction when `purgeAt ≤ now`
     (disposition `past-retention`), and the claim transaction re-checks the delivery's stored
     `purgeAt` immediately before a push may start, terminalizing rather than sending. Both are
     pinned in clock-controlled tests. The boundary is the bare deadline, not a deadline minus a
     margin: a push that starts just inside it can still be in flight for up to the outbound
     timeout (10 s) afterwards, which is deliberate — a 10-second overshoot on a boundary
     measured in days is not worth the complexity of a purgeAt-relative abort, and the message
     itself carries only a date and a state. The day-side re-poke performs no boundary check of
     its own; it is a latency optimization, and every event it hands off is dispositioned by the
     authority above. Sustained `AdapterDelivery` unreachability is intra-platform (same
     substrate as storage itself) and out of model; recorded here.
3. **Deterministic outbox event IDs**, unique per (event, consumer): versioned tuple
   `consumer + date + reservationId + commandId + eventType` for command transitions and
   `consumer + date + reservationId + deadline + eventType` for lazy expiry — receipt replay,
   transaction re-execution, and cross-day `commandId` reuse can never collide or double-insert.
   **Event ordering uses a dedicated monotonic event sequence**, not the kernel state revision:
   the approve transition writes only the booking detail and meta (verified — it never calls the
   kernel, so `core_state.revision` does not move), which disqualifies the state revision as an
   order key. Every event-writing transaction increments the sequence (stored beside the outbox
   in `__adapter_outbox`) in the same SQLite transaction; outbox events carry it, and the link
   watermark reads it via `readEventSequence(consumer, generation)` — which returns 0 with
   **zero side effects** on a day whose outbox table does not exist (no schema, storage, or
   alarm creation), and event transactions increment only their own `{consumer, generation}`
   sequence (tested: link against an empty day; a synthetic second consumer's sequence
   unaffected). Regression test: a barrier between the watermark read and an approve
   commit proves the approve still delivers.
4. **Rollback-safe storage via `__`-prefixed tables — no schema-set change at all**: both DOs'
   exact table-set checks exclude `__*` names from their `sqlite_master` listing (verified in
   both files), so the adapter's tables — `__adapter_outbox` (+ event sequence) in
   `ReservationDay`, `__line_lifecycle` in `InstallationConfig` — are **invisible to the
   pre-adapter code**: `#hasSchema`/`TABLES` and `INSTALLATION_TABLES` are not modified, legacy
   partitions need no migration, and a code rollback keeps every existing reservation API
   working over already-written adapter storage (tested by exercising the legacy check against
   a configured store). Tables are created lazily inside the first configured gated transaction;
   `__line_lifecycle` and the authority schema first appear on operator commands; a day's `__adapter_outbox` appears only through an active-generation event commit; the disable's final pass removes every LINE-owned row, sequence, and meta, dropping the table itself only when no other consumer remains (state table above). Orphaned rows after a rollback die at the
   partition's retention `deleteAll`. **The rollback-safety claim is scoped**: the reservation
   core is rollback-safe unconditionally, but `AdapterDelivery`'s own retention sweep stops if
   a backout removes its class — adapter personal data (links, subjects) could then outlive
   the parent retention. The deployment note in `docs/RELEASING.md` therefore requires a
   **forward backout**, never `wrangler rollback` to a pre-adapter deployment: first reach
   `disabled` (which purges every personal/event row), then deploy the desired earlier
   application behavior while retaining the authority class, export, binding, and `exports`
   entry. The bounded redacted ledger and webhook-dedup rows may still have TTL alarms; the
   retained class services them until they drain. **There is no erase command** (an earlier
   draft had one; it grew a saga of its own and was cut). Diagnostics show the remaining TTL
   and flip to "no personal or event data retained" when the store drains. Two properties
   make this sufficient: the
   **generation high-water persists** (a non-identifying scalar, **authoritative in the
   `AdapterDelivery` store**; `__line_lifecycle` carries only a non-authoritative diagnostic
   copy — re-enable always mints strictly above the authority value, tested across TTL drain,
   DO restart, and re-enable, so a delayed stale accept/finalize RPC can never attach to a
   new activation), and **`disabled` is quiescent**: stale-generation ingress
   (accept/finalize/webhook) is acked or refused **without persisting any event-specific
   data**, so nothing re-grows the store while it drains (tested: stale ingress after
   disabled leaves storage byte-identical) — and **the first pre-implementation gate in tasks.md** is the
   official-documentation check of alarm/class behavior for removed DO classes and the
   additive-migration deployment sequence, before the note's wording locks. Test: disable →
   TTL elapse (clock-controlled) → simulated old-version deployment; diagnostics prove
   nothing remained.
5. **One new secret**: the Messaging API channel secret (webhook HMAC + stateless token minting,
   research R3), as an optional binding. Channel IDs and LIFF ID are non-secret settings.
6. **Link model** (reservation-scoped; management key is the customer-held proof):
   - `POST /api/reservations/:reservationId/line/link-intent` — reservation ID in the path,
     `{date, managementKey}` in the JSON body only (the existing public-route convention; the
     management key never appears in a URL, access log, `Referer`, or response URL — negative
     tests) — mints a **256-bit single-use nonce**. The clear nonce is returned once and never
     persisted; only its **SHA-256 digest** is stored with the reservation reference, date,
     adapter generation, and 10-minute TTL. The same transaction creates or refreshes the
     provisional link and stamps it with the parent `purgeAt`.
   - `POST /api/adapters/line/link` (active-gated) takes nonce + ID token, verifies the token
     against the LINE Platform (fixed URL, configured login channel ID as `client_id`). The
     completing `AdapterDelivery` transaction re-checks the nonce digest, TTL, and generation,
     deletes the digest, and promotes the provisional link to final with the verified subject and
     sequence watermark. The same clear nonce cannot be used again. A new intent for an identical
     final subject is a no-op; a different subject over a live link is a 409 conflict, and unlink
     followed by replay of the old nonce cannot recreate the link.
   - Links live in `AdapterDelivery` keyed by reservation **and** indexed by subject (webhooks
     carry only the subject). Links carry parent `purgeAt` for the retention sweep. Deliveries
     never duplicate the subject: a delivery stores the **canonical message fragment**, the link
     ID + link version, and the retry key; each attempt resolves the subject through the link
     and one canonical serializer rebuilds the full push body — byte-identical across attempts
     because fragment, link version, and serializer are all fixed. The **link version is an
     immutable incarnation ID**: it changes only when a new link is created after an unlink —
     never on deliverability or webhook-timestamp updates, so a legitimate retry to the same
     recipient is never discarded by a version bump (tested). If the link is gone or its
     incarnation changed, the delivery is discarded/terminally parked without sending. Tests:
     first-vs-retry byte equality, unlink with pending deliveries, unlink → relink never sends
     the old deliveries, deliverability flaps leave the version unchanged.
   - **No retroactive delivery, decided by a clock-free watermark in one revision domain, with
     a two-phase link closing the arrival race**: outbox events carry the **adapter event
     sequence** of their committing transaction (decision 3 — the kernel revision is
     disqualified). The link completes in two steps on `AdapterDelivery`: after ID-token
     verification a **provisional link** (bounded expiry) is created; then the link endpoint
     reads the current event sequence via an internal-only `ReservationDay` RPC (the
     linearization point — reading at completion, not intent creation, keeps
     between-intent-and-consent transitions correctly pre-link); then **finalize** stores that
     sequence as the watermark. Events accepted for a reservation holding a provisional link
     are **held (bounded)** rather than acked-away; finalize discards held events with
     sequence ≤ watermark and delivers those above it — so an event that commits right after
     the sequence read but reaches `AdapterDelivery` before the finalize cannot be lost,
     whatever the DO-to-DO arrival order. An unfinalized provisional's TTL expiry routes its held events through the same
     disposition function — they resolve to `ignored-unfinalized` (non-identifying) before
     deletion, so a death between provisional and finalize still leaves a defined outcome
     (idempotent under re-execution, tested at the TTL boundary). (These reads sit on the link endpoint — a
     session-boundary surface — never on the booking path.) Tests: intent → transition → link →
     delayed handoff = no delivery; a transition after the watermark read delivers;
     accept-before-finalize; finalize-before-accept; death between provisional and finalize.
     Deliverability starts `unknown` at link time and is resolved by the first send outcome or a
     later follow/unfollow (by event timestamp; on an equal timestamp the deterministic
     tie-break is **unfollow wins** — the safe side — verified with order-reversed fixtures;
     stale follow cannot resurrect). Webhooks for unlinked subjects record only the dedup
     `webhookEventId` — no subject stored. This deliberately does not remember a pre-link
     unfollow: if that subject links later without a newer webhook, the first provider refusal
     terminalizes only that recipient's delivery. Avoiding storage of an unlinked subject wins
     over predicting that future link; known linked-subject unfollows still park before push.
7. **Retry policy fits the 24-hour retry-key window**: a delivery persists the **canonical
   message fragment bytes, link ID + version, UUID retry key, and wire-format version** — the
   full push body is **never stored** (decision 6); each attempt rebuilds it through the
   serializer for its recorded wire-format version. **This stage ships exactly one serializer
   version (v1) and keeps it compatible indefinitely** — in an independently operated OSS
   deployment no release can know whether some installation still holds a v1 delivery (an
   `awaiting-configuration` one can live to the retention bound), so v1 is never removed; a
   future v2 may only ever sit alongside it. Bytes therefore stay identical across attempts,
   restarts, config edits, and deploys (tested by simulating a default-serializer change).
   Absolute attempt schedule — attempt 1 at t=0, then t+1 m, t+6 m, t+21 m, t+1 h 21 m,
   t+4 h 21 m, t+10 h 21 m (**7 attempts total**; terminal parking at the 7th failure, ≈10.4 h,
   comfortably < 24 h). Push retries only on 5xx and timeout; `409` means accepted; `401` is a
   configuration rejection that parks the delivery as `awaiting-configuration`; all other 4xx,
   including `429`, are terminal immediately. Token-endpoint calls remain distinct from push
   outcomes — token-endpoint 408, 429, 5xx, and transport failures retry; other non-200 token
   responses park for configuration repair; a token failure never marks the delivery accepted.
   Outbound timeouts fixed at 10 s each for verify, token, and push calls.
8. **Lifecycle and cleanup are first-class**:
   - A **LINE-specific, server-managed, monotonically increasing generation** (not
     `settingsVersion` — unrelated settings edits must not invalidate deliveries; not a config
     fingerprint — re-enabling identical settings must still be distinguishable). States:
     `active` / `deactivating` / `disabled`. Acceptance and the moment before each push both
     verify the generation; stale-generation events are acked without delivery.
   - **`AdapterDelivery` is the single lifecycle authority, and the booking path never calls
     it.** Generation, state, purge cursor, and a **non-secret channel-settings snapshot** live
     in its storage (the snapshot lets alarms run without further config reads);
     `InstallationConfig`'s `__line_lifecycle` table holds the desired settings **plus the
     non-authoritative activation projection** (the generation returned by activation). Day
     commands read only that projection (flowing in the per-command config context) — the
     outbox gate costs zero extra RPCs and booking never waits on `AdapterDelivery` (FR-002). Outbox rows record the
     projected generation; `AdapterDelivery` re-verifies its own generation at accept and before
     each push, acking stale-generation events without delivery — so a lagging projection can
     only cause a skipped delivery, never a blocked or double-delivered booking.
   - **Lifecycle sagas converge without operator action, with one coordinator.**
     `InstallationConfig` is the sole saga driver: the first transaction of any transition
     persists a **server-generated operation ID and saga phase** in `__line_lifecycle` and
     **pre-arms `InstallationConfig`'s own alarm before committing**. The driver then calls the
     authority (`activate(operationId)` — one transaction: new generation, snapshot;
     `begin-disable(operationId)` — generation bump + `deactivating` + purge cursor + the
     authority's own pre-armed alarm for the purge) and completes locally — enable to
     `phase=active` + generation; disable stays **`deactivating` until the authority reports
     the purge complete** (the idempotent `begin-disable(operationId)` re-call returns purge
     status; the coordinator's alarm polls it), and only then flips to `phase=disabled` — so
     privacy disclosure, the cleanup surface, and the operator's remove-the-secret cue never
     end while subjects remain. **A death at any point self-heals from one place**: the
     `InstallationConfig` alarm sees a non-terminal phase and re-drives the idempotent,
     operation-ID-keyed authority call and the local completion until the phase is terminal —
     there is no second recovery path to reason about (the authority's own alarms drive only
     its internal work: purge, deliveries, retention, the sweep). Tests: death mid-purge,
     re-drive just before completion. This closes, in particular,
     the window where a dead disable would otherwise leave the projection active and day
     objects queueing stale rows indefinitely (FR-001). Tested per RPC boundary, in both
     directions, with **no subsequent operator or customer traffic**. Concurrent transitions
     are excluded: a transition arriving while a saga with a different operation ID is in flight
     is refused (409); the same operation ID replays idempotently (tested). Transitions stay
     confined to `disabled → active` and `active → deactivating → disabled`; identifiers travel
     only in the enable command, and enable refuses while the phase is not `disabled` — so
     changing identifiers structurally requires disable → enable (API-level, not just setup
     UI).
   - **The pre-arm invariant applies to `AdapterDelivery`** (whose alarms are reservation-core-isolated,
     unlike the day's): any transaction that creates earlier-due work (delivery creation, retry
     reschedule, begin-disable purge, retention deadline, the handoff sweep) pre-arms the alarm
     *before* committing, and the alarm handler reconstructs all work from storage alone — the
     commit-vs-alarm crash window is closed here for every timed behavior in the system, tested
     per work type.
   - **One disposition function for every handoff path**, with an explicit priority order
     evaluated inside the `AdapterDelivery` local transaction: (0) **authority `disabled` →
     ack/refuse with zero persistence** (no ledger, dedup, or counter row — full-store
     byte-identical, tested separately for accept, finalize, and webhook ingress); (1) stale
     generation while `active`/`deactivating` → `canceled`; (2) past its lead → terminal failure (redacted ledger); (3) provisional link
     → **held** (finalize re-disposes); (4) finalized link and sequence ≤ watermark →
     `ignored-prelink`; (5) finalized link and sequence > watermark → delivery — or
     `awaiting-configuration` while the secret is missing; (6) no link →
     `ignored-no-recipient` (a non-event, not a failure) — and only then is the day acked.
     The `waitUntil` push, the sweep pull, the lead boundary, and finalize's re-disposition
     all call the same function, so one event can never resolve differently by route (tested:
     same event, both routes, same disposition; disable-vs-push race; held-then-finalize).
   - **Traffic-independent handoff recovery — the durable sweep**: while the adapter is active
     **or deactivating**, the `AdapterDelivery` alarm runs a **cursor-based sweep** over the
     bounded partition-window date range (implemented as the fixed worst-case window
     `[today − 366, today + 90]` — a deliberate superset of every configurable
     retention/horizon window, so the authority needs no config read and the cycle bound's
     457-partition worst case is the actual window), a fixed batch of day objects per run, calling `drainOutbox`
     on each — an explicit **pull protocol**: the day RPC returns a bounded event batch and
     deletes nothing; `AdapterDelivery` accepts/terminalizes in its own local transaction; a
     separate idempotent, generation-scoped `ackOutbox(event identities)` RPC then deletes from the day; the cursor
     advances only after the local outcome is durable. (No reentrant
     `AdapterDelivery → day → AdapterDelivery` call chain exists; the `waitUntil` handoff keeps
     its push shape — both converge on idempotent accept + ack.) Death points tested:
     post-pull, post-accept-pre-ack, post-ack. `drainOutbox`'s contract on an uninitialized day
     is **existence-check and immediate return** — it creates no schema, storage, or alarm on
     days that never existed (tested), and the per-cycle request budget (window days × cadence,
     with the pull/ack pair counted) is a tasks.md number. The cycle bound counts **every** alarm execution **and a declared fault budget** `F`
     (allowed batch failures per cycle; beyond `F` is out-of-model):
     `fullCycleBound = (ceil(partitions / batch) + F) × (maxBatchRuntime + rearmDelay +
     allowedAlarmLateness + alarmRetryBackoff) + RPC margin` — lateness and retry backoff
     apply per batch attempt (platform worst case ~1 minute) — and `handoffTerminalLead` is
     strictly greater. This is the **single authoritative formula** (no other bound appears in
     the plan), clock-tested with per-batch lateness plus a mid-batch death in the same run.
     `maxBatchRuntime` is made real by **per-RPC deadlines** on `drainOutbox`/`ackOutbox` — a
     timed-out call counts as one of `F`'s failures and its batch re-drives within the bound
     (tested with a parked pull and a parked ack) — with the platform invocation ceiling as
     the conservative cap; the numbers are fixed in tasks.md. A `waitUntil` handoff that died on a day never used again is
     re-drained within one sweep cycle. **Deadlines are sweep-aware**: a distinct
     `handoffTerminalLead` constant, strictly greater than `fullCycleBound` (the single
     formula above), governs terminalization — during any
     visit, an event whose *next guaranteed visit* would fall past its lead is **always
     terminalized** — recorded in the redacted ledger and acked from the day
     (`awaiting-configuration` is reserved for deliveries already accepted before their lead;
     it never holds identifiable payload past `purgeAt`) — so the cursor-tail day that jumps
     from "outside the margin" to "purged" between visits can never die silently. Ledger
     idempotency holds because the event dedup key survives until the day ack completes (or
     `purgeAt`), and count-cap eviction folds evicted entries into an aggregate counter so
     visibility degrades to counts, never to silence. During
     `deactivating`, stale-generation day outbox rows are recorded as `canceled` (never sent)
     and acked+deleted. (No separate generation fence exists — the descriptor lease plus the
     lease-expiry-gated final pass already close the stale-writer window; a redundant fence
     would also conflict with never-touching uninitialized days.) Because the projection is
     cleared **before** the final pass, the purge
     completes — and `disabled` is reached — only when internal rows are purged **and** one
     full window pass that *started after* projection-clear **plus the descriptor lease
     duration** (every issued lease provably expired) finds zero stale-generation outbox —
     and, on that pass, removes the LINE consumer's rows and meta and **drops
     `__adapter_outbox` only where no consumer's rows or meta remain** — the outbox, its
     sequence, descriptors, and per-day meta are all keyed `{consumer, generation}`, so a LINE
     disable can never destroy a future calendar/audit consumer's pending rows (synthetic
     second-consumer regression test); where LINE was the only consumer, `disabled-purged`
     truly has no day adapter table (asserted via `sqlite_master`). Barrier tests: capture projection → disable completes → commit attempt
     → lease-expired retry, descriptor-less success; commit-then-dead-waitUntil inside the
     lease window → caught and canceled by the final pass; a stalled worker holding a
     pre-disable projection calling a day after `disabled` → expired, non-mutating.
     Diagnostics reuse the sweep's cursor and aggregates (`lastScanAt`, completeness, pending
     count, oldest age) — no synchronous all-partition fan-out. Tests: dead handoff on an
     untouched day recovered by sweep alone; cursor resumption after death; clock-controlled
     cursor-tail terminalization; disable with pending outbox on an unused day; missing-secret
     during deactivating.
   - **The alarm runs in bounded, claim-based batches**: a fixed per-run cap on deliveries and
     purge steps (sized against the subrequest and wall-time budget with 10 s outbound
     timeouts), fair ordering across work types, and an **immediate re-arm** whenever work
     remains. Before any outbound fetch the delivery is claimed durably (in-flight state
     persisted in its own transaction) with a **claim lease**: a claim whose holder died is
     re-eligible after the lease expires and recovers through the same retry key + rebuilt
     canonical body (an uncertain send is safe to repeat by construction). Push-start and
     unlink/disable/unfollow are linearized through those transactions so **no new push starts
     after an unlink, disable, or unfollow commit**, and re-entrancy during an awaited fetch
     cannot double-send (a parked-fetch fixture tests both orders, including
     unfollow-vs-push-start). The concrete numbers — batch caps, lease duration, margins — are
     fixed in `tasks.md` with the other constants. Tests: batch overflow with remainder, death
     mid-batch (lease recovery), claim-vs-unlink races.
   - **Effective activity is fail-closed at every entry, computed per site from what that site
     can reach without new waits**:
     - *Day outbox gate* (no authority call, ever): metadata phase = `active` **and** projected
       generation present **and** the secret binding is present — all read from the
       per-command config context. (No settings hash: identifiers travel only in the enable
       command and are immutable while active, so no API path can change them out from under
       an activation.) The day object receives only a **generic consumer descriptor** — per-consumer
       `{consumer, generation}` entries plus an **`issuedAt`/`notAfter` lease — minted by
       `InstallationConfig` inside the same read that serves the projection and forwarded by
       the worker unmodified** (the worker cannot fabricate or extend one; the day validates
       generation, `issuedAt`, `notAfter`, and the maximum lease length), never LINE-specific
       fields — the foundation stays provider-neutral. The day validates `notAfter` inside the
       command transaction before any mutation: an expired descriptor yields a **non-mutating internal
       `retry-config` outcome, defined uniformly for every day RPC** — commands re-execute
       with the same `commandId` (receipt replay keeps it safe), reads (whose lazy expiry also
       commits) are simply re-invoked after the worker re-reads the projection — and only
       normal responses ever leave the worker, so no public API shape changes (tested with a
       lazy-expiry read under an expired descriptor); if the adapter is by then disabled the
       call simply proceeds descriptor-less — so a stalled request can never write with a
       stale generation, on existing **or brand-new** days, and `disabled` waits only for
       lease expiry, not for unbounded request lifetimes (Workers have no hard wall-time
       cap).
     - *Public capability (`/api/config`)*: **local projection + secret presence only — never
       an authority RPC** (consistent with the Config row; the saga order guarantees the
       projection lags only in the fail-closed direction).
     - *Link-intent, link, webhook* (adapter-only surfaces): the local checks **plus**
       verification against the authority (state, generation, snapshot agreement); an authority
       RPC failure 404s/refuses the LINE surface only — existing API responses are never
       affected.
     - *Accept and push*: the authority verifies its own state, generation, and snapshot before
       creating or sending anything.
     A missing secret at runtime (the binding is operator-managed outside the Worker)
     fail-closes all of the above — capability omitted, webhook 404, link/outbox refuse, zero
     outbound — while the stored state shows the operator a degraded `missing-secret` status.
   - **In-flight work under a missing secret has defined transitions**: any pre-lead
     eligible event that reaches `AdapterDelivery` — by `waitUntil` push or sweep pull — is
     **accepted into `awaiting-configuration` and the day is acked** (one rule, both routes;
     rows stay in a day only while no RPC has reached the authority, and the sweep keeps
     pulling those). A descriptor issued just before the secret vanished can still write
     outbox rows until its lease expires — bounded, and with **zero outbound** either way
     (tested on both routes with a post-issuance secret loss);
     accepted pending deliveries move to an `awaiting-configuration` state that consumes no
     attempts and is visible with its reason in diagnostics; a delivery whose first push already
     happened is terminally parked (`configuration-lost`) if the secret is not restored before
     its retry-key window (with margin) expires — never a silent ack, never an attempt-burning
     loop. `awaiting-configuration` deliveries persist a `nextConfigurationCheckAt`, and
     first-pushed ones a `retryKeyDeadline`; both feed the alarm's minimum-due computation, so
     recovery and deadline expiry are processed **without any external traffic**. Tests:
     secret-only, IDs-only, short loss + recovery (alarm-driven), sustained loss past the key
     window (alarm-driven terminal).
   - **Disable is one idempotent operation**: it bumps the generation (send-stop) and starts the
     purge in the same step; the adapter shows `deactivating` until the purge completes (the
     `AdapterDelivery` alarm retries it), then `disabled`. No window where the adapter is
     "inactive with subjects retained" is reachable by operator mis-sequencing.
   - The purge cascade deletes links, subject index, nonces, and pending deliveries (including
     canonical fragments and retry keys) and redacts terminal records to non-identifying form.
     **The redacted remainder is a bounded installation-level ledger**: reason code + time
     only — reservation reference, subject, event ID, fragment, and retry key are all removed
     by the parent `purgeAt` — with its own TTL and count cap (tasks.md constants; oldest
     evicted first), reflected in the privacy documentation. Tests: cap/TTL boundaries,
     idempotent re-recording, and a full-table negative assertion that no identifier survives
     `purgeAt`.
   - **Every reservation-scoped adapter row carries the parent partition's `purgeAt`.** The
     retention prune deletes those rows on that boundary, and the send path re-checks the
     delivery's boundary immediately before a push can start. When the last final link for a
     subject is removed, the subject row is removed as well. The fixed 366-day date window
     remains only as a backstop for rows that predate the `purgeAt` stamp or unexpectedly lack
     one; it is not the primary retention boundary. The redacted reason+time ledger alone may
     persist past parent retention under its own TTL/cap. `accepted_events` is likewise a
     subject- and reservation-free receipt (`date`, generation, sequence, disposition) bounded
     by the fixed date window, not reservation-scoped personal data. **Webhook dedup rows are
     the exception**: they are installation-scoped, subject-free `{webhookEventId, receivedAt}`
     records (an unlinked subject's webhook has no parent reservation; a multi-linked subject
     has no single one) pruned by their own TTL and size cap. Negative assertions cover all
     tables; TTL/cap boundaries and unlinked/multi-linked cases are tested.

   Enable reuses the installation's existing `protectionReady` predicate and fails with
   `ORIGIN_UNCONFIGURED` until the configured hostname and Turnstile protection are live-ready.
   Notification payloads contain no management URL, and no request-derived origin is persisted.

   - Operator documentation states the order once (disable performs everything; remove the
     secret after `disabled` is shown).
9. **Notified events**: approve / reject / reschedule / cancel / expire (spec FR-003).
10. **LIFF surface**: LIFF framework; operator docs recommend the Mini App channel (research R2),
    LINE Login channel equally supported; LIFF SDK loaded from LINE's CDN with a
    `/line.html`-scoped CSP override (the `@line/liff` npm package's proprietary license was
    verified 2026-08-12 — vendoring into this public repository is not clearly permitted); in
    browser tests the SDK and all LINE origins are route-intercepted fixtures.

## Adapter state table (single authority for surface outputs)

| State | `/api/config` | Opt-in module & LIFF page | Customer DOM / network | Privacy section | Adapter tables |
|---|---|---|---|---|---|
| Never configured | Property absent (byte-identical) | 404 / never fetched | Zero LINE trace | Absent | None |
| Secret-only (binding set, no draft, `disabled`) | Property absent — customer surfaces identical to never-configured | 404 / never fetched | Zero LINE trace | Absent | None (setup shows missing-identifiers) |
| Draft (`disabled` + stored identifiers) | Property absent | 404 / never fetched | Zero LINE trace | Absent | `__line_lifecycle` only (operator's draft command) |
| Activating (saga in flight) | Property absent | 404 / never fetched | Zero LINE trace | Absent | `__line_lifecycle` + authority lifecycle rows |
| Active | Capability object | Served; module imports on capability | Opt-in on managed reservations | Rendered | All: day `__adapter_outbox` appears **only via an active event commit** (never from customer traffic in any other state; `__line_lifecycle` and the authority schema appear only via operator commands) |
| Missing secret (state active, binding absent) | **Cleanup marker** | Module served in cleanup mode (status + unlink only); LIFF page 404 | Cleanup-only affordance where a link exists | Rendered (data still held) | Unchanged |
| Deactivating | Cleanup marker | Cleanup mode; LIFF page 404 | Cleanup-only affordance | Rendered until purge completes | Being purged |
| Disabled (purge complete) | Property absent | 404 / never fetched | Zero LINE trace | Absent (see privacy note below) | `__line_lifecycle` (receipts + version + a non-authoritative high-water copy; **draft cleared on disable completion**) + `AdapterDelivery` keeps the **authoritative** non-identifying generation high-water plus the bounded redacted ledger and webhook-dedup rows until their own TTL/cap; day tables hold no LINE-owned rows (dropped entirely where LINE was sole consumer) |

The frontend guard imports the module when the config carries **either** the capability or the
cleanup marker; with neither it stays inert (and the module is 404 anyway). Spec FR-001's
cleanup exception covers the two marker states. Privacy note: the section is absent after purge
because the surviving ledger and webhook-dedup rows are non-identifying operational records,
covered by the permanent privacy text's generic operational-records paragraph (Routes row).
Never-configured, active, and deactivating states are browser-tested. Missing-secret and
post-purge byte identity are Worker-tested because one local browser-server process cannot remove
its secret binding or drive the purge clock. `Cache-Control: no-store` (the existing helper) is
asserted on every state-dependent response (`/api/config`, the module, LIFF aliases,
`privacy.html`) so a cached 200/404 cannot leak across states.

## Contract crosswalk (SC-003)

Every identity/notifications contract row maps to a verification:

| Contract row | Verification |
|---|---|
| Identity: configuration gating | Unconfigured absence tests (no UI element, no stored identifier, byte-identical responses) |
| Identity: event/trigger model | Link flow tests (session-boundary only; no reservation-transaction participation); server-side verify fixtures (valid / expired / forged / wrong audience) |
| Identity: failure semantics | Provider-outage fixture → accountless path untouched, clear degradation message |
| Identity: idempotency | Same-subject replay no-op; different-subject 409; unlink + replay does not recreate |
| Identity: retry/terminal visibility | No background identity queue; retryable provider failure returns a clear in-flow 503 and increments the bounded link-failure count in diagnostics |
| Identity: privacy | Only `sub` stored post-link; unlink/purge sweep leaves no copy (negative assertions across all tables); no profile claims persisted |
| Identity: observability | Diagnostics report configured state, failure counts, **and installation-level aggregates: linked-reservation count, deliverability-state breakdown, unlink/purge outcomes** — per installation, never per customer; **no subject in any log or diagnostic payload** (negative assertion); operator-authenticated access only |
| Notifications: configuration gating | Nothing queued while unconfigured (gate test); success surface promises no channel until active |
| Notifications: event/trigger model | Five events, emitted post-commit only, traceable to committed transitions; completed/no_show emit nothing |
| Notifications: failure semantics | Per-delivery failure isolation test; reservation state never touched |
| Notifications: idempotency | Event redelivery (accept dedup) and webhook redelivery (`webhookEventId`) produce exactly one message per event × recipient × channel |
| Notifications: retry/terminal visibility | Backoff schedule, retry-key/body identity across attempts and restarts, terminal parking with reason + time in diagnostics; **reasons are normalized to allowlisted internal codes + HTTP status + time** — no provider response body, header, or token is ever stored (negative tests with malicious provider fixtures) |
| Notifications: privacy | Message payload = time, service label, state only (negative assertions: no management key, no contact record, no secret) |
| Notifications: observability | Diagnostics: pending/failed counts, terminal records, webhook signature-failure counter |

Operator-side (not machine-checkable, documented in `docs/LINE-SETUP.md`): live-channel
verification checklist, same-provider constraint, Official Account quota, deactivation order.

## Implementation order

1. **Foundation**: `__adapter_outbox` + event sequence + gated write + handoff/ack + lazy
   re-poke in `ReservationDay` (day alarm untouched); `AdapterDelivery` accept/dedup skeleton
   with its own pre-armed alarms. Tests: legacy invisibility (adapter tables present → legacy
   checks still pass; unknown non-`__` tables still refused), rollback simulation (old-code
   reads over configured storage keep every reservation API working), crash windows
   (post-commit death → next-use re-poke; accept-then-ack-loss → receiver dedup), purge-boundary
   refusals, sustained destination failure, race suites untouched and green.
2. **LINE core**: signature verify (bounded body, strict base64, constant-time), ID-token verify,
   stateless token mint, push client (persisted key + fragment, versioned serializer, backoff
   table) — `fetchMock`
   fixtures; bounded signature-failure counter.
3. **Link flow**: settings validation + `lineAdapterStatus` projection; intent mint; link/unlink
   endpoints; conflict/replay/expiry/theft-resistance semantics; enable/disable/partial-config on
   existing days.
4. **Delivery pipeline**: accept → link resolution (no retroactive delivery) → queue → push →
   terminal parking; follow/unfollow ordering; unfollow parks that subject's pending deliveries;
   diagnostics counters; retention sweep + purge operation + config-generation lifecycle.
5. **Frontend**: LIFF page (`liff.init` → login → consent → `liff.getIDToken` → link;
   `liff.state` is **untrusted input** — only a same-origin relative path with a bounded intent
   value is accepted, and external URLs, protocol-relative URLs, or oversized values are
   rejected, with negative tests for external navigation and token-in-URL), dynamic opt-in on
   the management surface, setup/admin sections, `_headers` override; Playwright with fixture
   LINE secret injected into the webServer, full LINE-origin interception + zero-egress
   assertion, active-journey coverage; accessibility suite.
6. **Docs & release**: operator walkthrough, privacy surfaces, PARITY/ROADMAP flips (last, with
   evidence), allowlist + release audit.
7. **Gates**: `npm run check` + browser suites; **the constitution's customer-UI gate in
   full** — the manual keyboard-only review and the 320 px / mobile check for the new customer
   surfaces, and the SonarCloud quality gate (including the new-duplication ceiling) green on
   the PR; correctness review (codex-review, resume discipline + independent fresh session);
   `ponytail-review`; security battery — semgrep with a **pinned invocation recorded in
   tasks.md** (version, ruleset, target paths, generated-artifact exclusions, and
   finding-disposition log, so SC-004's rule-based scan is reproducible and evidenced against
   the final diff) + codex-review mode=security + adversarial review; PR "Part of #1".

## Parallel-plan integration (Codex second opinion, 2026-08-12)

An independent Codex plan converged on the same core architecture (outbox in `ReservationDay`;
installation-singleton `AdapterDelivery`; five events; nonce link intent;
raw-bytes HMAC; first-attempt retry key; stateless token; page-scoped CSP; fixture-only CI).
Adopted from it: deterministic event IDs; subject-indexed links in `AdapterDelivery`; unfollow
parks pending deliveries; generation-verified acceptance with ack-without-delivery for unlinked
events (the generation model of decision 8 supersedes the fingerprint idea); bounded webhook
body / fixed LINE URLs (no SSRF surface); dynamic opt-in DOM; privacy-surface updates;
deactivation ordering. Divergences kept: `transactionSync` stays (no async-
transaction rewrite — the post-commit handoff plus the durable sweep cover the recovery window
instead); no `PRAGMA user_version`
machinery (the `__`-prefixed tables of decision 4 are invisible to both legacy schema checks,
which also supersedes the earlier two-set recognition idea); contract crosswalk lives in this
plan + tasks.md.

## Risks

- **Outbox write on the hot path**: one SQLite insert (plus a pending-row check) per committed
  mutation when configured; zero when not; the day alarm is never scheduled early and its
  handler is untouched. Race suites + absence tests gate it.
- **Sweep load**: the durable sweep is bounded (cursor, fixed batch) and runs while `active`
  or `deactivating`; after `disabled` the day sweep stops and only the bounded retention
  alarms (ledger TTL, webhook-dedup TTL) may fire — a regression test pins each state's
  allowed work, including that `never-configured`/`draft-disabled` run nothing.
- **`__`-prefix invisibility is load-bearing**: the adapter's rollback safety rests on both
  schema checks excluding `__*` tables — a dedicated test pins that exclusion (creating the
  adapter tables and asserting the legacy checks still pass), so a future refactor of the
  listing query cannot silently break it; unknown non-`__` tables still throw.
- **Fixture fidelity**: LINE error shapes mocked from research-verified docs; the operator-side
  live checklist compensates for what fixtures cannot prove.
- **Scope creep**: no operator push notifications, no reply-message flows, no rich menus, no
  multicast; deferred until a target-matrix row asks.

## Plan-gate decisions for approval

1. Slice = the whole S1 stage in one feature (foundation + identity + notifications), PR "Part of
   #1", issue #1 stays open.
2. The ten design decisions above — notably the DO-outbox substrate (not Queues), the
   untouched-day-alarm handoff with the durable sweep, the purge-boundary send prohibition, and
   the reservation-scoped nonce-based link model.
3. Delegation posture: security scope + frontend → Claude Code implements everything directly (no
   external CLI for this slice), same as recorded for features 001/002.
