/**
 * Provider-session lease CAS and the bounded Postgres transaction shared with
 * the admission tick. Heartbeat scheduling stays with acquire.
 */

import { sql } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import {
  type AdmissionRequest,
  type AdmissionStatus,
  LEASE_OPERATION_BUDGET_MS,
  PROVIDER_SESSION_LEASE_TTL_MS,
} from './provider-session-admission-policy';

const DB_STATEMENT_CEILING_MS = 1_000;
const DB_LOCK_CEILING_MS = 250;

function isDbBudgetError(error: unknown): boolean {
  // Drizzle wraps the postgres-js error, so the SQLSTATE can live on `cause`.
  // Bound traversal and fence cycles because adapters may attach arbitrary errors.
  const seen = new Set<object>();
  let current = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (!current || typeof current !== 'object' || seen.has(current)) return false;
    seen.add(current);
    const code = 'code' in current ? String((current as { code?: unknown }).code ?? '') : '';
    if (code === '55P03' || code === '57014') return true;
    current = 'cause' in current ? (current as { cause?: unknown }).cause : undefined;
  }
  return false;
}

/**
 * Bound both statement execution and time queued for a pooled connection.
 *
 * The local timer only wins while the transaction callback has not entered. A
 * callback delivered after that win observes `queueDeadlineWon` and performs no
 * SQL, so there is no late commit. Once entered, PostgreSQL-side LOCAL budgets
 * own cancellation; we never abandon a mutating statement via Promise.race.
 */
export async function boundedAdmissionTransaction<T>(
  db: Db,
  monotonicDeadlineAt: number,
  fn: (tx: Tx) => Promise<T>,
  onUnderlyingSettled?: () => void,
): Promise<T | undefined> {
  const initialRemainingMs = monotonicDeadlineAt - performance.now();
  if (initialRemainingMs <= 0) {
    onUnderlyingSettled?.();
    return undefined;
  }

  let entered = false;
  let queueDeadlineWon = false;
  let queueTimer: ReturnType<typeof setTimeout> | undefined;
  const transaction = db
    .transaction(async (tx) => {
      if (queueDeadlineWon || performance.now() >= monotonicDeadlineAt) return undefined;
      entered = true;
      const remainingMs = Math.max(1, monotonicDeadlineAt - performance.now());
      const statementMs = Math.max(1, Math.floor(Math.min(DB_STATEMENT_CEILING_MS, remainingMs)));
      const lockMs = Math.max(1, Math.floor(Math.min(DB_LOCK_CEILING_MS, statementMs)));
      await tx.execute(sql`
        SELECT set_config('lock_timeout', ${`${lockMs}ms`}, true),
               set_config('statement_timeout', ${`${statementMs}ms`}, true)
      `);
      return fn(tx);
    })
    .catch((error) => {
      if (isDbBudgetError(error)) return undefined;
      throw error;
    });
  // When the caller's pool-queue deadline wins, the postgres-js transaction
  // promise still has to obtain a connection and observe queueDeadlineWon. Let
  // lane single-flight ownership follow that underlying lifetime, not the
  // earlier caller return, so expired callbacks cannot accumulate in the pool.
  if (onUnderlyingSettled) {
    transaction.then(onUnderlyingSettled, onUnderlyingSettled);
  }

  const queueDeadline = new Promise<undefined>((resolve) => {
    queueTimer = setTimeout(() => {
      if (entered) return;
      queueDeadlineWon = true;
      resolve(undefined);
    }, initialRemainingMs);
  });
  try {
    return await Promise.race([transaction, queueDeadline]);
  } finally {
    if (queueTimer) clearTimeout(queueTimer);
  }
}

export function eventLog(
  level: 'log' | 'warn' | 'error',
  event: string,
  input: AdmissionRequest,
  extra: Record<string, unknown> = {},
): void {
  console[level](`[provider-session-admission] ${event}`, {
    event,
    task_run_id: input.taskRunId,
    task_kind: input.kind,
    lane_id: input.plan.laneId,
    mode: input.plan.mode,
    policy_fingerprint: input.plan.policy.fingerprint,
    ...extra,
  });
}

type LeaseRenewalResult =
  | { kind: 'renewed'; leaseRemainingMs: number }
  | { kind: 'fence_lost' }
  | { kind: 'indeterminate'; underlyingSettled: Promise<void> };

type StartupCompletionResult =
  | { kind: 'completed'; leaseRemainingMs: number }
  | { kind: 'fence_lost' }
  | { kind: 'indeterminate'; underlyingSettled: Promise<void> };

