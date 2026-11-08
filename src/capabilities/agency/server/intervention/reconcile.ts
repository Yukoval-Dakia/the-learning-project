import { randomUUID } from 'node:crypto';
import { type SQL, and, asc, eq, gt, or } from 'drizzle-orm';
import type { Job } from 'pg-boss';
import type { Db } from '@/db/client';
import { withLearningStateLock } from '@/db/learning-state-lock';
import { intervention } from '@/db/schema';
import { materializeInterventionDiagnostics } from '@/kernel/records/intervention-diagnostic-materialize';
import { getRunningBoss } from '@/server/boss/client';
import {
  lockInterventionCorrectionsAll,
  lockInterventionInstance,
  lockInterventionSource,
} from './intervention-lock';
import {
  type InterventionPreparationBoss,
  drainInterventionPreparationDispatch,
} from './preparation-dispatch';
import { loadInterventionVersion, updatePreparationJobId } from './store';

const RECOVERY_SCAN_LIMIT = 100;

export type InterventionPrepareRecoveryBoss = InterventionPreparationBoss;

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
 * Recreate eligible diagnostic questions/FSRS cards after restoring an archive.
 * Completed one-shot diagnostics are retained as immutable questions but are not
 * re-enrolled.
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

    for (const row of rows) {
      try {
        const outcome = await withLearningStateLock(db, async (tx) => {
          await lockInterventionInstance(tx, row.id, row.version);
          const current = await loadInterventionVersion(tx, row.id, row.version);
          if (
            current?.status !== 'active' ||
            current.delivery_mode !== 'eligible' ||
            !current.package ||
            !current.settlement
          ) {
            return 'raced' as const;
          }
          await materializeInterventionDiagnostics(tx, {
            package: current.package,
            settlement: current.settlement,
            snapshot: current.snapshot,
            // Recovery may materialize an eligible row for the first time: place
            // its immediate delivery in today's stream while preserving the
            // immutable due times already frozen in settlement.
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
 * Backup/restore preserves aggregates but not pg-boss rows. Every row flows
 * through the single dispatch drain, which binds missing delivery identities,
 * re-delivers lost sends under the persisted job id, and turns retry
 * exhaustion into a terminal aggregate failure instead of paying forever.
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
      const outcome = await drainInterventionPreparationDispatch(
        db,
        boss,
        { interventionId: row.id, version: row.version },
        now,
      );
      report[
        outcome === 'dispatched' ? 'reenqueued' : outcome === 'not_preparing' ? 'raced' : outcome
      ] += 1;
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

export interface InterventionProviderWaitRearmInput {
  interventionId: string;
  version: number;
  idempotencyKey: string;
  /**
   * The still-running job being superseded. CAS guard: the repoint only lands
   * while the aggregate still names it, so a raced recovery or a concurrent
   * terminal flip makes the rearm a no-op instead of a rogue redelivery.
   */
  supersededJobId: string;
  /** Wait count recorded on the replacement job data. */
  waits: number;
  delayMs: number;
}

/**
 * Provider-wait rearm (YUK-2030): a `prepare_intervention` delivery that hit a
 * proven transient provider rejection schedules its own replacement instead of
 * burning pg-boss retries against a dead route. The CAS repoint commits the
 * fresh delivery identity and the wait receipt durably; the shared drain then
 * delivers it after commit, so a lost send leaves the recovery floor — not a
 * rolled-back half-state — in charge.
 */
export async function rearmInterventionPreparationWait(
  db: Db,
  boss: InterventionPrepareRecoveryBoss,
  input: InterventionProviderWaitRearmInput,
  now = new Date(),
): Promise<'waiting' | 'raced'> {
  const [row] = await db
    .select({ source_probe_result_event_id: intervention.source_probe_result_event_id })
    .from(intervention)
    .where(and(eq(intervention.id, input.interventionId), eq(intervention.version, input.version)))
    .limit(1);
  if (!row) return 'raced';

  const repointed = await db.transaction(async (tx) => {
    await lockInterventionCorrectionsAll(tx);
    await lockInterventionSource(tx, row.source_probe_result_event_id);
    const current = await loadInterventionVersion(tx, input.interventionId, input.version);
    if (current?.status !== 'preparing' || current.preparation_job_id !== input.supersededJobId) {
      return false;
    }
    await updatePreparationJobId(tx, current.id, current.version, randomUUID(), now, {
      waits: input.waits,
      until: new Date(now.getTime() + input.delayMs),
    });
    return true;
  });
  if (!repointed) return 'raced';
  // The repoint is durable; the drain delivers the bound id with the persisted
  // provider_waits/startAfter. A send failure here stays recoverable — the
  // recovery floor re-drives the same identity.
  const outcome = await drainInterventionPreparationDispatch(
    db,
    boss,
    { interventionId: input.interventionId, version: input.version },
    now,
  );
  return outcome === 'dispatched' || outcome === 'live' ? 'waiting' : 'raced';
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
