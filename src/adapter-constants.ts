/**
 * Every tuning number for the LINE adapter, in one place. Sources and sizing rationale live in
 * specs/003-line-adapter/tasks.md ("Constants"); the inequalities between them are asserted by
 * a test so a future edit cannot silently break the timing model.
 *
 * Sweep cycle bound (documented, not stored — computed by fullCycleBoundS below):
 *   partitions       = SWEEP_PAST_DAYS + 1 + SWEEP_FUTURE_DAYS = 366 + 1 + 90 = 457
 *   fullCycleBound   = (ceil(partitions / SWEEP_DAY_BATCH) + FAULT_BUDGET_F)
 *                      × (SWEEP_MAX_BATCH_RUNTIME_S + SWEEP_REARM_DELAY_S
 *                         + ALARM_LATENESS_ALLOWANCE_S + ALARM_RETRY_BACKOFF_ALLOWANCE_S)
 *                      + SWEEP_RPC_MARGIN_S
 *                    = (29 + 3) × 720 + 300 = 23,340 s ≈ 6.48 h at the fixed window.
 *   HANDOFF_TERMINAL_LEAD_S must stay strictly above that worst case (and below the 24 h
 *   push retry-key validity). More than FAULT_BUDGET_F batch failures per cycle is out of the
 *   timing model: delivery still recovers (the sweep keeps re-driving), only the bound's
 *   deadline guarantee no longer applies to that cycle.
 */
