// Durable dispatch owner for prepare_intervention. The business transaction
// binds a stable delivery identity on the aggregate (preparation_job_id); this
// drain is the only sender — it runs after commit, reads engine state to
// resolve ambiguous sends, and writes a job_events receipt for every delivery
// identity the engine accepted.
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { JobWithMetadata } from 'pg-boss';
import type { Db } from '@/db/client';
import { job_events } from '@/db/schema';
import { writeJobEvent } from '@/kernel/job-events';
import { lockInterventionCorrectionsAll, lockInterventionSource } from './intervention-lock';
import {
  failInterventionPreparation,
  loadInterventionVersion,
  updatePreparationJobId,
} from './store';

export const PREPARE_INTERVENTION_JOB = 'prepare_intervention';
const PREPARATION_DISPATCH_RECEIPT = 'preparation_dispatch_accepted';
const LIVE_JOB_STATES: ReadonlySet<string> = new Set(['created', 'retry', 'active']);

export interface PrepareInterventionJobData {
  intervention_id: string;
  version: number;
  idempotency_key: string;
  /**
   * Provider-wait count carried on redeliveries (YUK-2030). Every resend —
   * rearm, recovery floor, subscription replay — echoes the aggregate's
   * `preparation_waits` so a lost pg-boss row never resets the ladder.
   */
  provider_waits?: number;
}

export interface InterventionPreparationBoss {
  send(
    name: typeof PREPARE_INTERVENTION_JOB,
    data: PrepareInterventionJobData,
    options: { id: string; startAfter?: Date },
  ): Promise<string | null>;
  getJobById(
    name: typeof PREPARE_INTERVENTION_JOB,
    id: string,
  ): Promise<Pick<JobWithMetadata, 'state'> | null>;
}

/** Engine-acceptance receipt: durable proof the engine holds this delivery
 * identity, written only after a resolved send or a live readback. Idempotent —
 * the (aggregate, job id) pair is recorded at most once. */
export async function writePreparationDispatchReceipt(
  db: Db,
  input: { interventionId: string; version: number; preparationJobId: string },
): Promise<void> {
  await db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: job_events.id })
      .from(job_events)
      .where(
        and(
          eq(job_events.business_table, 'intervention'),
          eq(job_events.business_id, input.interventionId),
          eq(job_events.event_type, PREPARATION_DISPATCH_RECEIPT),
          sql`${job_events.payload}->>'preparation_job_id' = ${input.preparationJobId}`,
        ),
      )
      .limit(1);
    if (existing.length > 0) return;
    await writeJobEvent(tx, {
      business_table: 'intervention',
      business_id: input.interventionId,
      event_type: PREPARATION_DISPATCH_RECEIPT,
      payload: {
        intervention_version: input.version,
        preparation_job_id: input.preparationJobId,
        backend: 'pgboss',
      },
    });
  });
}

export type InterventionPreparationDrainOutcome =
  /** This pass delivered (or re-delivered) the bound identity to the engine. */
  | 'dispatched'
  /** The engine already holds a live delivery for the bound identity. */
  | 'live'
  /** The engine reports the bound delivery terminal while business is
   * unfinished; the aggregate was moved to its failed verdict instead of
   * re-paying a dead route. */
  | 'terminalized'
  /** A concurrent writer moved the aggregate between reads. */
  | 'raced'
  | 'not_preparing';

type EngineSendTruth =
  | { kind: 'sent' }
  | { kind: 'engine_row'; state: string }
  | { kind: 'burned' };

// Resolve what the engine actually holds for a bound identity after send. A
// null return names a pre-existing row — read it back rather than guessing.
async function sendAndReadBack(
  boss: InterventionPreparationBoss,
  row: {
    id: string;
    version: number;
    idempotency_key: string;
    preparation_waits: number;
    preparation_wait_until: Date | null;
  },
  jobId: string,
  now: Date,
): Promise<EngineSendTruth> {
  const startAfter =
    row.preparation_wait_until && row.preparation_wait_until.getTime() > now.getTime()
      ? row.preparation_wait_until
      : undefined;
  const sent = await boss.send(
    PREPARE_INTERVENTION_JOB,
    {
      intervention_id: row.id,
      version: row.version,
      idempotency_key: row.idempotency_key,
      ...(row.preparation_waits > 0 ? { provider_waits: row.preparation_waits } : {}),
    },
    { id: jobId, ...(startAfter ? { startAfter } : {}) },
  );
  if (sent !== null) return { kind: 'sent' };
  const readBack = await boss.getJobById(PREPARE_INTERVENTION_JOB, jobId);
  if (!readBack) return { kind: 'burned' };
  return { kind: 'engine_row', state: readBack.state };
}

