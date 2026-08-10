# Security Policy

## Supported version

Security fixes are provided for the latest `0.2.x` release candidate. Until a tagged release
exists, use the newest commit on the public default branch.

## Reporting a vulnerability

Use the repository host's private security-advisory feature or the private contact method listed by
the maintainers. Do not open a public issue for a suspected vulnerability.

Include:

- affected commit or version;
- the smallest fictional reproduction;
- expected and observed impact;
- whether credentials or personal data may have been exposed; and
- any temporary mitigation already applied.

Do not include live owner tokens, Turnstile secrets, customer details, Cloudflare account IDs, or
production dumps. Maintainers should acknowledge a complete report promptly, coordinate disclosure,
and credit the reporter when requested. Response and release timing depends on severity and
maintainer availability; this volunteer project does not promise a fixed SLA.

## Operator response

If a deployment secret may be exposed, rotate it before sharing diagnostic output:

```bash
openssl rand -base64 32 | npx wrangler secret put OWNER_TOKEN
npx wrangler secret put TURNSTILE_SECRET
```

Review recent Worker versions and account activity, then redeploy a known-good commit. A Worker code
rollback does not undo Durable Object storage changes. See [docs/CLOUDFLARE.md](docs/CLOUDFLARE.md)
for recovery and rollback limits.

## Security model

- The Worker is the only HTTP trust boundary and derives every domain actor.
- Public creation requires server-side Turnstile verification and abuse limiting.
- Operator requests require one high-entropy bearer secret and uniform failure responses.
- Customer cancellation requires a 256-bit management key whose plaintext is never persisted.
- Same-day writes are serialized and state/detail/receipt writes are one SQLite transaction.
- Private values are excluded from application logs and public projections.
- Retention alarms delete a complete day's database; deletion is intentionally irreversible in the
  application.

Cloudflare account security, custom-domain TLS, source-code availability, privacy notices, and
backup policy remain the deployer's responsibility.
