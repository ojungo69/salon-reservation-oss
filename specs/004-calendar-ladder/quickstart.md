# Quickstart verification: Calendar ladder (S2)

No Cloudflare or Google account is needed. All Google endpoints are mocked by Workers-pool fixtures;
the feed is parsed from the real local Worker/DO response.

## Prerequisites

- Node.js 24
- npm 12
- clean fixture values only; do not put a real token or OAuth credential in the repository

```bash
npm ci
```

## Focused verification

```bash
npx vitest run test/calendar-adapter.test.ts test/reservation-day.test.ts test/worker.test.ts
npm run typecheck
npm run types:check
```

Expected evidence:

- a valid fixture capability returns parseable CRLF iCalendar; invalid/unconfigured returns the
  same 404 and increments only the redacted aggregate;
- create/approve/reschedule/terminal state converges on one feed UID and one opaque Google event ID;
- duplicate/dead handoff, lost Google response, 409, delete 404/410, 429/5xx retry, permanent 4xx,
  configuration removal, retry exhaustion, and reconciliation all have deterministic fixtures;
- no calendar payload contains fixture customer name, contact, management key, reservation UUID,
  calendar ID, refresh token, client secret, authorization header, or provider body;
- availability JSON is byte-identical with modes off/on, during provider outage, and after retry/
  reconciliation.

## Full repository gates

```bash
npm run check
npm run test:browser
git diff --check
```

`npm run check` includes all unit/Workers tests, TypeScript, generated-binding drift, Wrangler
deployment dry-run, npm audit, and the release allowlist/secret scan. The dry run creates no
Cloudflare resource.

## Manual local feed smoke (fictional only)

Generate a disposable local token, keep it outside shell history where practical, and put it in a
local `.dev.vars` file that is already ignored. Use only the repository's fictional owner and
Turnstile values. Start `npm run dev`, create a fictional reservation, and request:

```text
http://localhost:<port>/api/adapters/calendar/feed.ics?token=<local-token>
```

Confirm the calendar body contains only schedule facts. Delete `.dev.vars` when finished. This is
optional evidence; automated fixtures are authoritative.

## Security/review gates

1. Run the repository's rule-based security scan and record `security-scan.md`.
2. Run adversarial review over feed authentication, secret parsing, fixed provider URLs, response
   bounds, retry classification, claim races, diagnostics, and retention.
3. Run normal correctness review, then `ponytail-review` to delete any one-use abstraction,
   duplicate serializer/parser, unused configuration, or new dependency.
4. Run GitNexus `detect_changes` against `main` and inspect the final diff/allowlist.

## Deliberately not run

- `wrangler deploy`
- a temporary Cloudflare account
- a Google OAuth consent flow or live Calendar mutation
- inbound Calendar list/sync/watch/free-busy calls

A self-hosting operator may perform the optional live smoke in `docs/CALENDAR-SETUP.md` only after
deploying their own installation and provisioning their own target calendar/credentials.
