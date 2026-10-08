# Local acceptance guide

Use fictional fixtures and the pinned Node/npm toolchain from CONTRIBUTING. Do not point tests at a live installation or call provider accounts. Run commands with `GIT_TRACE2_EVENT=0` when the local Git wrapper requires trace suppression.

1. Run focused config/location and Worker tests after the config and adapter branches are integrated. Prove a default legacy fixture reads byte-identically, create A/B/C alongside default, reject a fifth location, and preserve exact retry/receipt/alarm state on failure.
2. Exercise two simultaneous fifty-way same-slot races at different locations with colliding local resource/service/command IDs. Expect one winner each; cancel/closure/settings/purge at A leaves B unchanged.
3. Create staff scoped only to B, authenticate its global directory, operate B, then probe every A private route. Expect uniform refusal. Remove B, restart root and expect next-request refusal. Wrong-location customer proofs reveal nothing.
4. Enable two locations' LINE/calendar adapters using fixture clients only. Exercise nonce isolation, shared webhook partial retry, identical notification retries, feed-token separation, immutable Google targets, lifecycle alarm restart/earliest due and isolated disable/retention. Failure to read named configuration must not purge it.
5. After backend integration run `npm run test:browser`: create/configure locations through setup, book/remember/recover/cancel with each record's own scope, verify named-only-live boot, unknown links, staff-only-B sign-in, late-response isolation and named calendar owner controls. Compare actual screenshots with `design/` at 320/360/768/1440; perform keyboard/theme checks.
6. Run `npm run check` and the complete browser suite on the combined change. Obtain correctness, over-implementation, static security and adversarial reviews; verify public release audit and current-head gates. Record exact commands/results and unresolved limits in the verification report before checking implementation tasks.

Expected exclusions: no D1/alternate backend, no live calls, no import/export/data migration/restore/cutover, no global customer identity, no cross-day/location move. Timing optimization is deferred beyond S4; preserve current 60-second behavior.
