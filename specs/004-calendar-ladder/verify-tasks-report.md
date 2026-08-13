# Task verification report — feature 004 (S2 calendar ladder)

Verified on 2026-08-14 at `<repository-root>`, branch `feat/calendar-ladder`, against base
`3a9f72508ae075357da7c8b04a34cf7dc075c404`.
No deployment or live provider/account was used.

## Final command evidence

| Command | Result |
|---|---|
| `specify self check` | Up to date: 0.16.2 |
| `specify integration status` | OK; Codex integration; 0 modified/missing managed files |
| `npx vitest run test/calendar-adapter.test.ts test/reservation-day.test.ts --reporter=verbose` | 77/77 passed (calendar 51; reservation-day 26) |
| pinned Semgrep command in `security-scan.md` | 400 rules over 25 tracked files; 1 unchanged Turnstile finding accepted; 0 feature blocking findings |
| focused security regression command in `security-scan.md` | 28/28 passed |
| focused calendar privacy cleanup test | 1/1 passed |
| `npm run check` | core 54/54; Workers/DO 228/228; typecheck; generated types; Wrangler dry-run build; npm audit 0; release audit 77 files |
| `npm run test:browser` | 34/34 passed against local HTTPS Wrangler |
| GitNexus `detect-changes --scope compare --base-ref main --repo salon-reservation-oss-calendar` | 38 files, 321 changed symbols, 72 affected flows reviewed; shared validator/deadline/call wrapper correctly classified critical blast radius |
| `git diff --check` | passed |

The Workers pool prints expected unhandled-RPC warnings in tests that deliberately replace a
Durable Object receiver with an incomplete stub. The browser server prints certificate-unknown
messages when Chromium rejects Wrangler's self-signed local TLS connection before retrying with the
configured ignore-HTTPS-errors policy. Both suites completed with exit code 0; neither is a code
regression. One real privacy-test failure was found during the first full run: the test still
assumed a public privacy GET initialized Calendar state. The security design intentionally removed
that stateful public RPC, so the test now explicitly activates the authority before asserting
residual cleanup disclosure; its focused and full reruns pass.

