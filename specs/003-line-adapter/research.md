# Research: Optional LINE identity and notifications (S1)

**Date**: 2026-08-12 · **Feature**: 003-line-adapter · **Stage**: S1 of [the roadmap](../../docs/ROADMAP.md)

The roadmap records an in-stage prerequisite for S1: *"mechanism research (push-retry mechanism,
current LIFF and token-verification endpoints) before the design commits"*. This document records
that research. Every mechanism fact below was verified against the current official documentation
on 2026-08-12; nothing is carried from memory.

## R1 — Push-retry substrate: Durable Object outbox, not Cloudflare Queues

**Decision**: The shared post-commit event delivery foundation is a transactional outbox in the
`ReservationDay` Durable Object plus a single new delivery Durable Object (`AdapterDelivery`) that
drains it with bounded-backoff retries scheduled through its own alarm. Cloudflare Queues is not
used in this stage.

**Facts established** (Cloudflare documentation, 2026-08-12):

- Cloudflare Queues **is** available on the Workers Free plan since 2026-02-04: 10,000 operations
  per day across reads, writes, and deletes; all features included; maximum message retention on
  the free tier is **24 hours** (14 days on paid).
  Source: <https://developers.cloudflare.com/changelog/post/2026-02-04-queues-free-plan/>
- Queues can be auto-provisioned: the Deploy-button flow provisions Queues bindings, and current
  wrangler versions auto-provision queues on `wrangler deploy` (beta).
  Sources: <https://developers.cloudflare.com/workers/platform/deploy-buttons/> (Automatic resource
  provisioning), <https://developers.cloudflare.com/workers/wrangler/configuration/> (Automatic
  provisioning).

So Queues is *viable* on this project's Free-plan constraint, and the earlier assumption that queue
provisioning would break the deploy-button story is **wrong** — it would not. The decision rests on
what Queues would and would not remove:

- **The transactional outbox must exist either way.** At-least-once delivery from a committed
  reservation change requires recording the event atomically with the commit — a row written inside
  the same `ReservationDay` storage transaction. A queue producer call after commit can be lost
  (the invocation can die between commit and send), which would be a silent drop, and the
  notifications contract forbids silent drops. With the outbox and its re-drain in place, Queues
  would add a second delivery hop (outbox → queue → consumer) without deleting any code.
- **Terminal-failure visibility lives in a Durable Object regardless.** The contract requires
  terminally failed notifications to be parked and visible with reason and time. That parking
  store is Durable Object state either way; Queues' own retry/DLQ machinery would still end by
  writing there.
- **The free tier's 24-hour retention cap** would silently bound any Queues-based retry window;
  the outbox has no platform-imposed retention.
- **Test determinism and repo idiom**: the repository already race-tests SQLite-backed Durable
  Object storage and exercises alarms; a queue consumer adds a new binding and a new test surface.
- **Infrastructure trace**: a provisioned queue exists per installation even when the adapter is
  unconfigured. The invisibility invariant is written for the customer/booking surface, so this is
  not a violation — but zero new infrastructure is still the smaller footprint.

Queues remains the recorded upgrade path if per-installation notification volume ever outgrows a
single delivery Durable Object (it is orders of magnitude away for a single salon: the free tier's
10,000 operations/day alone corresponds to thousands of notifications daily).

## R2 — LIFF versus LINE Mini App (branding check recorded in issue #1's decision)

**Decision**: The adapter targets the **LIFF framework**, which is the technical surface of both
channel types. Operator documentation recommends creating the app as a **LINE Mini App** (LINE's
current guidance) and records the LINE Login channel as the equally supported alternative. The
code is identical for both; only the operator's channel-creation walkthrough differs.

**Facts established** (LINE Developers documentation, 2026-08-12):

- LINE announced (news, 2025-02-12) that LIFF and the LINE Mini App **will be integrated into a
  single brand**, LIFF being integrated *into* the Mini App, and recommends creating new LIFF apps
  as LINE Mini Apps. Source: <https://developers.line.biz/en/docs/liff/getting-started/>
  (recommendation callout), <https://developers.line.biz/en/docs/line-mini-app/discover/introduction/>
