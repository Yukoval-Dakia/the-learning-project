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
import { fixtureErrorMessage, sanitizeDiagnostic } from '../dbos-review-orphan/fixture-process';

let stage = 'validate-database';
let database: string | undefined;
const requestId = process.env.TLP_SESSION_WORKFLOW_ID ?? process.env.TLP_SESSION_REQUEST_ID;
const diagnosticSecrets = [
  process.env.DATABASE_URL ?? '',
  process.env.TLP_SESSION_APP_DATABASE_URL ?? '',
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
  const timestamped = { ...message, at: new Date().toISOString() };
  process.send?.(timestamped);
  console.error(JSON.stringify(timestamped));
}
async function reportDatabaseState(client: ReturnType<typeof postgres>, atStage: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const rows = await Promise.race([
      client.begin('read only', async (tx) => {
        await tx`set local statement_timeout = '1s'`;
        await tx`set local lock_timeout = '250ms'`;
        return tx`with relations as (
          select c.oid, n.nspname as schema, c.relname as name, c.relkind
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'pgboss'
        ), activity as (
          select pid, application_name, state, wait_event_type, wait_event,
            xact_start, query_start, pg_blocking_pids(pid) as blocking_pids,
            case when query ~* '^[[:space:]]*((DROP|CREATE)[[:space:]]+TRIGGER|LOCK[[:space:]]+TABLE|SELECT[[:space:]]+pg_advisory_xact_lock)'
              then left(query, 2048) else null end as fence_query
          from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid()
        ) select jsonb_build_object(
          'observedAt', clock_timestamp(), 'observerPid', pg_backend_pid(),
          'databaseOid', (select oid from pg_database where datname = current_database()),
          'relations', (select coalesce(jsonb_agg(r order by r.oid), '[]'::jsonb) from relations r),
          'inherits', (select coalesce(jsonb_agg(i order by i.parent_oid, i.child_oid), '[]'::jsonb)
            from (select h.inhparent as parent_oid, pn.nspname as parent_schema,
              p.relname as parent_name, h.inhrelid as child_oid, cn.nspname as child_schema,
              c.relname as child_name
              from pg_inherits h join pg_class p on p.oid = h.inhparent
              join pg_namespace pn on pn.oid = p.relnamespace
              join pg_class c on c.oid = h.inhrelid join pg_namespace cn on cn.oid = c.relnamespace
              where pn.nspname = 'pgboss' or cn.nspname = 'pgboss') i),
          'locks', (select coalesce(jsonb_agg(l order by l.pid, l.relation, l.locktype, l.mode), '[]'::jsonb)
            from (select pid, locktype, database, relation, transactionid, classid, objid,
              objsubid, mode, granted, waitstart from pg_locks
              where pid in (select pid from activity)) l),
          'activity', (select coalesce(jsonb_agg(a order by a.pid), '[]'::jsonb) from activity a)
        ) as snapshot`;
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Read-only lock diagnostic timed out after 3000ms')),
          3000,
        );
      }),
    ]);
    const snapshot: unknown = JSON.parse(
      sanitizeDiagnostic(JSON.stringify(rows[0]?.snapshot), diagnosticSecrets),
    );
    const message = {
      kind: 'database-diagnostic',
      pid: process.pid,
      database,
      stage: atStage,
      requestId,
      snapshot,
    };
    process.send?.(message);
    console.error(JSON.stringify(message));
  } catch (error) {
    reportError('diagnostic-failure', error, `${atStage}-diagnostic`);
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const url = new URL(z.url().parse(process.env.DATABASE_URL));
  diagnosticSecrets.push(url.password, decodeURIComponent(url.password));
  if (
    process.env.TLP_SESSION_TEST_PROCESS !== '1' ||
    !/^\/test_fork_\d+$/.test(url.pathname) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  )
    throw new Error('Session orphan fixture requires an isolated disposable fork DB');
  database = url.pathname.slice(1);
  const appUrl = new URL(process.env.TLP_SESSION_APP_DATABASE_URL ?? url.toString());
  if (
    appUrl.pathname !== url.pathname ||
    !['localhost', '127.0.0.1', '[::1]'].includes(appUrl.hostname) ||
    (appUrl.toString() !== url.toString() && process.env.TLP_SESSION_APP_PROXY !== '1')
  )
    throw new Error('Application proxy must target the same disposable DB');
  diagnosticSecrets.push(appUrl.password, decodeURIComponent(appUrl.password));
  stage = 'load-host';
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
    reportError(String(error).includes('producer fenced') ? 'cron-error' : 'failure', error),
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
        reportError('forward-rejected', error, 'cron-forward');
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
    stage = 'pg-boss-start';
    await boss.start();
    stage = 'durable-host-start';
    await host.startDurableWorker({
      boss,
      db,
      declarations,
      sessionBoundary,
      reconcileIntervalMs: 100,
    });
    stage = 'ready';
    process.send?.({
      kind: 'ready',
      pid: process.pid,
      database,
      requestId,
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
        commandStage = `command-${command.kind}`;
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
        reportError('rejected', error, commandStage);
      }
    });
    const workflowId = process.env.TLP_SESSION_WORKFLOW_ID;
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
        stage = process.env.TLP_SESSION_RECOVER === '1' ? 'workflow-retrieve' : 'workflow-enqueue';
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
    if (stage === 'durable-host-start' || stage === 'pg-boss-start')
      await reportDatabaseState(appClient, stage);
    stage = 'failure-cleanup';
    await host.stopDurableWorker();
    await boss.stop();
    await appClient.end({ timeout: 2 });
    process.exit(1);
  }
}
main().catch((error: unknown) => {
  reportError('failure', error);
  process.exit(1);
});