PR review follow-up added regressions for a 33-event two-batch handoff, byte-identical repeated ICS
reads, and completion/no-show reconciliation. Before the corresponding fixes, those tests failed at
32/33 drained events, a changed `DTSTAMP`, and a missing confirmed projection respectively. The
latest review also reproduced both sides of an ordering race: an older outbox event resurrecting a
row after reconciliation, and an older reconciliation snapshot overwriting a newer accepted event.
A retained generation/sequence watermark now prevents both. At that checkpoint, the 58-case focused
run and full check passed. A subsequent review reproduced retained failed/configuration-blocked
Google deletes not being requeued and rate limiting suppressing residual privacy disclosure. The
new regressions failed on the parked mutation and missing disclosure before the fixes; one bounded
SQL update at reconciliation completion and a conditional conservative disclosure now pass. A
later review reproduced a failed day purge advancing the deactivation cursor; the lifecycle test
failed on that cursor move before the sweep was changed to retain and retry the same day. The final
review found that a full Google-mutation table could discard the only required delete, and that a
stalled optional descriptor could block reservation paths. Regressions failed before the fixes on
an acknowledged orphan delete and a one-second availability watchdog. Terminal ingress now retains
its outbox event and projection, reconciliation retains the projection without advancing its
watermark, and both recover when a slot frees; descriptor acquisition fails open after 250 ms. The
66-case focused and 216-case full runs above pass. Final static-analysis follow-up made the fixed
Google origin an explicit pre-fetch allowlist, consolidated repeated OAuth fixtures, and clarified
two duplicate contract headings. The exact GitLab SSRF rule changed from one finding to zero; the
large-file split was rejected as a dependency-free code move with no behavioral or measured
maintenance benefit. A final concurrency regression changed the adapter generation while identifier
hashing was suspended; it projected the old event before the fix, and now records it as stale after
re-reading active metadata inside the transaction. The last review cycle also reproduced an OAuth
body escaping its request deadline, a mutation-cap reconciliation partially rewriting one date, and
optional-integration copy appearing with every adapter absent. Both Google token and Calendar event
deadlines now cover their bounded response bodies, date replacement preflights every required delete
atomically, and the zero-adapter asset copy is restored.
The final review cycle reproduced three more recovery gaps: a stalled day RPC freezing the Calendar
sweep, an old final purge erasing a concurrently reactivated generation, and a deferred date being
skipped by the owner cursor. The shared five-second RPC deadline now retries the same day;
generation-scoped day purge plus a transactional lifecycle recheck preserve reactivation; and an
explicit deferred result keeps the blocked date as `nextCursor`.
The merge-gate review then reproduced an active sweep cursor surviving deactivation, Google queue
pressure retaining a cancelled item in the independent ICS feed, and terminal failed upserts
occupying every slot needed by a required delete. Entering deactivation now resets the purge cursor;
local projection removal no longer waits for Google capacity while the transactional source event
remains pending; and only failed upserts yield capacity to newer work. The new regressions failed on
all old paths and pass in the 68-case focused, 218-case full, and 17-case security runs above.
The Worker descriptor path also reuses the shared deadline helper, and the queue-bound fixture now
uses the exported production cap instead of a duplicate literal.
A final P1 regression paused the first Google item until the next row crossed its retention
deadline. Reusing the alarm-start time made an obsolete second provider call before the fix; each
claim now refreshes the clock after prior I/O, and the 69-case focused, 219-case full, and 18-case
security runs include this boundary.
Two late P2 regressions then proved that descriptor timeout committed no durable recovery event and
that an in-flight active sweep could overwrite deactivation's cursor reset. Calendar events now use
one day-global sequence, with generation `0` reserved for timeout or expired-lease recovery and
adopted only under a stable active generation. The sweep revalidates lifecycle state after every
awaited day RPC. The 71-case focused, 222-case full, and 21-case security runs cover both fixes.
The last P2 pair then reproduced a revoked shared credential calling the provider once per queued
row and the active sweep multiplying its 16-slot budget by the immediate handoff's ten rounds. A
persisted non-secret blocked fingerprint now parks current and new work after one shared rejection,
and rotation or explicit reconciliation requeues it. Sweep and handoff reuse one drain primitive,
but sweep spends only one round per slot and retains the date while `more` remains. The 73-case
focused, 224-case full, and 24-case security runs cover these bounds.
A final P2 pair proved that reconciliation could advance after a required upsert failed to enter a
full mutation table, and that the public residual-disclosure lookup could wait forever on a stalled
authority. The date preflight now covers every required upsert and delete before any write, while
the lookup reuses the shared 250 ms deadline and conservative disclosure fallback. The 74-case
focused, 225-case full, and 25-case security runs cover both fixes.
The final review also proved that a first wrong feed token was not counted before authority
activation. A configured feed now initializes the bounded authority schema before authentication and
writes only the aggregate counter, while an unconfigured mode remains storage-free; the regression failed with
two instead of three and passes after the fix without adding another test case.
The merge-ready recheck then reproduced a valid OAuth token paired with a missing target calendar:
each queued row attempted an update plus insert because the collection-level 404 was treated as an
item failure. Event-insert 404 now enters the existing fingerprint-scoped configuration block, so
one update/insert pair parks the whole queue. The 75-case focused, 226-case full, and 26-case
security runs cover this classification.
The final P1 recheck reproduced both post-OAuth expiry before the first Calendar mutation and expiry
after an update 404 but before its fallback insert. The shared sender now receives the claimed
`purgeAt`, checks it immediately before every DELETE, PUT, and POST, and returns expired work to the
existing retention prune. The regressions failed as a provider success instead of expiry and as two
Calendar calls instead of one; the 77-case focused, 228-case full, and 28-case security runs pass.

## Manual completion sweep

`speckit-verify-tasks` is not installed in this repository, so T039 used the specified manual
equivalent exactly once. Subsequent review fixes were checked against their affected tasks and the
command evidence above. Every task is accounted for below.