export async function completeStartupLease(
  input: AdmissionRequest,
  claimToken: string,
  knownLeaseDeadlineMonotonicAt: number,
): Promise<StartupCompletionResult> {
  let markUnderlyingSettled!: () => void;
  const underlyingSettled = new Promise<void>((resolve) => {
    markUnderlyingSettled = resolve;
  });
  const rows = await boundedAdmissionTransaction(
    input.db,
    Math.min(performance.now() + LEASE_OPERATION_BUDGET_MS, knownLeaseDeadlineMonotonicAt),
    (tx) =>
      tx.execute<{ task_run_id: string; lease_remaining_ms: number | string }>(sql`
        UPDATE provider_session_admission
           SET heartbeat_at = clock_timestamp(),
               lease_expires_at = LEAST(
                 hard_reclaim_at,
                 clock_timestamp() + (
                   ${PROVIDER_SESSION_LEASE_TTL_MS}::double precision
                   * interval '1 millisecond'
                 )
               )
         WHERE task_run_id = ${input.taskRunId}
           AND lane_id = ${input.plan.laneId}
           AND policy_fingerprint = ${input.plan.policy.fingerprint}
           AND mode = ${input.plan.mode}
           AND claim_token = ${claimToken}
           AND status = 'acquired'
           AND lease_expires_at > clock_timestamp()
           AND hard_reclaim_at > clock_timestamp()
        RETURNING task_run_id,
                  GREATEST(
                    0,
                    EXTRACT(EPOCH FROM (lease_expires_at - clock_timestamp())) * 1000
                  ) AS lease_remaining_ms
      `),
    markUnderlyingSettled,
  );
  if (rows === undefined) return { kind: 'indeterminate', underlyingSettled };
  const row = rows[0];
  if (!row) return { kind: 'fence_lost' };
  const leaseRemainingMs = Number(row.lease_remaining_ms);
  if (!Number.isFinite(leaseRemainingMs) || leaseRemainingMs <= 0) {
    return { kind: 'fence_lost' };
  }
  return { kind: 'completed', leaseRemainingMs };
}

export async function renewLease(
  input: AdmissionRequest,
  claimToken: string,
  knownLeaseDeadlineMonotonicAt: number,
): Promise<LeaseRenewalResult> {
  let markUnderlyingSettled!: () => void;
  const underlyingSettled = new Promise<void>((resolve) => {
    markUnderlyingSettled = resolve;
  });
  const rows = await boundedAdmissionTransaction(
    input.db,
    Math.min(performance.now() + LEASE_OPERATION_BUDGET_MS, knownLeaseDeadlineMonotonicAt),
    (tx) =>
      tx.execute<{ task_run_id: string; lease_remaining_ms: number | string }>(sql`
        UPDATE provider_session_admission
           SET heartbeat_at = clock_timestamp(),
               lease_expires_at = LEAST(
                 hard_reclaim_at,
                 GREATEST(
                   lease_expires_at,
                   clock_timestamp() + (
                     ${PROVIDER_SESSION_LEASE_TTL_MS}::double precision
                     * interval '1 millisecond'
                   )
                 )
               )
         WHERE task_run_id = ${input.taskRunId}
           AND lane_id = ${input.plan.laneId}
           AND policy_fingerprint = ${input.plan.policy.fingerprint}
           AND mode = ${input.plan.mode}
           AND claim_token = ${claimToken}
           AND status = 'acquired'
           AND lease_expires_at > clock_timestamp()
           AND hard_reclaim_at > clock_timestamp()
        RETURNING task_run_id,
                  GREATEST(
                    0,
                    EXTRACT(EPOCH FROM (lease_expires_at - clock_timestamp())) * 1000
                  ) AS lease_remaining_ms
      `),
    markUnderlyingSettled,
  );
  if (rows === undefined) return { kind: 'indeterminate', underlyingSettled };
  const row = rows[0];
  if (!row) return { kind: 'fence_lost' };
  const leaseRemainingMs = Number(row.lease_remaining_ms);
  if (!Number.isFinite(leaseRemainingMs) || leaseRemainingMs <= 0) {
    return { kind: 'fence_lost' };
  }
  return { kind: 'renewed', leaseRemainingMs };
}

export async function releaseLease(
  input: AdmissionRequest,
  claimToken: string,
  borrowedFromTaskRunId: string | null,
): Promise<void> {
  try {
    const rows = await boundedAdmissionTransaction(
      input.db,
      performance.now() + LEASE_OPERATION_BUDGET_MS,
      (tx) =>
        tx.execute<{ previous_status: AdmissionStatus }>(sql`
          UPDATE provider_session_admission
             SET status = 'released',
                 terminal_at = clock_timestamp(),
                 terminal_reason = CASE
                   WHEN status = 'lease_expired' THEN 'released_after_lease_expiry'
                   ELSE 'released'
                 END
           WHERE task_run_id = ${input.taskRunId}
             AND lane_id = ${input.plan.laneId}
             AND policy_fingerprint = ${input.plan.policy.fingerprint}
             AND mode = ${input.plan.mode}
             AND claim_token = ${claimToken}
             AND status IN ('acquired', 'lease_expired')
          RETURNING status AS previous_status
        `),
    );
    if (!rows) throw new Error('provider session release exceeded DB operation budget');
    eventLog(rows.length === 1 ? 'log' : 'warn', 'provider_session_released', input, {
      borrowed_from_task_run_id: borrowedFromTaskRunId,
      release_fence_matched: rows.length === 1,
    });
  } catch (error) {
    // Never turn a completed provider response into an application failure. A
    // failed release conservatively occupies capacity until hard_reclaim_at.
    eventLog('error', 'provider_session_release_failed', input, {
      borrowed_from_task_run_id: borrowedFromTaskRunId,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}
