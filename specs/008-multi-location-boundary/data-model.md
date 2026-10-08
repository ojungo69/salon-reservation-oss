# Data model — location additions without conversion

## Identity and authority

`default` is the existing location, represented virtually. Named IDs match `[a-z][a-z0-9-]{0,31}`, cannot end with `-`, and are immutable. Maximum four locations includes default. Display names use existing locationName validation (1–80 Unicode code points after normalization). No location deletion, cross-location/day move or global customer entity is introduced. The same unverified phone/contact at two locations is legal.

One root InstallationConfig owns configuration, roster and grants; one ReservationDay per `(location,date)` owns booking transactions; provider actors own only post-commit delivery/projections. Address construction is defined in `contracts/location-rpc.md`.

## Existing records

Leave `installation_state`, `__staff_roster`, default `__line_lifecycle`, day-pinned schedule JSON, receipts, proof records and queued notification v1 JSON unchanged. Optional location arguments default to the existing object/table path. Reads do not initialize new side tables or backfill data. Existing exports/bindings remain registered.

## New root side tables

Create each lazily only on its first accepted owner mutation, under `__` names already excluded by the existing exact main-schema check. Proposed concrete records:

| Table | Key and payload | Invariants |
| --- | --- | --- |
| `__location_states` | `location_id` PK; `state_json`; `creation_command_id` UNIQUE; `creation_fingerprint`; `creation_response_json` | Named IDs only; existing InstallationState schema/reducer; stable creation replay; atomic count <=3 named rows |
| `__staff_location_scopes` | `staff_id` PK; `scope_version`; `location_ids_json` | Version starts 1; distinct known IDs, 0–4 entries; absent record means legacy default-only/version0; owner role always global |
| `__location_line_lifecycle` | `location_id` PK; `lifecycle_json` | Existing lifecycle schema; absent means off; default stays old table; active/deactivating and in-flight enabling realms agree |
| `__location_calendar_settings` | `location_id` PK; `version`; `activation_version`; `google_enabled`; `calendar_id`; `feed_enabled`; `feed_token_digest` | Named only; version0 virtual off; target null until first binding then immutable; targets unique including default; digest null or lowercase SHA-256 hex; no plaintext secret |

Use existing exact JSON parsing/round-trip principles. New table absence is valid; present-but-corrupt rows fail closed. Validate before writes and keep roster+initial-grant, creation+receipt, scope CAS and calendar version updates atomic. Current-owner checks share the synchronous transaction with rights/configuration writes. Runtime-created side tables in fictional tests are application additions, not a tool to transform existing-system data.

## Settings and grants

New location uses `createDefaultInstallationState` with its validated display name, demo mode and independent version/history/receipts. It does not clone the installation's private configuration or provider state. The existing settings command reducer operates on the selected state. Day catalog/settings snapshots remain immutable under the existing rule.

Scope input is sorted and deduplicated only after validation rejects duplicates; do not silently repair invalid scope. A missing scope row means `["default"]`; a stored `[]` means none. Revocation/rotation/reactivation keep existing credential handling. New staff creation with explicit locations writes both records atomically. Owners cannot be accidentally narrowed through staff scope operations.

## Integration states

LINE: absent/disabled → activating → active → deactivating → disabled, reusing existing generations, receipts and pre-armed recovery. Each location has its own lifecycle; root schedules the earliest pending due time. Shared realm agreement includes messaging/login/LIFF identifiers while active, draining, or an enable operation is in flight. Compare all such rows in the same accepting transaction. Booking-specific opt-in remains local to the actor.

Named calendar: version0/off/unbound → configured off or enabled; target binding never changes afterwards in S4. Feed token rotation increments version and affects only that location. Enabling a feed requires a stored digest; enabling Google requires a target and valid existing credential set. Root-context uncertainty is an error, not an off transition. The root activation version supplies the generation for named descriptors and recovery events, including when the actor missed an off/on transition. Disabling retains that generation so an uninitialized actor can clean up its prior recovery work without removing a newer generation. Token rotation or editing an already-enabled mode does not advance the generation. Existing actor state/claim/cleanup rules still govern delivery. A named Calendar actor additionally persists its highest applied root configuration version as an ordering fence; delayed lower versions cannot overwrite it. Default actor metadata stays unchanged. These fences store no duplicate settings or secret and are checked again before a provider claim after asynchronous work. The new named table includes the activation column from its first creation. Missing or inconsistent unpublished candidate schema fails closed; no epoch is guessed and no old row is backfilled.

Named notification v2 stores a public location label at queue acceptance. Default v1 fields/bytes and all prior rows remain readable. Browser named records retain existing exact v1 shapes under location-suffixed keys; no stored proof is rewritten.

## Error and retention boundary

Unknown selected state throws exactly `Error("LOCATION_NOT_FOUND")` across RPC; other failures stay unavailable. Every rejected command preserves prior state. Location pausing affects fresh booking only; management/retention continue. No location deletion avoids dangling proof/adapter targets. Code backout must retain all new-location routes, side-table readers, namespaces and alarm handlers until their data safely expires; a pre-S4 code rollback is not a data rollback.
