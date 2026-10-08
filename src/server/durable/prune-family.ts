import { DBOS } from '@dbos-inc/dbos-sdk';
import { sql } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import { z } from 'zod';
import type { Db } from '@/db/client';
import { runPruneJobEvents } from '@/server/boss/handlers/prune_job_events';
import { lockProducerFenceInstaller } from './producer-fence-lock';

export const PRUNE_FAMILY = 'prune_job_events';
export const PRUNE_DBOS_SCHEMA = 'tlp_dbos';
export const prunePhaseSchema = z.enum(['pg-boss', 'draining-pg-boss', 'dbos', 'draining-dbos']);
export type PrunePhase = z.infer<typeof prunePhaseSchema>;
type Executor = Pick<Db, 'execute'>;

export async function readPrunePhase(db: Executor): Promise<PrunePhase> {
  const rows = await db.execute(sql`select phase from prune_job_events_control`);
  return prunePhaseSchema.parse(rows[0]?.phase);
}

/** pg-boss forwards the previous cron point for 60 seconds, even after rollback. */
export async function hasRecentDbosPruneReceipt(db: Executor): Promise<boolean> {
  // Receipt cutoff is scheduledDate minus 30 * 86400 seconds; include the 60s lookback.
  const rows = await db.execute(sql`select exists (
    select 1 from prune_job_events_receipt
    where cutoff > clock_timestamp() - interval '2592060 seconds'
  ) as recent`);
  return z.boolean().parse(rows[0]?.recent);
}

export async function installPruneProducerFence(db: Db): Promise<void> {
  // All families replace triggers on the same relations; retain the family lock too.
  await db.transaction(async (tx) => {
    await lockProducerFenceInstaller(tx);
    await tx.execute(sql`select pg_advisory_xact_lock(1355, 1)`);
    for (const table of ['job', 'schedule']) {
      await tx.execute(sql.raw(`DROP TRIGGER IF EXISTS yuk1355_prune_producer ON pgboss.${table}`));
      await tx.execute(
        sql.raw(
          `CREATE TRIGGER yuk1355_prune_producer BEFORE INSERT OR UPDATE OF name ON pgboss.${table} FOR EACH ROW EXECUTE FUNCTION fence_prune_job_events_producer()`,
        ),
      );
    }
  });
}

/** One transaction owns the delete and receipt. A lost DBOS checkpoint reuses the receipt. */
export async function commitPrune(db: Db, workflowId: string, cutoff: Date) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select phase from prune_job_events_control for update`);
    const saved = await tx.execute(
      sql`select cutoff, deleted from prune_job_events_receipt where workflow_id = ${workflowId}`,
    );
    if (saved.length) {
      if (new Date(String(saved[0].cutoff)).getTime() !== cutoff.getTime())
        throw new Error('Prune workflow identity conflict');
      return { kind: 'committed' as const, deleted: z.number().parse(saved[0].deleted) };
    }
    const phase = await readPrunePhase(tx);
    if (phase !== 'dbos' && phase !== 'draining-dbos') return { kind: 'fenced' as const };
    const result = await runPruneJobEvents(tx, cutoff);
    await tx.execute(
      sql`insert into prune_job_events_receipt (workflow_id, cutoff, deleted) values (${workflowId}, ${cutoff.toISOString()}::timestamptz, ${result.deleted})`,
    );
    return { kind: 'committed' as const, ...result };
  });
}

export async function drainLegacyPrune(db: Db) {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select phase from prune_job_events_control for update`);
    const phase = await readPrunePhase(tx);
    if (
      (phase === 'pg-boss' || phase === 'draining-pg-boss') &&
      !(await hasRecentDbosPruneReceipt(tx))
    )
      await runPruneJobEvents(tx);
  });
}

export async function pruneObligations(db: Executor, backend: 'pg-boss' | 'dbos') {
  // Terminal failures remain obligations until a named, justified disposition. Never replay.
  if (backend === 'pg-boss') {
    return db.execute(sql`select j.id::text as task_id, j.state::text as state, j.name from pgboss.job j
      where j.name in ('prune_job_events','prune_job_events_dlq') and j.state <> 'completed'
      and not exists (select 1 from prune_job_events_disposition d where d.backend = 'pg-boss' and d.task_id = j.id::text and d.observed_state = j.state::text)`);
  }
  return db.execute(sql`select w.workflow_uuid as task_id, w.status as state from tlp_dbos.workflow_status w
    where w.name = 'prune_job_events' and w.status <> 'SUCCESS'
    and not exists (select 1 from prune_job_events_disposition d where d.backend = 'dbos' and d.task_id = w.workflow_uuid and d.observed_state = w.status)`);
}

export async function retireFailedPrune(
  db: Db,
  backend: 'pg-boss' | 'dbos',
  taskId: string,
  reason: string,
) {
  if (!reason.trim()) throw new Error('Disposition requires a reason');
  await db.transaction(async (tx) => {
    await tx.execute(sql`select phase from prune_job_events_control for update`);
    const rows = await pruneObligations(tx, backend);
    const row = rows.find((r) => r.task_id === taskId);
    const terminal =
      backend === 'pg-boss' ? ['failed', 'cancelled'] : ['ERROR', 'CANCELLED', 'RETRIES_EXCEEDED'];
    if (!row || !terminal.includes(String(row.state)))
      throw new Error('Only observed terminal prune failures may be retired');
    // A DLQ can contain unknown imported payloads. Keep it for explicit investigation.
    if (row.name === 'prune_job_events_dlq')
      throw new Error('Unexpected prune DLQ requires manual investigation');
    await tx.execute(
      sql`insert into prune_job_events_disposition (backend,task_id,observed_state,reason) values (${backend},${taskId},${String(row.state)},${reason})`,
    );
  });
}

export async function changePrunePhase(
  db: Db,
  boss: Pick<PgBoss, 'unschedule'>,
  target: PrunePhase,
  schedules: Pick<typeof DBOS, 'getSchedule' | 'pauseSchedule'> = DBOS,
) {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select phase from prune_job_events_control for update`);
    const current = await readPrunePhase(tx);
    if (current === target) return;
    const expected: Record<PrunePhase, PrunePhase> = {
      'draining-pg-boss': 'pg-boss',
      dbos: 'draining-pg-boss',
      'draining-dbos': 'dbos',
      'pg-boss': 'draining-dbos',
    };
    if (current !== expected[target])
      throw new Error(`Invalid prune transition ${current} -> ${target}`);
    if (target === 'dbos' || target === 'pg-boss') {
      const obligations = await pruneObligations(tx, target === 'dbos' ? 'pg-boss' : 'dbos');
      if (obligations.length)
        throw new Error(`Prune drain blocked: ${JSON.stringify(obligations)}`);
    }
    if (await schedules.getSchedule(PRUNE_FAMILY)) await schedules.pauseSchedule(PRUNE_FAMILY);
    await boss.unschedule(PRUNE_FAMILY);
    await tx.execute(sql`update prune_job_events_control set phase = ${target}`);
  });
}
