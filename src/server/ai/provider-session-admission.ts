/**
 * Cross-process admission for central provider sessions (YUK-842).
 *
 * The admitted unit is a whole `startup()` + `query()` session, not an HTTP
 * request: one session can contain multiple turns, nested agents and bounded
 * internal retries. This module caps concurrent session families/branches and
 * starts per minute; it does not claim raw open-query count or wire-level RPM.
 *
 * All coordination uses short Postgres transactions. No connection, row lock or
 * advisory lock is held while waiting or while the provider session runs.
 *
 * Lane policy and capacity predicates live in provider-session-admission-policy.ts.
 * Lease CAS and the bounded admission transaction live in provider-session-lease.ts.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Provider } from '@/ai/registry';
import type { Db, Tx } from '@/db/client';
import {
  type AdmissionRequest,
  type AdmissionRow,
  type AdmissionStatus,
  LEASE_OPERATION_BUDGET_MS,
  PROVIDER_SESSION_ABORT_GRACE_MS,
  PROVIDER_SESSION_HEARTBEAT_MS,
  PROVIDER_SESSION_INITIAL_LEASE_TTL_MS,
  PROVIDER_SESSION_LEASE_TTL_MS,
  ProviderSessionAdmissionError,
  type ProviderSessionAdmissionMode,
  type ProviderSessionAdmissionReason,
  concurrentCapacityAvailable,
  expireAndTrim,
  hardReclaimHorizonMs,
  insertObservedAcquired,
  insertWaitingOrRejected,
  isOldestWaiter,
  parentCanLendSlot,
  readAdmissionRow,
  requireRowIdentity,
  sessionStartCapacityAvailable,
} from './provider-session-admission-policy';
import {
  boundedAdmissionTransaction,
  completeStartupLease,
  eventLog,
  releaseLease,
  renewLease,
} from './provider-session-lease';

const PROVIDER_SESSION_HEARTBEAT_RETRY_MS = 500;

const STUCK_RUN_SAFETY_BOUND_MS = 60 * 60_000;
const POLL_MIN_MS = 100;
const POLL_MAX_MS = 1_000;
const POLL_JITTER_MS = 100;

const TERMINAL_SETTLEMENT_BUDGET_MS = 250;

type TickResult =
  | { kind: 'lock_busy' }
  | { kind: 'waiting' }
  | {
      kind: 'acquired';
      claimToken: string;
      borrowedFromTaskRunId: string | null;
      waitMs: number;
      leaseDeadlineMonotonicAt: number;
    }
  | {
      kind: 'terminal';
      reason: Extract<
        ProviderSessionAdmissionReason,
        'cancelled' | 'policy_mismatch' | 'queue_full' | 'wait_timeout'
      >;
    };

export interface ProviderSessionPermit {
  readonly mode: ProviderSessionAdmissionMode;
  readonly laneId: Provider;
  readonly borrowedFromTaskRunId: string | null;
  /** Synchronously fence provider work after an event-loop stall. */
  assertProviderStartAllowed(): void;
  /** Replace the startup lease with the shorter steady execution lease. */
  completeStartup(): Promise<void>;
  release(): Promise<void>;
}

const NOOP_PERMIT = (laneId: Provider): ProviderSessionPermit => ({
  mode: 'off',
  laneId,
  borrowedFromTaskRunId: null,
  assertProviderStartAllowed() {},
  async completeStartup() {},
  async release() {},
});

function callerStopError(
  input: AdmissionRequest,
  reason: Extract<ProviderSessionAdmissionReason, 'cancelled' | 'wait_timeout'>,
): ProviderSessionAdmissionError {
  eventLog('warn', `provider_session_${reason}`, input);
  return new ProviderSessionAdmissionError({
    reason,
    laneId: input.plan.laneId,
    taskRunId: input.taskRunId,
  });
}

const localLaneTickInFlight = new Set<Provider>();

