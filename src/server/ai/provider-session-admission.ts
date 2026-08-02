/**
 * Cross-process admission for central Claude Agent SDK query sessions (YUK-842).
 *
 * The admitted unit is deliberately a whole `sdkQuery()` session, not an HTTP
 * request. One session can contain multiple turns, nested SDK agents and the
 * Claude CLI's bounded internal retries. Keeping that name honest is important:
 * this module caps concurrent central session families/active branches and
 * session-start reservations per minute; it does not claim raw open-query count
 * or wire-level provider RPM.
 *
 * All coordination uses short Postgres transactions. No connection, row lock or
 * advisory lock is held while waiting or while the provider session runs.
 */

import { createHash, randomUUID } from 'node:crypto';
import type { Provider } from '@/ai/registry';
import type { Db, Tx } from '@/db/client';
import { provider_session_admission } from '@/db/schema';
import { isKnownProvider } from '@/server/ai/providers';
import { sql } from 'drizzle-orm';

export type ProviderSessionAdmissionMode = 'off' | 'observe' | 'enforce';

export interface ProviderSessionLanePolicy {
  laneId: Provider;
  /** Active roots/parallel branches; one nested descendant chain may share a root slot. */
  maxConcurrentSessions: number;
  maxSessionStartsPerMinute: number;
  maxQueuedSessions: number;
  maxWaitMs: number;
  fingerprint: string;
}

export type ProviderSessionAdmissionPlan =
  | { mode: 'off'; laneId: Provider; policy?: undefined }
  | {
      mode: 'observe' | 'enforce';
      laneId: Provider;
      policy: ProviderSessionLanePolicy;
    };

export type ProviderSessionAdmissionReason =
  | 'cancelled'
  | 'control_plane_unavailable'
  | 'lease_lost'
  | 'policy_mismatch'
  | 'queue_full'
  | 'wait_timeout';

export class ProviderSessionAdmissionError extends Error {
  readonly reason: ProviderSessionAdmissionReason;
  readonly laneId: Provider;
  readonly taskRunId: string;

  constructor(input: {
    reason: ProviderSessionAdmissionReason;
    laneId: Provider;
    taskRunId: string;
    cause?: unknown;
  }) {
    const causeMessage =
      input.cause instanceof Error
        ? `: ${input.cause.message}`
        : input.cause
          ? `: ${String(input.cause)}`
          : '';
    super(
      `provider session admission ${input.reason} for lane=${input.laneId} task_run_id=${input.taskRunId}${causeMessage}`,
    );
    this.name = 'ProviderSessionAdmissionError';
    this.reason = input.reason;
    this.laneId = input.laneId;
    this.taskRunId = input.taskRunId;
    if (input.cause !== undefined) this.cause = input.cause;
  }
}

interface RawLanePolicy {
  maxConcurrentSessions: number;
  maxSessionStartsPerMinute: number;
  maxQueuedSessions?: number;
  maxWaitMs?: number;
}

const MODE_ENV = 'AI_PROVIDER_SESSION_ADMISSION_MODE';
const POLICIES_ENV = 'AI_PROVIDER_SESSION_ADMISSION_POLICIES_JSON';
const RAW_POLICY_KEYS = new Set<keyof RawLanePolicy>([
  'maxConcurrentSessions',
  'maxSessionStartsPerMinute',
  'maxQueuedSessions',
  'maxWaitMs',
]);

export const PROVIDER_SESSION_RATE_WINDOW_MS = 60_000;
export const PROVIDER_SESSION_LEASE_TTL_MS = 15_000;
export const PROVIDER_SESSION_HEARTBEAT_MS = 5_000;
export const PROVIDER_SESSION_ABORT_GRACE_MS = 30_000;
export const PROVIDER_SESSION_RETENTION_MS = 7 * 24 * 60 * 60_000;
const PROVIDER_SESSION_HEARTBEAT_RETRY_MS = 500;
const DEFAULT_MAX_QUEUED_SESSIONS = 32;
const DEFAULT_MAX_WAIT_MS = 30_000;
const MAX_WAIT_MS = 5 * 60_000;
const STUCK_RUN_SAFETY_BOUND_MS = 60 * 60_000;
const POLL_MIN_MS = 100;
const POLL_MAX_MS = 1_000;
const POLL_JITTER_MS = 100;
const DB_STATEMENT_CEILING_MS = 1_000;
const DB_LOCK_CEILING_MS = 250;
const LEASE_OPERATION_BUDGET_MS = 1_000;
const TERMINAL_SETTLEMENT_BUDGET_MS = 250;

