# Contract: the roster HTTP surface

Five endpoints, all `owner`-only, all behind `operatorGate` and — for the mutations — behind
`requireMutationOrigin`. Shapes follow the conventions already in `src/worker.ts`: exact-key body
validation, `errorResponse(400, "BAD_REQUEST")` for anything unparsable, no query string permitted.

Error envelope is the existing one throughout, produced by `errorResponse` and not hand-built:
`{ "ok": false, "error": { "code": "<CODE>", "message": "…" } }` (`src/worker.ts:120-129`).

---

## `GET /api/admin/staff`

Reads the roster. Never returns a credential or a digest.

**200**

```jsonc
{
  "members": [
    {
      "id": "6f1c2e40-9a3b-4d17-8c5e-2b7d90a4f8e1",
      "displayName": "受付 A",
      "role": "owner",
      "active": true,
      "createdAt": "2026-08-16T02:00:00.000Z",
      "deactivatedAt": null
    }
  ]
}
```

An installation with no roster answers `{ "members": [] }` — not `404`. The absence of a roster is a
normal state, and the operator screen renders the same empty panel either way. (FR-017)

---

## `POST /api/admin/staff`

Creates a member and issues their credential.

**Request** — exact keys, no others accepted:

```jsonc
{
  "displayName": "受付 A",     // 1–80 chars
  "role": "staff",             // "owner" | "staff"
  "dryRun": false              // optional, default false
}
```

**201**

```jsonc
{
  "member": { "id": "…", "displayName": "受付 A", "role": "staff", "active": true,
              "createdAt": "…", "deactivatedAt": null },
  "credential": "sB3n…Qk"      // 43 chars, base64url. Returned here and nowhere else, ever.
}
```

**200 with `dryRun: true`** — validates the input and the exact roster document that would be
stored, reports the outcome, writes nothing:

```jsonc
{
  "dryRun": true,
  "wouldBeFirstMember": true
}
```

The request is not echoed back, and there is no `valid: true` field: a dry run that got this far
*is* the validation, and a field that can only ever hold one value tells a reader nothing. An input
the parser refuses answers `400` instead.

No credential is generated on a dry run — there is nothing to hand out, and generating one would
mean a credential existed that was never stored. (FR-020)

**Failures**

| Status | Code | When |
|---|---|---|
| 400 | `BAD_REQUEST` | Unknown key, bad `displayName` length, `role` not one of the two |
| 401 | `UNAUTHORIZED` | Not `owner` — including a valid `staff` credential (FR-005) |
| 409 | `VERSION_CONFLICT` | The roster changed under this command (R7) |
| 409 | `ROSTER_FULL` | The roster already holds 200 records, stopped ones included |
| 503 | `TEMPORARILY_UNAVAILABLE` | `OWNER_TOKEN` absent or placeholder |

---

## `POST /api/admin/staff/:id/rotate`

Issues a new credential for one member; the previous one stops working on its next request.

**Request**: `{}` — no body fields. The member is the path parameter.

**200**

```jsonc
{ "member": { … }, "credential": "…" }
```

**Failures**: as above, plus `404 NOT_FOUND_OR_UNAUTHORIZED` when no such member exists **or** the
member is inactive — one code for both, so the endpoint does not confirm which identifiers are real.

Rotation affects exactly one member's digest. No other credential is touched. (FR-008)

---

## `POST /api/admin/staff/:id/deactivate`

**Request**: `{}`

**200**: `{ "member": { …, "active": false, "deactivatedAt": "…" } }`

**Failures**: as above, plus

| Status | Code | When |
|---|---|---|
| 409 | `LAST_OWNER` | The roster would be left with no active `owner` (FR-011) |

`LAST_OWNER` is the one refusal in this surface that is deliberately *specific*. It is not a
credential-validity disclosure — the caller is already an authenticated owner — and an operator who
cannot tell why the button did nothing will reach for `OWNER_TOKEN` and start editing storage, which
is the outcome the whole break-glass design exists to make unnecessary.

The digest is cleared in the same write, so the credential is dead from the next request. (FR-010)

---

## `POST /api/admin/staff/:id/reactivate`

**Request**: `{}`

**200**: `{ "member": { …, "active": true }, "credential": "…" }`

Returns a **new** credential. The old one was destroyed at deactivation and cannot be restored — the
digest was cleared, which is what made revocation real rather than a flag. The operator screen says
so before the button is pressed.

---

## Staff sign-in

There is no sign-in endpoint. A staff credential is a bearer token presented on the operator routes,
exactly as `OWNER_TOKEN` is today: `Authorization: Bearer <credential>`. The operator screen stores
it the same way it stores the owner token, and "signing in" is the client verifying the credential
against a route it is allowed to reach.

This is the specification's "static per-person credentials, not sessions" assumption made concrete:
no issuance endpoint, no expiry, no refresh. Deactivation is what ends access.

**Which route does the client verify against?** `GET /api/admin/availability` — the cheapest
`staff`-allowed route, no side effects, and it works for both roles. A `200` means the credential is
live; a `401` means it is not, with no way for the client to tell whether it was wrong or revoked,
which is the same thing from its point of view.

**How does the client learn its role?** From the response to `GET /api/admin/staff`: `200` means
owner, `401` means staff. The client uses this only to decide which panels to render — it is a
convenience, never a boundary. Every enforcement decision is made server-side on every request.