async function tryLaneTransaction<T>(
  db: Db,
  laneId: Provider,
  monotonicDeadlineAt: number,
  fn: (tx: Tx) => Promise<T>,
): Promise<T | undefined> {
  if (localLaneTickInFlight.has(laneId)) return undefined;
  localLaneTickInFlight.add(laneId);
  try {
    return await boundedAdmissionTransaction(
      db,
      monotonicDeadlineAt,
      async (tx) => {
        const lockRows = await tx.execute<{ locked: boolean }>(sql`
          SELECT pg_try_advisory_xact_lock(
            hashtextextended(${`provider-session-admission:${laneId}`}, 0)
          ) AS locked
        `);
        if (lockRows[0]?.locked !== true) return undefined;
        return fn(tx);
      },
      () => localLaneTickInFlight.delete(laneId),
    );
  } catch (error) {
    // `db.transaction()` is allowed to throw synchronously (for example after
    // pool shutdown), before boundedAdmissionTransaction can attach its
    // underlying-settlement cleanup. Never poison this lane for the process
    // lifetime merely because one transaction could not be constructed.
    localLaneTickInFlight.delete(laneId);
    throw error;
  }
}

function terminalReason(row: AdmissionRow): TickResult | undefined {
  if (row.status === 'cancelled') return { kind: 'terminal', reason: 'cancelled' };
  if (row.status === 'timed_out') return { kind: 'terminal', reason: 'wait_timeout' };
  if (row.status === 'rejected') {
    return {
      kind: 'terminal',
      reason: row.terminal_reason === 'policy_mismatch' ? 'policy_mismatch' : 'queue_full',
    };
  }
  return undefined;
}

function requireClaimToken(row: AdmissionRow, taskRunId: string): string {
  if (!row.claim_token) throw new Error(`acquired admission has no claim token: ${taskRunId}`);
  return row.claim_token;
}

function requireLeaseDeadlineMonotonicAt(
  row: AdmissionRow,
  measuredAtMonotonic: number,
  input: AdmissionRequest,
): number {
  const remainingMs = Number(row.lease_remaining_ms);
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
    throw new Error(`acquired admission has no live lease: ${input.taskRunId}`);
  }
  return measuredAtMonotonic + remainingMs;
}

function requireOwnedClaimToken(row: AdmissionRow, input: AdmissionRequest): string {
  requireRowIdentity(row, input);
  const claimToken = requireClaimToken(row, input.taskRunId);
  if (claimToken !== input.claimToken) {
    throw new Error(`provider session admission is already owned: ${input.taskRunId}`);
  }
  return claimToken;
}

