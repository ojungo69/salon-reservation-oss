# Internal location/RPC contract

These are implementation targets, not additional HTTP authorization mechanisms. RPC callers are the Worker and existing Durable Object classes. Runtime parsers validate IDs and command inputs; root rights changes recheck current actor state.

## One backend naming helper: `src/location.ts`

```ts
export const DEFAULT_LOCATION_ID = "default";
export const MAX_LOCATIONS = 4;
export const parseLocationId: (value: unknown) => string | null;
export const adapterObjectName: (locationId: string) => string;
export const dayObjectName: (locationId: string, date: string) => string;
export const locationFromAdapterId: (
  id: DurableObjectId, legacyId: DurableObjectId,
) => string;
export const locationFromDayId: (
  id: DurableObjectId, date: string, legacyId: DurableObjectId,
) => string;
```

`adapterObjectName(default)` is `installation`; others are `location:<id>`. `dayObjectName(default,date)` is `single-location:<date>`; others are `location:<id>:<date>`. Validate canonical calendar dates, not regex alone. Reject malformed IDs and mismatched day/date names. A missing `id.name` is default only when `id.equals(legacyId)`; every other missing/unknown name throws. The caller obtains legacyId from the appropriate namespace's `idFromName`, never another namespace. No persistent day metadata or rewritten schedule JSON is needed for addressing.

Browser code uses a small URL helper implementing the HTTP contract; do not add TS/JS build infrastructure merely to share it. All backend callers, including alarms and handoffs, use the helper above.

## Root `InstallationConfig("installation")`

Existing return bodies stay unchanged; optional trailing location parameters preserve old calls:

```ts
getState(locationId = "default"): InstallationState;
getContext(locationId = "default"): {state: InstallationState; line?: LineContext};
executeCommand(input: unknown, runtime: ReadinessRuntime, locationId = "default"): Promise<InstallationCommandResult>;
installationReceipt(runtime: ReadinessRuntime, locationId = "default"): Promise<InstallationReceipt>;
resolveActor(digest: unknown, locationId?: string): {staffId: string; role: StaffRole} | null;
executeRosterCommand(input: unknown, actorId: unknown, locationIds?: string[]): Promise<RosterCommandResult>;
executeLineCommand(input: unknown, runtime: ReadinessRuntime, locationId = "default"): Promise<LineCommandResult>;
lineAdapterStatus(locationId = "default"): existing status shape;
```

`resolveActor` without location authenticates a global route (such as the caller's directory); with location it additionally requires current membership, unless role is owner. It never adds scope fields to its existing result. Passing a selected location does not create it. Unknown getState/getContext must produce an Error with exactly the message `LOCATION_NOT_FOUND` so the Worker maps only that fixed message to 404; every other RPC failure remains 503. Verify message propagation in the real Worker runtime rather than relying on custom error prototypes. Do not return default state.

New methods (export named result types from this module, no separate repository abstraction):

```ts
listLocations(runtime: ReadinessRuntime, actorId?: string | null): LocationSummary[];
createLocation(input: unknown, actorId: string | null): Promise<LocationCreateResult>;
listStaffLocationScopes(actorId: string | null): StaffLocationScope[];
setStaffLocationScope(input: unknown, actorId: string | null): StaffScopeResult;
getLineWebhookTargets(): string[];
getCalendarContext(locationId: string): NamedCalendarContext;
setCalendarSettings(input: unknown, actorId: string | null, locationId: string): CalendarSettingsResult;
setCalendarFeedDigest(input: unknown, actorId: string | null, locationId: string): CalendarSettingsResult;
```

`LocationSummary = {id:string,label:string,bookable:boolean}`. `listLocations` with actorId omitted is public minimal projection; null is trusted break-glass; a staff ID filters current grants and checks active state. Worker supplies role from its gate for the authenticated directory response. `StaffLocationScope = {staffId:string,scopeVersion:number,locationIds:string[]|null}`. Missing staff grant has version 0 and default-only scope; owner scope is null/all.

`createLocation` consumes the HTTP creation fields and rechecks owner within a synchronous transaction; save one stable creation receipt per named location. `setStaffLocationScope` consumes `{staffId,expectedScopeVersion,locationIds}` and atomically validates roster role, known locations and CAS. `executeRosterCommand` optional scope is only valid for staff creation, and its roster+grant writes are atomic; old call/result semantics stay unchanged. `getLineWebhookTargets` returns known actor IDs with an active projection in active or deactivating root phase, including named actors when default is inactive; deactivating targets remain until their actor acknowledges cleanup because beginDisable RPC may have failed; no subject/link data leaves actors.

`NamedCalendarContext` is `{version:number,googleEnabled:boolean,calendarId:string|null,feedEnabled:boolean,feedTokenDigest:string|null}`. Before first settings write version=0, modes=false, IDs/digest=null. `setCalendarSettings` accepts the HTTP fields; `setCalendarFeedDigest` accepts `{expectedVersion,feedTokenDigest}` from a freshly generated Worker credential. These methods reject default, whose calendar configuration remains environment-owned. Root stores no provider secret, feed token or refresh token. Treat failed/corrupt context reads as unavailable, never all modes off.

## Actor handoff contract

Existing AdapterDelivery/CalendarAdapter RPC signatures remain local to the addressed actor: `pokeDay({date})`, intent, finalize, webhook, descriptor, feed, reconcile and purge methods need no client-supplied location. Derive immutable scope from actor ID. Worker, root LINE saga, day post-commit handoff and alarms must address the same name. Calendar internal configuration reads carry its derived location to root. No actor may consult the default day's data as fallback.

Default day/adapter/config namespaces and exports remain registered. No D1 binding, extra DO class, dual write, runtime import or data-conversion job is introduced.
