# Multi-location operations

This guide applies to a release containing the S4 multi-location boundary. One installation can
hold the existing `default` location and up to three named locations. Each location has its own
catalog, hours, booking days, retention and optional adapter state. The original default object
names, API bodies, browser keys and queued LINE v1 messages remain unchanged; opening this release
does not convert existing records. See [ADR0003](ADR-0003-MULTI-LOCATION-BOUNDARY.md) for the storage
decision, [browser compatibility](../specs/008-multi-location-boundary/contracts/browser-state.md)
for the exact default keys, and [the HTTP contract](../specs/008-multi-location-boundary/contracts/http-api.md)
for complete request and error shapes.

## Add and prepare a location

1. Sign in as an owner on `/setup.html`. Add a location with a permanent ID such as `annex` and an
   editable display name. IDs use lowercase letters, digits and hyphens, start with a letter, end
   without a hyphen and are at most 32 characters. The fifth location is refused. S4 cannot rename,
   delete or reuse an ID.
2. Select the new location and configure its services, resources, hours, legal notices and
   protection settings. It starts in demo with LINE and calendar modes off; adding it does not
   change `default` or make the new location accept bookings. Complete that location's readiness
   gates and explicitly enable live mode when it is ready. Pausing one location stops fresh
   bookings there while retained booking management and other locations continue.
3. Give staff only the locations they operate. Owner-role staff and the deployment credential
   retain installation-wide authority. Existing staff without an explicit grant remain
   `default`-only; an explicit empty grant gives access to none. A revoked grant takes effect on
   the next request. A reservation request authorized earlier may finish under the existing S3
   boundary.

The owner screen handles location creation, selection, per-location setup and staff grants. A
named location's calendar controls are described below. The public booking flow offers only
currently bookable locations before service selection; a known but paused location can still be
used to manage an existing booking. An unknown explicit location never falls back to `default`.

## HTTP selection and owner commands

Location-sensitive routes take one optional `?location=<id>` query parameter. Omission and
`location=default` select the existing location; `location=annex` selects that named location.
This applies to config, availability, reservation/status/cancel/LINE proof, location-private admin
setup/schedule/reservation/closure, LINE owner, calendar owner and feed routes. Keep the selected
location in booking, legal, return and operator links. Existing request and response JSON for
`default` is unchanged; a booking proof is still date, reservation ID and management key, with
location carried by its URL and browser namespace. Global routes below reject `location`.

| Method and global route | Who can call it | Purpose |
| --- | --- | --- |
| `GET /api/locations` | Public | List all known locations as `{id,label,bookable}`, including paused and demo locations. `bookable` is readiness, not a free slot. |
| `GET /api/admin/locations` | Active staff or owner | List only permitted locations and the caller's role. Zero-grant staff receive an empty list. |
| `POST /api/admin/locations` | Owner | Create a named demo location with `{commandId,locationId,locationName}`; identical command replay is safe. |
| `GET /api/admin/staff/locations` | Owner | Read each staff member's `staffId`, `scopeVersion` and `locationIds`; owner scope is `null`. |
| `PUT /api/admin/staff/:staffId/locations` | Owner | Replace a staff grant with `{expectedScopeVersion,locationIds}`. Read again after a version conflict. |

For example, an owner can create one fictional location with a fresh command ID:

```http
POST /api/admin/locations
Authorization: Bearer <owner-credential>
Origin: https://<installation-host>
Content-Type: application/json

{"commandId":"<fresh-uuid>","locationId":"annex","locationName":"Annex"}
```

The response is `201 {"location":{"id":"annex","label":"Annex"},"replayed":false}`.
To grant a staff member only that location, read the scope projection, then send
`PUT /api/admin/staff/<staff-id>/locations` with
`{"expectedScopeVersion":0,"locationIds":["annex"]}` using the version actually returned.
When creating a new staff member, optional `locationIds` on the existing `POST /api/admin/staff`
sets the first grants atomically; omitting it gives staff `default` only. Owners omit it.

Duplicate, empty or malformed `location` is `400`; a well-formed unknown location is `404` for an
authorized owner. A wrong-location staff request is refused with the existing uniform `401`
before private day data or the mutation body is read. A duplicate ID, fifth location, changed
command replay or stale staff scope is `409`. Configuration/storage failure is `503`, never an
empty directory or implicit default. Mutations keep their existing Origin, size and rate checks.

