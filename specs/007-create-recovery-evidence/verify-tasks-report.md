# Verification: create recovery evidence

Date: 2026-10-08. Scope: feature 007 changes and their current local verification. The independent task verification below was executed once after implementation and complete local checks.

## Actual verification

| Check | Result |
| --- | --- |
| Four focused public/owner × receipt/calendar-sequence recovery cases | 4 passed against unchanged runtime, including the actual public-attribution query |
| `GIT_TRACE2_EVENT=0 npm run check` | Passed: 100 core tests, 248 Worker tests, typecheck, generated-type check, deployment dry-run, dependency audit with zero vulnerabilities, release audit with 84 allowlisted files |
| `GIT_TRACE2_EVENT=0 ./node_modules/.bin/playwright test` | 41 passed; fictional local application only |
| `npm install-scripts ls --json` with `.allowScripts == []` assertion | Passed |
| Independent read-only correctness/spec and simplicity reviews | No findings; the final attribution-query refinement was reviewed separately |
| `git diff --check`, changed-file inspection, relative links, private-coordinate scan | Passed; no application runtime, schema, API, UI, or dependency changes in this feature |

No initial product failure was manufactured. The new recovery checks passed on the existing implementation. Their exact table-value and retention-alarm comparisons detect singleton revision/state/budget updates that unchanged row counts would miss. Failure triggers are local test fixtures, removed in `finally`. After recovery, one retry commits and the following replay changes none of the captured values. Calendar creation adds one event and LINE creation adds none.

## Earlier execution conditions

The first inherited Git-tracing run failed two public-fixture ref checks. The identical checks passed with tracing disabled; the final complete check uses that condition. The first browser attempt could not launch its required headless-shell revision. Both worktrees' declared, locked, and installed Playwright versions matched; installing the required shell allowed all 41 browser tests to pass. These setup failures are separate from application assertions.

The branch follows the preceding release-audit/dependency fixes. Final installation and checks report zero dependency vulnerabilities. No audit threshold, required check, browser assertion, or security gate was weakened.

## Claims and limits

The tests compare `core_state`, `booking_details`, `adapter_receipts`, `partition_meta`, `closures`, `__attribution` when present, `__adapter_meta`, `__adapter_outbox`, and the retention alarm. They do not compare arbitrary platform-internal state or prove exactly-once external delivery.

ADR0002 retains one day Durable Object for the current single-location/JST/accountless scope. Global customer identity, multiple locations, cross-day transactions, application import/backout, production backup/restore, live-provider behavior, and measured cost/performance are not proven. Application migration readiness remains Blocked. Runtime provenance stays Reimplemented; no source/test/DDL was copied.

The worktree is not registered in GitNexus. Current-source caller inspection, relevant real-runtime checks, changed-file review, and `git diff --check` supplied the documented fallback. Existing private rights assessments were preserved, with a separate public-license/reference evaluation appended privately.

## Independent task verification

Fresh-session advisory: verification was performed by the independent read-only reviewer, separate from the implementing writer. It covered feature 007 and final task/report documents. No suites were rerun. Semantic assessments are interpretive.

`+` means positive; `—` means not applicable.

| Task | Files | Diff | Symbols | Wiring | Semantic | Verdict | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| T001 | + | + | — | — | + | ✅ VERIFIED | Existing snapshot, consent, expiry, race and outbox tests support the adopted scope. |
| T002 | + | + | — | — | + | ✅ VERIFIED | Spec, plan and design artifacts exist and preserve the application contract. |
| T003 | + | + | — | — | + | ✅ VERIFIED | Historical evidence prefix is preserved byte for byte; one public-reference evaluation was appended. Historical Pending rights remain unchanged. |
| T004 | + | + | — | — | + | ✅ VERIFIED | Four real-runtime cases compare exact table values/alarm, clean up triggers, retry identical commands and preserve replay. Public attribution is queried; calendar increment=1 and LINE increment=0. |
| T005 | + | + | — | — | + | ✅ VERIFIED | Final focused execution records four passing recovery cases. Runtime is unchanged. |
| T006 | + | + | — | — | + | ✅ VERIFIED | ADR0002 selects one bounded authority and records comparison, mappings and unsupported claims. |
| T007 | + | + | — | — | + | ✅ VERIFIED | Provenance/parity/roadmap links agree; ADR appears exactly once in the release manifest. |
| T008 | + | + | — | — | + | ✅ VERIFIED | Actual executions confirm 100 core, 248 Worker and 41 browser passes; type checks, dry-run, audit=0 and release audit=84 pass. Install-script JSON satisfies the allowlist assertion. |
| T009 | — | — | — | — | + | ⚠️ WEAK | Both independent review rounds were directly observed with no findings. The task originally named no file or code reference, making mechanical layers inapplicable; review work was present. |

Original scorecard: VERIFIED 8; WEAK 1; PARTIAL 0; NOT_FOUND 0; SKIPPED 0. No concrete implementation defect or omitted requirement was found. The focused selection excluded unrelated tests; the complete core/Worker run had no skipped tests.

T010 self-evidence: this single independent audit verified T001–T009 against artifacts, execution evidence, boundaries, and test semantics. T010 was intentionally unchecked until this result was recorded. Recording the audit completes T010; no second audit was run.

## Walkthrough log

T009's structural classification was resolved by adding this report's path to its task description and recording both review rounds here. The original WEAK verdict above is retained as the immutable audit result. The change corrects the evidence pointer; it does not claim a rerun or alter the independently observed clean reviews. There is no remaining implementation or review work from this item.

## Review follow-up — 2026-10-08

PR 62 review found that ADR0002 was listed in the public manifest but absent from the release audit's required paths. The existing governance omission test gained an ADR0002 case: before the fix, removing it returned audit exit 0 and failed the new test (`0 !== 1`); after one `REQUIRED` entry was added, that case passed. The original task-verification verdicts and counts above remain historical results.

The updated local checks passed: 101 core tests, 248 Worker tests, type and generated-type checks, deployment dry-run, dependency audit with zero vulnerabilities, release audit with 84 allowlisted files, and 41 browser tests. The fresh review of the pushed head remains a merge gate.
