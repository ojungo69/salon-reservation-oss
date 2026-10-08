# S4 verification evidence

Status: implementation in progress. Targeted results below do not complete S4. Combined current-head checks, rendered flows, independent reviews and task verification remain pending.

## Boundary and design

- The existing-system migration confirmation rule is on public main through PR #64. Its main CI and Sonar analysis passed. S5 remains unstarted; no migration-purpose data read/export, import, restore, cutover, deployment or live-provider operation was performed.
- [ADR0003](../../docs/ADR-0003-MULTI-LOCATION-BOUNDARY.md), the feature contracts and the private evidence gate precede runtime implementation. Current implementation provenance remains Reimplemented.
- Three actual generated references were selected and inspected before UI code. Their exact prompts, hashes, selection and limitations are in [the design record](design/selection.md). Browser comparison is still required.

## Completed targeted checks

Results were obtained at the corresponding writer or integration stage. They are not a claim that the final combined head has passed.

| Check | Observed result |
| --- | --- |
| Backend canonical names and exact nameless-default fallback | Four pure tests passed; strict typecheck passed |
| Location creation/settings/replay/unknown/CAS/current-owner authority | Four real Durable Object cases passed |
| Staff grants/default-only/empty scope/revocation/restart/atomic scoped creation | Eight new runtime cases, 15 existing Worker staff cases and 10 pure roster cases passed |
| Named calendar version/digest/unique immutable target/readiness/current-owner boundary | 12 real-runtime cases and existing pure settings/type checks passed |
| Location/day routing and create recovery | Two fifty-way races, eight exact-value rollback/retry cases and handoff checks passed in the HTTP writer; combined regression remains pending |
| Initial customer selector and named-only URL | Two stubbed browser cases failed before the UI change and then passed; these are controller evidence, not real-backend acceptance |
| Public location/storage/proof helpers | 18 pure journey cases passed in the UI writer; combined acceptance remains pending |
| Required release documents/source/test paths | Five omission regressions first failed because audit incorrectly succeeded, then passed after the required-path fix |
| Core command registration and release audit | 108 core cases passed at the first metadata stage; later additions require the final combined run. Current release audit passed with 89 allowlisted paths |

The release-boundary red cases were literal `actual exit 0` versus `expected exit 1` after removing a required manifest path. The audit printed success with 84, 86 or 88 allowlisted files. The fixed audit refuses those omissions. No gate was weakened.

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

## Pending completion gates

- Integrate all root, HTTP/adapter and UI implementations; verify exact default compatibility and named isolation on the combined head.
- Run full `npm run check` and rendered browser suites with real local backend/provider fixtures. Verify keyboard, narrow widths, themes, reduced motion, forced colors and selected-image comparisons.
- Complete correctness, separate over-implementation, rule-based static security and adversarial scope/privacy/race reviews. Resolve valid findings and recheck the affected behavior.
- Verify tasks once after implementation, reconcile capability/provenance/roadmap claims, then obtain current-head remote checks/reviews before merge and verify main afterward.

Existing-system data migration requires separate concrete confirmation and is not a completion task for this feature.
