# Contract: the authorization boundary

Every route this Worker serves, and what each actor may do with it. SC-004 requires the boundary be
verified route by route with none unaccounted for, so this table is the checklist that verification
runs against — the test suite asserts one case per row.

## The gate

`ownerGate(request, env, route)` becomes `operatorGate(request, env, route, required)`:

```ts
type Required = "owner" | "staff";   // "staff" means "staff or owner"

const operatorGate = async (
  request: Request, env: AppEnv, route: string, required: Required,
): Promise<{ actor: Actor } | Response> => { … }
```

Order of operations, unchanged from today except for step 3:

1. **Rate limit** on the route's own bucket. Refuses with `429` before anything else is read.
2. **Deployment secret check**, from the environment, constant time. Missing or placeholder secret →
   `503 TEMPORARILY_UNAVAILABLE` exactly as today. A match → `{ kind: "break_glass", role: "owner" }`
   with no Durable Object call.
3. **Roster resolution** — `InstallationConfig.resolveActor(sha256(presented))`. No match → refuse.
4. **Role check** — `required === "owner" && actor.role !== "owner"` → refuse.

Steps 3 and 4 refuse **identically**: `401 UNAUTHORIZED`, `www-authenticate: Bearer`, same body, same
path. See research R4 — this is FR-005, not an oversight, and the refusal site carries a comment
saying so.

The same-origin mutation check (`requireMutationOrigin`) runs at the top of each handler, *before*
the gate, and is untouched. Neither it nor the rate limiter is an authorization decision and no role
bypasses either. (FR-004)

## Public routes — unchanged, no gate, no actor

| Path | Method | Note |
|---|---|---|
| `/api/config` | GET | Publication mode and public settings |
| `/api/availability` | GET | — |
| `/api/reservations` | POST | Public booking; Turnstile |
| `/api/reservations/:id/status` | POST | Management key |
| `/api/reservations/:id/cancel` | POST | Management key |
| `/api/reservations/:id/line/link-intent` | POST | Management key |
| `/api/reservations/:id/line/unlink` | POST | Management key |
| `/api/reservations/:id/line/status` | POST | Management key |
| `/api/adapters/line/link` | GET | LIFF completion |
| `/api/adapters/line/webhook` | POST | LINE signature |
| `/api/adapters/calendar/feed.ics` | GET | Feed token |
| `/privacy`, `/privacy.html` | GET | — |
| everything else | GET | Static assets |

FR-026 and FR-001 both bind here: no route in this table gains a gate, and no gated route loses one.

## Operator routes — day-to-day operations (`staff` or `owner`)

| Path | Method | Rate bucket | Attribution |
|---|---|---|---|
| `/api/admin/availability` | GET | `owner-availability` | — read |
| `/api/admin/schedule` | GET | `owner-schedule` | — read |
| `/api/admin/reservations` | POST | `owner-create` | ✓ |
| `/api/admin/reservations/:id/transition` | POST | `owner-transition` | ✓ |
| `/api/admin/closures` | POST | `owner-closure-create` | ✓ |
| `/api/admin/closures/:id/remove` | POST | `owner-closure-remove` | ✓ |

Six buckets. This is FR-002's "read availability, read the schedule, create a booking, transition a
booking, create and remove a closure — and nothing else", enumerated.

`/api/admin/schedule` returns customer names and contact details. A staff member sees them, per the
specification's assumption: it is the only route that carries them and the role cannot run a day
without it.

## Operator routes — installation administration (`owner` only)

| Path | Method | Rate bucket | Why owner-only |
|---|---|---|---|
| `/api/admin/setup` | GET, PUT | `owner-setup` | Installation settings, legal notices, consent version |
| `/api/admin/setup/live` | POST | `owner-live` | Publication toggle |
| `/api/admin/installation-receipt` | GET | `owner-receipt` | Deployment and readiness disclosure |
| `/api/admin/line/settings` | POST | `line-lifecycle` | Adapter lifecycle |
| `/api/admin/line/enable` | POST | `line-lifecycle` | Adapter lifecycle |
| `/api/admin/line/disable` | POST | `line-lifecycle` | Adapter lifecycle |
| `/api/admin/line/status` | GET | `line-status` | Adapter and channel state |
| `/api/admin/calendar/status` | GET | `calendar-status` | Adapter state |
| `/api/admin/calendar/reconcile` | POST | `calendar-reconcile` | Adapter repair |

Seven buckets over nine paths. Together with the six above this is all thirteen buckets that exist
today — every one accounted for, none moved out of the gate. (FR-003, FR-001)

**The methods in these tables are load-bearing for the tests.** Every handler checks its method first
and answers `405` before the gate is reached — `handleSetup` at `src/worker.ts:1355` is the one that
catches people out, because it accepts `GET` and `PUT` and never `POST`. A role assertion sent with
the wrong method gets `405` and silently never exercises the boundary it was written to check.

## Roster routes — new, `owner` only

| Path | Method | Rate bucket |
|---|---|---|
| `/api/admin/staff` | GET | `owner-staff` |
| `/api/admin/staff` | POST | `owner-staff` |
| `/api/admin/staff/:id/rotate` | POST | `owner-staff-credential` |
| `/api/admin/staff/:id/deactivate` | POST | `owner-staff-credential` |
| `/api/admin/staff/:id/reactivate` | POST | `owner-staff-credential` |

Two new buckets, not one: reading the roster and issuing a credential deserve different limits,
because the second is the operation an attacker who has somehow reached an owner session would want
to repeat. A `staff` credential is refused on all five, indistinguishably from a bad one. (FR-003)

The shapes are in [roster-api.md](./roster-api.md).

## The role check is total

```ts
const ROUTE_ROLE: Record<OperatorRoute, Required> = { … };   // no index signature, no default
```

`OperatorRoute` is the union of the bucket names. Adding a route without adding it to this record is
a type error, not a route that quietly defaults to one side. That is what "no route unaccounted for"
means in code rather than in a checklist.