- A LINE Mini App **is** a web application running on LIFF ("LINEミニアプリは、LIFF上で実行される
  ウェブアプリです"); `liff.init()` with a LIFF ID is the bootstrap in both cases. Mini App LIFF
  URLs use `https://miniapp.line.me/{liffId}` (since 2023-12-13).
- LIFF apps can be added to exactly two channel types: **LINE Login** channels and **LINE Mini
  App** channels. Source: <https://developers.line.biz/en/docs/liff/getting-started/>
- Newly created Mini Apps start **unverified**: accessible to anyone, with restricted features
  (for example no home-screen shortcut or LINE-search discovery; the header shows the endpoint
  domain). Verified status requires an LY Corporation review. The LINE MINI App Policy's
  Permitted Customers clause (revised 2026-02-19) allows **individuals in Japan to operate
  unverified Mini Apps**; **verified** Mini Apps are limited to organizations with a corporate
  number or individual business owners — relevant to self-hosted operators, recorded in the
  operator walkthrough. Since 2025-10-01 Mini Apps also run in external browsers. No brand-
  integration date is announced, and LIFF apps created before or after it remain usable. Sources:
  <https://developers.line.biz/en/docs/line-mini-app/discover/introduction/>,
  <https://developers.line.biz/en/docs/line-mini-app/develop/develop-overview/>,
  <https://terms2.line.me/LINE_MINI_App?lang=en>, <https://developers.line.biz/en/news/2025/>
- Differences that matter to this feature are configuration-level only (screen size fixed to
  `Full`, one LIFF app per Mini App channel, module mode unavailable). The login and ID-token
  mechanics are the same.

## R3 — Server-side verification and push mechanics

All facts from the current LINE Developers reference (2026-08-12).

**ID token verification** (identity seam's "verify every assertion server-side"):

- Endpoint: `POST https://api.line.me/oauth2/v2.1/verify` (form-encoded), parameters `id_token`
  (required), `client_id` = the channel ID the token must be issued for (required), `nonce`
  (optional, expected value), `user_id` (optional, expected value). Note the method trap: **GET**
  on the same path is a different API (access-token validity check); ID-token verification is
  **POST** only.
- On success returns the validated payload: `iss` (`https://access.line.me`), `sub` (user ID),
  `aud`, `exp`, `iat`, optionally `name`/`picture`/`email`. On failure returns
  `{"error": "invalid_request", "error_description": "..."}` (expired, wrong audience, bad
  signature). The LINE Platform performs the signature/expiry/audience checks server-side.
- LIFF flow: the client obtains the token via `liff.getIDToken()` and sends it to the server; the
  server never trusts client-supplied profile data.
  Source: <https://developers.line.biz/en/docs/liff/using-user-profile/>,
  <https://developers.line.biz/en/reference/line-login/#verify-id-token>
- A captured ID token can be **replayed** to the server within its `exp` window; the endpoint
  proves authenticity, not freshness. The spec therefore states the replay posture explicitly
  (single-valued link state; re-linking the same subject is a no-op; a different subject over an
  existing link is a surfaced conflict, never a silent overwrite).

**Webhook signature verification** (Messaging API):

- The signature is `base64(HMAC-SHA256(channel secret, raw request body))` compared against the
  `x-line-signature` request header. The body must be verified **exactly as received** — any
  parsing, escaping, or re-serialization before verification is indistinguishable from tampering.
  LINE does not disclose webhook source IP addresses; signature verification is the only
  authentication. Source: <https://developers.line.biz/en/docs/messaging-api/verify-webhook-signature/>
- Webhook event objects carry `webhookEventId` (ULID, unique per event) and
  `deliveryContext.isRedelivery`. LINE's guidance: detect duplicates by `webhookEventId`, order by
  `timestamp`. Relevant event types for this stage: `follow` (friend add or unblock) and
  `unfollow` (block). Source: <https://developers.line.biz/en/reference/messaging-api/> (webhook
  event objects), <https://developers.line.biz/en/docs/messaging-api/receiving-messages/>

**Channel access tokens and push**:

- Four token types exist; the **stateless channel access token** (`POST
  https://api.line.me/oauth2/v3/token`, form-encoded `grant_type=client_credentials`,
  `client_id={channel ID}`, `client_secret={channel secret}`) is valid for 15 minutes, unlimited
  issuance, non-revocable, and requires storing no additional long-lived credential. Response:
  `{token_type: "Bearer", access_token, expires_in: 900}`.
  Source: <https://developers.line.biz/en/docs/basics/channel-access-token/>, Messaging API
  reference (issue stateless channel access token).
- Push endpoint: `POST https://api.line.me/v2/bot/message/push` with `Authorization: Bearer
  {channel access token}`.
- **Retry idempotency**: the `X-Line-Retry-Key` header (a UUID chosen by the sender) makes push
  retries safe — the request executes at most once; an already-accepted key returns `409`. The key
  must be sent **on the first attempt** (a request without it can never be retried safely), is
  valid for 24 hours, and retried requests must be byte-identical. Retry **only** on `5xx` or
  timeout; never on `2xx`, `409`, or other `4xx`. LINE recommends exponential backoff.
  Source: <https://developers.line.biz/en/docs/messaging-api/retrying-api-request/>

**Message quota (operator-side cost boundary)**:

- Push, multicast, narrowcast, and broadcast messages count against the LINE Official Account
  plan's monthly free message quota; **Reply API messages do not**. The default (Communication)
  plan is ¥0 with **200 messages/month and no overage purchase** — delivery stops at the cap;
  paid plans start at ¥5,000/month for 5,000 messages.
  Source: <https://www.lycbiz.com/jp/service/line-official-account/plan>
- Every notification this stage sends is server-initiated and therefore a push (reply tokens only
  exist briefly after inbound webhook events, which reservation transitions are not). The design
  is unaffected, but the **operator documentation must state the quota** (a salon with ~100
  linked reservations a month sits near the free cap), and quota exhaustion surfaces naturally
  through the existing terminal-failure visibility: a push refused for quota reasons parks as a
  terminally failed delivery with its reason, so the operator sees it in diagnostics without a
  dedicated quota widget.

**Channel model** (minimal-secret configuration):

- Login surface: a LIFF app on a LINE Login or Mini App channel — needs the **LIFF ID** (public,
  embedded in the page) and that channel's **channel ID** (the `client_id` for ID-token
  verification; not a secret).
