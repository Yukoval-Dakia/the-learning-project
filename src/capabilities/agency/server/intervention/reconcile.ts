import { randomUUID } from 'node:crypto';
import { type SQL, and, asc, eq, gt, or, sql } from 'drizzle-orm';
import type { Job, JobWithMetadata } from 'pg-boss';
import type { Db } from '@/db/client';
import { intervention } from '@/db/schema';
import { eventCorrectionLockKey, eventCorrectionsGlobalLockKey } from '@/kernel/events';
import { getRunningBoss } from '@/server/boss/client';
import { fromPgBossDrizzleTx } from '@/server/boss/pg-boss-drizzle';
import {
  PREPARE_INTERVENTION_JOB,
  type PrepareInterventionJobData,
} from './probe-result-subscription';
import {
  failInterventionPreparation,
  loadInterventionVersion,
  updatePreparationJobId,
} from './store';

const LIVE_JOB_STATES: ReadonlySet<string> = new Set(['created', 'retry', 'active']);
const RECOVERY_SCAN_LIMIT = 100;

export interface InterventionPrepareRecoveryBoss {
  getJobById(
    name: typeof PREPARE_INTERVENTION_JOB,
    id: string,
  ): Promise<Pick<JobWithMetadata, 'state'> | null>;
  send(
    name: typeof PREPARE_INTERVENTION_JOB,
    data: PrepareInterventionJobData,
    options: { id: string; db: ReturnType<typeof fromPgBossDrizzleTx> },
  ): Promise<string | null>;
}

export interface InterventionPrepareRecoveryReport {
  scanned: number;
  live: number;
  reenqueued: number;
  terminalized: number;
  raced: number;
  failed: number;
}

export interface InterventionSettlementRecoveryReport {
  scanned: number;
  ensured: number;
  raced: number;
  failed: number;
}

/**
 * Recreate eligible diagnostic questions/FSRS cards after restoring an archive
 * created before or during YUK-792. Completed one-shot diagnostics are retained
 * as immutable questions but are not re-enrolled.
 */
