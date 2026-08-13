# Calendar adapter API and wire contracts

All admin routes use the existing owner bearer gate and rate limit. Admin mutations also require
the existing same-origin mutation gate. Every error body uses the existing `{ "ok": false,
"code": "..." }` shape. No response includes a secret, calendar ID, reservation ID, external event
ID, provider body, or authorization header.

## `GET /api/adapters/calendar/feed.ics`

Query is exact: `?token=<43-char-base64url>` and no other parameter is accepted.

### Feed success

```http
HTTP/1.1 200 OK
Content-Type: text/calendar; charset=utf-8
Cache-Control: private, no-store
X-Content-Type-Options: nosniff

BEGIN:VCALENDAR\r\n
VERSION:2.0\r\n
PRODID:-//Salon Reservation OSS//Calendar Feed//EN\r\n
CALSCALE:GREGORIAN\r\n
...
END:VCALENDAR\r\n
```

### Absent/auth failure

Unsupported method, inactive mode, missing/malformed/wrong token, unexpected query, or unavailable
authority all return the repository's identical 404 response. No `Allow`, `WWW-Authenticate`, or
redirect distinguishes the cause. Valid authenticated responses are never cached.

## `GET /api/admin/calendar/status`

### Success body

```json
{
  "ok": true,
  "modes": {
    "ics": { "configured": false, "active": false },
    "google": { "configured": false, "active": false }
  },
  "authority": null
}
```

When initialized, `authority` is an aggregate:

```json
{
  "state": "active",
  "generation": 1,
  "projectionCount": 12,
  "pendingCount": 0,
  "failedCount": 0,
  "oldestPendingAt": null,
  "lastReconciledAt": "2026-08-13T00:00:00.000Z",
  "reconcileCursor": null,
  "sweepCursor": "2026-08-13",
  "purgeCompletedAt": null,
  "counters": {},
  "ledger": []
}
```

Each ledger item is exactly `{ reason, operation, httpStatus, occurredAt }`.
If the authority RPC fails, `authority` is the literal string `"unavailable"`; the owner surface
still responds.

## `POST /api/admin/calendar/reconcile`

### Request

```json
{ "cursor": "2026-08-13" }
```

`cursor` may be omitted to start at current JST date. It must be a canonical date within the current
90-day booking horizon. No unknown key is accepted.

Each page replaces the selected days from committed reservation state. With valid Google
configuration, it also requeues retained failed or configuration-blocked deletes, including rows
whose schedule projection is already absent.

### Reconciliation success

```json
{
  "ok": true,
  "processedDates": 7,
  "projected": 8,
  "removed": 1,
  "nextCursor": "2026-08-20"
}
```

The final page returns `nextCursor: null`. Repeating a page is idempotent and may report zero
changes. Calendar configuration absence returns `409 CALENDAR_NOT_CONFIGURED`; calendar-authority
absence and bounded internal failure return `503 TEMPORARILY_UNAVAILABLE`; invalid input returns
`400 BAD_REQUEST`.

## ReservationDay ↔ CalendarAdapter RPC

### Day outbox

`drainOutbox({ consumer: "calendar", limit })` uses the released shape plus:

```json
{
  "type": "create",
  "endTime": "11:00",
  "reservationStatus": "pending"
}
```

Calendar requires these fields; LINE may receive null only on released pre-S2 rows and never
receives `create`. Ack/purge remain consumer-scoped.

### Safe projection

`calendarProjection(dayConfig)` returns:

```json
{
  "ok": true,
  "date": "2026-08-13",
  "purgeAt": 1800000000000,
  "watermark": { "generation": 1, "seq": 17 },
  "events": [
    {
      "reservationId": "00000000-0000-4000-8000-000000000001",
      "stampAt": "2026-08-13T00:00:00.000Z",
      "startTime": "10:00",
      "endTime": "11:00",
      "serviceLabel": "カット",
      "status": "pending"
    }
  ]
}
```

This internal response contains the reservation ID only to match authoritative rows, the
reservation creation timestamp only to keep `DTSTAMP` stable, and the current calendar outbox
generation/sequence as an ordering watermark. Completion/no-show rows retain `status: "approved"`;
schedule-removing states are absent. Worker maps the response directly into the calendar authority
and never returns it from calendar HTTP routes. The calendar authority advances the watermark for
both event delivery and replacement: a delayed event at or below it cannot rewrite a reconciled
day, and an older replacement cannot overwrite a newer event.

## Google fixed HTTP contract

Token endpoint is exactly `POST https://oauth2.googleapis.com/token` with form-encoded
`client_id`, `client_secret`, `refresh_token`, and `grant_type=refresh_token`.

Event endpoints are fixed under
`https://www.googleapis.com/calendar/v3/calendars/{encodedCalendarId}/events` with manual redirect
handling and `sendUpdates=none`. The complete event body contains only:

```json
{
  "id": "sr<sha256-hex>",
  "summary": "カット",
  "status": "tentative",
  "visibility": "private",
  "transparency": "opaque",
  "start": { "dateTime": "2026-08-13T01:00:00.000Z" },
  "end": { "dateTime": "2026-08-13T02:00:00.000Z" }
}
```

Update always omits `id`; insert always includes it. No attendees, reminders, description,
location, extended properties, or contact fields are sent. Response bodies are bounded and never
persisted.
