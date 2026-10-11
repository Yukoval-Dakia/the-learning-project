import { DBOS } from '@dbos-inc/dbos-sdk';
import { drizzle } from 'drizzle-orm/postgres-js';
import { type Clock, PgBoss, systemClock } from 'pg-boss';
import postgres from 'postgres';
import { z } from 'zod';
import * as schema from '@/db/schema';
import { changePrunePhase, retireFailedPrune } from '@/server/durable/prune-family';
import { startPruneWorker, stopDurableWorker } from '@/server/durable/prune-worker';
import dbosPackage from '../../node_modules/@dbos-inc/dbos-sdk/package.json';
import pgBossPackage from '../../node_modules/pg-boss/package.json';
import { acceleratePruneCron, clockSearchPath, pruneDeclarations } from './fixture';

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
  let clockOffsetMs = 0;
  const clock: Clock = {
    ...systemClock,
    now: () => Date.now() + clockOffsetMs,
  };
  const boss = new PgBoss({
    connectionString: url.toString(),
    max: 2,
    supervise: false,
    schedule: cronTest,
    cronMonitorIntervalSeconds: 1,
    cronWorkerIntervalSeconds: 1,
    ...(cronTest ? { clock } : {}),
  });
  boss.on('error', (error) =>
    process.send?.({
      kind: cronTest && String(error).includes('producer fenced') ? 'cron-error' : 'failure',
      error: String(error),
      at: new Date().toISOString(),
    }),
  );
  let native: ReturnType<typeof acceleratePruneCron> | undefined;
  if (cronTest) {
    native = acceleratePruneCron(boss);
    // Observe and delay the real Timekeeper.onSendIt -> Manager.createJob SQL.
    // Keep the real forwarding SQL; the fixture controls its clock and barriers.
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
  const client = postgres(url.toString(), {
    max: 2,
    ssl: false,
    connect_timeout: 2,
    ...(cronTest ? { connection: { search_path: clockSearchPath } } : {}),
  });
  const db = drizzle(client, { schema });
  async function syncClock() {
    const [state] =
      await client`select offset_ms::float8 as offset_ms from prune_cron_clock.state where singleton`;
    clockOffsetMs = z.number().parse(state.offset_ms);
  }
  if (cronTest) await syncClock();
  await boss.start();
  try {
    const options = {
      boss,
      db,
      decl: cronTest
        ? pruneDeclarations.pruneEvents
        : {
            name: 'prune_job_events',
            backend: 'dbos',
            queue: 'fast',
            schedule: { cron: '0 4 * * *', tz: 'Asia/Shanghai' },
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
    process.send?.({
      kind: 'ready',
      pid: process.pid,
      runtime: {
        node: process.version,
        execPath: process.execPath,
        pgBoss: pgBossPackage.version,
        dbos: dbosPackage.version,
      },
    });
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
            z.object({ kind: z.literal('sync-clock') }),
            z.object({ kind: z.literal('pause-native') }),
            z.object({ kind: z.literal('arm-native'), at: z.iso.datetime() }),
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
        } else if (command.kind === 'sync-clock') {
          if (!cronTest) throw new Error('Clock control requires the cron fixture');
          await syncClock();
        } else if (command.kind === 'pause-native') {
          if (native) await native.pause();
        } else if (command.kind === 'arm-native') {
          if (!native) throw new Error('Native point requires the cron fixture');
          native.arm(new Date(command.at));
        } else {
          await stopDurableWorker();
          await boss.stop();
          await client.end();
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
    await client.end();
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
