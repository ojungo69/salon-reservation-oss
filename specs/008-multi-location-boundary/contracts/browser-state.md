# Browser state and design contract

## Initial selection

Fetch the public directory before choosing a new location's storage/API scope. An explicit `location` is authoritative; malformed/unknown selection shows a safe error without loading another location's draft or posting a proof. With no explicit selection, a valid legacy default pending-create record takes precedence so it can recover even when paused. Otherwise select bookable default, then the first bookable named location, then default when none are accepting. Write the named choice into the URL before scoped storage/config/API use. API requests without location still mean default; this browser preference does not change the server contract.

The booking selector lists only bookable locations. It may be hidden for a sole bookable named location, but that location remains explicit in URL/API/storage. Default-only installation keeps the existing presentation. No accepting location gives the existing safe non-accepting state. A direct known-but-paused link retains its chosen scope and allows retained-booking management; no fresh create is offered.

After operator sign-in, call the global authenticated directory before any private schedule. With implicit selection choose permitted default, otherwise first permitted location; zero grants gives a safe empty state. An explicit forbidden location is an error with a manual allowed-location choice, never an automatic private-data fallback. Clear old private details immediately on scope/auth changes. Capture request generation, credential and location for every asynchronous result; stale schedule/attention/detail/proxy/closure responses cannot repaint the new scope.

## Existing storage without conversion

Preserve exact default keys and exact v1 record shapes:

- `salon-reservation:journey-draft:v1`
- `salon-reservation:pending-customer-create:v1`
- `salon-reservation:pending-owner-create:v1`
- `salon-reservation:owned-bookings:v1`
- `salon-reservation:setup-step:v1`
- `salon-reservation:line-link-intent:v1`

For a named location append `:location:<id>` to each key. Do not rewrite/backfill default records. Freeze a pending command's selected location in its surrounding controller/storage namespace; switching cannot attach it to another location. Disable switching while a mutation is unresolved, or require explicit recovery of its original scope before another submit. Authentication stays in page memory only.

The remembered-booking page discovers proof keys only for known directory locations, including paused/demo. Each displayed record carries its owning location in controller state, label and API URL. Never submit an unrecognized location's proof against current/default. Optional LINE enhancement is selected per record location using its own public capability and scoped module import, never the default capability or reservationId alone. Existing per-location retention and 16-record bounds remain. Aggregate view is bounded to at most four known keys; page/status-check at most 16 records at once, retain access to subsequent pages, honor rate-limit retry and never delete records just because a lookup failed. Status/cancel request bodies remain their existing date/key/command shapes.

Legal, setup-to-closures, source fallback, booking-return and operator navigation preserve the selected query. Do not append location to external source URLs, fragment-only links or static shared CSS. Consent comes from the selected configuration. LINE module imports and fixed same-origin login return preserve location; retain existing default intent storage/redirect bytes and unsupported `liff.state` refusal.

## Owner controls and failure states

Reuse native select/checkbox/fieldset controls and the existing setup cards. Provide location creation/list/selection, location-specific settings/live controls, staff scope checkboxes and scope conflict refresh. Keep existing roster responses and use the separate scope projection. Scoped staff creation supplies locationIds atomically; do not show an issued credential as complete before its intended grants commit.

For named locations add a small calendar setup card: target calendar ID, explanation that it cannot change after binding in this feature, Google/feed enable controls, and feed-token issuance/rotation with one-time display or copyable feed URL. Show status/version and configuration failures without exposing digests/credentials. Default keeps its existing environment-managed controls; this work does not update provider accounts. Tokens stay out of local/session storage, logs and screenshots; fictional tests may inspect them in memory.

Show current location before services/date and in summary/result/proof cards; preserve the operator attention/list layout. Clear dependent selections on a genuine location change; do not discard uncertain submissions. Announce loading/empty/denied/conflict/success through existing live regions. Keyboard order follows location then dependent fields; native targets remain at least 44px, visible focus and no horizontal overflow at 320/360/768/1440. Preserve dark/forced-color/reduced-motion semantics.

Actual selected references and exact prompts are recorded in `../design/selection.md` and `../design/prompts.json`. Generated frames/text are visual targets, not executable evidence. Compare real browser screenshots and the complete flows against them.