function readPositiveInteger(
  value: unknown,
  label: string,
  input: { min?: number; max: number },
): number {
  const min = input.min ?? 1;
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > input.max) {
    throw new Error(`${POLICIES_ENV}.${label} must be an integer in [${min}, ${input.max}]`);
  }
  return value as number;
}

function policyFingerprint(input: Omit<ProviderSessionLanePolicy, 'fingerprint'>): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        laneId: input.laneId,
        maxConcurrentSessions: input.maxConcurrentSessions,
        maxSessionStartsPerMinute: input.maxSessionStartsPerMinute,
        maxQueuedSessions: input.maxQueuedSessions,
        maxWaitMs: input.maxWaitMs,
        rateWindowMs: PROVIDER_SESSION_RATE_WINDOW_MS,
        leaseTtlMs: PROVIDER_SESSION_LEASE_TTL_MS,
        heartbeatMs: PROVIDER_SESSION_HEARTBEAT_MS,
        abortGraceMs: PROVIDER_SESSION_ABORT_GRACE_MS,
      }),
    )
    .digest('hex');
}

function parsePolicies(raw: string | undefined): Map<Provider, ProviderSessionLanePolicy> {
  if (!raw?.trim()) {
    throw new Error(`${POLICIES_ENV} is required when ${MODE_ENV} is observe or enforce`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${POLICIES_ENV} must be valid JSON`, { cause: error });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${POLICIES_ENV} must be an object keyed by provider lane`);
  }

  const policies = new Map<Provider, ProviderSessionLanePolicy>();
  for (const [laneId, rawPolicy] of Object.entries(parsed)) {
    if (!isKnownProvider(laneId)) {
      throw new Error(`${POLICIES_ENV} contains unknown provider lane '${laneId}'`);
    }
    if (!rawPolicy || typeof rawPolicy !== 'object' || Array.isArray(rawPolicy)) {
      throw new Error(`${POLICIES_ENV}.${laneId} must be an object`);
    }
    for (const key of Object.keys(rawPolicy)) {
      if (!RAW_POLICY_KEYS.has(key as keyof RawLanePolicy)) {
        throw new Error(`${POLICIES_ENV}.${laneId} contains unknown key '${key}'`);
      }
    }
    const value = rawPolicy as Partial<RawLanePolicy>;
    const base = {
      laneId,
      maxConcurrentSessions: readPositiveInteger(
        value.maxConcurrentSessions,
        `${laneId}.maxConcurrentSessions`,
        { max: 1_000 },
      ),
      maxSessionStartsPerMinute: readPositiveInteger(
        value.maxSessionStartsPerMinute,
        `${laneId}.maxSessionStartsPerMinute`,
        { max: 100_000 },
      ),
      maxQueuedSessions: readPositiveInteger(
        value.maxQueuedSessions ?? DEFAULT_MAX_QUEUED_SESSIONS,
        `${laneId}.maxQueuedSessions`,
        { max: 1_000 },
      ),
      maxWaitMs: readPositiveInteger(
        value.maxWaitMs ?? DEFAULT_MAX_WAIT_MS,
        `${laneId}.maxWaitMs`,
        {
          max: MAX_WAIT_MS,
        },
      ),
    } satisfies Omit<ProviderSessionLanePolicy, 'fingerprint'>;
    policies.set(laneId, { ...base, fingerprint: policyFingerprint(base) });
  }
  if (policies.size === 0) {
    throw new Error(`${POLICIES_ENV} must configure at least one provider lane`);
  }
  return policies;
}

