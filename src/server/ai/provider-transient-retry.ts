// YUK-1876 — bounded provider-transient retry policy for admission and
// structured (model-slice) tasks.
//
// `providerTransientVerdict` (src/ai/provider-failure) names the positively
// proven retryable class; this module owns the configured bounds and the delay
// math. Callers apply both — nothing else decides retryability.

import { eq } from 'drizzle-orm';
import { AgentRunError } from '@/ai/agent-run-error';
import {
  type ProviderTransientVerdict,
  providerTransientResendable,
  providerTransientVerdict,
} from '@/ai/provider-failure';
import {
  type AttemptCostTruth,
  type ProviderTransportEvidence,
  failureSpendChargeUsd,
} from '@/ai/task-result';
import { getConfig } from '@/core/config/store';
import type { Db } from '@/db/client';
import { ai_task_runs } from '@/db/schema';

export interface ProviderTransientRetryPolicy {
  /** Extra wire sends allowed after the first bound failure. */
  readonly maxRetries: number;
  /** Total sleep budget across all retries; a delay that cannot fit is not taken. */
  readonly maxWaitMs: number;
  /** Fallback delay base when the provider carried no Retry-After hint. */
  readonly baseDelayMs: number;
}

/**
 * Resolved per call so DB/env overrides apply to the next run. 0 maxRetries
 * disables in-run retries entirely while leaving every receipt/evidence path
 * unchanged.
 */
export function providerTransientRetryPolicy(): ProviderTransientRetryPolicy {
  // Registered keys always resolve (env > db > code-default), so the registry
  // owns these defaults; a fallback here would silently shadow it. YUK-1983's
  // 180s wait budget lives at ADMISSION_PROVIDER_RETRY_MAX_WAIT_MS.
  return {
    maxRetries: getConfig('ADMISSION_PROVIDER_RETRY_MAX_RETRIES') as number,
    // Sleeping costs no tokens; the streaming path keeps its own 15s cap (runner.ts).
    maxWaitMs: getConfig('ADMISSION_PROVIDER_RETRY_MAX_WAIT_MS') as number,
    baseDelayMs: getConfig('ADMISSION_PROVIDER_RETRY_BASE_DELAY_MS') as number,
  };
}

/**
 * The bound a verdict's class earns — the single class→budget table. Every
 * resendable class is a complete pre-billing refusal and consumes the full
 * configured retry/wait budget (sleep costs no tokens); `quota_exhausted`
 * cannot be outwaited in-run, so its bound is zero and the caller's durable
 * wait takes over instead.
 */
export function transientClassBound(
  verdict: ProviderTransientVerdict,
  policy: ProviderTransientRetryPolicy,
): ProviderTransientRetryPolicy {
  return providerTransientResendable(verdict.class)
    ? policy
    : { maxRetries: 0, maxWaitMs: 0, baseDelayMs: 0 };
}

/**
 * Delay before retry number `retryIndex` (0-based). A bound `retry_after_ms`
 * wins over the fallback exponential backoff — the provider's own hint is the
 * only honest lower bound.
 */
export function providerTransientRetryDelayMs(input: {
  verdict: ProviderTransientVerdict;
  retryIndex: number;
  policy: ProviderTransientRetryPolicy;
}): number {
  if (input.verdict.retryAfterMs !== undefined) return input.verdict.retryAfterMs;
  return input.policy.baseDelayMs * 2 ** input.retryIndex;
}

export interface SettledAttemptEvidence {
  /** False while the attempt may still be running — never resend alongside it. */
  readonly settled: boolean;
  /**
   * True only when the settled row carries the unbilled-rejection receipt —
   * `estimated` basis, amount 0, `unbilled-provider-rejection:` ref. A bare
   * `cost_usd === 0` is NOT proof: free-at-margin lanes (subscription routes,
   * zero-price catalog cards) record 0 for work that actually ran and may
   * have side effects; resending them can duplicate paid-or-written effects.
   */
  readonly unbilled: boolean;
  /** Armed-lane transport when the attempt produced one; absent on the typed lane. */
  readonly transport?: ProviderTransportEvidence;
  /** Persisted failure line — the row-driven quota-signature source. */
  readonly errorMessage?: string | null;
}

