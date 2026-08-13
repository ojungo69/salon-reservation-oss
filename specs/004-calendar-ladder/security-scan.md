# Security scan record — feature 004 (S2 calendar ladder)

Date: 2026-08-13
Base revision: `3a9f72508ae075357da7c8b04a34cf7dc075c404`
Scan ID: `3a9f725_20260813T081430Z`
Tool: Codex Security plugin 0.1.18 plus repository release/dependency checks

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
| Public reads could force serialized Calendar DO descriptor work (`CWE-770`) | `installationContext` originally acquired the optional descriptor for generic public reads | **Fixed and suppressed.** Descriptor acquisition now occurs only around day operations; `/api/config` performs zero calendar RPC, and public availability is rate-limited before calendar work. |
| Wrong feed tokens could force unthrottled authority writes (`CWE-770`) | The initial feed path reached the authority without a limiter and activated the descriptor before rejecting the token | **Fixed and suppressed.** The Worker applies `PUBLIC_RATE_LIMITER` before namespace access and preserves a uniform 404; the authority validates and constant-time compares the token before `descriptor()`. |

Post-remediation source review and focused Workers/DO tests found no remaining reportable attack
path. Final reportable findings: **0**.

## Reproducible checks

```sh
npx vitest run test/worker.test.ts test/calendar-adapter.test.ts \
  -t "keeps public config byte-identical|serves only the exact capability|rate-limits public availability|orders events and exposes only an aggregate feed-auth|prunes expired local calendar state" \
  --reporter=verbose
npm run release:audit
npm audit --audit-level=low
rg -n "fetch\\(|authorization|CALENDAR_FEED_TOKEN|GOOGLE_CALENDAR_CREDENTIALS|console\\.|redirect" \
  src/calendar-adapter.ts src/worker.ts docs/CALENDAR-SETUP.md
```

Results: 5 focused security regressions passed; 77 allowlisted files passed the release audit; npm
reported 0 vulnerabilities. Source inspection found only the fixed Google OAuth and Calendar HTTPS
origins, `redirect: "manual"`, bounded response readers, and no calendar credential/body logging.

Canonical scan artifacts and the deterministic readable report are under
`/tmp/codex-security-scans/srv-wt-calendar/3a9f725_20260813T081430Z/`. The only residual uncertainty is
Cloudflare's distributed limiter behavior under live multi-IP load; local integration proves the
ordering and zero namespace access, while live load testing would require an authorized deployment
and is not necessary for this implementation gate.