| Task | Implementation/evidence |
|---|---|
| T001 | Current Specify self/integration checks above; constitution and active feature are present in `.specify/`. |
| T002 | Current primary-mechanism decisions and links are recorded in `research.md`, including the explicit no-deploy decision. |
| T003 | Pre-edit CRITICAL/LOW GitNexus impact and shared-surface constraints are recorded in `plan.md`. |
| T004 | Spec, plan, model, contract, quickstart, research, and 16/16 checked requirements exist with no clarification marker. |
| T005 | Calendar migration/two-consumer/lease/projection/privacy/availability regressions are in `test/reservation-day.test.ts`. |
| T006 | Generic consumer descriptors, additive outbox fields, calendar-only create, safe projection, and handoff are in `src/reservation-day.ts`. |
| T007 | Secret/ID/ICS/OAuth/URL/payload/classification pure tests are in `test/calendar-adapter.test.ts`. |
| T008 | One concrete dependency-free provider implementation and bounded SQLite authority are in `src/calendar-adapter.ts`. |
| T009 | Binding/export/optional secret fixtures and regenerated types are present; `types:check` and dry-run build pass. |
| T010 | Optional descriptor wiring preserves byte-identical public config, zero absent-mode calendar RPC, and 250 ms fail-open with a durable unbound outbox event under a stalled authority. |
| T011 | Foundation, LINE regression, and type checks pass within the full command evidence. |
| T012 | Projection/dedup/order/retention/overflow/feed authority tests pass in the 51-case calendar suite. |
| T013 | Absent/bad/valid/rotated/exact-query/header/cache/privacy Worker feed tests are in `test/worker.test.ts`. |
| T014 | Calendar acceptance, projection, bounded cleanup, aggregate auth diagnostics, and serializer are implemented. |
| T015 | Uniform-404 capability route and no-store/nosniff headers are implemented and tested. |
| T016 | Feed lifecycle bytes are parsed in tests; forbidden customer/contact/proof/reference fields are absent. |
| T017 | OAuth cache/rotation/redirect/full-body deadline/body/schema tests pass. |
| T018 | Desired-state, claim, retry, convergence, race, retention, and mutation-cap delete recovery tests pass. |
| T019 | Worker tests prove Google retry/permanent failure leaves reservation/availability JSON unchanged. |
| T020 | Bounded refresh exchange and credential-fingerprint memory cache are implemented without persistence/logging. |
| T021 | Deterministic update→insert/409→update/delete Google protocol is implemented against fixed hosts with bounded error-response deadlines. |
| T022 | Latest desired state, bounded claims/retries, fingerprint-scoped whole-queue configuration parking, terminal ledger, and alarm scheduling are implemented. |
| T023 | Fixture fetch assertions and source/security scans prove zero live network, redirect follow, secret logs, provider reads, or runtime dependency. |
| T024 | Lifecycle/high-water/disable/purge-fault/deadline retry, one-round sweep budgeting, generation-safe reactivation, cursor revalidation, recovery-event adoption, requeue/redaction, atomic date-reconciliation, and identifier-hash generation-race tests pass. |
| T025 | Owner status and bounded reconciliation auth/origin/rate/input/idempotency tests pass. |
| T026 | Browser owner-only status/reconcile and zero customer calendar trace pass in `tests-browser/owner.spec.ts`. |
| T027 | Mode transition, leases, consumer purge, fingerprint requeue, status, and quiescent alarms are implemented. |
| T028 | Redacted owner status and seven-date authoritative reconciliation routes are implemented, retaining a capacity-deferred date as the next cursor. |
| T029 | Invalid/removed credential, response-redaction, and browser evidence pass with fixture-only secrets. |
| T030 | `docs/CALENDAR-SETUP.md` covers optional setup, OAuth, token/target rotation, recovery, smoke, and no-deploy development. |
| T031 | Privacy documents and state-dependent Worker disclosure name the exact fields and cleanup lifecycle; the zero-adapter static asset keeps no integration copy. |
| T032 | Cloudflare/release docs cover optional bindings, Free-plan budget, alarms, and forward backout. |
| T033 | Sorted manifest/audit required-set changes pass the 77-file secret/email/license/install-script gate. |
| T034 | 77-case focused, 228-case full, type/build/audit, and 34-case browser results are recorded above. |
| T035 | `security-scan.md` records the pinned 400-rule Semgrep run, exact GitLab SSRF rule, complete adversarial review, one hardened CWE-918 candidate, three fixed CWE-770 candidates, six fixed CWE-400 candidates, two fixed CWE-362 races, durable timeout recovery, atomic reconciliation-cap/cursor handling, one accepted baseline finding, and zero feature-blocking findings. |
| T036 | Correctness review found the privacy test's obsolete assumption and retention-cleanup visibility gap; PR review then found the multi-batch, stable-stamp, legacy-drain migration, optional-lease, reconciliation-ordering/cursor, retained-delete recovery, conservative-disclosure, failed/stalled day sweep, mutation-cap delete/atomicity, deactivation/reactivation race, descriptor and Google response-body deadline stalls, zero-adapter copy, identifier-hash generation-race, timeout-recovery, sweep-cursor transition, shared-credential parking, missing-target classification, post-OAuth/subrequest retention, sweep-round budget, required-upsert capacity, residual-disclosure deadline, and first-feed-failure visibility gaps. Ponytail reused native Promise/SQLite, the existing outbox, and the shared deadline/drain primitives; it added no dependency, provider API, or speculative abstraction. Focused/full reruns pass. |
| T037 | GitNexus changed-flow review, complete diff review, scope check, and `git diff --check` pass; only feature files changed. |
| T038 | Calendar rows are Implemented, S2 is Complete, and inbound availability remains Deliberately excluded. |
| T039 | This one-time manual evidence sweep found no checked task without implementation or evidence. |

Result: T001–T039 have corresponding implementation/evidence; no false completion found.
