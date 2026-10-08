# S4 verification evidence

Status: integrated implementation and local acceptance. Publication requires the current-head remote checks and review gate; S5 remains Not started.

## Boundary and design

- The existing-system migration confirmation rule is on public main through PR #64. S5 remains unstarted. No migration-purpose real-data read/export, import, restore, cutover, deployment or live-provider operation was performed.
- [ADR0003](../../docs/ADR-0003-MULTI-LOCATION-BOUNDARY.md), the feature contracts and the private evidence gate precede runtime implementation. The delivered capabilities are Reimplemented; no source, tests, fixtures or DDL were copied from the public reference.
- Three actual generated references were selected before UI code. Exact prompts, hashes, delegated selection and limitations are in [the design record](design/selection.md). Rendered customer, operator and named-calendar views were compared with those references. Selection was delegated, not personal approval of an image.

## Combined acceptance

The final source-quality combined gate ran at `ad2eed8b8e2abf94042e668fa0b1c9b934ebcf90`. Earlier `04a8f97` and writer results below remain historical stage evidence; they are not substituted for the final run. The initial browser writer at `b88b53ec1f0aa6d51b9642c6b15ae6e35f6cb726` matched the runtime/browser configuration and bindings. Later test-only commits `f219f0a8b67011253ec27d43aea38c411a65422b` and `2d8802fa96d28e72fc4bc809f3563f7267c1ff26` add the rendered recovery and native peer-purge evidence below; the integration additionally contains release-metadata omission guards and documentation. Documentation-only follow-ups do not change these runtime results.

| Check | Command or evidence | Observed result |
| --- | --- | --- |
| Full combined gate | `npm run check` | 120 core + 327 Worker tests (six files, 249.33 seconds); strict types, generated types, dry-run build, dependency audit zero vulnerabilities and release audit 94 paths; exit 0 |
| Real rendered flows, fresh isolated local backend | `npm run test:browser` | 59/59 passed in 3.8 minutes at `ad2eed8`: installation 8, app 37, bootstrap 2, customer 5, operator 3, capacity 1 and private-artifact 3; no skipped or duplicated cases. The ordered scoped phases retain the earlier 58-case order, plus the new stale-conflict regression. |
| Native peer-purge follow-up | `npm run test:worker` at `2d8802f` | 326/326 passed across six files in 255.10 seconds; required typecheck and exact-delta review passed |
| Static security and secret rules | Semgrep OSS 1.178.0, `p/security-audit` and `p/secrets`, `src public scripts`, metrics/auth off | 29 files, zero findings and zero errors; exit 0 |
| Dependency installation policy | `npm ci --ignore-scripts`, `npm install-scripts ls --json` | Lockfile-matched worktree dependencies; zero vulnerabilities; `allowScripts: []` |
| Required release boundaries | `test/release-metadata.test.ts` | Ten added omission cases, including the split customer/operator suites, observed literal `actual exit 0` versus `expected exit 1` before their fixes; all now refuse the omitted paths |
| Task verification | Independent manual audit after implementation | One independent audit at `797e281`: 32 Verified, 5 Weak, 0 Missing; four requested execution gaps and report recording. Original verdict is retained in [the report](verify-tasks-report.md); four execution gaps and report recording are closed in a separate coordinator appendix, without rerunning or rewriting the original audit. |

The rendered suite uses real local application state and fixed provider fixtures. Customer browser commit/replay uses the existing native owner-forwarding fixture for both attempts, preserving its receipt fingerprint. Native public API tests independently prove paused existing-receipt replay and fresh-command refusal; these layers are composed rather than claiming browser execution against live Siteverify. It covers creation/cap/conflicts, same-scope booking/proof return/cancel and uncertain outcomes, paused proof access, unknown scope refusal, staff grants/revocation and stale private responses, scoped LINE SDK intent/abandon and owner calendar token/version/error flows. Native verified-token/finalization/unlink tests complement browser LINE login; no live-provider end-to-end claim is made.

## Behavioral and adversarial evidence

| Boundary | Runtime evidence |
| --- | --- |
| Legacy default compatibility | Existing root/day/receipt/roster fixtures, default object names, browser v1 records and queued LINE v1 payload assertions retained; default-only native and browser cases pass |
| Location authority | Canonical names and exact nameless-default ID fallback; four-location cap, duplicate/replay/CAS and concurrent last-slot refusal; unknown reads do not initialize a named row |
| Booking transaction | Two independent fifty-way races; exact-value rollback after receipt/final Calendar sequence faults, identical retry and unchanged replay; scoped proof, pending command and purge isolation |
| Staff authorization | Atomic initial grants, legacy default-only and explicit-empty grants, distinct known IDs, current-owner/CAS recheck, restart and next-request revocation; complete route/role/query/PII matrix with slow-body cases |
| LINE | Local nonce/consent/claim/sequence/dedup/unlink isolation; named v2 label snapshots/default v1 bytes; signed global fanout with all-target acknowledgement, partial/stalled retry and draining-unfollow; shared-realm concurrency and bounded earliest root alarm |
| Calendar | Digest-only independent feed capabilities, immutable unique actual targets, missing-credential/target refusal; reversed config/version fences, root activation epoch across off/on/restart, old purge and stale 403 refusal, lost handoff/retry/retention and bounded full per-day continuation |
| Browser privacy | Credential/location/request snapshots reject late success/error/finally; directory authorization precedes pending private restoration; four known proof keys and at most 16 status checks; no current-location fallback for another proof |

