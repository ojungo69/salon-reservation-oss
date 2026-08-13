# LINE adapter setup (operator walkthrough)

The LINE adapter is optional. An installation that never follows this page
keeps serving exactly the same pages, responses, and storage as before — no
LINE code path runs, and no LINE trace appears anywhere a customer can see.
Everything below is operator-side; the repository, its fixtures, and its CI
never contain or contact a real LINE channel.

All identifiers on this page are placeholders. Never commit a real channel
ID, channel secret, or LIFF ID to a public repository, issue, or log.

## What you create on the LINE side

1. Create a provider in the [LINE Developers console](https://developers.line.biz/).
   Create both channels below inside this same provider. LINE user IDs are
   provider-scoped, and channels cannot be moved to a different provider later;
   channels under different providers cannot share a usable notification subject.
2. Create a **LINE Mini App** channel for the customer-facing login surface.
   LINE has announced that LIFF and the Mini App are being integrated into a
   single brand and recommends new apps be created as Mini Apps; a classic
   **LINE Login** channel with a LIFF app works identically with this
   adapter if your account cannot create Mini Apps. Note the **channel ID**
   (a number such as `1234567890`) and the **LIFF ID** (such as
   `1234567890-abcdefgh`).
   - New Mini Apps start **unverified**: anyone can open them, but some
     platform features stay restricted and verification is limited to
     corporate accounts. This adapter needs none of the restricted features.
   - Set the LIFF/Mini App **endpoint URL** to `https://<your-host>/line.html`.
3. Create a **Messaging API** channel (this is the sender of push messages).
   Note its **channel ID** and its **channel secret**.
   - Set the **webhook URL** to `https://<your-host>/api/adapters/line/webhook`
     and enable webhooks. Disable auto-reply features you do not want.

## The one secret

The Messaging API **channel secret** is the only secret the Worker holds. It
never goes in `wrangler.jsonc`, `.dev.vars.example`, or the repository:

```sh
wrangler secret put LINE_MESSAGING_CHANNEL_SECRET
```

The binding is deliberately absent from the required-secrets list: without
it the adapter simply stays invisible. If the secret is removed while the
adapter is active, customer pages fall back to a cleanup-only mode (existing
links can still be viewed and removed; nothing is sent) and the setup status
shows the degraded state until you restore it.

## Enabling

Identifiers are supplied through the owner API (the setup UI does not manage
LINE yet). With your owner token:

```sh
# 1. Check the current state (phase, lifecycleVersion, delivery diagnostics).
curl -sS https://<your-host>/api/admin/line/status \
  -H "authorization: Bearer $OWNER_TOKEN"

# 2. Store the identifiers (allowed while disabled; repeatable).
curl -sS https://<your-host>/api/admin/line/settings \
  -H "authorization: Bearer $OWNER_TOKEN" \
  -H "content-type: application/json" \
  -H "origin: https://<your-host>" \
  -d '{
    "commandId": "'"$(uuidgen)"'",
    "expectedLifecycleVersion": 0,
    "identifiers": {
      "liffId": "1234567890-abcdefgh",
      "loginChannelId": "1234567890",
      "messagingChannelId": "9876543210"
    }
  }'

# 3. Enable (requires the secret to be present; identifiers are authoritative
#    here and immutable while active).
curl -sS https://<your-host>/api/admin/line/enable \
  -H "authorization: Bearer $OWNER_TOKEN" \
  -H "content-type: application/json" \
  -H "origin: https://<your-host>" \
  -d '{
    "commandId": "'"$(uuidgen)"'",
    "expectedLifecycleVersion": 1,
    "identifiers": {
      "liffId": "1234567890-abcdefgh",
      "loginChannelId": "1234567890",
      "messagingChannelId": "9876543210"
    }
  }'
```

`expectedLifecycleVersion` is the optimistic-concurrency check — read it from
the status response. Repeating a command with the same `commandId` replays
the recorded outcome; changing identifiers requires disable → enable.

Enabling reuses the installation's live-readiness protection and fails with
`ORIGIN_UNCONFIGURED` until `allowedHostname` and its matching Turnstile setup
are ready. Notification messages contain no management URL.

## ⚠️ Regional message quotas and pricing

Messaging API plans and limits vary by country or region. For a LINE Official
Account billed in **Japan**, the Communication Plan currently includes at most
**200 messages per month and does not allow additional-message purchases —
delivery stops at the cap**. Do not apply those numbers to another region or
plan; check the [current pricing for your region](https://developers.line.biz/en/docs/messaging-api/pricing/)
before relying on notifications.
LINE returns HTTP 429 for the monthly cap and temporary rate limits alike.
LINE's retry policy excludes 4xx responses, so the adapter records that attempt
as terminally `rejected`, with HTTP 429 attached to its diagnostics-ledger
entry. A Japan-billed salon with a few hundred bookings a month will exceed the
Communication Plan allowance. Treat LINE as a convenience channel rather than
the only record: every state change remains visible on the customer's
booking-management page regardless of message delivery.

## Verifying a live channel (operator-side only)

CI proves the protocol against fixtures; a real channel is verified by hand:

1. Open `https://<your-host>/` in a browser, book a test reservation, and
   choose "LINE で通知を受け取る" on the booking-management page.
2. Complete the LINE login. The page confirms the link.
3. Approve the reservation from the owner page. A LINE message with the
   date, service label, and state should arrive.
4. Check `/api/admin/line/status`: the delivery counters should show one
   delivered message and no terminal failures.
5. Send a nonsense request to the webhook URL and confirm it is rejected
   (the signature-failure counter increments; nothing else changes).

## Rotation and disabling

- **Secret rotation**: issue a new channel secret in the LINE console, run
  `wrangler secret put LINE_MESSAGING_CHANNEL_SECRET` with the new value,
  then remove the old one on the LINE side. In-flight deliveries retry with
  the new credentials automatically; during any gap the adapter degrades to
  the visible cleanup mode instead of failing silently.
- **Disabling**: `POST /api/admin/line/disable` (same command shape as
  above). The adapter shows `deactivating` while it cancels queued work and
  purges every link, subject, and pending delivery — including the per-day
  outbox rows — then settles at `disabled`. Remove the secret binding after
  the status shows `disabled`, not before. Re-enabling later mints a fresh
  generation; old deliveries can never resurface.

## Updating the pinned LIFF SDK

`public/line.html` pins the LIFF SDK to a specific versioned URL with
subresource integrity. Update it deliberately by pull request: change the
version in the URL, recompute the `integrity` hash from the fetched file,
and re-run the browser suite. Never float on the edge channel.
