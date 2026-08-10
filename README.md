# Salon Reservation OSS

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Fojungo69%2Fsalon-reservation-oss)

A small, self-hostable reservation application for one location. Customers can choose compatible
services, view availability, submit a pending request, and manage it with a browser-generated
management key. One operator credential controls setup and the bounded schedule.

The v0.2 design targets Cloudflare's Free plan using one Worker, Workers Static Assets, Turnstile,
Workers Rate Limiting, and SQLite-backed Durable Objects. It has no runtime npm dependencies and
starts in fictional demo mode. Free-plan quotas and availability are platform limits, not an
application uptime guarantee.

## What it includes

- Japanese, responsive customer, customer-status, setup, and operator pages
- A guarded three-stage booking journey with server-derived duration, price, eligibility, and
  availability recheck before submission
- Pending capacity holds, idempotent approve/reject/cancel, same-day reschedule, closures, and
  bounded day/week views
- Browser-generated 256-bit management keys; only SHA-256 digests are stored
- Owner-guided configuration with a demo/live latch, legal-copy readiness checks, and a secret-free
  installation receipt
- Whole-day retention deletion, focused race/security checks, and allowlisted release auditing

## Deliberate limits

One `Asia/Tokyo` location, 1–8 capacity-one resources, 1–16 services, 1–4 services per request,
same-day rescheduling, and a bounded seven-day operator view are in scope. Payments, notifications,
external identity, calendar sync, customer CRM/medical notes, multiple locations, staff roles, and
cross-day moves are intentionally absent. See [the parity matrix](docs/PARITY.md).

Service and resource identifiers must stay stable while future dates already contain reservations.
Replacing or disabling one safely stops incompatible new bookings on those pinned dates; existing
bookings, cancellation, and accepted retry results remain available.

## Deploy and finish setup

Publishing the audited repository on GitHub is sufficient for the OSS release; deploying a live
instance is optional. The button below is for users who choose to run their own copy.

The official button is the primary path once the separately audited public candidate exists. It
uses that candidate's Wrangler configuration; it does not authorize publication, account changes,
or a real-data deployment from this private workspace.

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
accepting real bookings.

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
      ├─ Settings DO ───────── versioned public setup and demo/live readiness
      └─ Day DO ────────────── reservation transaction, snapshots, retention alarm
```

All requests for one JST date reach one day object. The pure reservation kernel stays
side-effect-free; adapters persist results and expose only safe projections.

## Public-release boundary

This development workspace is not a publication artifact. The original publisher must keep its
private-name denylist outside both repositories. The isolated assembler requires it, snapshots it
privately, creates the one root commit, and uses that snapshot for content and commit-metadata
scans:

```bash
./scripts/assemble-public-release.sh /new/release/tree /absolute/private-denylist
cd /new/release/tree
npm ci
npm run check
npm run release:audit:public -- --denylist /absolute/private-denylist
```

Never commit the raw denylist or a hash derived from its terms. Forks without private-source
context can run the generic public-history audit without this project-specific input.

## Security

Please report vulnerabilities privately as described in [SECURITY.md](SECURITY.md). Never put real
customer data, credentials, account IDs, or deployment output in an issue or fixture.

## Contributing and license

Contributions are welcome under [CONTRIBUTING.md](CONTRIBUTING.md) and the
[Code of Conduct](CODE_OF_CONDUCT.md). The application is licensed
[AGPL-3.0-only](LICENSE); development-tool licenses are summarized in
[docs/THIRD_PARTY_LICENSES.md](docs/THIRD_PARTY_LICENSES.md).

Before redistributing a build, confirm that you have the right to publish every contribution and
that the configured source URL provides the corresponding AGPL source. This repository cannot
make that ownership determination for an operator.