## Optional calendar per location

The original `default` calendar uses the existing environment-managed feed token and Google
credentials. A named location starts with neither mode enabled. Its setup calendar card can issue a
feed token and enable the feed independently. For Google synchronization, first bind a distinct
target calendar ID writable with the installation's existing credential set. It becomes immutable
after its first binding, even while disabled; another location cannot bind that target. Use the
actual calendar ID supplied by Google, never the `primary` alias. If the shared default configuration
uses `primary`, named Google synchronization stays unavailable until the operator separately sets
the actual default ID; accountless booking and named feeds remain usable. No extra Google account
or OAuth flow is added. See [calendar setup](CALENDAR-SETUP.md) for the shared credentials.

Named owner API routes are location-sensitive:

| Method and route for `annex` | Request / result |
| --- | --- |
| `GET /api/admin/calendar/status?location=annex` | Redacted status plus `settings:{version,googleEnabled,calendarId,feedEnabled,feedTokenPresent}`. |
| `PUT /api/admin/calendar/settings?location=annex` | `{expectedVersion,googleEnabled,calendarId,feedEnabled}`; returns the sanitized settings. |
| `POST /api/admin/calendar/feed-token?location=annex` | `{expectedVersion}`; returns `{version,token}` **once** and stores only a digest. |
| `POST /api/admin/calendar/reconcile?location=annex` | Existing bounded seven-day cursor body and result, scoped to this location. |

Issue a named feed token before enabling its feed. Copy the one-time token or feed URL directly
into the intended calendar client; do not put either in logs, tickets, browser storage or
screenshots. A lost token response cannot be read back: get the current version from status and
rotate explicitly. The named URL is
`https://<installation-host>/api/adapters/calendar/feed.ics?location=annex&token=<token>`;
the old default token never opens it. Wrong-scope, disabled and invalid feeds all return the same
`404`. Disabling a named mode changes only that location's setting and cleanup. A missing shared
Google credential is an unavailable/retry condition, not an automatic disable or purge.

## Optional LINE per location

One installation uses one LINE messaging/login/LIFF realm and one global signed webhook. Configure
the provider secret and identifiers as in [LINE setup](LINE-SETUP.md), then use the existing owner
`/api/admin/line/{status,settings,enable,disable}` routes with `?location=annex` for a named
location. Use its reported `lifecycleVersion` in each command. The registered
`/api/adapters/line/webhook` has **no** location query; the server verifies its raw signature and
fans out only to active or still-draining location actors. Shared identifiers must agree across
active, deactivating and activating locations.

Each customer opts in separately for each booking. A link at one location does not grant consent
or send notifications for another. Named messages include that location's validated public label;
the original default message bytes stay v1. Disabling `annex` drains its own links and deliveries,
without disabling another location. Removing the shared provider secret degrades all active LINE
locations; restore it or disable locations deliberately. Provider failures never change booking
capacity.

## Limits, recovery and cost

- Each location retains the existing per-day limits: up to eight resources, 16 services, 96
  accepted creates and 192 accepted mutations. The four-location cap bounds directory and webhook
  fanout, not account-wide traffic or a free-plan guarantee.
- At the retained 60-second adapter sweep, a local empty-actor scenario observed 24,138 alarm and
  day RPC requests per adapter/day. LINE and calendar active at all four locations extrapolate
  **193,104 Durable Object requests/day** before customer, operator or provider work. Cloudflare
  currently lists **100,000/day** for the Free plan. The scenario is not live billing or a
  worst-case workload; check current
  [pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) and monitor the
  account before enabling integrations. See
  [ADR0003](ADR-0003-MULTI-LOCATION-BOUNDARY.md#bounds-evidence-and-cost) and
  [Cloudflare operations](CLOUDFLARE.md#free-plan-fit).
- The application remains one Worker with zero runtime npm dependencies. Retained bookings and
  unresolved mutation retries stay with their original location. S4 does not move bookings
  between locations or days, create global customer identities, or import existing-system data.
  Migration-purpose reads, exports, imports, restores and cutovers require the separate concrete
  confirmation in [AGENTS.md](../AGENTS.md#existing-system-data-migration); S5 remains unstarted.
- A backout must retain the new location readers, actor names, class bindings and alarms while
  named data can remain. Rolling back Worker code does not undo storage writes. See
  [releasing](RELEASING.md#backing-out-a-multi-location-release).