/** Resolve once per lifecycle. An unlisted lane is an explicit, observable bypass. */
export function resolveProviderSessionAdmissionPlan(
  laneId: Provider,
  env: NodeJS.ProcessEnv = process.env,
): ProviderSessionAdmissionPlan {
  const rawMode = env[MODE_ENV]?.trim() || 'off';
  if (rawMode !== 'off' && rawMode !== 'observe' && rawMode !== 'enforce') {
    throw new Error(`${MODE_ENV} must be one of off | observe | enforce; received '${rawMode}'`);
  }
  if (rawMode === 'off') return { mode: 'off', laneId };

  const policy = parsePolicies(env[POLICIES_ENV]).get(laneId);
  if (!policy) return { mode: 'off', laneId };
  return { mode: rawMode, laneId, policy };
}

type AdmissionStatus =
  | 'waiting'
  | 'acquired'
  | 'released'
  | 'timed_out'
  | 'cancelled'
  | 'rejected'
  | 'lease_expired';

interface AdmissionRow extends Record<string, unknown> {
  lane_id: Provider;
  policy_fingerprint: string;
  mode: Exclude<ProviderSessionAdmissionMode, 'off'>;
  status: AdmissionStatus;
  claim_token: string | null;
  borrowed_from_task_run_id: string | null;
  terminal_reason: string | null;
  wait_ms: number | string | null;
  lease_remaining_ms: number | string | null;
}

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

interface AdmissionRequest {
  db: Db;
  kind: string;
  taskRunId: string;
  claimToken: string;
  callerDeadlineMonotonicAt: number;
  parentTaskRunId?: string;
  executionTimeoutMs: number;
  signal: AbortSignal;
  plan: Exclude<ProviderSessionAdmissionPlan, { mode: 'off' }>;
  onLeaseLost: (error: ProviderSessionAdmissionError) => void;
}

export interface ProviderSessionPermit {
  readonly mode: ProviderSessionAdmissionMode;
  readonly laneId: Provider;
  readonly borrowedFromTaskRunId: string | null;
  release(): Promise<void>;
}

const NOOP_PERMIT = (laneId: Provider): ProviderSessionPermit => ({
  mode: 'off',
  laneId,
  borrowedFromTaskRunId: null,
  async release() {},
});

