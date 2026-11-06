// YUK-1876 — bounded provider-transient retry policy for admission and
// structured (model-slice) tasks.
//
// `providerTransientVerdict` (src/ai/provider-failure) names the positively
// proven retryable class; this module owns the configured bounds and the delay
// math. Callers apply both — nothing else decides retryability.

import { eq } from 'drizzle-orm';
import { AgentRunError } from '@/ai/agent-run-error';
import { type ProviderTransientVerdict, providerTransientVerdict } from '@/ai/provider-failure';
import type { ProviderTransportEvidence } from '@/ai/task-result';
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
  return {
    maxRetries: (getConfig('ADMISSION_PROVIDER_RETRY_MAX_RETRIES') as number | undefined) ?? 8,
    maxWaitMs: (getConfig('ADMISSION_PROVIDER_RETRY_MAX_WAIT_MS') as number | undefined) ?? 60_000,
    baseDelayMs:
      (getConfig('ADMISSION_PROVIDER_RETRY_BASE_DELAY_MS') as number | undefined) ?? 2_000,
  };
}

/**
 * The bound a verdict's class earns. `rate_limited` and `not_sent` — the two
 * classes the admission bound was designed for — consume the full configured
 * retry/wait budget; the other positively-proven classes keep the ADR-0079
 * single immediate re-send, capped by the configured limit so `0` still
 * disables every resend.
 */
export function transientClassBound(
  verdict: ProviderTransientVerdict,
  policy: ProviderTransientRetryPolicy,
): ProviderTransientRetryPolicy {
  return verdict.class === 'rate_limited' || verdict.class === 'not_sent'
    ? policy
    : { maxRetries: Math.min(1, policy.maxRetries), maxWaitMs: 0, baseDelayMs: 0 };
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
  /** Armed-lane transport when the attempt produced one; absent on the typed lane. */
  readonly transport?: ProviderTransportEvidence;
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
    })
    .from(ai_task_runs)
    .where(eq(ai_task_runs.id, taskRunId));
  return {
    settled: row?.finished_at != null && row.status !== 'running',
    ...(row?.usage_json?.transport !== undefined ? { transport: row.usage_json.transport } : {}),
  };
}

/**
 * The caller-side verdict for one thrown attempt error: settled rows only,
 * transport forwarded when the lane armed one. A bound status without a
 * settled row still cannot justify a resend.
 */
export async function settledTransientVerdict(
  db: Db,
  error: unknown,
): Promise<ProviderTransientVerdict | undefined> {
  if (!(error instanceof AgentRunError)) return undefined;
  const evidence = await settledAttemptEvidence(db, error.taskRunId);
  if (!evidence.settled) return undefined;
  return providerTransientVerdict({ error, transport: evidence.transport });
}

export interface ProviderTransientRetryBudget {
  /** Retries already consumed by this caller. */
  retries: number;
  /** Sleep already consumed by this caller. */
  waitedMs: number;
}

/**
 * One owner for "may this settled failure re-issue, and after how long?":
 * verdict → class bound → count/wait/deadline fit. undefined means terminal;
 * the caller treats that as the definitive provider failure it is.
 */
export async function planProviderTransientRetry(input: {
  db: Db;
  error: unknown;
  policy: ProviderTransientRetryPolicy;
  budget: ProviderTransientRetryBudget;
  /** Absolute wall-clock bound (ms epoch); the delay must leave room to retry. */
  deadlineAt?: number;
}): Promise<{ verdict: ProviderTransientVerdict; delayMs: number } | undefined> {
  const verdict = await settledTransientVerdict(input.db, input.error);
  if (verdict === undefined) return undefined;
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