export async function settledAttemptEvidence(
  db: Db,
  taskRunId: string,
): Promise<SettledAttemptEvidence> {
  const [row] = await db
    .select({
      status: ai_task_runs.status,
      finished_at: ai_task_runs.finished_at,
      usage_json: ai_task_runs.usage_json,
      cost_usd: ai_task_runs.cost_usd,
      cost_basis: ai_task_runs.cost_basis,
      cost_ref: ai_task_runs.cost_ref,
      error_message: ai_task_runs.error_message,
    })
    .from(ai_task_runs)
    .where(eq(ai_task_runs.id, taskRunId));
  const truth: AttemptCostTruth =
    (row?.cost_basis === 'reported' || row?.cost_basis === 'estimated') && row.cost_usd != null
      ? { basis: row.cost_basis, amountUsd: row.cost_usd, ref: row.cost_ref ?? '' }
      : { basis: 'unknown', amountUsd: null, ref: row?.cost_ref ?? '' };
  return {
    settled: row?.finished_at != null && row.status !== 'running',
    unbilled: failureSpendChargeUsd(truth) === 0,
    ...(row?.usage_json?.transport !== undefined ? { transport: row.usage_json.transport } : {}),
    errorMessage: row?.error_message,
  };
}

/**
 * One settled-failure consultation: verdict + the unbilled receipt. A resend
 * is only honest when the failed attempt provably billed nothing — the
 * persisted `unbilled-provider-rejection:` ref is that proof; an unknown,
 * positive, or merely-zero amount never authorizes another send.
 */
async function settledTransientFacts(
  db: Db,
  error: unknown,
): Promise<{ verdict: ProviderTransientVerdict; unbilled: boolean } | undefined> {
  if (!(error instanceof AgentRunError)) return undefined;
  const evidence = await settledAttemptEvidence(db, error.taskRunId);
  if (!evidence.settled) return undefined;
  const verdict = providerTransientVerdict({ error, transport: evidence.transport });
  return verdict === undefined ? undefined : { verdict, unbilled: evidence.unbilled };
}

export interface ProviderTransientRetryBudget {
  /** Retries already consumed by this caller. */
  retries: number;
  /** Sleep already consumed by this caller. */
  waitedMs: number;
}

/**
 * One owner for "may this settled failure re-issue, and after how long?":
 * settled row → verdict → unbilled-rejection receipt → class bound →
 * count/wait/deadline fit. undefined means terminal; the caller treats that
 * as the definitive provider failure it is.
 */
export async function planProviderTransientRetry(input: {
  db: Db;
  error: unknown;
  policy: ProviderTransientRetryPolicy;
  budget: ProviderTransientRetryBudget;
  /** Absolute wall-clock bound (ms epoch); the delay must leave room to retry. */
  deadlineAt?: number;
}): Promise<{ verdict: ProviderTransientVerdict; delayMs: number } | undefined> {
  const facts = await settledTransientFacts(input.db, input.error);
  if (facts === undefined) return undefined;
  if (!facts.unbilled) return undefined;
  const { verdict } = facts;
  const bound = transientClassBound(verdict, input.policy);
  if (input.budget.retries >= bound.maxRetries) return undefined;
  const delayMs = providerTransientRetryDelayMs({
    verdict,
    retryIndex: input.budget.retries,
    policy: bound,
  });
  if (input.budget.waitedMs + delayMs > bound.maxWaitMs) return undefined;
  if (input.deadlineAt !== undefined && input.deadlineAt - Date.now() <= delayMs) return undefined;
  return { verdict, delayMs };
}

export function sleepMs(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
