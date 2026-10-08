# Validate create recovery evidence

Use the repository's pinned Node and npm versions, then `npm ci --ignore-scripts`.

```sh
npx vitest run test/reservation-day.test.ts -t "recovers an identical"
npm run check
npm run test:browser
```

The focused command runs four cases: public/owner creation with receipt/final calendar sequence failure. Each case checks exact persisted rollback, free capacity, successful identical retry, and stable replay. All expected error responses are deliberate failure injection, not evidence of a product bug.

Read [ADR0002](../../docs/ADR-0002-CREATE-STORAGE-AUTHORITY.md) for the selected scope and public test mappings. These local checks prove neither live provider delivery nor production migration readiness.
