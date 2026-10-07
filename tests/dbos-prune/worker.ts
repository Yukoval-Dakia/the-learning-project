import { DBOS } from '@dbos-inc/dbos-sdk';
import { PgBoss } from 'pg-boss';
import { z } from 'zod';
import { db } from '@/db/client';
import { changePrunePhase, retireFailedPrune } from '@/server/durable/prune-family';
import { startPruneWorker, stopDurableWorker } from '@/server/durable/prune-worker';

async function main() {
  const url = new URL(z.url().parse(process.env.DATABASE_URL));
  if (
    process.env.TLP_PRUNE_TEST_PROCESS !== '1' ||
    !/^\/test_fork_\d+$/.test(url.pathname) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  )
    throw new Error('Prune fixture requires a fresh scoped test database');
  const boss = new PgBoss({
    connectionString: url.toString(),
    max: 2,
    supervise: false,
    schedule: false,
  });
  boss.on('error', (error) => process.send?.({ kind: 'failure', error: String(error) }));
  await boss.start();
  try {
    const options = {
      boss,
      db,
      decl: {
        name: 'prune_job_events',
        backend: 'dbos',
        queue: 'fast',
        schedule: { cron: '0 4 * * *', tz: 'Asia/Shanghai' },
      },
      reconcileIntervalMs: 50,
      boundary: async (boundary) => {
        if (process.env.TLP_PRUNE_PAUSE_AT !== boundary) return;
        process.send?.({ kind: 'boundary', boundary, pid: process.pid });
        await new Promise<void>(() => {});
      },
    } satisfies Parameters<typeof startPruneWorker>[0];
    const [workflow, repeated] = await Promise.all([
      startPruneWorker(options),
      startPruneWorker(options),
    ]);
    if (workflow !== repeated)
      throw new Error('Repeated same-process registration duplicated DBOS');
    process.send?.({ kind: 'ready', pid: process.pid });
    process.on('message', async (message) => {
      try {
        const command = z
          .discriminatedUnion('kind', [
            z.object({
              kind: z.literal('transition'),
              phase: z.enum(['pg-boss', 'draining-pg-boss', 'dbos', 'draining-dbos']),
            }),
            z.object({ kind: z.literal('retire'), id: z.string(), reason: z.string() }),
            z.object({ kind: z.literal('stop') }),
          ])
          .parse(message);
        if (command.kind === 'transition') await changePrunePhase(db, boss, command.phase);
        else if (command.kind === 'retire')
          await retireFailedPrune(db, 'pg-boss', command.id, command.reason);
        else {
          await stopDurableWorker();
          await boss.stop();
          process.exit(0);
        }
        process.send?.({ kind: 'ack' });
      } catch (error) {
        process.send?.({
          kind: 'rejected',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
    const workflowId = process.env.TLP_PRUNE_WORKFLOW_ID;
    if (workflowId) {
      const handle =
        process.env.TLP_PRUNE_RECOVER === '1'
          ? DBOS.retrieveWorkflow(workflowId)
          : await DBOS.startWorkflow(workflow, { workflowID: workflowId })(
              new Date('2026-10-07T00:00:00Z'),
              {},
            );
      await handle.getResult();
      process.send?.({
        kind: 'done',
        pid: process.pid,
        status: await handle.getStatus(),
        steps: await DBOS.listWorkflowSteps(workflowId),
      });
    }
  } catch (error) {
    process.send?.({
      kind: 'failure',
      error: error instanceof Error ? error.stack : String(error),
    });
    await stopDurableWorker();
    await boss.stop();
    process.exit(1);
  }
}
main().catch((error: unknown) => {
  process.send?.({ kind: 'failure', error: error instanceof Error ? error.stack : String(error) });
  process.exit(1);
});
