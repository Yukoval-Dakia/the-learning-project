import { DBOS } from '@dbos-inc/dbos-sdk';
import { drizzle } from 'drizzle-orm/postgres-js';
import { PgBoss } from 'pg-boss';
import postgres from 'postgres';
import { z } from 'zod';
import * as schema from '@/db/schema';
import type { ReviewOrphanBoundaryHook } from '@/server/durable/review-orphan-family';
import type { ReviewOrphanWorkflow } from '@/server/durable/review-orphan-worker';
import dbosPackage from '../../node_modules/@dbos-inc/dbos-sdk/package.json';
import pgBossPackage from '../../node_modules/pg-boss/package.json';
import { fixtureErrorMessage } from './fixture-process';

let stage = 'validate-database';
let database: string | undefined;
const requestId = process.env.TLP_REVIEW_WORKFLOW_ID;
const diagnosticSecrets = [
  process.env.DATABASE_URL ?? '',
  process.env.TLP_REVIEW_APP_DATABASE_URL ?? '',
];
function reportError(kind: string, error: unknown, atStage = stage) {
  const message = fixtureErrorMessage({
    kind,
    error,
    pid: process.pid,
    database,
    stage: atStage,
    requestId,
    secrets: diagnosticSecrets,
  });
  process.send?.(message);
  console.error(JSON.stringify(message));
}

