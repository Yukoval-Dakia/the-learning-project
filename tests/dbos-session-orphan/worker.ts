import { DBOS } from '@dbos-inc/dbos-sdk';
import { drizzle } from 'drizzle-orm/postgres-js';
import { PgBoss } from 'pg-boss';
import postgres from 'postgres';
import { z } from 'zod';
import * as schema from '@/db/schema';
import type {
  SessionOrphanBoundaryHook,
  SessionOrphanFamily,
} from '@/server/durable/session-orphan-family';
import type { SessionOrphanWorkflows } from '@/server/durable/session-orphan-worker';
import dbosPackage from '../../node_modules/@dbos-inc/dbos-sdk/package.json';
import pgBossPackage from '../../node_modules/pg-boss/package.json';

async function main() {
  const url = new URL(z.url().parse(process.env.DATABASE_URL));
  if (
    process.env.TLP_SESSION_TEST_PROCESS !== '1' ||
    !/^\/test_fork_\d+$/.test(url.pathname) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  )
    throw new Error('Session orphan fixture requires an isolated disposable fork DB');
  const appUrl = new URL(process.env.TLP_SESSION_APP_DATABASE_URL ?? url.toString());
  if (
    appUrl.pathname !== url.pathname ||
    !['localhost', '127.0.0.1', '[::1]'].includes(appUrl.hostname) ||
    (appUrl.toString() !== url.toString() && process.env.TLP_SESSION_APP_PROXY !== '1')
  )
    throw new Error('Application proxy must target the same disposable DB');
  const appClient = postgres(appUrl.toString(), { max: 2, ssl: false, connect_timeout: 2 });
  const db = drizzle(appClient, { schema });
  const family = await import('@/server/durable/session-orphan-family');
  const backend = await import('@/server/durable/session-orphan-backend');
  const selectedFamily: SessionOrphanFamily = family.sessionOrphanFamilySchema.parse(
    process.env.TLP_SESSION_FAMILY,
  );
  const host = await import('@/server/durable/prune-worker');
  const cron = process.env.TLP_SESSION_CRON_TEST === '1';
  let holdForward = cron;
  let releaseForward: (() => void) | undefined;
  const heldRows = new Set<() => void>();
  const boss = new PgBoss({
    connectionString: url.toString(),
    max: 2,
    supervise: false,
    schedule: cron,
    cronMonitorIntervalSeconds: 1,
    cronWorkerIntervalSeconds: 1,
  });
  boss.on('error', (error) =>
    process.send?.({
      kind: String(error).includes('producer fenced') ? 'cron-error' : 'failure',
      error: String(error),
    }),
  );
  if (cron) {
    const adapter = boss.getDb();
    const execute = adapter.executeSql.bind(adapter);
    adapter.executeSql = async (text, values) => {
      if (!text.includes('INSERT INTO pgboss.') || !text.includes(`'${selectedFamily}' as name`))
        return execute(text, values);
      if (holdForward) {
        holdForward = false;
        await new Promise<void>((resolve) => {
          releaseForward = resolve;
          process.send?.({ kind: 'forward-held', at: new Date().toISOString(), values });
        });
      }
      try {
        const result = await execute(text, values);
        process.send?.({ kind: 'forwarded', at: new Date().toISOString(), rows: result.rows });
        return result;
      } catch (error) {
        process.send?.({
          kind: 'forward-rejected',
          at: new Date().toISOString(),
          error: String(error),
        });
        throw error;
      }
    };
  }
  const sessionBoundary: SessionOrphanBoundaryHook = async (event) => {
    if (
      (event.family === selectedFamily && process.env.TLP_SESSION_PAUSE_AT === event.kind) ||
      (cron && event.kind === 'row-committed' && process.env.TLP_SESSION_HOLD_ROWS === '1')
    ) {
      process.send?.({
        ...event,
        kind: 'boundary',
        boundary: event.kind,
        workflowId: DBOS.workflowID,
        pid: process.pid,
      });
      await new Promise<void>((resolve) => {
        heldRows.add(resolve);
      });
    }
  };
  // Stop at the receipt query after the original transition/event writes in this transaction.
  if (
    ['row-uncommitted', 'admission-uncommitted'].includes(process.env.TLP_SESSION_PAUSE_AT ?? '')
  ) {
    const send = appClient.options.debug;
    appClient.options.debug = (connection, query, parameters, types) => {
      if (typeof send === 'function') send(connection, query, parameters, types);
      if (
        (process.env.TLP_SESSION_PAUSE_AT === 'row-uncommitted' &&
          query.startsWith('insert into "session_orphan_receipt"')) ||
        (process.env.TLP_SESSION_PAUSE_AT === 'admission-uncommitted' &&
          query.startsWith('insert into "session_orphan_tick"'))
      ) {
        process.send?.({
          kind: 'boundary',
          boundary: process.env.TLP_SESSION_PAUSE_AT,
          pid: process.pid,
        });
        // The driver's debug callback runs before dispatch. Earlier row/event writes
        // remain uncommitted; neither this insert nor COMMIT can be issued before SIGKILL.
        process.kill(process.pid, 'SIGSTOP');
      }
    };
  }
  const declarations = {
    pruneEvents: {
      name: 'prune_job_events',
      backend: 'dbos',
      queue: 'fast',
      schedule: { cron: '0 4 * * *', tz: 'Asia/Shanghai' },
    },
    conversationOrphans: {
      name: 'prune_orphan_conversation_sessions',
      backend: 'dbos',
      queue: 'fast',
      schedule: { cron: cron ? '* * * * *' : '25 4 * * *', tz: 'Asia/Shanghai' },
    },
    placementOrphans: {
      name: 'prune_orphan_placement_sessions',
      backend: 'dbos',
      queue: 'fast',
      schedule: { cron: cron ? '* * * * *' : '35 4 * * *', tz: 'Asia/Shanghai' },
    },
    reviewOrphans: {
      name: 'prune_orphan_review_sessions',
      backend: 'dbos',
      queue: 'fast',
      schedule: { cron: '15 4 * * *', tz: 'Asia/Shanghai' },
    },
  } satisfies Parameters<typeof host.startDurableWorker>[0]['declarations'];
  try {
    await boss.start();
    await host.startDurableWorker({
      boss,
      db,
      declarations,
      sessionBoundary,
      reconcileIntervalMs: 100,
    });
    process.send?.({
      kind: 'ready',
      pid: process.pid,
      runtime: {
        node: process.version,
        execPath: process.execPath,
        dbos: dbosPackage.version,
        pgBoss: pgBossPackage.version,
      },
    });
    process.on('message', async (raw) => {
      try {
        const command = z
          .discriminatedUnion('kind', [
            z.object({
              kind: z.literal('transition'),
              family: family.sessionOrphanFamilySchema,
              phase: family.sessionOrphanPhaseSchema,
            }),
            z.object({
              kind: z.literal('quiesce'),
              family: family.sessionOrphanFamilySchema,
              reason: z.string(),
            }),
            z.object({ kind: z.literal('release-forward') }),
            z.object({ kind: z.literal('arm-forward') }),
            z.object({ kind: z.literal('release-rows') }),
            z.object({ kind: z.literal('stop') }),
          ])
          .parse(raw);
        if (command.kind === 'transition')
          await backend.changeSessionOrphanPhase(db, boss, {
            family: command.family,
            target: command.phase,
          });
        else if (command.kind === 'quiesce')
          await backend.attestSessionOrphanQuiescence(db, {
            family: command.family,
            reason: command.reason,
          });
        else if (command.kind === 'release-forward') {
          holdForward = false;
          releaseForward?.();
          releaseForward = undefined;
        } else if (command.kind === 'arm-forward') holdForward = true;
        else if (command.kind === 'release-rows') {
          for (const release of heldRows) release();
          heldRows.clear();
        } else {
          await host.stopDurableWorker();
          await boss.stop();
          await appClient.end();
          process.exit(0);
        }
        process.send?.({ kind: 'ack' });
      } catch (error) {
        process.send?.({ kind: 'rejected', error: String(error) });
      }
    });
    const workflowId = process.env.TLP_SESSION_WORKFLOW_ID;
    if (workflowId) {
      // The host owns registration. The client enqueues by the already registered name.
      const { DBOSClient } = await import('@dbos-inc/dbos-sdk');
      const client = await DBOSClient.create({
        systemDatabaseUrl: url.toString(),
        systemDatabaseSchemaName: 'tlp_dbos',
        systemDatabasePoolSize: 1,
        applicationName: 'tlp-housekeeping',
      });
      try {
        const scheduledAt = new Date(
          process.env.TLP_SESSION_SCHEDULED_AT ?? '2026-10-09T00:00:00Z',
        );
        const handle =
          process.env.TLP_SESSION_RECOVER === '1'
            ? DBOS.retrieveWorkflow(workflowId)
            : await client.enqueue<SessionOrphanWorkflows['conversationOrphans']>(
                {
                  workflowName: selectedFamily,
                  workflowID: workflowId,
                  queueName: '_dbos_internal_queue',
                  appVersion: 'prune-v1',
                },
                scheduledAt,
                {},
              );
        await handle.getResult();
        process.send?.({
          kind: 'done',
          status: await handle.getStatus(),
          steps: await DBOS.listWorkflowSteps(workflowId),
          pid: process.pid,
        });
      } finally {
        await client.destroy();
      }
    }
  } catch (error) {
    process.send?.({
      kind: 'failure',
      error: error instanceof Error ? error.stack : String(error),
    });
    await host.stopDurableWorker();
    await boss.stop();
    await appClient.end();
    process.exit(1);
  }
}
main().catch((error: unknown) => {
  process.send?.({ kind: 'failure', error: String(error) });
  process.exit(1);
});