export async function recoverEligibleInterventionDiagnostics(
  db: Db,
  now = new Date(),
): Promise<InterventionSettlementRecoveryReport> {
  const report: InterventionSettlementRecoveryReport = {
    scanned: 0,
    ensured: 0,
    raced: 0,
    failed: 0,
  };
  let cursor: { updatedAt: Date; id: string; version: number } | null = null;
  let materializeInterventionDiagnostics:
    | typeof import('@/capabilities/practice/public')['materializeInterventionDiagnostics']
    | null = null;

  while (true) {
    const activeEligible = and(
      eq(intervention.status, 'active'),
      eq(intervention.delivery_mode, 'eligible'),
    );
    const afterCursor: SQL<unknown> | undefined =
      cursor === null
        ? undefined
        : or(
            gt(intervention.updated_at, cursor.updatedAt),
            and(eq(intervention.updated_at, cursor.updatedAt), gt(intervention.id, cursor.id)),
            and(
              eq(intervention.updated_at, cursor.updatedAt),
              eq(intervention.id, cursor.id),
              gt(intervention.version, cursor.version),
            ),
          );
    const rows: Array<{ id: string; version: number; updatedAt: Date }> = await db
      .select({
        id: intervention.id,
        version: intervention.version,
        updatedAt: intervention.updated_at,
      })
      .from(intervention)
      .where(afterCursor ? and(activeEligible, afterCursor) : activeEligible)
      .orderBy(asc(intervention.updated_at), asc(intervention.id), asc(intervention.version))
      .limit(RECOVERY_SCAN_LIMIT);
    if (rows.length === 0) break;
    report.scanned += rows.length;
    if (!materializeInterventionDiagnostics) {
      ({ materializeInterventionDiagnostics } = await import('@/capabilities/practice/public'));
    }
    const materialize = materializeInterventionDiagnostics;

    for (const row of rows) {
      try {
        const outcome = await db.transaction(async (tx) => {
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(hashtextextended(${`intervention:${row.id}:${row.version}`}, 0))`,
          );
          const current = await loadInterventionVersion(tx, row.id, row.version);
          if (
            !current ||
            current.status !== 'active' ||
            current.delivery_mode !== 'eligible' ||
            !current.package ||
            !current.settlement
          ) {
            return 'raced' as const;
          }
          await materialize(tx, {
            package: current.package,
            settlement: current.settlement,
            snapshot: current.snapshot,
            // Recovery may be materializing a pre-deploy eligible row for the
            // first time. Place its immediate delivery in today's stream while
            // preserving the immutable due times already frozen in settlement.
            now,
          });
          return 'ensured' as const;
        });
        report[outcome] += 1;
      } catch (error) {
        report.failed += 1;
        console.warn('[intervention_settlement_recovery] row failed', {
          intervention_id: row.id,
          version: row.version,
          error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
        });
      }
    }

    const last = rows.at(-1);
    if (!last || rows.length < RECOVERY_SCAN_LIMIT) break;
    cursor = { updatedAt: last.updatedAt, id: last.id, version: last.version };
  }
  return report;
}

/**
 * Recreate operational pg-boss work for durable `preparing` aggregates.
 *
 * Backup/restore intentionally preserves the business aggregate but not pg-boss
 * rows. A frequent recovery job therefore checks queue liveness, reserves a
 * fresh job UUID when the archived id is missing, and makes retry exhaustion
 * visible as a terminal aggregate failure instead of paying forever.
 */
export async function recoverPreparingInterventions(
  db: Db,
  boss: InterventionPrepareRecoveryBoss,
  now = new Date(),
): Promise<InterventionPrepareRecoveryReport> {
  const rows = await db
    .select({
      id: intervention.id,
      version: intervention.version,
      idempotency_key: intervention.idempotency_key,
      preparation_job_id: intervention.preparation_job_id,
      source_probe_result_event_id: intervention.source_probe_result_event_id,
    })
    .from(intervention)
    .where(eq(intervention.status, 'preparing'))
    .orderBy(asc(intervention.updated_at), asc(intervention.id), asc(intervention.version))
    .limit(RECOVERY_SCAN_LIMIT);
  const report: InterventionPrepareRecoveryReport = {
    scanned: rows.length,
    live: 0,
    reenqueued: 0,
    terminalized: 0,
    raced: 0,
    failed: 0,
  };

  for (const row of rows) {
    try {
      const existingJob = row.preparation_job_id
        ? await boss.getJobById(PREPARE_INTERVENTION_JOB, row.preparation_job_id)
        : null;
      if (existingJob && LIVE_JOB_STATES.has(existingJob.state)) {
        report.live += 1;
        continue;
      }
      if (existingJob) {
        if (!row.preparation_job_id) {
          throw new Error('terminal preparation job lookup had no aggregate job id');
        }
        const failed = await failInterventionPreparation(db, {
          interventionId: row.id,
          version: row.version,
          expectedPreparationJobId: row.preparation_job_id,
          failureCode: `preparation_job_${existingJob.state}`,
          now,
        });
        if (failed.status === 'preparation_failed') report.terminalized += 1;
        else report.raced += 1;
        continue;
      }

      const replacementJobId = randomUUID();
      const outcome = await db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${eventCorrectionsGlobalLockKey()}, 0))`,
        );
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${eventCorrectionLockKey(row.source_probe_result_event_id)}, 0))`,
        );
        const current = await loadInterventionVersion(tx, row.id, row.version);
        if (
          !current ||
          current.status !== 'preparing' ||
          current.preparation_job_id !== row.preparation_job_id
        ) {
          return 'raced' as const;
        }
        // The subscription replay uses the same source lock. Re-check after
        // acquiring it because the pre-lock liveness read may be stale: replay
        // can recreate the archived UUID while recovery is waiting.
        const jobAfterLock = current.preparation_job_id
          ? await boss.getJobById(PREPARE_INTERVENTION_JOB, current.preparation_job_id)
          : null;
        if (jobAfterLock) {
          return LIVE_JOB_STATES.has(jobAfterLock.state) ? ('live' as const) : ('raced' as const);
        }
        const sent = await boss.send(
          PREPARE_INTERVENTION_JOB,
          {
            intervention_id: current.id,
            version: current.version,
            idempotency_key: current.idempotency_key,
          },
          { id: replacementJobId, db: fromPgBossDrizzleTx(tx) },
        );
        await updatePreparationJobId(
          tx,
          current.id,
          current.version,
          sent ?? replacementJobId,
          now,
        );
        return 'reenqueued' as const;
      });
      report[outcome] += 1;
    } catch (error) {
      report.failed += 1;
      console.warn('[intervention_prepare_recovery] row failed', {
        intervention_id: row.id,
        version: row.version,
        error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
      });
    }
  }
  return report;
}

export function buildInterventionPrepareRecoveryHandler(
  db: Db,
): (jobs: Job<Record<string, never>>[]) => Promise<InterventionPrepareRecoveryReport> {
  return async () => {
    const boss = getRunningBoss();
    if (!boss) throw new Error('intervention prepare recovery requires the running pg-boss');
    const preparation = await recoverPreparingInterventions(
      db,
      boss as InterventionPrepareRecoveryBoss,
    );
    const settlement = await recoverEligibleInterventionDiagnostics(db);
    console.log('[intervention_prepare_recovery] settlement', settlement);
    return preparation;
  };
}
