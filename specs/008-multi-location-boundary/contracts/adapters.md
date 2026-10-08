# Adapter isolation and recovery contract

## Complete actors, shared providers

Reuse existing AdapterDelivery and CalendarAdapter classes/namespaces per canonical location. Default actor remains `installation`; named actors are `location:<id>`. Their existing SQL rows/IDs need no cross-location columns because actor identity supplies the scope. Day handoff derives its own location and pokes only that actor. Drain, sequence lookup, sweep, purge and reconciliation resolve only matching day names. Nameless nondefault identity fails closed.

LINE retains links, subjects/friendship, dedup, delivery queue and send claim inside the same actor. A remote global-identity lookup must not replace the existing synchronous link-version/friendship check before push. Shared provider subject strings do not create global customer identity or consent. Link proof/nonce/generation remain local; wrong-actor nonce fails before provider verification. One shared realm is enforced in the accepting root transaction across active/deactivating records and in-flight activating operation identifiers; concurrent enables cannot establish two realms.

Root LINE lifecycle functions take explicit location. Default serialized lifecycle stays exact; named lifecycle rows reuse its existing shape. One canonical earliest-due root alarm drives bounded pending rows. A later operation cannot overwrite an earlier wake-up; one unavailable actor cannot starve the others. Pre-arm before accepting lifecycle writes, persist operation progress, bound RPC calls and re-drive after restart. Never declare global idle while any row has pending work.

The global signed webhook calls only root-projected active and still-draining actors; default need not be active. Await all bounded acknowledgements before success. Failed/partial attempts are retryable and per-actor webhookEventId dedup makes repeated processing harmless. No public location parameter controls this fanout.

## Wire identity and provider configuration

Default notification v1 serialization is immutable. Named notifications use a minimal v2 fragment that stores a validated public location label with the existing event/date/time/service fields when delivery is queued. Retries serialize that stored fragment, not current settings; old v1 queues remain readable. No customer name/contact/proof/provider identifier enters message text. The configuration actor may supply the current public label for a named acceptance batch; count that read in resource evidence.

Default calendar environment parsing, feed capability and `ics:<reservationId>` / `google:<reservationId>` hash inputs remain exact. Named calendar IDs include canonical location in hash inputs. Feed capabilities are independent random secrets with root-stored digests; default feed holders cannot derive or access other feeds. Named actor configuration comes from one trusted root read per logical processing pass, with the current global Google credential set and selected immutable target ID. Configuration failure throws/rearms; it must never masquerade as both modes disabled or trigger destructive cleanup. Named Calendar actors persist a highest-applied root configuration version as a coordination fence: an old asynchronous context response cannot reactivate or overwrite a newer applied disable/rotation. Recheck local state and applied version before claiming a provider write, including after token acquisition; reject stale claims. This marker is not a second configuration authority. Test reversed context-response order and restart. A send already begun may finish under the existing boundary; no instantaneous cross-object revocation is promised.

Named enablement is explicit and off by default. Disabling, retention and outbox cleanup affect only that actor/day prefix. Keep reconciliation at seven selected-location days per request. Provider failures never change core capacity. Existing direct OAuth refresh is reused; no new OAuth callback/onboarding or provider-account mutation belongs here.

## Timing and cost boundary

Retain the current 60-second sweep behavior as the implementation baseline. A 300-second **idle-only** delay is deferred beyond S4 and is not an implementation task in this feature. Never change the shared rearm constant alone: Calendar currently depends on polling for retries/claim recovery, and a changed full-cycle formula changes LINE late-terminal behavior.

Any optimization must separately schedule due retries, in-flight claim expiry, remaining batch work, disable lease waits and retention at the earliest appropriate wake-up. Preserve default timing contracts unless a deliberate independently proven change is recorded. Simulate lost post-commit handoff, actor restart, full supported outbox backlog, more/pending drain pages, retry/claim deadlines and failed configuration reads.

The 457-partition cycle calculation is conditional on bounded drain work: a `more`/pending day can consume multiple batch slots. Empty-cycle arithmetic is a cost scenario, not a universal delivery deadline or full-backlog proof. Publish source-derived and measured counts separately. Four integrated locations do not inherit the single-location Free-plan claim. No live price/performance or quota guarantee is made by this design.