- Messaging surface: a **Messaging API channel** — its **channel secret** serves both webhook
  signature verification and stateless-token minting, and is the **single new secret** the adapter
  requires. No long-lived channel access token is stored.
- The two channels live under one provider so the `sub`/`userId` space is shared.

## R4 — Scope boundary confirmed against the roadmap and contracts

- S1 delivers the identity seam and the notifications seam of
  [the adapter contracts](../../docs/ADAPTER-CONTRACTS.md), plus the shared post-commit event
  delivery foundation those contracts stage with the first adapter (the calendar and audit seams
  reuse it in later stages).
- Completion criteria come verbatim from [the roadmap's S1 row](../../docs/ROADMAP.md): issue #1's
  end-to-end criteria — login verification, invalid webhook signature, duplicate webhook delivery,
  notification retry — fixture-tested with **zero live LINE dependency in CI** (no channel secrets
  in the public repository; live-channel verification is an operator-side step), plus the security
  review battery.
- The webhook endpoint, token verification, secret handling, and queueing logic are security
  scope under the constitution's quality gates.

## R5 — Pre-implementation platform verification (tasks.md T001, 2026-08-12)

All facts from the current Cloudflare documentation, verified after the plan gate and before any
code, because the deployment mechanics and the rollback story depend on them.

- **This repository manages Durable Object classes with the declarative `exports` field** (in
  `wrangler.jsonc`), which is mutually exclusive with the legacy `migrations` array — once a
  Worker deploys with `exports`, subsequent deploys must continue using it. Adding
  `AdapterDelivery` therefore means a live entry `{"type": "durable-object", "storage":
  "sqlite"}` plus the binding, not a `new_sqlite_classes` migration (the plan's earlier wording
  predated this check). Cloudflare provisions the namespace on first deploy; re-deploys with the
  same entry make no namespace changes. Free-plan namespaces must be SQLite-backed, which this
  is. Source: <https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/>,
  <https://developers.cloudflare.com/changelog/post/2026-06-30-declarative-do-class-exports/>
- **The first deployment creates the complete authority schema.** `AdapterDelivery` is new in
  this feature and no namespace for it has ever been deployed, so there is no released older
  schema to upgrade. `CREATE TABLE IF NOT EXISTS` does not add columns to an existing table;
  any column change after this first release must ship an explicit additive migration.
- **Backout is a forward deployment.** Namespace deletion happens only through an explicit
  `deleted` tombstone (guarded at deploy time: the class must be absent from code and no other
  Worker may bind it), but a pre-adapter deployment also lacks the required class export.
  Therefore `wrangler rollback` must not select it. A compatible backout uses `wrangler deploy`
  with the desired earlier application behavior while retaining the `AdapterDelivery` class,
  binding, export, and live `exports` entry. Never deploy a `deleted` tombstone for
  `AdapterDelivery` as part of a backout. `wrangler versions upload` cannot apply lifecycle
  changes (it fails fast when `exports` entries change); the first deploy and any lifecycle
  change use `wrangler deploy`. Same sources.
- **Alarm retry semantics**: the `alarm()` handler has guaranteed at-least-once execution and is
  retried on uncaught exception with exponential backoff starting at 2-second delays for up to
  6 retries (worst ≈ 126 s, within `ALARM_RETRY_BACKOFF_ALLOWANCE_S` = 300 s). The handler
  receives `{retryCount, isRetry}`. Behavior of a pending alarm whose class is no longer
  exported is **not explicitly documented**; the design does not depend on it. `disabled`
  purges personal/event rows, but bounded ledger or webhook-dedup TTL alarms may remain. The
  compatible forward backout retains `AdapterDelivery` until those stores drain; only then does
  the tested T009 invariant guarantee no pending alarm.
  Source: <https://developers.cloudflare.com/durable-objects/api/base/>
