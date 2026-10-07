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
  const cronTest = process.env.TLP_PRUNE_CRON_TEST === '1';
  let holdForward = cronTest;
  let releaseForward: (() => void) | undefined;
  const releaseBusiness = new Set<() => void>();
  const boss = new PgBoss({
    connectionString: url.toString(),
    max: 2,
    supervise: false,
    schedule: cronTest,
    cronMonitorIntervalSeconds: 1,
    cronWorkerIntervalSeconds: 1,
  });
  boss.on('error', (error) =>
    process.send?.({
      kind: cronTest && String(error).includes('producer fenced') ? 'cron-error' : 'failure',
      error: String(error),
      at: new Date().toISOString(),
    }),
  );
  if (cronTest) {
    // Observe and delay the real Timekeeper.onSendIt -> Manager.createJob SQL.
    // No fabricated tick, direct send, scheduler replacement or clock change.
    const adapter = boss.getDb();
    const execute = adapter.executeSql.bind(adapter);
    adapter.executeSql = async (text, values) => {
      if (!text.includes('INSERT INTO pgboss.') || !text.includes("'prune_job_events' as name"))
        return execute(text, values);
      const payload = z
        .array(z.object({ data: z.unknown() }).passthrough())
        .parse(JSON.parse(z.string().parse(values?.[0])));
      if (holdForward) {
        holdForward = false;
        await new Promise<void>((resolve) => {
          releaseForward = resolve;
          process.send?.({ kind: 'forward-held', payload, at: new Date().toISOString() });
        });
      }
      try {
        const result = await execute(text, values);
        process.send?.({ kind: 'forwarded', rows: result.rows, at: new Date().toISOString() });
        return result;
      } catch (error) {
        process.send?.({
          kind: 'forward-rejected',
          error: String(error),
          at: new Date().toISOString(),
        });
        throw error;
      }
    };
  }
  await boss.start();
  try {
    const options = {
      boss,
      db,
      decl: {
        name: 'prune_job_events',
        backend: 'dbos',
        queue: 'fast',
        schedule: { cron: cronTest ? '* * * * *' : '0 4 * * *', tz: 'Asia/Shanghai' },
      },
      reconcileIntervalMs: 50,
      boundary: async (boundary) => {
        if (cronTest && boundary === 'business-committed') {
          await new Promise<void>((resolve) => {
            releaseBusiness.add(resolve);
            process.send?.({
              kind: 'cron-business-held',
              workflowId: DBOS.workflowID,
              at: new Date().toISOString(),
            });
          });
          return;
        }
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
            z.object({ kind: z.literal('hold-legacy') }),
            z.object({ kind: z.literal('arm-forward') }),
            z.object({ kind: z.literal('release-forward') }),
            z.object({ kind: z.literal('release-business') }),
          ])
          .parse(message);
        if (command.kind === 'transition') await changePrunePhase(db, boss, command.phase);
        else if (command.kind === 'retire')
          await retireFailedPrune(db, 'pg-boss', command.id, command.reason);
        else if (command.kind === 'hold-legacy')
          await boss.offWork('prune_job_events', { wait: true });
        else if (command.kind === 'arm-forward') holdForward = true;
        else if (command.kind === 'release-forward') {
          holdForward = false;
          releaseForward?.();
          releaseForward = undefined;
        } else if (command.kind === 'release-business') {
          for (const release of releaseBusiness) release();
          releaseBusiness.clear();
        } else {
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