export const ADAPTER = Object.freeze({
  /** Push retry schedule: seconds after first attempt (t0, +1m, +6m, +21m, +1h21m, +4h21m, +10h21m). */
  RETRY_OFFSETS_S: Object.freeze([0, 60, 360, 1260, 4860, 15660, 37260] as const),
  /** Validity window of X-Line-Retry-Key per LINE docs; the retry ladder must finish inside it. */
  RETRY_KEY_VALIDITY_S: 86400,
  /** Timeout for every outbound LINE API call. */
  OUTBOUND_TIMEOUT_MS: 10000,
  /** Stateless channel access token cache ceiling; the granted expires_in wins when it is shorter. */
  TOKEN_CACHE_TTL_S: 840,
  /** Never serve a cached token this close to its granted expiry. */
  TOKEN_CACHE_SAFETY_MS: 60000,
  /** Webhook raw-body byte cap, enforced before HMAC. */
  WEBHOOK_BODY_MAX_BYTES: 262144,
  /** Webhook event-count cap, enforced after signature verification. */
  WEBHOOK_EVENTS_MAX: 50,
  /** Bounded-reader cap for verify/token API response bodies. */
  VERIFY_RESPONSE_MAX_BYTES: 16384,
  /** Field caps for allowlisted response schemas. */
  ID_TOKEN_MAX_BYTES: 4096,
  ACCESS_TOKEN_MAX_BYTES: 4096,
  /** Untrusted liff.state bound (same-origin relative path only). */
  LIFF_STATE_MAX_CHARS: 512,
  /** Link intent nonce validity. */
  INTENT_NONCE_TTL_S: 600,
  /** Provisional link lifetime (finalize or expire). */
  PROVISIONAL_LINK_TTL_S: 900,
  /** Descriptor lease window minted by InstallationConfig; days validate in-transaction. */
  DESCRIPTOR_LEASE_WINDOW_S: 30,
  /** Disable saga: wait after projection clear before the final zero pass (≥ 2 × lease window). */
  FINAL_PASS_LEASE_WAIT_S: 60,
  /** Coordinator re-drive delay, pre-armed before a lifecycle command commits. */
  SAGA_REDRIVE_DELAY_S: 5,
  /** Events per drainOutbox pull. */
  OUTBOX_DRAIN_BATCH: 32,
  /** Day objects per sweep alarm run. */
  SWEEP_DAY_BATCH: 16,
  /** Delay between sweep alarm runs while work remains. */
  SWEEP_REARM_DELAY_S: 60,
  /** Per drain/ack RPC deadline; a timeout counts as one fault-budget failure. */
  SWEEP_RPC_DEADLINE_MS: 5000,
  /** Worst single-batch runtime: 16 days × 3 RPC (drain, ack, and the purge a
   * deactivating cycle adds) × 5 s deadline + local work. */
  SWEEP_MAX_BATCH_RUNTIME_S: 300,
  /** Platform's documented ~1 minute alarm-lateness worst case. */
  ALARM_LATENESS_ALLOWANCE_S: 60,
  /** Platform alarm retry: exponential from 2 s, ≤ 6 retries ≈ 126 s worst (research R5). */
  ALARM_RETRY_BACKOFF_ALLOWANCE_S: 300,
  /** Allowed batch failures per sweep cycle; beyond this the cycle bound is out-of-model. */
  FAULT_BUDGET_F: 3,
  /** Additive margin in the cycle bound. */
  SWEEP_RPC_MARGIN_S: 300,
  /** Undelivered-event terminalization lead; strictly above the worst full sweep cycle. */
  HANDOFF_TERMINAL_LEAD_S: 43200,
  /** webhookEventId dedup retention. */
  WEBHOOK_DEDUP_TTL_S: 259200,
  WEBHOOK_DEDUP_CAP: 5000,
  /** Redacted terminal-failure ledger retention. */
  LEDGER_TTL_S: 2592000,
  LEDGER_CAP: 500,
  /** Pending deliveries per installation; overflow terminalizes the incoming event with reason "overflow" (evicting an in-flight claim would break its invariants). */
  DELIVERY_QUEUE_CAP: 2000,
  /** Fixed sweep window: [today − SWEEP_PAST_DAYS, today + SWEEP_FUTURE_DAYS]. A deliberate
   * superset of every configurable retention/horizon window (365 + 1 and 90 at their caps), so
   * the authority never needs a config read; days outside the real window simply hold no outbox. */
  SWEEP_PAST_DAYS: 366,
  SWEEP_FUTURE_DAYS: 90,
  /** Deliveries attempted per alarm run (each is one outbound push + possibly one token mint). */
  SEND_BATCH: 8,
  /** In-flight send claim lease; a claim older than this recovers to queued (same retry key). */
  SEND_CLAIM_LEASE_S: 30,
  /** Cadence for re-checking whether a missing secret has been restored. */
  CONFIG_RECHECK_S: 300,
  /** First-pushed awaiting-configuration deliveries terminalize this margin before the retry-key window ends. */
  RETRY_KEY_SAFETY_MARGIN_S: 3600,
  /** Lifecycle command receipts. */
  RECEIPT_CAP: 50,
  RECEIPT_TTL_S: 7776000,
  /** Bounded webhook signature-failure counter window. */
  SIGFAIL_WINDOW_S: 86400,
} as const);

/** Worst-case sweep partitions: every day the fixed window visits, inclusive of
 * both endpoints and today. Derived so the bound can never drift from the window. */
export const WORST_CASE_PARTITIONS =
  ADAPTER.SWEEP_PAST_DAYS + 1 + ADAPTER.SWEEP_FUTURE_DAYS;

/** The documented cycle bound, computed for a given partition count. */
export function fullCycleBoundS(partitions: number): number {
  const perBatchS =
    ADAPTER.SWEEP_MAX_BATCH_RUNTIME_S +
    ADAPTER.SWEEP_REARM_DELAY_S +
    ADAPTER.ALARM_LATENESS_ALLOWANCE_S +
    ADAPTER.ALARM_RETRY_BACKOFF_ALLOWANCE_S;
  const batches = Math.ceil(partitions / ADAPTER.SWEEP_DAY_BATCH) + ADAPTER.FAULT_BUDGET_F;
  return batches * perBatchS + ADAPTER.SWEEP_RPC_MARGIN_S;
}

export const withDeadline = async <T>(work: PromiseLike<T>, ms: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error("rpc deadline"));
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};
