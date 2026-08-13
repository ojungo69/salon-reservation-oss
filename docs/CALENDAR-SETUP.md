# Optional calendar setup

Calendar integration is disabled by default. It never participates in availability decisions and
adds no customer-facing control. Operators can enable either mode independently:

- an authenticated iCalendar subscription by setting `CALENDAR_FEED_TOKEN`;
- outbound Google Calendar synchronization by setting `GOOGLE_CALENDAR_CREDENTIALS`.

No Cloudflare or Google account is needed for development or CI. The repository's Durable Object,
iCalendar, OAuth, retry, and browser checks run locally with fictional fixtures and mocked fixed
endpoints. Do not create a temporary account merely to run the test suite.

## Authenticated iCalendar subscription

Generate a dedicated 32-byte base64url capability. Do not reuse `OWNER_TOKEN`:

```bash
openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n'
```

The result must be exactly 43 base64url characters. Enter it interactively so it is not committed
to source:

```bash
npx wrangler secret put CALENDAR_FEED_TOKEN
```

After an authorized deployment, subscribe a calendar client to:

```text
https://<installation-host>/api/adapters/calendar/feed.ics?token=<43-character-token>
```

The URL is a read capability for reservation start/end, service label, tentative/confirmed state,
stable opaque event UID, and event creation timestamp. Keep it out of source control, tickets,
messages, screenshots, referrers, access analytics, and command output. To rotate it, put a newly
generated value under the same secret name. The old URL returns the same 404 as every inactive or
invalid request immediately after the new binding is active. Calendar clients may cache prior
event bytes even though the feed response is `private, no-store`; remove the old subscription where
necessary. The feed uses the existing public rate limiter before calendar storage work, and a
limited request keeps the same uniform 404.

## Google outbound synchronization

This adapter writes events but never lists, imports, watches, or uses free/busy data. Provision one
Google OAuth refresh token outside the application:

1. In an operator-controlled Google Cloud project, enable the Google Calendar API and configure the
   OAuth consent screen for the intended operator account.
2. Create an OAuth client. Request only
   `https://www.googleapis.com/auth/calendar.events`, request offline access, and complete consent
   as the account that owns or can write the target calendar. If the consent configuration is in
   testing mode, include that account as a permitted test user and review Google's current refresh
   token restrictions before relying on it.
3. Record the returned client ID, client secret, refresh token, and target calendar ID in this exact
   JSON shape, with no additional keys:

   ```json
   {
     "clientId": "fixture.apps.googleusercontent.com",
     "clientSecret": "fixture-only",
     "refreshToken": "fixture-only",
     "calendarId": "fixture@example.invalid"
   }
   ```

4. Enter the real JSON interactively; never put it in `.dev.vars.example`, a command argument,
   source control, a support issue, or logs:

   ```bash
   npx wrangler secret put GOOGLE_CALENDAR_CREDENTIALS
   ```

The Worker exchanges the refresh token only at Google's fixed token endpoint, keeps the access
token in isolate memory, and writes only start/end, service label, tentative/confirmed state, and a
non-reversible stable event ID. Redirects and caller-supplied provider URLs are not followed.

### Credential and target-calendar changes

- Rotating the OAuth client secret or refresh token for the same target calendar is safe. Apply the
  new exact JSON, then run reconciliation; current projections are re-queued with stable event IDs.
- Changing `calendarId` does **not** migrate or delete events from the old calendar. While the old
  account still has access, first inspect and manually remove the dedicated old-calendar events (or
  delete a calendar used solely for this installation), then change the secret and reconcile. If
  the old grant is already gone, cleanup of that external calendar is an operator action; the
  application cannot safely target it with new credentials.
- Removing or invalidating the Google secret stops new Google calls. Current reservations remain
  authoritative and booking remains available. Restore a valid secret and reconcile to recover.

## Status and bounded reconciliation

Both routes require the existing owner bearer token. Reconciliation also requires a same-origin
request and uses the owner rate limit:

```text
GET  /api/admin/calendar/status
POST /api/admin/calendar/reconcile
```

The status response contains mode booleans, aggregate counts, cursors, and redacted ledger reasons.
It never contains either calendar secret, calendar ID, reservation ID, event ID, provider body, or
Authorization header. Reconciliation accepts `{}` or `{"cursor":"YYYY-MM-DD"}`, reads at most seven
authoritative day partitions, applies lazy pending expiry, and returns the next cursor. Repeat until
`nextCursor` is `null`; repeating a page is idempotent. If bounded provider-mutation capacity is
temporarily full, the response stops before the deferred date and returns that same date as
`nextCursor`; retry it after pending work clears.

Run reconciliation after first activation, restored credentials, a suspected handoff gap, or a
target-calendar change. With a valid Google configuration, reconciliation also requeues retained
failed or configuration-blocked deletes whose local projection is already absent. Normal recovery
also sweeps the fixed retention/horizon window from the calendar authority's alarm.

## Disable and recovery boundary

Removing both optional secrets immediately disables feed access, stops new provider calls, and
starts local cleanup. Existing descriptor leases are allowed to expire, then the fixed sweep purges
calendar outbox rows, projections, mutations, and bounded diagnostics. The privacy disclosure stays
visible until cleanup reaches `disabled`. Removing secrets cannot guarantee deletion of copies a
calendar client cached or events left in a Google calendar whose old grant is no longer available.

Do not delete the `CalendarAdapter` Durable Object class or namespace during this process. A
compatible backout is a forward deployment that retains its class, export, binding, and alarm logic
until status shows disabled and retained work is drained.

## Optional live smoke

Automated local fixtures are the required development evidence. After an operator has separately
authorized and completed their own deployment, they may use one fictional booking to verify the
feed or one dedicated test calendar, inspect the exact schedule-only payload, cancel the booking,
and confirm removal. Delete the fictional provider event and rotate disposable credentials when the
smoke test ends. A live smoke is optional and is not permission to deploy from a development task.