/**
 * Deliver the aggregate's bound preparation identity exactly once at the
 * engine. Both the post-commit subscription path and the recovery floor call
 * this — concurrent callers converge on the persisted job id and the engine's
 * own dedup, so overlapping drains can never mint a second paid delivery.
 */
export async function drainInterventionPreparationDispatch(
  db: Db,
  boss: InterventionPreparationBoss,
  input: { interventionId: string; version: number },
  now = new Date(),
): Promise<InterventionPreparationDrainOutcome> {
  const row = await loadInterventionVersion(db, input.interventionId, input.version);
  if (row?.status !== 'preparing') return 'not_preparing';

  // Restored aggregates keep `preparing` with no bound delivery id. Bind a
  // fresh stable identity under the serialized locks before any engine call.
  let jobId = row.preparation_job_id;
  if (!jobId) {
    const minted = await db.transaction(async (tx) => {
      await lockInterventionCorrectionsAll(tx);
      await lockInterventionSource(tx, row.source_probe_result_event_id);
      const current = await loadInterventionVersion(tx, row.id, row.version);
      if (current?.status !== 'preparing' || current.preparation_job_id) {
        return null;
      }
      const fresh = randomUUID();
      await updatePreparationJobId(tx, current.id, current.version, fresh, now);
      return fresh;
    });
    if (!minted) return 'raced';
    jobId = minted;
  }

  const receipt = (boundId: string) =>
    writePreparationDispatchReceipt(db, {
      interventionId: row.id,
      version: row.version,
      preparationJobId: boundId,
    });

  const terminalize = async (boundId: string, state: string) => {
    await receipt(boundId);
    const failed = await failInterventionPreparation(db, {
      interventionId: row.id,
      version: row.version,
      expectedPreparationJobId: boundId,
      failureCode: `preparation_job_${state}`,
      now,
    });
    return failed.status === 'preparation_failed' ? ('terminalized' as const) : ('raced' as const);
  };

  const existingJob = await boss.getJobById(PREPARE_INTERVENTION_JOB, jobId);
  if (existingJob) {
    if (LIVE_JOB_STATES.has(existingJob.state)) {
      // Already accepted; make sure the receipt exists in case an earlier pass
      // crashed between acceptance and acknowledgement.
      await receipt(jobId);
      return 'live';
    }
    return terminalize(jobId, existingJob.state);
  }

  const truth = await sendAndReadBack(boss, row, jobId, now);
  if (truth.kind === 'sent') {
    await receipt(jobId);
    return 'dispatched';
  }
  if (truth.kind === 'engine_row') {
    if (LIVE_JOB_STATES.has(truth.state)) {
      // A concurrent drain won the send; the engine still holds exactly one
      // delivery for this identity.
      await receipt(jobId);
      return 'live';
    }
    return terminalize(jobId, truth.state);
  }

  // `burned`: send deduped the id but no engine row exists — the identity was
  // swept with the queue (archive restore). Rebind a fresh identity under the
  // serialized locks and deliver once; the CAS repoint is the fence.
  const rebound = await db.transaction(async (tx) => {
    await lockInterventionCorrectionsAll(tx);
    await lockInterventionSource(tx, row.source_probe_result_event_id);
    const current = await loadInterventionVersion(tx, row.id, row.version);
    if (current?.status !== 'preparing' || current.preparation_job_id !== jobId) {
      return null;
    }
    const fresh = randomUUID();
    await updatePreparationJobId(tx, current.id, current.version, fresh, now);
    return fresh;
  });
  if (!rebound) return 'raced';

  const retry = await sendAndReadBack(boss, row, rebound, now);
  if (retry.kind === 'sent') {
    await receipt(rebound);
    return 'dispatched';
  }
  if (retry.kind === 'engine_row') {
    if (LIVE_JOB_STATES.has(retry.state)) {
      await receipt(rebound);
      return 'live';
    }
    return terminalize(rebound, retry.state);
  }
  // Two burned identities in one pass is pathological; leave the aggregate
  // bound to the fresh id for the next drain.
  return 'raced';
}
