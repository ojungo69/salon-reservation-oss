# Salon Reservation OSS

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Fojungo69%2Fsalon-reservation-oss)

A small, self-hostable reservation application for up to four locations in one installation.
When several locations accept bookings, customers choose one before selecting compatible services,
viewing availability and submitting a pending request. They manage it with a browser-generated
management key. Owners configure locations and grant staff access to the schedules they operate.

The application uses one Worker, Workers Static Assets, Turnstile, Workers Rate Limiting, and
SQLite-backed Durable Objects. It has no runtime npm dependencies and starts in fictional demo
mode. The v0.2.0 release predates multi-location support; this source's four-location cap is a
product limit, not a Cloudflare Free-plan guarantee. Four locations with both optional adapters
active can exceed the Free request allowance before customer traffic; see
[Cloudflare operations](docs/CLOUDFLARE.md#free-plan-fit).

## What it includes

- Japanese, responsive customer, customer-status, setup, and operator pages
- A guarded three-stage booking journey with server-derived duration, price, eligibility, and
  availability recheck before submission
- Pending capacity holds, idempotent approve/reject/cancel, same-day reschedule, closures, and
  bounded day/week views
- Browser-generated 256-bit management keys; only SHA-256 digests are stored
- Owner-guided configuration with a demo/live latch, legal-copy readiness checks, and a secret-free
  installation receipt
- Up to four independently configured locations, with location-scoped staff grants and retained
  booking management at a paused location
- Optional schedule-only iCalendar and Google Calendar adapters, disabled by default and excluded
  from availability decisions
- Whole-day retention deletion, focused race/security checks, and allowlisted release auditing

## Deliberate limits

One `Asia/Tokyo` installation can hold `default` and up to three named locations. Each location
supports 1–8 capacity-one resources, 1–16 services, 1–4 services per request, same-day
rescheduling, and a bounded seven-day operator view. Cross-location/day moves, a global customer
identity and existing-system data migration are outside this feature. What lies beyond that — and
its current status — is recorded capability by capability in
[the parity matrices](docs/PARITY.md), not here.

Service and resource identifiers must stay stable while future dates already contain reservations.
Replacing or disabling one safely stops incompatible new bookings on those pinned dates; existing
bookings, cancellation, and accepted retry results remain available.

## Parity status

Production parity is determined by
[the production-parity target matrix](docs/PARITY.md#production-parity-target-matrix): a release
may claim it only when every target row is implemented or deliberately excluded. Current releases
are **core-feature parity, not production parity** — the
[implemented capability matrix](docs/PARITY.md#implemented-capability-matrix) records what exists
with evidence, and planned target rows remain open. The order in which the remaining rows land is
[the roadmap](docs/ROADMAP.md); the obligations any external integration must meet are
[the adapter extension contracts](docs/ADAPTER-CONTRACTS.md).

## Deploy and finish setup

Publishing the audited repository on GitHub is sufficient for the OSS release; deploying a live
instance is optional. The button below is for users who choose to run their own copy.

The official button uses this published repository's Wrangler configuration for an operator's own
copy. Deploying or configuring that copy is an operator decision; no source checkout grants access
to another installation or its data.

1. Deploy, then use the platform-provided `workers.dev` URL only to inspect the fictional demo.
   Demo/setup mode refuses booking mutations and must not receive real customer details.
2. In the deployment form, replace the sample `OWNER_TOKEN` with a high-entropy owner secret. If
   it was not set there, create it after deployment, for example:

   ```bash
   openssl rand -base64 32 | npx wrangler secret put OWNER_TOKEN
   ```

3. The deployment form can keep Cloudflare's published test `TURNSTILE_SECRET` only for inspecting
   the fictional demo. Use [Turnstile's guided setup](https://developers.cloudflare.com/turnstile/spin/)
   for the exact deployed hostname, put its public site key into the setup wizard, and replace the
   secret with `npx wrangler secret put TURNSTILE_SECRET`. Published test keys and secrets never
   satisfy live readiness.
4. Complete the wizard's four human gates: owner secret, Turnstile hostname/widget/secret, legal
   operator/contact/source details, and bounded capacity settings with final live confirmation.
5. A custom domain is optional for the demo and recommended before business-critical use. Add it
   through your account, update the Turnstile hostname, and recheck server-side validation before
   enabling live bookings.

[Cloudflare deployment and operations](docs/CLOUDFLARE.md) covers the exact boundary between the
demo URL and a custom domain, Workers Builds limitations, rollback, export, recovery, and deletion.
Review [privacy and retention](docs/PRIVACY.md), then replace every fictional operator notice before
accepting real bookings. Optional calendar modes are documented in
[calendar setup](docs/CALENDAR-SETUP.md). For another salon, start with the
[multi-location operator guide](docs/MULTI-LOCATION.md) before assigning staff or enabling adapters.

## Local verification

Requirements: Node.js 24 and npm 12.

```bash
npm ci
npm run check
```

To run the fictional sample:

```bash
cp .dev.vars.example .dev.vars
# Replace OWNER_TOKEN with output from: openssl rand -base64 32
npm run dev
```

Open the URL printed by Wrangler. Local Turnstile values are Cloudflare's published test keys;
production mode rejects them. The deployment dry-run and all tests remain local checks—they do not
create a Cloudflare resource.

## Architecture

```text
browser
├─ HTML/CSS/JS ─────────────── Workers Static Assets
└─ /api/*
   └─ Worker ──────────────── validation, Turnstile, rate limits, owner auth
      ├─ Settings DO ───────── location directory, grants, versioned setup/readiness
      ├─ Day DO per location/date ─ reservation transaction and retention alarm
      └─ Optional adapter DOs ──── post-commit LINE/calendar work per location
```

All requests for one location and JST date reach one day object. The pure reservation kernel stays
side-effect-free; adapters persist results and expose only safe projections.

## Public-release boundary

This is the published public repository with an ongoing Git history. Normal changes use pull
requests and `npm run release:audit`. The one-commit assembler and `release:audit:public` describe
the historical first-publication candidate only; do not run the assembler against this repository
or replace its history. See [the release procedure](docs/RELEASING.md).

Never commit real customer data, credentials, account identifiers, private source material or
deployment output.

## Security

Please report vulnerabilities privately as described in [SECURITY.md](SECURITY.md). Never put real
customer data, credentials, account IDs, or deployment output in an issue or fixture.

## Contributing and license

Contributions are welcome under [CONTRIBUTING.md](CONTRIBUTING.md) and the
[Code of Conduct](CODE_OF_CONDUCT.md). Released versions are recorded in
[CHANGELOG.md](CHANGELOG.md); the release procedure is [docs/RELEASING.md](docs/RELEASING.md).
The application is licensed
[AGPL-3.0-only](LICENSE); development-tool licenses are summarized in
[docs/THIRD_PARTY_LICENSES.md](docs/THIRD_PARTY_LICENSES.md).

Before redistributing a build, confirm that you have the right to publish every contribution and
that the configured source URL provides the corresponding AGPL source. This repository cannot
make that ownership determination for an operator.
