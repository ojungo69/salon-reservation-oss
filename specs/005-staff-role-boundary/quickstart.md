# Phase 1 Quickstart: validating the staff and role boundary

How to prove this slice works, and where each success criterion is checked. Every scenario below is
runnable against the repository's existing suites — the slice adds cases, not a new way of testing.

## Prerequisites

```bash
npm install
./node_modules/.bin/playwright install chromium    # only for the browser scenarios
```

`wrangler dev` is not needed for the automated scenarios; the Workers pool and Playwright's own
web server handle their own runtimes.

## The full gate

```bash
npm run check        # core + worker suites, typecheck, generated types, dry-run build,
                     # dependency audit, release audit
npm run test:browser # Chromium, the viewports the constitution names
```

Both must be green before review, and CI runs both — `check` as its own step and `test:browser` at
`.github/workflows/ci.yml:86`. A failure in either is a slice failure, not a flake to retry.

> Do not pipe either command into `tail` or `head`. The pipeline reports the *pager's* exit status,
> so a failing run reads as green.

---

## Scenario 1 — a staff member works without the deployment secret (SC-004, US1)

**Suite**: `test:worker`

1. Provision a fixture installation and complete setup with `OWNER_TOKEN`.
2. `POST /api/admin/staff` with `{ "displayName": "受付 A", "role": "staff" }`; keep the returned
   credential and discard the owner token from the test's request helper.
3. Assert `200` on each of the six day-to-day routes in
   [contracts/authorization.md](./contracts/authorization.md).
4. Assert `401` — with `www-authenticate: Bearer` and the identical body a garbage credential
   produces — on each of the nine administration routes and all five roster routes.

**Passes when** every row of the authorization contract has exactly one assertion and the role check
record is exhaustive (a missing route is a type error, not a silent allow).

---

## Scenario 2 — revocation lands on the next request (SC-001, SC-002, US2)

**Suite**: `test:worker`

1. Create two staff members, A and B.
2. Confirm both are accepted on `GET /api/admin/schedule`.
3. `POST /api/admin/staff/:idA/deactivate`.
4. **Immediately** re-issue A's request: expect `401`. Re-issue B's: expect `200`.
5. Reset the Durable Object and repeat step 4 — the refusal must survive a restart, because it is
   stored state and not memory.

**Passes when** no delay, retry, or sleep appears anywhere in the scenario. The absence of a wait is
the assertion: FR-010 forbids any cache that would need one.

> Give each test its own Durable Object name and fake the whole `Date`, not one method. A promise
> that never settles pins a DO across `reset()` and the next test inherits it.

---

## Scenario 3 — the installation can always be administered (SC-006, US3)

**Suite**: `test:worker`

1. Build a roster whose only `owner`-role member is then deactivated — and assert the deactivation
   is **refused** with `409 LAST_OWNER`.
2. Write a deliberately corrupt `__staff_roster` document directly into storage.
3. Confirm the `OWNER_TOKEN` holder is still accepted on every one of the fifteen gated paths, and
   can repair the roster from there.

**Passes when** step 3 needs no recovery procedure — the break-glass path is reached by control flow
before the roster is consulted, so a corrupt roster is invisible to it.

---

## Scenario 4 — attribution resolves for every operator change (SC-005, US4)

**Suite**: `test:worker`

1. As staff member A: approve a booking. As B: reject another. With `OWNER_TOKEN`: create a closure.
2. Read the attribution rows for the day and assert three rows, one per command id, with
   `actor_id = A`, `actor_id = B`, and `actor_kind = 'break_glass'` respectively.
3. Deactivate A and re-read: A's row is unchanged and still resolves to A's identifier.
4. Replay one of the commands — same command id, same fingerprint — and assert the receipt replays,
   no second attribution row is written, and the original actor is unchanged.

**Passes when** step 4 needs no special handling in the production code. Replay short-circuits at the
command gate before any write, which is the whole reason attribution sits inside that transaction.

---

## Scenario 5 — the customer path did not move (SC-003, US5)

**Suites**: `test:core`, `test:worker`, `test:browser`

1. Run all three suites unchanged against an installation with **no roster**.
2. Run the worker suite again with a populated roster and assert the public routes answer
   identically — same status, same body, same headers.

**Passes when** no existing test needed editing to accommodate this slice. A test that had to change
is a behaviour change that FR-026 does not permit; investigate rather than update it.

---

## Scenario 6 — the roster screen (Constitution III)

**Suite**: `test:browser`

1. Sign in as owner on the operator screen, add a staff member, and confirm the credential is shown
   once and is gone after a reload.
2. Deactivate that member and confirm the screen says what deactivation does and does not remove.
3. Run the accessibility and horizontal-overflow assertions the other specs use, at the documented
   viewports.

Two constraints, both learned in this repository:

- **New cases go at the end of the file.** The browser suite runs `workers: 1` with
  `fullyParallel: false` and shares one installation; the bootstrap test in `install.spec.ts` must
  stay first.
- **Check the test against unfixed code once.** A browser assertion that passes before the feature
  exists is not coverage.

---

## Scenario 7 — the dry run writes nothing (FR-020)

**Suite**: `test:worker`

`POST /api/admin/staff` with `dryRun: true` on an installation with no roster: assert the response
reports `wouldBeFirstMember: true`, that there is no `credential` key at all, and that
`GET /api/admin/staff` still answers `{ "members": [] }` afterwards.

There is no `rosterValid: true` in the body. Reaching a `200` *is* the validation — the same parser
the write would run has already accepted the document — and a field that can only ever hold one
value tells a reader nothing. A refused input is a `400`.

**No screen calls this.** The dry run is an operator-invoked API affordance for rehearsing a
migration against a real installation, which is what FR-020 asks for; the roster panel creates
members directly. If a later slice gives it a client, this note is what should change.

---

## Scenario 8 — the privacy documents answer the question (SC-007)

**Manual, and the only one that is.** A reviewer reads `docs/PRIVACY.md` and the served privacy page
and answers, without opening any source file:

- what a staff record contains, and what it deliberately does not (no contact address, no link to a
  customer record);
- how the credential is protected (digest only, never stored in plaintext, shown once);
- how long a record is kept (the life of the installation; deactivation is not deletion) and how
  long attribution is kept (the life of the day partition it sits in);
- what leaving removes, and — plainly — what it does not: the calendar feed token, the LINE channel
  secret, and the Google calendar credentials are installation-level secrets that an offboarded
  person may still hold a copy of, and deactivation does not reach them. (FR-012)

**Passes when** the answer needs no inference. If the reviewer has to reason about it, the document
is not finished.

---

## Security battery

Beyond the suites, because this slice is in security scope:

```bash
semgrep scan --config=p/security-audit
```

plus a security-focused review iterated to a clean verdict and an adversarial review of the design
itself. The specification's gates section is the authority on the list; this is the reminder that it
runs before the correctness and over-implementation reviews conclude, not after.
