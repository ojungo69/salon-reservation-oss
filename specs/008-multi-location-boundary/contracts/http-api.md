# HTTP contract — S4 locations

Status: accepted implementation target; existing endpoints remain delivered only as recorded in `docs/PARITY.md`.

## Selecting a location

- Location IDs: `default` or a lowercase slug matching `[a-z][a-z0-9-]{0,31}`; no trailing hyphen. Maximum four locations including default. IDs never change and locations cannot be deleted in S4.
- Location-sensitive requests use exactly one optional `location` query parameter. Absent means default; `location=default` is its explicit alias. Duplicate, empty and malformed values are 400. A well-formed unknown ID is 404; never fall back to default or the first location. Calendar feed failures remain uniform 404.
- The Worker may parse/remove this parameter once before existing strict query parsers, carrying the validated selection in request-local context. Never mutate shared environment state. Global routes reject `location`.
- Existing JSON request/response bodies remain unchanged, including default config, booking, status, cancel, setup, roster and receipt responses. Booking proof identity is `(location, date, reservationId, managementKey)`; location travels in the URL, not a new proof field.
- These routes are location-sensitive: `/api/config`, `/api/availability`, `/api/reservations`, all reservation status/cancel/LINE proof routes, `/api/adapters/line/link`, `/api/admin/{availability,schedule,reservations,closures,setup,setup/live,installation-receipt}`, their existing captured mutation routes, `/api/admin/line/*`, `/api/admin/calendar/*`, and `/api/adapters/calendar/feed.ics`.
- Preserve mutation Origin checks, size/rate limits, response redaction and no-store headers. Rate-limit bucket identity does not gain a location suffix. Named-location Turnstile verification binds location/date/command/token; default derivation bytes remain exact.

## New global projections and commands

| Method / path | Body | Success |
| --- | --- | --- |
| GET `/api/locations` | none | `{locations:[{id,label,bookable}]}` for every known location, including paused/demo |
| GET `/api/admin/locations` | none; staff or owner credential | `{role:"owner"|"staff",locations:[{id,label,bookable}]}` restricted to permitted locations |
| POST `/api/admin/locations` | `{commandId,locationId,locationName}`; owner only | 201 `{location:{id,label},replayed}`; new location starts demo, adapters absent/off |
| GET `/api/admin/staff/locations` | none; owner only | `{members:[{staffId,scopeVersion,locationIds}]}`; owner `locationIds:null`, staff array |
| PUT `/api/admin/staff/:staffId/locations` | `{expectedScopeVersion,locationIds}`; owner only | `{staffId,scopeVersion,locationIds}` |

`bookable` means current live mode and existing effective readiness pass for this request hostname, not that any specific slot is available. Directory labels come from current settings. Public directory contains no personal data, settings, staff data or provider identifiers. Stable order is default then named IDs ascending.

Existing POST `/api/admin/staff` additionally accepts optional `locationIds` for `role:"staff"`; omitted preserves legacy default-only behavior. Validate/create staff and explicit grants atomically. Its old response shape stays unchanged. Owner-role creation must omit locationIds. Existing roster read/credential/deactivation/reactivation routes remain global and unchanged; use the new scope projection for extra fields. A zero-element staff grant is valid and grants no location. Grants contain distinct known IDs, maximum four; absent legacy grant means `["default"]`, never all.

Global owners and the deployment secret can manage every location. Staff can read their permitted directory even if they have no grants; their location-private routes then refuse. Invalid credential, insufficient role and wrong-location permission give the existing identical 401. Check permission before body parsing or day access. An authenticated owner requesting an unknown location gets 404. Settings/receipt/adapter administration stay owner-only. Scope mutations recheck current owner authority in the same root transaction. Existing S3 already-authorized reservation requests may finish; subsequent requests observe revocation. No commit-time cross-object revocation claim.

Create replay is stable for identical commandId and payload; altered reuse is 409 IDEMPOTENCY_CONFLICT. Duplicate slug is 409 LOCATION_EXISTS; fifth location is 409 LOCATION_LIMIT_REACHED. Scope CAS mismatch is 409 VERSION_CONFLICT, refreshed through the scope projection. Existing booking/setup errors retain their current status codes. Missing/invalid new payloads are 400; unavailable storage/configuration is 503 and never interpreted as an empty directory, default selection or adapter disable.

## Named calendar controls

New owner-only location-sensitive routes:

- PUT `/api/admin/calendar/settings?location=<id>`: `{expectedVersion,googleEnabled,calendarId,feedEnabled}`. Additional locations only. `calendarId` is null before initial binding or a validated target identifier; once bound it is immutable in S4, including while disabled. Distinct locations cannot bind the same target. Named targets require actual calendar IDs and reject the `primary` alias. If the shared default target is `primary`, named Google enable is refused until the operator separately supplies its actual ID; default behavior and named ICS remain compatible. A later shared-target conflict makes named outbound work unavailable/retryable, never disabled or purged. Existing default target remains env-owned. Version begins at zero and increments once per accepted change. Enabling the feed requires an issued digest; enabling Google requires valid shared credentials. A later missing/invalid required shared credential is unavailable/retry, never an off transition.
- POST `/api/admin/calendar/feed-token?location=<id>`: `{expectedVersion}`. Named location only; returns `{version,token}` once, stores only a digest. A lost response is recovered by an explicit rotation after rereading status, never by storing plaintext. Token issuance alone does not enable a feed.
- Existing GET calendar status adds no fields for default. Named status retains `{ok,modes,authority}` and adds `settings:{version,googleEnabled,calendarId,feedEnabled,feedTokenPresent}`. PUT settings returns `{settings:<same sanitized projection>}`. Never return a digest or provider credentials. Existing reconcile remains location-scoped and seven days per page.

Keep the currently configured Google OAuth client/secret/refresh-token set, override only the named target calendarId. No OAuth onboarding/callback/state route is added. Default env feed token and Google behavior remain exact. A default feed token cannot authorize a named feed. Feed URL permits only `token` plus optional canonical location, each once; malformed/unknown/wrong-scope/disabled all return the existing uniform 404.

## LINE realm and assets

The registered `/api/adapters/line/webhook` stays global, rejects location, verifies one raw signature with the current installation secret, then delivers to the bounded trusted list of active location actors. Success means all targets acknowledged; partial retries deduplicate within each actor. Default may be off while a named actor remains active. One shared messaging/login/LIFF realm is supported; active/deactivating lifecycle rows and in-flight activating operation identifiers cannot disagree on identifiers. New locations require owner enable and explicit booking-by-booking customer consent.

Booking/legal/setup/operator links preserve location. Named LIFF return is fixed same-origin `/line.html?location=<id>`; default stays exact `/line.html`. No nonce, proof or token enters these URLs. Scoped `/line-link.mjs` and `/line-liff.mjs` requests use the same query selection; keep lifecycle gating and CSP. Preserve the existing refusal of unsupported `liff.state`; do not modify SDK parameters before initialization resolves.