Independent exact-ref reviews found and closed the unknown named intent recovery gap, activation-epoch cleanup/re-enable races, stale provider failure settlement, three stale private browser response paths, and capability-bearing test artifact exposure. Correctness/Standards and separate lean/over-implementation reviews cover the integrated slices. The final staff-read follow-up passed independent correctness, privacy/security and lean review at `b88b53e` plus test-only closure `8d68170`; the accepted artifact-cleanup finding is corrected and reverified, with zero unresolved findings. Findings are verified against actual definitions and callers; stale or missing linked-worktree graph entries are not evidence of low impact.

A final browser run exposed an enabled logout button refusing to clear an issued staff credential while a subsequent read-only roster refresh was pending. A native held-response regression first failed at the primitive credential-hidden assertion. The fix distinguishes the three pending staff writes from follow-up reads: an unconfirmed POST still prevents logout/reauthentication, while a committed POST followed by a delayed GET permits explicit logout. Releasing the old GET cannot repaint private state or restore the credential, and a second sign-in has no old secret. The targeted regression and all 56 cases pass. A subsequent test-only cleanup correction detaches the cached credential container before releasing held replies. Native scheduling first proved that a text scrub could be followed by a late credential write, then proved that the detached container cannot expose that write. The original targeted case passes again, its functional assertions and the 56-case collection are unchanged, and strict browser/configuration typechecking passes.

## Native fixture isolation

A full-suite Calendar failure reproduced a pinned workerd reset limitation: an evicted fixture object's SQLite data survived native reset. A 92 ms native red case failed to reuse the same fixture slot after eviction/reset; waking that explicitly registered fixture before reset passed. The Calendar suite now records only its own stateful factory fixtures, reacquires/wakes them, then uses native reset; mock globals/fetch are restored after each case. No host database paths, runtime bindings, dependencies, timeout increases or skipped functional assertions were introduced.

The provider-retry fixture uses actual registered day objects, SQLite queue/claims, native alarms and all seven retry assertions. Known-empty sweep days return an empty test descriptor only in that case, with the exact namespace property restored in `finally` before reset. Queue and provider-call assertions ensure that an accidentally empty test cannot pass. This avoids an unrelated full-window scan in that retry case while retaining actual native delivery semantics. All 327 Worker cases pass in the final normal six-file run; the Calendar suite contains 71 cases.

## Rendered and artifact evidence

Customer widths 320/360/768/1440, operator 320/1440 and setup/calendar 360/1440 were inspected; observed scroll width equals viewport width. Keyboard flows pass. Relevant customer/operator/setup axe checks reported zero violations; dark theme, reduced motion and forced colors were exercised. Private local captures contain only fictional labels and exclude issued capabilities. Added customer commit/drop/scope recovery, paused-default precedence, forbidden/empty operator scope and same-page closure recovery cases close the audit gaps. Native LINE/Calendar peer-purge checks remove a real A event and sequence while retaining B storage, proof digests, alarms and projections.

A synthetic inert-string trace probe demonstrated that masking a token later does not remove its earlier trace snapshot. Primitive boolean assertions retain the clear-state checks, and capability-bearing projects disable retained traces/screenshots. Discovery assigns all 59 tests exactly once; the issued-credential installation regression now runs in the private-artifact project. Other legacy artifact policies remain unchanged. A later inert-marker probe also confirmed that fill action logs and password-field failure snapshots can expose values. The final staff test uses one local submit helper with pre-injection actionability checks, constant-source evaluation arguments, the actual submit click and unconditional input clearing in `finally`; the four primitive privacy observations pass without a real-credential failure experiment.

## Source-quality follow-up and fresh review

The first public PR analysis found source-quality issues despite passing functional gates. Valid issues were corrected without disabling rules or reducing thresholds. Root alarm driving now starts at most four existing per-location drivers concurrently: a native red case observed a peer remaining activating while another actor was held; the green case observes that peer becoming active before release. The existing alarm tail, in-flight counter, per-RPC deadlines and retry persistence remain unchanged. Root location tests now total 22.

The root retains mutable owner/version/target/digest/epoch checks inside the synchronous transaction, reuses the existing exact control-character validator and represents empty SQL results as optional values. Worker authorization/body/rate order and all delivery SQL, consent, dedup, claims and clock boundaries remain intact. Fulfilled webhook acknowledgements are treated as an unknown boundary: null, an empty object, false and a truthy string each yield retryable 503; explicit true still succeeds after all targets acknowledge.

The browser source uses consistent internal history options and small existing-style jobs while retaining scope/epoch/token fences. An inherited 409 error path could overwrite a reauthenticated session after a held directory read failed. Its native regression first observed the old duplicate-location error replacing the new session success; one post-await scope check fixes it. The focused three-case run and the full 59-case run pass.

