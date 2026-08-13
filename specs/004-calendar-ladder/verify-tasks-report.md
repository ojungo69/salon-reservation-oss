# Task verification report — feature 004 (S2 calendar ladder)

Verified on 2026-08-13 at `<repository-root>`, branch `feat/calendar-ladder`, against base
`3a9f72508ae075357da7c8b04a34cf7dc075c404`.
No deployment or live provider/account was used.

## Final command evidence

| Command | Result |
|---|---|
| `specify self check` | Up to date: 0.16.2 |
| `specify integration status` | OK; Codex integration; 0 modified/missing managed files |
| `npx vitest run test/calendar-adapter.test.ts test/reservation-day.test.ts --reporter=verbose` | 62/62 passed (calendar 36; reservation-day 26) |
| pinned Semgrep command in `security-scan.md` | 400 rules over 25 tracked files; 1 unchanged Turnstile finding accepted; 0 feature blocking findings |
| focused security regression command in `security-scan.md` | 7/7 passed |
| focused calendar privacy cleanup test | 1/1 passed |
| `npm run check` | core 54/54; Workers/DO 211/211; typecheck; generated types; Wrangler dry-run build; npm audit 0; release audit 77 files |
| `npm run test:browser` | 34/34 passed against local HTTPS Wrangler |
| GitNexus `detect-changes --scope compare --base-ref main --repo salon-reservation-oss-calendar` | 37 files, 318 changed symbols, 72 affected flows reviewed; shared validator/call wrapper correctly classified critical blast radius |
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
62-case focused and 211-case full runs above pass. Final static-analysis follow-up made the fixed
Google origin an explicit pre-fetch allowlist, consolidated repeated OAuth fixtures, and clarified
two duplicate contract headings. The exact GitLab SSRF rule changed from one finding to zero; the
large-file split was rejected as a dependency-free code move with no behavioral or measured
maintenance benefit. A final concurrency regression changed the adapter generation while identifier
hashing was suspended; it projected the old event before the fix, and now records it as stale after
re-reading active metadata inside the transaction.

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
| T010 | Optional descriptor wiring preserves byte-identical public config, zero absent-mode calendar RPC, and 250 ms fail-open under a stalled authority. |
| T011 | Foundation, LINE regression, and type checks pass within the full command evidence. |
| T012 | Projection/dedup/order/retention/overflow/feed authority tests pass in the 36-case calendar suite. |
| T013 | Absent/bad/valid/rotated/exact-query/header/cache/privacy Worker feed tests are in `test/worker.test.ts`. |
| T014 | Calendar acceptance, projection, bounded cleanup, aggregate auth diagnostics, and serializer are implemented. |
| T015 | Uniform-404 capability route and no-store/nosniff headers are implemented and tested. |
| T016 | Feed lifecycle bytes are parsed in tests; forbidden customer/contact/proof/reference fields are absent. |
| T017 | OAuth cache/rotation/redirect/body/schema tests pass. |
| T018 | Desired-state, claim, retry, convergence, race, retention, and mutation-cap delete recovery tests pass. |
| T019 | Worker tests prove Google retry/permanent failure leaves reservation/availability JSON unchanged. |
| T020 | Bounded refresh exchange and credential-fingerprint memory cache are implemented without persistence/logging. |
| T021 | Deterministic update→insert/409→update/delete Google protocol is implemented against fixed hosts. |
| T022 | Latest desired state, bounded claims/retries, configuration parking, terminal ledger, and alarm scheduling are implemented. |
| T023 | Fixture fetch assertions and source/security scans prove zero live network, redirect follow, secret logs, provider reads, or runtime dependency. |
| T024 | Lifecycle/high-water/disable/purge-fault retry/re-enable/requeue/redaction and identifier-hash generation-race tests pass. |
| T025 | Owner status and bounded reconciliation auth/origin/rate/input/idempotency tests pass. |
| T026 | Browser owner-only status/reconcile and zero customer calendar trace pass in `tests-browser/owner.spec.ts`. |
| T027 | Mode transition, leases, consumer purge, fingerprint requeue, status, and quiescent alarms are implemented. |
| T028 | Redacted owner status and seven-date authoritative reconciliation routes are implemented. |
| T029 | Invalid/removed credential, response-redaction, and browser evidence pass with fixture-only secrets. |
| T030 | `docs/CALENDAR-SETUP.md` covers optional setup, OAuth, token/target rotation, recovery, smoke, and no-deploy development. |
| T031 | Privacy documents and state-dependent Worker disclosure name the exact fields and cleanup lifecycle. |
| T032 | Cloudflare/release docs cover optional bindings, Free-plan budget, alarms, and forward backout. |
| T033 | Sorted manifest/audit required-set changes pass the 77-file secret/email/license/install-script gate. |
| T034 | 62-case focused, 211-case full, type/build/audit, and 34-case browser results are recorded above. |
| T035 | `security-scan.md` records the pinned 400-rule Semgrep run, exact GitLab SSRF rule, complete adversarial review, one hardened CWE-918 candidate, three fixed CWE-770 candidates, one accepted baseline finding, and zero feature-blocking findings. |
| T036 | Correctness review found the privacy test's obsolete assumption and retention-cleanup visibility gap; PR review then found the multi-batch, stable-stamp, legacy-drain migration, optional-lease, reconciliation-ordering, retained-delete recovery, conservative-disclosure, failed-day purge cursor, mutation-cap delete, descriptor-stall, and identifier-hash generation-race gaps. Ponytail reused native Promise/SQLite and the existing durable recovery path, consolidated repeated fixtures, and rejected a behavior-neutral file split; no dependency or speculative abstraction was added. Focused/full reruns pass. |
| T037 | GitNexus changed-flow review, complete diff review, scope check, and `git diff --check` pass; only feature files changed. |
| T038 | Calendar rows are Implemented, S2 is Complete, and inbound availability remains Deliberately excluded. |
| T039 | This one-time manual evidence sweep found no checked task without implementation or evidence. |

Result: T001–T039 have corresponding implementation/evidence; no false completion found.
