# Security scan record — feature 003 (S1 LINE adapter)

Rule-based static analysis gate (tasks.md T038), reproducible invocation.

- Tool: semgrep **1.172.0** (pinned; recorded by `semgrep --version` at scan time)
- Date: 2026-08-12
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

## Result

- Blocking findings introduced by this feature: **0**
- Scan exit status: 1 (the single pre-existing finding above, disposition
  recorded; unchanged from baseline)
