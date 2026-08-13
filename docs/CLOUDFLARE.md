# Cloudflare deployment and operations

This guide is for the eventual public v0.2 candidate. The current development workspace has no
public remote and must not be deployed from this document. Confirm the current official Cloudflare
documentation before an account, billing, domain, or production change; limits and platform
behavior can change.

## Deployment contract

The public README's [official Deploy to Cloudflare button](https://developers.cloudflare.com/workers/platform/deploy-buttons/)
must target the exact authorized public GitHub repository. It is a deployment action, not a grant of
authority to publish, configure an account, create secrets, or use personal data.

The candidate's Wrangler configuration defines the Worker, static assets, rate limiters, and its
SQLite Durable Object classes. Run `npm run build` first and inspect the resolved configuration.
The default deployment flow should not require a D1 database, a database console, a manual SQL
command, or a source edit. Confirm the resources Cloudflare actually reports as created; this
documentation does not promise a particular account state.

`CalendarAdapter` is an optional installation-singleton SQLite Durable Object. Its binding/export
is always present so forward upgrades and backouts preserve the namespace, but neither calendar
mode activates without a valid optional secret. `CALENDAR_FEED_TOKEN` and
`GOOGLE_CALENDAR_CREDENTIALS` deliberately do not join Wrangler's required-secret list; owner and
Turnstile remain the only deployment-required secrets. See [calendar setup](CALENDAR-SETUP.md).

The two rate-limit namespace IDs are project-specific rather than Cloudflare's sample values.
Cloudflare shares counters when another Worker in the same account deliberately reuses an ID, so
operators with an existing collision must assign two unused positive integers before deployment.

## Demo first, then live readiness

1. After a successful authorized deployment, use the assigned `workers.dev` URL, if one is
   available, only for the fictional demo. Demo/setup mode must refuse booking mutations and real
   customer details must not be entered.
2. Replace the deployment form's sample `OWNER_TOKEN` with a unique owner secret. If it was not set
   there, create it after deployment. Do not place it in `wrangler.jsonc`, the setup receipt, a
   browser URL, or source control:

   ```bash
   openssl rand -base64 32 | npx wrangler secret put OWNER_TOKEN
   ```

