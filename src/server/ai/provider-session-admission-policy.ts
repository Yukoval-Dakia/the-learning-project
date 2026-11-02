/**
 * Provider-session admission policy: mode and lane-plan parsing, plus the
 * capacity predicates that decide whether a waiter may take or borrow a slot.
 * Acquire, the tick loop, and heartbeat stay in provider-session-admission.ts.
 * Lease CAS stays in provider-session-lease.ts.
 */

import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Provider } from '@/ai/registry';
import { getConfig } from '@/core/config/store';
import type { Db, Tx } from '@/db/client';
import { provider_session_admission } from '@/db/schema';
import { readProviderId } from '@/server/ai/providers';

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
// YUK-1007 — config keys mirror their env names (both registered).
const MODE_KEY = MODE_ENV;
const POLICIES_KEY = POLICIES_ENV;
const RAW_POLICY_KEYS = new Set<keyof RawLanePolicy>([
  'maxConcurrentSessions',
  'maxSessionStartsPerMinute',
  'maxQueuedSessions',
  'maxWaitMs',
]);

export const PROVIDER_SESSION_RATE_WINDOW_MS = 60_000;
export const PROVIDER_SESSION_INITIAL_LEASE_TTL_MS = 45_000;
export const PROVIDER_SESSION_LEASE_TTL_MS = 15_000;
export const PROVIDER_SESSION_HEARTBEAT_MS = 5_000;
export const PROVIDER_SESSION_SDK_STARTUP_TIMEOUT_MS =
  PROVIDER_SESSION_INITIAL_LEASE_TTL_MS - PROVIDER_SESSION_HEARTBEAT_MS;
export const PROVIDER_SESSION_ABORT_GRACE_MS = 30_000;
export const PROVIDER_SESSION_RETENTION_MS = 7 * 24 * 60 * 60_000;

const DEFAULT_MAX_QUEUED_SESSIONS = 32;
const DEFAULT_MAX_WAIT_MS = 30_000;
const MAX_WAIT_MS = 5 * 60_000;

export const LEASE_OPERATION_BUDGET_MS = 1_000;

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
        sdkStartupTimeoutMs: PROVIDER_SESSION_SDK_STARTUP_TIMEOUT_MS,
        initialLeaseTtlMs: PROVIDER_SESSION_INITIAL_LEASE_TTL_MS,
        renewalLeaseTtlMs: PROVIDER_SESSION_LEASE_TTL_MS,
        heartbeatMs: PROVIDER_SESSION_HEARTBEAT_MS,
        leaseProtocolVersion: 2,
        providerStartLeaseMarginMs: LEASE_OPERATION_BUDGET_MS,
        abortGraceMs: PROVIDER_SESSION_ABORT_GRACE_MS,
      }),
    )
    .digest('hex');
}

export function hardReclaimHorizonMs(executionTimeoutMs: number): number {
  // Adapter startup is intentionally outside the model execution timer, so its
  // bounded phase must be in the DB reclaim horizon or a live attempt could
  // outlast its capacity fence.
  return (
    PROVIDER_SESSION_INITIAL_LEASE_TTL_MS + executionTimeoutMs + PROVIDER_SESSION_ABORT_GRACE_MS
  );
}

function parsePolicies(
  raw: string | Record<string, unknown> | undefined,
): Map<Provider, ProviderSessionLanePolicy> {
  // YUK-1007 — env carries JSON text, DB stores parsed objects (registry schema
  // validates shape, the writer rejects provider keys). Both use this one check;
  // the existing error messages stay unchanged.
  let parsed: unknown;
  if (typeof raw === 'string') {
    if (!raw.trim()) {
      throw new Error(`${POLICIES_ENV} is required when ${MODE_ENV} is observe or enforce`);
    }
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(`${POLICIES_ENV} must be valid JSON`, { cause: error });
    }
  } else if (raw === undefined) {
    throw new Error(`${POLICIES_ENV} is required when ${MODE_ENV} is observe or enforce`);
  } else {
    parsed = raw;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${POLICIES_ENV} must be an object keyed by provider lane`);
  }

  const policies = new Map<Provider, ProviderSessionLanePolicy>();
  for (const [laneId, rawPolicy] of Object.entries(parsed)) {
    const provider = readProviderId(laneId);
    if (!provider) {
      throw new Error(`${POLICIES_ENV} contains unknown provider lane '${laneId}'`);
    }
    if (policies.has(provider)) {
      throw new Error(
        `${POLICIES_ENV} contains both '${laneId}' and another id for provider '${provider}'`,
      );
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
      laneId: provider,
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
    policies.set(provider, { ...base, fingerprint: policyFingerprint(base) });
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
  // YUK-1007 — mode/policies resolve through the config face (DB > env > 'off');
  // the env argument is only the fallback layer for getConfig. An invalid mode
  // still throws: admission is a circuit breaker and must not fail open.
  const rawModeValue = getConfig(MODE_KEY, env);
  const rawMode =
    typeof rawModeValue === 'string' && rawModeValue !== '' ? rawModeValue.trim() : 'off';
  if (rawMode !== 'off' && rawMode !== 'observe' && rawMode !== 'enforce') {
    throw new Error(`${MODE_ENV} must be one of off | observe | enforce; received '${rawMode}'`);
  }
  if (rawMode === 'off') return { mode: 'off', laneId };

  const policy = parsePolicies(
    getConfig(POLICIES_KEY, env) as string | Record<string, unknown> | undefined,
  ).get(laneId);
  if (!policy) return { mode: 'off', laneId };
  return { mode: rawMode, laneId, policy };
}

export type AdmissionStatus =
  | 'waiting'
  | 'acquired'
  | 'released'
  | 'timed_out'
  | 'cancelled'
  | 'rejected'
  | 'lease_expired';

export interface AdmissionRow extends Record<string, unknown> {
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

export interface AdmissionRequest {
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

export async function expireAndTrim(tx: Tx, laneId: Provider): Promise<void> {
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

export async function readAdmissionRow(tx: Tx, taskRunId: string): Promise<AdmissionRowSnapshot> {
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

export function requireRowIdentity(row: AdmissionRow, input: AdmissionRequest): void {
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

export async function insertWaitingOrRejected(
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

export async function insertObservedAcquired(
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
      lease_expires_at: sql`clock_timestamp() + (${PROVIDER_SESSION_INITIAL_LEASE_TTL_MS}::double precision * interval '1 millisecond')`,
      hard_reclaim_at: sql`clock_timestamp() + (
        ${hardReclaimHorizonMs(input.executionTimeoutMs)}::double precision
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

export async function parentCanLendSlot(tx: Tx, input: AdmissionRequest): Promise<boolean> {
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

export async function sessionStartCapacityAvailable(
  tx: Tx,
  input: AdmissionRequest,
): Promise<boolean> {
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

export async function concurrentCapacityAvailable(
  tx: Tx,
  input: AdmissionRequest,
): Promise<boolean> {
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

export async function isOldestWaiter(tx: Tx, input: AdmissionRequest): Promise<boolean> {
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
