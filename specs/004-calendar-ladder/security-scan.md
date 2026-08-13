# Security scan record — feature 004 (S2 calendar ladder)

Date: 2026-08-13
Base revision: `3a9f72508ae075357da7c8b04a34cf7dc075c404`
Scan ID: `3a9f725_20260813T081430Z`
Tools: Semgrep 1.172.0 with pinned registry rules, Codex Security plugin 0.1.18, and repository
release/dependency checks

The review covered the complete working-tree diff, including the public Worker routes, both Durable
Object boundaries, optional secret parsing, fixed Google HTTP clients, browser/runtime fixtures,
release allowlisting, and operator/privacy documentation. No deployment, live Cloudflare account,
Google account, or provider network call was used.

## Threats and controls reviewed

- capability-feed guessing, response or timing oracles, and unauthenticated resource exhaustion;
- owner authorization, same-origin mutation checks, input/body/cursor bounds, and output redaction;
- credential parsing, storage/log exclusion, fixed HTTPS endpoints, manual redirects, bounded
  provider bodies, and access-token cache rotation;
- duplicate/lost responses, latest-desired claims, stale outcomes, retry exhaustion, configuration
  parking, and booking/provider isolation;
- projection/queue/ledger caps, parent retention boundaries, disable leases, residual disclosure,
  and unresolved external cleanup visibility;
- release manifest, named-secret allowlist, fictional fixtures, direct dependencies, and install
  scripts.

## Candidates and dispositions

| Candidate | Discovery result | Final disposition |
|---|---|---|
| `html.security.audit.missing-integrity.missing-integrity` at `public/index.html:11` | Semgrep flags Cloudflare Turnstile's evergreen `api.js` URL | **Pre-existing and accepted.** The line is unchanged from base. Turnstile rotates this script continuously, so a fixed SRI digest would break the widget; feature 004 adds no external browser script. |
| Generic URL helper obscured the fixed Google host from SAST (`CWE-918`) | Every caller used `googleEventUrl`, which fixes the HTTPS origin and percent-encodes calendar/event IDs, but the helper accepted a string | **Hardened.** `calendarRequest` now parses the target and requires the exact Google Calendar origin before `fetch`; redirects remain manual. The pinned GitLab SSRF rule reports zero findings. |
| Public reads could force serialized Calendar DO descriptor work (`CWE-770`) | `installationContext` originally acquired the optional descriptor for generic public reads; a stalled authority could still delay every day operation | **Fixed and suppressed.** Descriptor acquisition now occurs only around day operations, fails open after a 250 ms local deadline, `/api/config` performs zero calendar RPC, and public availability is rate-limited before calendar work. |
| Wrong feed tokens could force unthrottled authority writes (`CWE-770`) | The initial feed path reached the authority without a limiter and activated the descriptor before rejecting the token | **Fixed and suppressed.** The Worker applies `PUBLIC_RATE_LIMITER` before namespace access and preserves a uniform 404; the authority validates and constant-time compares the token before `descriptor()`. |
| Public privacy reads could force residual Calendar DO lookups (`CWE-770`) | With both local modes absent, every request queried `hasDisclosure()` | **Fixed and suppressed.** The residual lookup now passes through `PUBLIC_RATE_LIMITER`; a limited request performs no namespace access, and a limited or unavailable lookup conservatively renders bounded conditional disclosure so cleanup state cannot be hidden. |

Post-remediation source review and focused Workers/DO tests found no remaining reportable attack
path. Final reportable findings: **0**.

## Reproducible checks

```sh
semgrep scan --metrics=off --error --config p/default --config p/owasp-top-ten src/ public/
semgrep scan --metrics=off \
  --config https://gitlab.com/gitlab-org/security-products/sast-rules/-/raw/8a904a2ef98c8c0ef23c1368a6f4334a4e806f5a/rules/lgpl/javascript/ssrf/rule-node_ssrf.yml \
  src/calendar-adapter.ts
npx vitest run test/worker.test.ts test/calendar-adapter.test.ts \
  -t "keeps public config byte-identical|serves only the exact capability|rate-limits public availability|fails open when the optional calendar descriptor stalls|conservatively discloses residual calendar state when its lookup cannot run|orders events and exposes only an aggregate feed-auth|prunes expired local calendar state" \
  --reporter=verbose
npm run release:audit
npm audit --audit-level=low
rg -n "fetch\\(|authorization|CALENDAR_FEED_TOKEN|GOOGLE_CALENDAR_CREDENTIALS|console\\.|redirect" \
  src/calendar-adapter.ts src/worker.ts docs/CALENDAR-SETUP.md
```

Semgrep ran 400 rules over 25 tracked files and returned its expected `--error` exit 1 for the one
unchanged Turnstile finding dispositioned above; feature-004 blocking findings are zero. Results:
the pinned GitLab SSRF rule reported 0 findings; 7 focused security regressions passed; 77
allowlisted files passed the release audit; npm reported 0 vulnerabilities. Source inspection found
only the allowlisted Google OAuth and Calendar HTTPS origins, `redirect: "manual"`, bounded response
readers, and no calendar credential/body logging.

This committed file is the persistent, reproducible scan artifact; the Codex plugin's machine
artifacts under `/tmp/codex-security-scans/` are supplemental and intentionally not part of the
release. The only residual uncertainty is Cloudflare's distributed limiter behavior under live
multi-IP load; local integration proves the ordering and zero namespace access, while live load
testing would require an authorized deployment and is not necessary for this implementation gate.