The shared path helper is now independently tested against slash-backslash/control-character authority parsing and dot-segment normalization that exposes a leading double slash, for both default and named scopes. The original failure was a missing expected TypeError; all 20 journey cases now pass, including unchanged valid default bytes and encoded query data.

The long browser file was split by fixture-dependent customer/operator phases, with the capacity case last. All original assertions and the staff credential helper remain, and captured commands are reported only as safe primitive observations. Pinned local SonarJS checks report no function over complexity 15; measured test files remain below 500 non-comment lines and reported functions at or below 50. These local checks complement the mandatory hosted analysis.

Fresh independent Standards/Spec/security and separate lean reviews bind root `e7bbb273`, Worker/delivery `19e3af1`, and browser `5bdc189` plus stale-error closure `4fca308` to the combined source. Intentional bounded sequential proof/config reads and two scanner claims about a fixed numeric status map and a fixture null check were independently reviewed and recorded as issue-specific false positives with service evidence. The redirect scanner's exact Express claim is distinct from the latent helper gaps, which were fixed rather than dismissed. No repository-wide exclusion or gate change was made. A final test-only diagnostic change uses equivalent URL predicates while a management proof is visible. An inert-marker check against installed Playwright observed that the old RegExp URL matcher retains the body marker and the predicate matcher does not; no real credential was used. Functional matching conditions are unchanged, and current-head CI runs all 59 cases.

## Local tool isolation

Writer worktrees use their own lockfile-matched dependencies, installed with `npm ci --ignore-scripts`. The canonical checkout's existing dependencies were left unchanged. Node 24.16.0 and npm 12.2.0 were used; the existing supported npm range is 12.x. Installation reported zero vulnerabilities and `npm install-scripts ls --json` returned `allowScripts: []`.

The browser cache was isolated to the integration worktree. Playwright 1.62.1 launched its matching Chromium Headless Shell 151.0.7922.34. This launch check establishes browser availability only, not application correctness. Other projects' browser caches were preserved.

## Adapter operation-count experiment

Before S4 runtime changes, 28 fictional workerd/SQLite scenarios exercised the existing application algorithms at baseline `43825e67`. The temporary instrumented bundle redirected storage access to counters, used actual day RPC/SQLite, replaced provider calls with fixed fixtures, and advanced the clock rather than waiting 24 hours. All scenario assertions passed. Instrumentation and raw local evidence remain separate from the shipped runtime.

| Retained 60-second cadence, one empty adapter for a simulated moving-window day | LINE | Calendar |
| --- | ---: | ---: |
| Alarm handlers | 1,440 | 1,440 |
| Day drain RPCs | 22,698 | 22,698 |
| Alarm plus day requests | 24,138 | 24,138 |
| Adapter SQL rows read | 84,717 | 1,020,852 |
| Adapter SQL rows written | 1,490 | 2,880 |
| Alarm writes, counted separately | 1,440 | 1,440 |

Four locations with both adapters extrapolate to 193,104 alarm/day requests before booking, operator, webhook, provider and named-configuration work. This is a conditional baseline scenario, not measured S4 installation traffic, billing or a worst-case workload. It does not establish Free-plan fit.

A deliberately naive 300-second replacement delayed Calendar retry, send-claim recovery and remaining queued work from 60 to 300 seconds. LINE retained its earlier queue/claim wakes, but retention and late-terminal rules still needed separate proof. Therefore S4 retains the existing 60-second constant and behavior.

`fullCycleBoundS(457) = 23,340` remains a model for one drain slot per day under its declared batch-runtime and fault assumptions. A day reporting more/pending consumes additional slots. Neither that value nor the naive 300-second calculation proves a maximum-backlog deadline. The 2,000-row queue experiment observed one-alarm reads of 28,103 LINE rows and 56,849 Calendar rows while retaining the existing eight-send batch; it did not fill all 457 day outboxes or measure production performance.

The producer command budgets alone are not an outbox-event maximum: lazy expiration emits an event without consuming an accepted mutation. Adding up to 96 expirations gives conservative per-day test bounds of 288 LINE and 384 Calendar events, rather than 192/288 from accepted mutations/creates alone. These are conservative bounds, not a proof of the tight reachable maximum or a saturated 457-partition delivery deadline. Native day fixtures exercise those conservative per-day bounds, actual drain/ack and bounded more/pending continuation. They do not establish a deadline for 457 simultaneously saturated partitions.

## Publication and limitations

Current-head remote CI, security/quality checks and valid review findings must be clear before an expected-SHA merge; main is verified afterward. The public feature is not deployed by this work. Full evidence and task verification accompany the candidate; final publication status is recorded in the pull request.

Live LINE/Google behavior, provider-account changes, actual billing, universal Free-plan fit and a 457-partition saturated-backlog deadline were not verified. Forward backout retains named readers/routes/alarms while retained data exists. Existing-system data migration needs separate concrete confirmation and is excluded from S4 completion.