function eventLog(
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
async function boundedAdmissionTransaction<T>(
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

async function expireAndTrim(tx: Tx, laneId: Provider): Promise<void> {
  await tx.execute(sql`
    UPDATE provider_session_admission
       SET status = 'lease_expired',
           terminal_at = clock_timestamp(),
           terminal_reason = 'heartbeat_expired'
     WHERE lane_id = ${laneId}
       AND status = 'acquired'
       AND lease_expires_at <= clock_timestamp()
  `);
  await tx.execute(sql`
    UPDATE provider_session_admission
       SET status = 'timed_out',
           terminal_at = clock_timestamp(),
           terminal_reason = 'wait_deadline_elapsed'
     WHERE lane_id = ${laneId}
       AND status = 'waiting'
       AND wait_deadline_at <= clock_timestamp()
  `);
  await tx.execute(sql`
    DELETE FROM provider_session_admission
     WHERE task_run_id IN (
       SELECT task_run_id
         FROM provider_session_admission
        WHERE lane_id = ${laneId}
          AND terminal_at < clock_timestamp() - (
            ${PROVIDER_SESSION_RETENTION_MS}::double precision * interval '1 millisecond'
          )
        ORDER BY terminal_at, task_run_id
        LIMIT 100
     )
  `);
}

interface AdmissionRowSnapshot {
  row: AdmissionRow | undefined;
  measuredAtMonotonic: number;
}

async function readAdmissionRow(tx: Tx, taskRunId: string): Promise<AdmissionRowSnapshot> {
  // Anchor the DB-reported remaining lease immediately before the statement that
  // measures it. Earlier work in the same lane transaction must not consume a
  // freshly-created lease in the local monotonic timeline.
  const measuredAtMonotonic = performance.now();
  const rows = await tx.execute<AdmissionRow>(sql`
    SELECT lane_id,
           policy_fingerprint,
           mode,
           status,
           claim_token,
           borrowed_from_task_run_id,
           terminal_reason,
           CASE
             WHEN acquired_at IS NULL THEN NULL
             ELSE EXTRACT(EPOCH FROM (acquired_at - requested_at)) * 1000
           END AS wait_ms,
           CASE
             WHEN lease_expires_at IS NULL THEN NULL
             ELSE GREATEST(
               0,
               EXTRACT(EPOCH FROM (lease_expires_at - clock_timestamp())) * 1000
             )
           END AS lease_remaining_ms
      FROM provider_session_admission
     WHERE task_run_id = ${taskRunId}
     LIMIT 1
  `);
  return { row: rows[0], measuredAtMonotonic };
}

function requireRowIdentity(row: AdmissionRow, input: AdmissionRequest): void {
  if (
    row.lane_id !== input.plan.laneId ||
    row.policy_fingerprint !== input.plan.policy.fingerprint ||
    row.mode !== input.plan.mode
  ) {
    throw new Error(
      `provider session admission identity collision for task_run_id=${input.taskRunId}`,
    );
  }
}

function remainingCallerWaitMs(input: AdmissionRequest): number {
  // Keep the DB deadline tied to the caller's original budget even if the lane
  // lock was briefly busy before this row could be inserted.
  return Math.max(1, input.callerDeadlineMonotonicAt - performance.now());
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

async function insertWaitingOrRejected(
  tx: Tx,
  input: AdmissionRequest,
): Promise<'waiting' | 'rejected'> {
  const waiterRows = await tx.execute<{ count: number | string }>(sql`
    SELECT count(*) AS count
      FROM provider_session_admission
     WHERE lane_id = ${input.plan.laneId}
       AND status = 'waiting'
       AND wait_deadline_at > clock_timestamp()
  `);
  const queueFull = Number(waiterRows[0]?.count ?? 0) >= input.plan.policy.maxQueuedSessions;
  const status = queueFull ? 'rejected' : 'waiting';
  await tx
    .insert(provider_session_admission)
    .values({
      task_run_id: input.taskRunId,
      lane_id: input.plan.laneId,
      policy_fingerprint: input.plan.policy.fingerprint,
      mode: input.plan.mode,
      status,
      requested_at: sql`clock_timestamp()`,
      wait_deadline_at: sql`clock_timestamp() + (${remainingCallerWaitMs(input)}::double precision * interval '1 millisecond')`,
      terminal_at: queueFull ? sql`clock_timestamp()` : null,
      terminal_reason: queueFull ? 'queue_full' : null,
    })
    .onConflictDoNothing({ target: provider_session_admission.task_run_id });
  return status;
}

async function insertObservedAcquired(
  tx: Tx,
  input: AdmissionRequest,
  borrowedFromTaskRunId: string | null,
): Promise<{ row: AdmissionRow; measuredAtMonotonic: number }> {
  await tx
    .insert(provider_session_admission)
    .values({
      task_run_id: input.taskRunId,
      lane_id: input.plan.laneId,
      policy_fingerprint: input.plan.policy.fingerprint,
      mode: 'observe',
      status: 'acquired',
      borrowed_from_task_run_id: borrowedFromTaskRunId,
      claim_token: input.claimToken,
      requested_at: sql`clock_timestamp()`,
      wait_deadline_at: sql`clock_timestamp() + (${remainingCallerWaitMs(input)}::double precision * interval '1 millisecond')`,
      acquired_at: sql`clock_timestamp()`,
      heartbeat_at: sql`clock_timestamp()`,
      lease_expires_at: sql`clock_timestamp() + (${PROVIDER_SESSION_LEASE_TTL_MS}::double precision * interval '1 millisecond')`,
      hard_reclaim_at: sql`clock_timestamp() + (
        ${input.executionTimeoutMs + PROVIDER_SESSION_ABORT_GRACE_MS}::double precision
        * interval '1 millisecond'
      )`,
    })
    .onConflictDoNothing({ target: provider_session_admission.task_run_id });
  const snapshot = await readAdmissionRow(tx, input.taskRunId);
  const row = snapshot.row;
  if (!row) throw new Error(`observed admission row missing after insert: ${input.taskRunId}`);
  requireRowIdentity(row, input);
  return { row, measuredAtMonotonic: snapshot.measuredAtMonotonic };
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
             ${PROVIDER_SESSION_LEASE_TTL_MS}::double precision * interval '1 millisecond'
           ),
           hard_reclaim_at = clock_timestamp() + (
             ${input.executionTimeoutMs + PROVIDER_SESSION_ABORT_GRACE_MS}::double precision
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

async function parentCanLendSlot(tx: Tx, input: AdmissionRequest): Promise<boolean> {
  if (!input.parentTaskRunId || input.parentTaskRunId === input.taskRunId) return false;
  const rows = await tx.execute<{ can_lend: boolean }>(sql`
    WITH RECURSIVE descendants(task_run_id) AS (
      SELECT task_run_id
        FROM provider_session_admission
       WHERE borrowed_from_task_run_id = ${input.parentTaskRunId}
      UNION
      SELECT child.task_run_id
        FROM provider_session_admission child
        JOIN descendants parent_descendant
          ON child.borrowed_from_task_run_id = parent_descendant.task_run_id
    )
    SELECT EXISTS (
             SELECT 1
               FROM provider_session_admission parent
              WHERE parent.task_run_id = ${input.parentTaskRunId}
                AND parent.lane_id = ${input.plan.laneId}
                AND parent.policy_fingerprint = ${input.plan.policy.fingerprint}
                AND parent.mode = ${input.plan.mode}
                AND parent.status = 'acquired'
                AND parent.lease_expires_at > clock_timestamp()
                AND parent.hard_reclaim_at > clock_timestamp()
           )
           AND NOT EXISTS (
             SELECT 1
               FROM provider_session_admission active_descendant
               JOIN descendants
                 ON descendants.task_run_id = active_descendant.task_run_id
              WHERE active_descendant.status IN ('acquired', 'lease_expired')
                AND active_descendant.hard_reclaim_at > clock_timestamp()
           ) AS can_lend
  `);
  return rows[0]?.can_lend === true;
}

async function sessionStartCapacityAvailable(tx: Tx, input: AdmissionRequest): Promise<boolean> {
  const rows = await tx.execute<{ starts: number | string }>(sql`
    SELECT count(*) AS starts
      FROM provider_session_admission
     WHERE lane_id = ${input.plan.laneId}
       AND acquired_at >= clock_timestamp() - (
         ${PROVIDER_SESSION_RATE_WINDOW_MS}::double precision * interval '1 millisecond'
       )
  `);
  return Number(rows[0]?.starts ?? 0) < input.plan.policy.maxSessionStartsPerMinute;
}

async function concurrentCapacityAvailable(tx: Tx, input: AdmissionRequest): Promise<boolean> {
  const rows = await tx.execute<{ active: number | string }>(sql`
    SELECT count(*) AS active
      FROM provider_session_admission candidate
     WHERE candidate.lane_id = ${input.plan.laneId}
       AND candidate.status IN ('acquired', 'lease_expired')
       AND candidate.hard_reclaim_at > clock_timestamp()
       AND (
         candidate.borrowed_from_task_run_id IS NULL
         OR NOT EXISTS (
           SELECT 1
             FROM provider_session_admission parent
            WHERE parent.task_run_id = candidate.borrowed_from_task_run_id
              AND parent.lane_id = candidate.lane_id
              AND parent.policy_fingerprint = candidate.policy_fingerprint
              AND parent.mode = candidate.mode
              AND parent.status IN ('acquired', 'lease_expired')
              AND parent.hard_reclaim_at > clock_timestamp()
         )
       )
  `);
  return Number(rows[0]?.active ?? 0) < input.plan.policy.maxConcurrentSessions;
}

async function isOldestWaiter(tx: Tx, input: AdmissionRequest): Promise<boolean> {
  const rows = await tx.execute<{ task_run_id: string }>(sql`
    SELECT task_run_id
      FROM provider_session_admission
     WHERE lane_id = ${input.plan.laneId}
       AND status = 'waiting'
       AND wait_deadline_at > clock_timestamp()
     ORDER BY requested_at, task_run_id
     LIMIT 1
  `);
  return rows[0]?.task_run_id === input.taskRunId;
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

type LeaseRenewalResult =
  | { kind: 'renewed'; leaseRemainingMs: number }
  | { kind: 'fence_lost' }
  | { kind: 'indeterminate'; underlyingSettled: Promise<void> };

async function renewLease(
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
                 clock_timestamp() + (
                   ${PROVIDER_SESSION_LEASE_TTL_MS}::double precision * interval '1 millisecond'
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

function startHeartbeat(
  input: AdmissionRequest,
  claimToken: string,
  initialLeaseDeadlineMonotonicAt: number,
): () => void {
  let stopped = false;
  let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  let leaseDeadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let knownLeaseDeadlineMonotonicAt = initialLeaseDeadlineMonotonicAt;

  const clearTimers = () => {
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    if (leaseDeadlineTimer) clearTimeout(leaseDeadlineTimer);
    heartbeatTimer = undefined;
    leaseDeadlineTimer = undefined;
  };
  const loseLease = (cause: unknown) => {
    if (stopped) return;
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
    if (input.plan.mode !== 'enforce') return;
    try {
      input.onLeaseLost(
        new ProviderSessionAdmissionError({
          reason: 'lease_lost',
          laneId: input.plan.laneId,
          taskRunId: input.taskRunId,
          cause,
        }),
      );
    } catch (handlerError) {
      eventLog('error', 'provider_session_lease_lost_handler_error', input, {
        reason: handlerError instanceof Error ? handlerError.message : String(handlerError),
      });
    }
  };
  const armLeaseDeadline = () => {
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
    heartbeatTimer = setTimeout(async () => {
      if (stopped) return;
      const renewalStartedAt = performance.now();
      try {
        const renewal = await renewLease(input, claimToken, knownLeaseDeadlineMonotonicAt);
        // Release may have stopped this heartbeat while the DB round trip was
        // in flight. In that case a zero-row renew is expected, not lease loss.
        if (stopped) return;
        if (renewal.kind === 'fence_lost') {
          loseLease(new Error('lease fence no longer owned'));
          return;
        }
        if (renewal.kind === 'renewed') {
          // DB returns the actual remaining lease after LEAST(hard_reclaim_at,
          // now+TTL). Anchor it to the operation start, not response completion,
          // so driver/network latency can only shorten this local deadline.
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
        if (stopped) return;
        schedule(Math.max(0, retryNotBefore - performance.now()));
        return;
      } catch (cause) {
        if (stopped) return;
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
  armLeaseDeadline();
  schedule(PROVIDER_SESSION_HEARTBEAT_MS);
  return () => {
    if (stopped) return;
    stopped = true;
    clearTimers();
  };
}

async function releaseLease(
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

/**
 * Acquire one central SDK-session permit. `observe` instruments but explicitly
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
    request.plan.policy.maxWaitMs + request.executionTimeoutMs + PROVIDER_SESSION_ABORT_GRACE_MS >=
    STUCK_RUN_SAFETY_BOUND_MS
  ) {
    throw new ProviderSessionAdmissionError({
      reason: 'control_plane_unavailable',
      laneId: request.plan.laneId,
      taskRunId: request.taskRunId,
      cause: new Error(
        'admission wait + execution timeout + abort grace must stay below the 1h stuck-run threshold',
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
        });
        const stopHeartbeat = startHeartbeat(
          request,
          result.claimToken,
          result.leaseDeadlineMonotonicAt,
        );
        let released = false;
        return {
          mode: request.plan.mode,
          laneId: request.plan.laneId,
          borrowedFromTaskRunId: result.borrowedFromTaskRunId,
          async release() {
            if (released) return;
            released = true;
            stopHeartbeat();
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
