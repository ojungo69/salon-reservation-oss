# Contributing

Thank you for improving Salon Reservation OSS.

## Before changing code

1. Use Node.js 24 and npm 12.
2. Run `npm ci`.
3. Read the relevant source and tests end to end.
4. Keep fixtures fictional. Never copy customer data, credentials, account IDs, private runbooks,
   or deployment output into the repository.
5. Open a private security advisory instead of a public issue for security-sensitive reports.

## Development

```bash
npm run test:core
npm run test:worker
npm run typecheck
npm run build
npm run check
```

For non-trivial behavior, add the smallest test that fails for the intended assertion before the
implementation. Reuse the pure reservation kernel and native Worker/browser/SQLite features before
adding a dependency or abstraction.

## Pull requests

- Keep one user-visible or security-relevant change per pull request.
- Explain the affected trust boundary and any abuse, data-loss, race, rollback, or secret-handling
  impact.
- Update the API contract and operator documentation when behavior changes.
- Include keyboard, narrow-screen, dark-mode, and reduced-motion evidence for UI changes.
- Confirm `npm run check` succeeds from the exact commit.
- Do not include a deployment, remote configuration, generated secret, or real resource identifier.

By submitting a contribution, you agree that it is licensed under `AGPL-3.0-only` and that you
have the right to provide it under that license.