3. The deployment form may retain Cloudflare's published test secret while the installation is a
   fictional demo. Use [Turnstile Spin](https://developers.cloudflare.com/turnstile/spin/) to create
   a widget for the exact demo or custom-domain hostname. Put the public site key in the setup
   wizard and replace the test value with the real secret as a Worker secret:

   ```bash
   npx wrangler secret put TURNSTILE_SECRET
   ```

   Server-side [Siteverify](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)
   remains required. Published test keys or secrets, a missing secret, or a hostname mismatch keep
   public booking mutations closed.
4. In `/setup.html`, finish the owner, protection, legal identity/contact/source, and bounded
   capacity gates. The installation receipt is safe to retain as operational evidence, but never
   contains a secret or customer data.

The platform-provided URL is enough to inspect a fictional demo. A custom domain is optional for
setup and recommended before business-critical operation. After adding one in the deployer's
account, add that exact hostname to the Turnstile widget, validate a real Siteverify response, and
only then enable live bookings. Do not treat a successful DNS or Worker deployment as legal or
security readiness.

## Branch builds and previews

Workers Builds can upload non-production-branch versions without promoting them to the active
deployment ([configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)).
That does **not** create a usable Durable Object preview for this application: Cloudflare currently
does not generate Preview URLs for Workers that implement Durable Objects
([Preview URL limitation](https://developers.cloudflare.com/workers/versions-and-deployments/preview-urls/)).
Workers also do not natively provide different bindings for production and non-production Builds
([migration guidance](https://developers.cloudflare.com/workers/static-assets/migration-guides/migrate-from-pages/)).

Therefore use local target-runtime tests and `npm run build` for branch verification. If an
authorized external demo is needed, use fictional data and explicitly inspect its bindings and
hostname; do not assume a branch build is isolated from real state or use it for personal data.

## Free-plan fit

The intended installation is deliberately bounded: one location, 1–8 resources, 1–16 services,
1–4 selected services, 96 offered resource/start pairs, 96 creates, and 192 accepted mutations per
day. The per-day create and mutation budgets are cumulative: a cancellation, rejection, or expiry
puts the time slot back on sale but does not refund the day's budget, because the stored rows it
created remain until the retention purge. A day that exhausts its create budget says so on the
booking and operator screens instead of presenting as fully booked; a spent mutation budget
surfaces as an error on the refused action itself. The final candidate's performance report must calculate its request/write budget against the
then-current [Workers limits](https://developers.cloudflare.com/workers/platform/limits/),
[Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/),
[static-assets limits](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/),
and [Turnstile plan](https://developers.cloudflare.com/turnstile/plans/).

This is a small-installation target, not a quota reservation, throughput guarantee, regional
residency guarantee, or uptime SLA. Account-wide traffic and future platform changes can exhaust a
limit and stop bookings; monitor the account and reduce scope or choose an appropriate plan before
relying on the service.

When calendar integration is configured, a booking request obtains one short-lived calendar
descriptor and performs only a post-commit Durable Object poke; no Google request is on the booking
transaction. The calendar authority drains at most 32 day events per pull, sends at most eight
Google mutations per alarm, and sweeps at most 16 day partitions per alarm. An upsert's worst
convergence path is update, insert, then update, so one send alarm stays below 25 Calendar requests
plus at most one token exchange. Owner reconciliation reads at most seven days per request. Recheck
these bounds against the current Workers external/internal subrequest, CPU, connection, Durable
Object, and alarm limits before production use; the links above remain authoritative.

## Retention, export, recovery, rollback, and deletion

- **Application retention:** each day object is deleted as a whole after the configured retention
  period. It removes reservations, customer details, management-key digests, snapshots, closures,
  receipts, and its alarm. Customer cancellation is not an erasure request; it changes booking
  state until the day is purged.
- **Export:** the application does not claim to be a backup service or silently export data. If an
  operator needs an export for law, continuity, or a deletion request, define and test a separately
  authorized, access-controlled process before live use. Minimize the data, protect the export,
  record its retention, and never put it in source control, issues, or logs.
- **Recovery:** Durable Object SQLite has a platform PITR capability and limits
  ([reference](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#pitr-point-in-time-recovery-api)).
  It is not a substitute for an operator backup policy and may not cover the configured retention
  window. Recovery is a destructive, separately reviewed operation: freeze writes, identify the
  exact object/date, preserve the pre-recovery state, restore only with authorization, then verify
  and document the outcome.
- **Rollback:** list and inspect the version, then use Cloudflare's documented
  [Worker-code rollback](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/).
  A code rollback does not undo Durable Object writes, deletion, or a schema change. Keep rollback
  and storage-recovery decisions separate.
- **Calendar alarms and backout:** one `CalendarAdapter` alarm reconstructs Google retries, claim
  recovery, day sweep, disable purge, and re-arming from SQLite. Alarm delivery may repeat, so stable
  event IDs, accepted-event deduplication, desired-version claims, and idempotent delete outcomes
  are required. Back out only with a forward build that retains the class, binding, export, and
  schema until cleanup is disabled; a pre-calendar rollback cannot service its namespace.
- **Deletion:** deleting a Worker, domain route, Turnstile widget, or Durable Object namespace is
  external and potentially irreversible. Export what policy requires, resolve the exact account and
  resource, follow the current Cloudflare deletion guidance, and record what remains recoverable.

## Before accepting real bookings

Confirm the live readiness screen has no blocker, the public source URL serves the corresponding
AGPL source, the rendered privacy/terms/cancellation notices name the real operator, and the
configured retention/export/deletion process matches the operator's obligations. Then verify with
fictional data: availability, one idempotent request, its proof-only status/cancel path, owner
authentication, Turnstile rejection, narrow/keyboard UI, and log redaction.

See [PRIVACY.md](PRIVACY.md) for application data and browser retention. Do not print secrets,
customer details, management keys, or Cloudflare account identifiers in diagnostic output.
