# Security scan record — feature 003 (S1 LINE adapter)

Rule-based static analysis gate (tasks.md T038), reproducible invocation.

- Tool: semgrep **1.172.0** (pinned; recorded by `semgrep --version` at scan time)
- Date: 2026-08-13
- Invocation (exact):

  ```sh
  semgrep scan --metrics=off --error --config p/default --config p/owasp-top-ten src/ public/
  ```

- Scope: 24 files tracked by git under `src/` and `public/`; 400 applicable
  rules ran.

## Findings and dispositions

| # | Rule | Location | Disposition |
|---|---|---|---|
| 1 | `html.security.audit.missing-integrity.missing-integrity` | `public/index.html:11` (`https://challenges.cloudflare.com/turnstile/v0/api.js`) | **Pre-existing, accepted, out of scope for this feature.** The line is unchanged from the `main` baseline (shipped in PR #35, feature 001). Cloudflare Turnstile's `api.js` is an evergreen, continuously rotated script served from Cloudflare's own challenge origin; pinning a subresource-integrity hash to it breaks the widget on every upstream rotation. The comparable surface this feature *did* introduce — the LINE LIFF SDK in `public/line.html` — is pinned to a versioned URL **with** an `integrity` hash and a deliberate-update policy (docs/LINE-SETUP.md), which is exactly the mitigation this rule asks for where pinning is possible. |

No findings were introduced by the feature-003 diff: the only finding is on a
baseline line outside the feature's changed files.

## Follow-up security review

The 2026-08-13 working-tree review traced the changed authorization and
retention boundaries end to end. The push path now acquires its token before a
fresh synchronous claim and starts no fetch after unlink, disable, unfollow, or
parent-retention commits. Intent checks and finalization enforce the same
frozen parent boundary; activation receipts are deleted on disable; enablement
requires the installation's existing public protection predicate. The safe
backout is documented as a forward deploy that retains the Durable Object.
Targeted race, retention, lifecycle, HTTP, and browser regressions cover these
paths. No reportable attack path remains in the changed code.

## Manual LIFF SDK verification

On 2026-08-12, the pinned LIFF SDK at
`https://static.line-scdn.net/liff/edge/versions/2.29.2/sdk.js` was fetched
directly. The response was HTTP 200 and contained 125806 bytes. Its SHA-384
digest was
`sha384-lIqmzc+FKSRwPp/kKmwE+MwctaDWs6FhFaqE1B9Jksq6PPZj8588nVrMR03O3KpB`,
which exactly matches the `integrity` value in `public/line.html`.

A review claimed that LIFF SDK 2.29.2 was unpublished. The direct successful
fetch and matching digest refuted that claim.

## Result

- Gate policy: `--error` deliberately stops on every finding so each one must
  be dispositioned. The feature gate passes only with zero undispositioned or
  blocking findings introduced by the feature; an accepted baseline finding
  remains non-blocking only while its line and rationale remain unchanged.
- Blocking findings introduced by this feature: **0**
- Scan exit status: 1 (the single pre-existing finding above, disposition
  recorded; unchanged from baseline)
- The separately installed Semgrep Cloud GitHub Check also completed
  successfully with zero annotations on PR #37. It is an external PR check,
  not a duplicate step in `.github/workflows/ci.yml`.