async function policyMismatchExists(
  tx: Tx,
  laneId: Provider,
  fingerprint: string,
): Promise<boolean> {
  const rows = await tx.execute<{ mismatched: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1
        FROM provider_session_admission
       WHERE lane_id = ${laneId}
         AND policy_fingerprint <> ${fingerprint}
         AND (
           (status = 'waiting' AND wait_deadline_at > clock_timestamp())
           OR (
             status IN ('acquired', 'lease_expired')
             AND hard_reclaim_at > clock_timestamp()
           )
         )
    ) AS mismatched
  `);
  return rows[0]?.mismatched === true;
}

async function markTerminal(
  tx: Tx,
  input: AdmissionRequest,
  status: Extract<AdmissionStatus, 'cancelled' | 'rejected'>,
  reason: string,
): Promise<void> {
  await tx.execute(sql`
    UPDATE provider_session_admission
       SET status = ${status},
           terminal_at = clock_timestamp(),
           terminal_reason = ${reason}
     WHERE task_run_id = ${input.taskRunId}
       AND lane_id = ${input.plan.laneId}
       AND policy_fingerprint = ${input.plan.policy.fingerprint}
       AND mode = ${input.plan.mode}
       AND (
         status = 'waiting'
         OR (${status} = 'rejected' AND status = 'rejected')
       )
  `);
}

async function settleStoppedWaiter(
  input: AdmissionRequest,
  reason: 'cancelled' | 'wait_timeout',
): Promise<void> {
  try {
    const status = reason === 'cancelled' ? 'cancelled' : 'timed_out';
    const rows = await boundedAdmissionTransaction(
      input.db,
      performance.now() + TERMINAL_SETTLEMENT_BUDGET_MS,
      (tx) =>
        tx.execute<{ task_run_id: string }>(sql`
          UPDATE provider_session_admission
             SET status = ${status},
                 terminal_at = CASE
                   WHEN ${status} = 'timed_out'
                     THEN GREATEST(clock_timestamp(), wait_deadline_at)
                   ELSE clock_timestamp()
                 END,
                 terminal_reason = ${
                   reason === 'cancelled'
                     ? 'caller_aborted_while_waiting'
                     : 'caller_wait_deadline_elapsed'
}
           WHERE task_run_id = ${input.taskRunId}
             AND lane_id = ${input.plan.laneId}
             AND policy_fingerprint = ${input.plan.policy.fingerprint}
             AND mode = ${input.plan.mode}
             AND status = 'waiting'
          RETURNING task_run_id
        `),
    );
    if (rows?.length !== 1) {
      eventLog('warn', 'provider_session_terminal_settlement_deferred', input, { reason });
    }
  } catch (error) {
    eventLog('warn', 'provider_session_terminal_settlement_deferred', input, {
      reason,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function acquireWaitingRow(
  tx: Tx,
  input: AdmissionRequest,
  borrowedFromTaskRunId: string | null,
): Promise<{ row: AdmissionRow; measuredAtMonotonic: number }> {
  await tx.execute(sql`
    UPDATE provider_session_admission
       SET status = 'acquired',
           borrowed_from_task_run_id = ${borrowedFromTaskRunId},
           claim_token = ${input.claimToken},
           acquired_at = clock_timestamp(),
           heartbeat_at = clock_timestamp(),
           lease_expires_at = clock_timestamp() + (
             ${PROVIDER_SESSION_INITIAL_LEASE_TTL_MS}::double precision
             * interval '1 millisecond'
           ),
           hard_reclaim_at = clock_timestamp() + (
             ${hardReclaimHorizonMs(input.executionTimeoutMs)}::double precision
             * interval '1 millisecond'
           )
     WHERE task_run_id = ${input.taskRunId}
       AND lane_id = ${input.plan.laneId}
       AND policy_fingerprint = ${input.plan.policy.fingerprint}
       AND mode = ${input.plan.mode}
       AND status = 'waiting'
       AND wait_deadline_at > clock_timestamp()
  `);
  // `clock_timestamp()` advances within a transaction. If the deadline crossed
  // after the lane sweep but before the acquire CAS, settle timeout under the
  // same lock instead of surfacing a misleading control-plane error.
  await tx.execute(sql`
    UPDATE provider_session_admission
       SET status = 'timed_out',
           terminal_at = clock_timestamp(),
           terminal_reason = 'wait_deadline_elapsed'
     WHERE task_run_id = ${input.taskRunId}
       AND lane_id = ${input.plan.laneId}
       AND policy_fingerprint = ${input.plan.policy.fingerprint}
       AND mode = ${input.plan.mode}
       AND status = 'waiting'
       AND wait_deadline_at <= clock_timestamp()
  `);
  const snapshot = await readAdmissionRow(tx, input.taskRunId);
  const row = snapshot.row;
  if (!row) throw new Error(`admission row missing after acquire: ${input.taskRunId}`);
  requireRowIdentity(row, input);
  return { row, measuredAtMonotonic: snapshot.measuredAtMonotonic };
}

async function tick(input: AdmissionRequest): Promise<TickResult> {
  const result = await tryLaneTransaction(
    input.db,
    input.plan.laneId,
    input.callerDeadlineMonotonicAt,
    async (tx) => {
      await expireAndTrim(tx, input.plan.laneId);

      let snapshot = await readAdmissionRow(tx, input.taskRunId);
      let row = snapshot.row;
      if (row) requireRowIdentity(row, input);
      if (!row) {
        if (input.plan.mode === 'observe') {
          const borrowedFromTaskRunId = (await parentCanLendSlot(tx, input))
            ? (input.parentTaskRunId ?? null)
            : null;
          const observedSnapshot = await insertObservedAcquired(tx, input, borrowedFromTaskRunId);
          const observedRow = observedSnapshot.row;
          return {
            kind: 'acquired',
            claimToken: requireOwnedClaimToken(observedRow, input),
            borrowedFromTaskRunId: observedRow.borrowed_from_task_run_id,
            waitMs: Number(observedRow.wait_ms ?? 0),
            leaseDeadlineMonotonicAt: requireLeaseDeadlineMonotonicAt(
              observedRow,
              observedSnapshot.measuredAtMonotonic,
              input,
            ),
          } satisfies TickResult;
        }
        if (await policyMismatchExists(tx, input.plan.laneId, input.plan.policy.fingerprint)) {
          await insertWaitingOrRejected(tx, input);
          await markTerminal(tx, input, 'rejected', 'policy_mismatch');
          return { kind: 'terminal', reason: 'policy_mismatch' } satisfies TickResult;
        }
        const inserted = await insertWaitingOrRejected(tx, input);
        snapshot = await readAdmissionRow(tx, input.taskRunId);
        row = snapshot.row;
        if (row) requireRowIdentity(row, input);
        if (inserted === 'rejected' || row?.status === 'rejected') {
          return { kind: 'terminal', reason: 'queue_full' } satisfies TickResult;
        }
      }

      if (!row) throw new Error(`admission row missing: ${input.taskRunId}`);
      const terminal = terminalReason(row);
      if (terminal) return terminal;
      if (row.status === 'released' || row.status === 'lease_expired') {
        throw new Error(`cannot reacquire terminal provider session admission: ${input.taskRunId}`);
      }
      if (row.status === 'acquired') {
        return {
          kind: 'acquired',
          claimToken: requireOwnedClaimToken(row, input),
          borrowedFromTaskRunId: row.borrowed_from_task_run_id,
          waitMs: Number(row.wait_ms ?? 0),
          leaseDeadlineMonotonicAt: requireLeaseDeadlineMonotonicAt(
            row,
            snapshot.measuredAtMonotonic,
            input,
          ),
        } satisfies TickResult;
      }

      if (
        input.plan.mode === 'enforce' &&
        (await policyMismatchExists(tx, input.plan.laneId, input.plan.policy.fingerprint))
      ) {
        await markTerminal(tx, input, 'rejected', 'policy_mismatch');
        return { kind: 'terminal', reason: 'policy_mismatch' } satisfies TickResult;
      }

      if (!(await sessionStartCapacityAvailable(tx, input))) {
        return { kind: 'waiting' } satisfies TickResult;
      }

      const borrowedFromTaskRunId = (await parentCanLendSlot(tx, input))
        ? (input.parentTaskRunId ?? null)
        : null;
      if (
        borrowedFromTaskRunId === null &&
        (!(await isOldestWaiter(tx, input)) || !(await concurrentCapacityAvailable(tx, input)))
      ) {
        return { kind: 'waiting' } satisfies TickResult;
      }

      const acquiredSnapshot = await acquireWaitingRow(tx, input, borrowedFromTaskRunId);
      const acquiredRow = acquiredSnapshot.row;
      const acquireTerminal = terminalReason(acquiredRow);
      if (acquireTerminal) return acquireTerminal;
      if (acquiredRow.status !== 'acquired') return { kind: 'waiting' } satisfies TickResult;
      return {
        kind: 'acquired',
        claimToken: requireOwnedClaimToken(acquiredRow, input),
        borrowedFromTaskRunId: acquiredRow.borrowed_from_task_run_id,
        waitMs: Number(acquiredRow.wait_ms ?? 0),
        leaseDeadlineMonotonicAt: requireLeaseDeadlineMonotonicAt(
          acquiredRow,
          acquiredSnapshot.measuredAtMonotonic,
          input,
        ),
      } satisfies TickResult;
    },
  );
  return result ?? { kind: 'lock_busy' };
}

function waitForNextPoll(
  signal: AbortSignal,
  maxDelayMs: number,
  pollAttempt: number,
): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  const backoffMs = Math.min(POLL_MAX_MS, POLL_MIN_MS * 2 ** Math.min(pollAttempt, 4));
  const delayMs = Math.min(
    Math.max(0, maxDelayMs),
    backoffMs + Math.floor(Math.random() * POLL_JITTER_MS),
  );
  if (delayMs === 0) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

interface HeartbeatControl {
  assertProviderStartAllowed(): void;
  completeStartup(): Promise<void>;
  stop(): void;
}

function startHeartbeat(
  input: AdmissionRequest,
  claimToken: string,
  initialLeaseDeadlineMonotonicAt: number,
): HeartbeatControl {
  let stopped = false;
  let lostError: ProviderSessionAdmissionError | undefined;
  let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  let leaseDeadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let knownLeaseDeadlineMonotonicAt = initialLeaseDeadlineMonotonicAt;
  let leaseDeadlineRevision = 0;
  let leasePhase: 'startup' | 'transitioning' | 'steady' = 'startup';
  let startupTransitionInFlight = false;

  const clearTimers = () => {
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    if (leaseDeadlineTimer) clearTimeout(leaseDeadlineTimer);
    heartbeatTimer = undefined;
    leaseDeadlineTimer = undefined;
  };
  const loseLease = (cause: unknown): ProviderSessionAdmissionError | undefined => {
    if (stopped) return lostError;
    stopped = true;
    clearTimers();
    eventLog(
      input.plan.mode === 'enforce' ? 'error' : 'warn',
      'provider_session_lease_lost',
      input,
      {
        reason: cause instanceof Error ? cause.message : String(cause),
      },
    );
    if (input.plan.mode !== 'enforce') return undefined;
    lostError = new ProviderSessionAdmissionError({
      reason: 'lease_lost',
      laneId: input.plan.laneId,
      taskRunId: input.taskRunId,
      cause,
    });
    try {
      input.onLeaseLost(lostError);
    } catch (handlerError) {
      eventLog('error', 'provider_session_lease_lost_handler_error', input, {
        reason: handlerError instanceof Error ? handlerError.message : String(handlerError),
      });
    }
    return lostError;
  };
  const armLeaseDeadline = () => {
    if (stopped) return;
    if (leaseDeadlineTimer) clearTimeout(leaseDeadlineTimer);
    const remainingMs = knownLeaseDeadlineMonotonicAt - performance.now();
    if (remainingMs <= 0) {
      loseLease(new Error('lease renewal was not confirmed before the known lease deadline'));
      return;
    }
    leaseDeadlineTimer = setTimeout(
      () => loseLease(new Error('lease renewal was not confirmed before the known lease deadline')),
      remainingMs,
    );
  };
  const schedule = (delayMs: number) => {
    if (stopped) return;
    const scheduledRevision = leaseDeadlineRevision;
    const scheduledPhase = leasePhase;
    heartbeatTimer = setTimeout(async () => {
      heartbeatTimer = undefined;
      if (
        stopped ||
        scheduledRevision !== leaseDeadlineRevision ||
        scheduledPhase !== leasePhase ||
        leasePhase === 'transitioning'
      ) {
        return;
      }
      const renewalStartedAt = performance.now();
      try {
        const renewal = await renewLease(input, claimToken, knownLeaseDeadlineMonotonicAt);
        // Release may have stopped this heartbeat while the DB round trip was
        // in flight. In that case a zero-row renew is expected, not lease loss.
        if (
          stopped ||
          scheduledRevision !== leaseDeadlineRevision ||
          scheduledPhase !== leasePhase
        ) {
          return;
        }
        if (renewal.kind === 'fence_lost') {
          loseLease(new Error('lease fence no longer owned'));
          return;
        }
        if (renewal.kind === 'renewed') {
          // DB returns the actual remaining lease after LEAST(hard_reclaim_at,
          // now+TTL). Anchor it to the operation start, not response completion,
          // so driver/network latency can only shorten this local deadline.
          // Startup completion deliberately shrinks the initial 45s lease. A
          // heartbeat that began before or during that transition may return
          // the older, longer deadline after the transition CAS commits. Its
          // revision is stale and must not overwrite the shorter local fence.
          knownLeaseDeadlineMonotonicAt = renewalStartedAt + renewal.leaseRemainingMs;
          armLeaseDeadline();
          schedule(PROVIDER_SESSION_HEARTBEAT_MS);
          return;
        }
        eventLog('warn', 'provider_session_lease_renewal_deferred', input, {
          reason: 'lease operation budget exceeded',
          known_lease_remaining_ms: Math.max(0, knownLeaseDeadlineMonotonicAt - performance.now()),
        });
        const retryNotBefore = performance.now() + PROVIDER_SESSION_HEARTBEAT_RETRY_MS;
        // A pool-queue timeout returns before postgres-js gets a connection. Do
        // not enqueue another heartbeat behind that stale callback; wait for it
        // to obtain a connection, observe its expired budget, and settle first.
        // The independent lease-deadline timer remains the fail-closed bound.
        await renewal.underlyingSettled;
        if (
          stopped ||
          scheduledRevision !== leaseDeadlineRevision ||
          scheduledPhase !== leasePhase
        ) {
          return;
        }
        schedule(Math.max(0, retryNotBefore - performance.now()));
        return;
      } catch (cause) {
        if (
          stopped ||
          scheduledRevision !== leaseDeadlineRevision ||
          scheduledPhase !== leasePhase
        ) {
          return;
        }
        // A DB/network error is not proof that another owner took the fence.
        // Keep the prior DB-derived deadline and retry briefly; the independent
        // deadline timer remains the fail-closed bound.
        eventLog('warn', 'provider_session_lease_renewal_deferred', input, {
          reason: cause instanceof Error ? cause.message : String(cause),
          known_lease_remaining_ms: Math.max(0, knownLeaseDeadlineMonotonicAt - performance.now()),
        });
      }
      schedule(PROVIDER_SESSION_HEARTBEAT_RETRY_MS);
    }, delayMs);
  };

  const startupControlPlaneError = (cause: unknown) =>
    cause instanceof ProviderSessionAdmissionError
      ? cause
      : new ProviderSessionAdmissionError({
          reason: 'control_plane_unavailable',
          laneId: input.plan.laneId,
          taskRunId: input.taskRunId,
          cause,
        });

  const failStartupTransitionClosed = (cause: unknown): ProviderSessionAdmissionError => {
    const error = startupControlPlaneError(cause);
    if (!stopped) {
      stopped = true;
      clearTimers();
      lostError = error;
      eventLog('error', 'provider_session_startup_completion_unavailable', input, {
        reason: error.message,
      });
      try {
        input.onLeaseLost(error);
      } catch (handlerError) {
        eventLog('error', 'provider_session_lease_lost_handler_error', input, {
          reason: handlerError instanceof Error ? handlerError.message : String(handlerError),
        });
      }
    }
    return lostError ?? error;
  };

  const scheduleStartupTransitionRetry = (underlyingSettled?: Promise<void>): void => {
    const enqueue = () => {
      if (stopped || leasePhase !== 'transitioning') return;
      heartbeatTimer = setTimeout(
        () => void attemptStartupTransition(false),
        PROVIDER_SESSION_HEARTBEAT_RETRY_MS,
      );
    };
    if (underlyingSettled) {
      void underlyingSettled.then(enqueue, enqueue);
      return;
    }
    enqueue();
  };

  async function attemptStartupTransition(failClosed: boolean): Promise<void> {
    if (stopped || leasePhase !== 'transitioning' || startupTransitionInFlight) {
      if (lostError) throw lostError;
      return;
    }
    startupTransitionInFlight = true;
    const completionStartedAt = performance.now();
    try {
      const completion = await completeStartupLease(
        input,
        claimToken,
        knownLeaseDeadlineMonotonicAt,
      );
      if (stopped || leasePhase !== 'transitioning') {
        if (lostError) throw lostError;
        return;
      }
      if (completion.kind === 'fence_lost') {
        const error = loseLease(new Error('startup completion fence no longer owned'));
        if (error) throw error;
        return;
      }
      if (completion.kind === 'indeterminate') {
        const error = startupControlPlaneError(
          new Error('startup completion lease transition was not confirmed'),
        );
        if (failClosed) throw failStartupTransitionClosed(error);
        eventLog('warn', 'provider_session_startup_completion_deferred', input, {
          reason: error.message,
          known_lease_remaining_ms: Math.max(0, knownLeaseDeadlineMonotonicAt - performance.now()),
        });
        scheduleStartupTransitionRetry(completion.underlyingSettled);
        return;
      }

      knownLeaseDeadlineMonotonicAt = completionStartedAt + completion.leaseRemainingMs;
      leasePhase = 'steady';
      leaseDeadlineRevision += 1;
      armLeaseDeadline();
      schedule(PROVIDER_SESSION_HEARTBEAT_MS);
      eventLog('log', 'provider_session_startup_completed', input, {
        steady_lease_remaining_ms: Math.max(0, knownLeaseDeadlineMonotonicAt - performance.now()),
      });
    } catch (cause) {
      if (stopped && lostError) throw lostError;
      if (failClosed) throw failStartupTransitionClosed(cause);
      const error = startupControlPlaneError(cause);
      eventLog('warn', 'provider_session_startup_completion_deferred', input, {
        reason: error.message,
        known_lease_remaining_ms: Math.max(0, knownLeaseDeadlineMonotonicAt - performance.now()),
      });
      scheduleStartupTransitionRetry();
    } finally {
      startupTransitionInFlight = false;
    }
  }

  armLeaseDeadline();
  schedule(PROVIDER_SESSION_HEARTBEAT_MS);
  return {
    assertProviderStartAllowed() {
      if (lostError) throw lostError;
      if (
        !stopped &&
        knownLeaseDeadlineMonotonicAt - performance.now() <= LEASE_OPERATION_BUDGET_MS
      ) {
        const error = loseLease(
          new Error(
            'provider session has no confirmed lease-operation margin after event-loop stall',
          ),
        );
        if (error) throw error;
      }
    },
    async completeStartup() {
      if (leasePhase === 'steady' || stopped) {
        if (lostError) throw lostError;
        return;
      }
      if (leasePhase === 'transitioning') return;

      // From this point an ambiguous DB outcome may already have committed the
      // shorter lease. Adopt that conservative deadline locally before issuing
      // the CAS, and invalidate every heartbeat response already in flight.
      const transitionStartedAt = performance.now();
      leasePhase = 'transitioning';
      leaseDeadlineRevision += 1;
      if (heartbeatTimer) clearTimeout(heartbeatTimer);
      heartbeatTimer = undefined;
      knownLeaseDeadlineMonotonicAt = Math.min(
        knownLeaseDeadlineMonotonicAt,
        transitionStartedAt + PROVIDER_SESSION_LEASE_TTL_MS,
      );
      armLeaseDeadline();
      await attemptStartupTransition(input.plan.mode === 'enforce');
      if (input.plan.mode === 'observe' && leasePhase === 'transitioning') {
        eventLog('warn', 'provider_session_observe_failed_open', input, {
          reason: 'startup completion is pending control-plane recovery',
        });
      }
    },
    stop() {
      if (stopped) return;
      stopped = true;
      clearTimers();
    },
  };
}

/**
 * Acquire one central provider-session permit. `observe` instruments but explicitly
 * fails open; `enforce` fails closed on every control-plane ambiguity.
 */
export async function acquireProviderSession(
  input: Omit<AdmissionRequest, 'claimToken' | 'callerDeadlineMonotonicAt'> & {
    deadlineAt?: number;
  },
): Promise<ProviderSessionPermit> {
  // A stable per-invocation fence lets this caller recover an ambiguous commit,
  // while a second process reusing the same taskRunId cannot inherit the first
  // process's lease and start another provider session.
  const { deadlineAt, ...requestInput } = input;
  if (deadlineAt !== undefined && !Number.isFinite(deadlineAt)) {
    throw new Error('provider session admission deadlineAt must be finite');
  }
  const externalRemainingMs =
    deadlineAt === undefined ? Number.POSITIVE_INFINITY : deadlineAt - Date.now();
  const callerWaitBudgetMs = Math.max(
    0,
    Math.min(input.plan.policy.maxWaitMs, externalRemainingMs),
  );
  const request: AdmissionRequest = {
    ...requestInput,
    claimToken: randomUUID(),
    callerDeadlineMonotonicAt: performance.now() + callerWaitBudgetMs,
  };
  if (
    request.plan.policy.maxWaitMs +
      PROVIDER_SESSION_INITIAL_LEASE_TTL_MS +
      request.executionTimeoutMs +
      PROVIDER_SESSION_ABORT_GRACE_MS >=
    STUCK_RUN_SAFETY_BOUND_MS
  ) {
    throw new ProviderSessionAdmissionError({
      reason: 'control_plane_unavailable',
      laneId: request.plan.laneId,
      taskRunId: request.taskRunId,
      cause: new Error(
        'admission wait + SDK startup + execution timeout + abort grace must stay below the 1h stuck-run threshold',
      ),
    });
  }

  eventLog('log', 'provider_session_requested', request, {
    parent_task_run_id: request.parentTaskRunId ?? null,
  });
  const callerDeadlineMonotonicAt = request.callerDeadlineMonotonicAt;
  let waitLogged = false;
  let sawWaitingRow = false;
  let pollAttempt = 0;
  try {
    while (true) {
      const cancelAtEntry = request.signal.aborted;
      const deadlineAtEntry = performance.now() >= callerDeadlineMonotonicAt;
      if (cancelAtEntry) {
        if (sawWaitingRow) await settleStoppedWaiter(request, 'cancelled');
        throw callerStopError(request, 'cancelled');
      }
      if (deadlineAtEntry) {
        if (sawWaitingRow) await settleStoppedWaiter(request, 'wait_timeout');
        throw callerStopError(request, 'wait_timeout');
      }

      const result = await tick(request);
      if (result.kind === 'acquired') {
        if (request.signal.aborted || performance.now() >= request.callerDeadlineMonotonicAt) {
          await releaseLease(request, result.claimToken, result.borrowedFromTaskRunId);
          throw callerStopError(request, request.signal.aborted ? 'cancelled' : 'wait_timeout');
        }
        eventLog('log', 'provider_session_acquired', request, {
          wait_ms: result.waitMs,
          borrowed_from_task_run_id: result.borrowedFromTaskRunId,
          initial_lease_remaining_ms: Math.max(
            0,
            result.leaseDeadlineMonotonicAt - performance.now(),
          ),
        });
        const heartbeat = startHeartbeat(
          request,
          result.claimToken,
          result.leaseDeadlineMonotonicAt,
        );
        let released = false;
        return {
          mode: request.plan.mode,
          laneId: request.plan.laneId,
          borrowedFromTaskRunId: result.borrowedFromTaskRunId,
          assertProviderStartAllowed() {
            heartbeat.assertProviderStartAllowed();
          },
          async completeStartup() {
            await heartbeat.completeStartup();
          },
          async release() {
            if (released) return;
            released = true;
            heartbeat.stop();
            await releaseLease(request, result.claimToken, result.borrowedFromTaskRunId);
          },
        };
      }
      if (result.kind === 'terminal') {
        eventLog('warn', `provider_session_${result.reason}`, request);
        throw new ProviderSessionAdmissionError({
          reason: result.reason,
          laneId: request.plan.laneId,
          taskRunId: request.taskRunId,
        });
      }
      if (result.kind === 'waiting') sawWaitingRow = true;
      if (request.signal.aborted || performance.now() >= callerDeadlineMonotonicAt) continue;
      if (!waitLogged) {
        waitLogged = true;
        eventLog('log', 'provider_session_waiting', request);
      }
      await waitForNextPoll(
        request.signal,
        callerDeadlineMonotonicAt - performance.now(),
        pollAttempt,
      );
      pollAttempt += 1;
    }
  } catch (error) {
    if (error instanceof ProviderSessionAdmissionError) {
      if (request.plan.mode === 'observe' && error.reason === 'wait_timeout') {
        eventLog('warn', 'provider_session_observe_failed_open', request, {
          reason: error.message,
        });
        return NOOP_PERMIT(request.plan.laneId);
      }
      throw error;
    }
    eventLog(
      request.plan.mode === 'enforce' ? 'error' : 'warn',
      'provider_session_control_plane_error',
      request,
      {
        reason: error instanceof Error ? error.message : String(error),
      },
    );
    if (request.plan.mode === 'observe') {
      eventLog('warn', 'provider_session_observe_failed_open', request);
      return NOOP_PERMIT(request.plan.laneId);
    }
    throw new ProviderSessionAdmissionError({
      reason: 'control_plane_unavailable',
      laneId: request.plan.laneId,
      taskRunId: request.taskRunId,
      cause: error,
    });
  }
}