async function main() {
  const url = new URL(z.url().parse(process.env.DATABASE_URL));
  diagnosticSecrets.push(url.password, decodeURIComponent(url.password));
  if (
    process.env.TLP_REVIEW_TEST_PROCESS !== '1' ||
    !/^\/test_fork_\d+$/.test(url.pathname) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  )
    throw new Error('Review orphan fixture requires an isolated disposable fork DB');
  database = url.pathname.slice(1);
  const appUrl = new URL(process.env.TLP_REVIEW_APP_DATABASE_URL ?? url.toString());
  if (
    appUrl.pathname !== url.pathname ||
    !['localhost', '127.0.0.1', '[::1]'].includes(appUrl.hostname) ||
    (appUrl.toString() !== url.toString() && process.env.TLP_REVIEW_APP_PROXY !== '1')
  )
    throw new Error('Application proxy must target the same disposable DB');
  diagnosticSecrets.push(appUrl.password, decodeURIComponent(appUrl.password));
  stage = 'load-host';
  const appClient = postgres(appUrl.toString(), { max: 2, ssl: false, connect_timeout: 2 });
  const db = drizzle(appClient, { schema });
  const family = await import('@/server/durable/review-orphan-family');
  const host = await import('@/server/durable/prune-worker');
  const cron = process.env.TLP_REVIEW_CRON_TEST === '1';
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
    reportError(String(error).includes('producer fenced') ? 'cron-error' : 'failure', error),
  );
  if (cron) {
    const adapter = boss.getDb();
    const execute = adapter.executeSql.bind(adapter);
    adapter.executeSql = async (text, values) => {
      if (
        !text.includes('INSERT INTO pgboss.') ||
        !text.includes("'prune_orphan_review_sessions' as name")
      )
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
        reportError('forward-rejected', error, 'cron-forward');
        throw error;
      }
    };
  }
  const reviewBoundary: ReviewOrphanBoundaryHook = async (event) => {
    if (requestId && DBOS.workflowID !== requestId) return;
    if (
      process.env.TLP_REVIEW_PAUSE_AT === event.kind ||
      (cron && event.kind === 'row-committed' && process.env.TLP_REVIEW_HOLD_ROWS === '1')
    ) {
      process.send?.({
        ...event,
        kind: 'boundary',
        boundary: event.kind,
        workflowId: DBOS.workflowID,
        requestId,
        pid: process.pid,
      });
      await new Promise<void>((resolve) => {
        heldRows.add(resolve);
      });
    }
  };
  // Stop at the receipt query after the original transition/event writes in this transaction.
  if (
    ['row-uncommitted', 'admission-uncommitted'].includes(process.env.TLP_REVIEW_PAUSE_AT ?? '')
  ) {
    const send = appClient.options.debug;
    appClient.options.debug = (connection, query, parameters, types) => {
      if (typeof send === 'function') send(connection, query, parameters, types);
      const workflowId = DBOS.workflowID;
      if (requestId && workflowId && workflowId !== requestId) return;
      if (
        (process.env.TLP_REVIEW_PAUSE_AT === 'row-uncommitted' &&
          query.startsWith('insert into "review_orphan_receipt"')) ||
        (process.env.TLP_REVIEW_PAUSE_AT === 'admission-uncommitted' &&
          query.startsWith('insert into "review_orphan_tick"'))
      ) {
        process.send?.({
          kind: 'boundary',
          boundary: process.env.TLP_REVIEW_PAUSE_AT,
          workflowId,
          requestId,
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
      schedule: { cron: '25 4 * * *', tz: 'Asia/Shanghai' },
    },
    placementOrphans: {
      name: 'prune_orphan_placement_sessions',
      backend: 'dbos',
      queue: 'fast',
      schedule: { cron: '35 4 * * *', tz: 'Asia/Shanghai' },
    },
    reviewOrphans: {
      name: family.REVIEW_ORPHAN_FAMILY,
      backend: 'dbos',
      queue: 'fast',
      schedule: { cron: cron ? '* * * * *' : '15 4 * * *', tz: 'Asia/Shanghai' },
    },
  } satisfies Parameters<typeof host.startDurableWorker>[0]['declarations'];
  try {
    stage = 'pg-boss-start';
    await boss.start();
    stage = 'durable-host-start';
    await host.startDurableWorker({
      boss,
      db,
      declarations,
      reviewBoundary,
      reconcileIntervalMs: 100,
    });
    stage = 'ready';
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
      let commandStage = 'command-parse';
      try {
        const command = z
          .discriminatedUnion('kind', [
            z.object({ kind: z.literal('transition'), phase: family.reviewOrphanPhaseSchema }),
            z.object({ kind: z.literal('quiesce'), reason: z.string() }),
            z.object({ kind: z.literal('release-forward') }),
            z.object({ kind: z.literal('arm-forward') }),
            z.object({ kind: z.literal('release-rows') }),
            z.object({ kind: z.literal('stop') }),
          ])
          .parse(raw);
        commandStage = `command-${command.kind}`;
        if (command.kind === 'transition')
          await family.changeReviewOrphanPhase(db, boss, command.phase);
        else if (command.kind === 'quiesce')
          await family.attestReviewOrphanQuiescence(db, command.reason);
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
        reportError('rejected', error, commandStage);
      }
    });
    const workflowId = process.env.TLP_REVIEW_WORKFLOW_ID;
    if (workflowId) {
      stage = 'workflow-client';
      // The host owns registration. The client enqueues by the already registered name.
      const { DBOSClient } = await import('@dbos-inc/dbos-sdk');
      const client = await DBOSClient.create({
        systemDatabaseUrl: url.toString(),
        systemDatabaseSchemaName: 'tlp_dbos',
        systemDatabasePoolSize: 1,
        applicationName: 'tlp-housekeeping',
      });
      try {
        stage = process.env.TLP_REVIEW_RECOVER === '1' ? 'workflow-retrieve' : 'workflow-enqueue';
        const scheduledAt = new Date(process.env.TLP_REVIEW_SCHEDULED_AT ?? '2026-10-09T00:00:00Z');
        const handle =
          process.env.TLP_REVIEW_RECOVER === '1'
            ? DBOS.retrieveWorkflow(workflowId)
            : await client.enqueue<ReviewOrphanWorkflow>(
                {
                  workflowName: family.REVIEW_ORPHAN_FAMILY,
                  workflowID: workflowId,
                  queueName: '_dbos_internal_queue',
                  appVersion: 'prune-v1',
                },
                scheduledAt,
                {},
              );
        stage = 'workflow-result';
        await handle.getResult();
        stage = 'workflow-evidence';
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
    reportError('failure', error);
    stage = 'failure-cleanup';
    await host.stopDurableWorker();
    await boss.stop();
    await appClient.end();
    process.exit(1);
  }
}
main().catch((error: unknown) => {
  reportError('failure', error);
  process.exit(1);
});
