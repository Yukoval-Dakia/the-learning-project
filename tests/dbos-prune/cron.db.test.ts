import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { PgBoss } from 'pg-boss';
import postgres from 'postgres';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { z } from 'zod';
import dbosPackage from '../../node_modules/@dbos-inc/dbos-sdk/package.json';
import pgBossPackage from '../../node_modules/pg-boss/package.json';

const messageSchema = z.object({ kind: z.string(), error: z.string().optional() }).passthrough();
const children = new Set<ChildProcess>();
const observations: unknown[] = [];
const processLogs: {
  pid: number | undefined;
  messages: unknown[];
  stdout: string;
  stderr: string;
}[] = [];
let sql: ReturnType<typeof postgres>;
let boss: PgBoss;
let passed = false;
let databaseUrl: string;
let unrelatedJob: string | null;

function startCronWorker() {
  const child = spawn(process.execPath, [resolve('.cache/yuk1355-cron-worker.cjs')], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'test',
      DATABASE_URL: databaseUrl,
      TLP_PRUNE_TEST_PROCESS: '1',
      TLP_PRUNE_CRON_TEST: '1',
    },
  });
  children.add(child);
  const exited = once(child, 'exit');
  const messages: z.infer<typeof messageSchema>[] = [];
  const log: (typeof processLogs)[number] = {
    pid: child.pid,
    messages: [],
    stdout: '',
    stderr: '',
  };
  processLogs.push(log);
  child.stdout?.on('data', (chunk) => {
    log.stdout += String(chunk);
  });
  child.stderr?.on('data', (chunk) => {
    log.stderr += String(chunk);
  });
  child.on('message', (value) => {
    const message = messageSchema.parse(value);
    messages.push(message);
    log.messages.push(message);
    process.stdout.write(`cron IPC pid=${child.pid} kind=${message.kind}\n`);
  });
  child.on('exit', () => children.delete(child));
  async function wait(kind: string, timeout = 20000) {
    let found: z.infer<typeof messageSchema> | undefined;
    await expect
      .poll(
        () => {
          const failure = messages.find((message) => message.kind === 'failure');
          if (failure) throw new Error(`${failure.error}\n${log.stderr}\n${log.stdout}`);
          if (child.exitCode !== null || child.signalCode !== null)
            throw new Error(`Cron worker exited: ${JSON.stringify(log)}`);
          const index = messages.findIndex((message) => message.kind === kind);
          if (index !== -1) found = messages.splice(index, 1)[0];
          return found !== undefined;
        },
        { timeout, interval: 50 },
      )
      .toBe(true);
    return messageSchema.parse(found);
  }
  async function command(command: { kind: string; phase?: string }, response = 'ack') {
    child.send(command);
    return wait(response);
  }
  async function stop() {
    child.send({ kind: 'stop' });
    const result = await exited;
    expect(result).toEqual([0, null]);
    observations.push({ stage: 'process-stopped', pid: child.pid, result });
  }
  return {
    child,
    wait,
    command,
    stop,
    has: (kind: string) => messages.some((message) => message.kind === kind),
  };
}

async function snapshot(stage: string) {
  const data = {
    stage,
    at: new Date().toISOString(),
    phase: await sql`select phase from prune_job_events_control`,
    pgSchedule: await sql`select name, cron, timezone from pgboss.schedule`,
    dbosSchedule:
      await sql`select schedule_name, schedule, status, last_fired_at, cron_timezone, automatic_backfill from tlp_dbos.workflow_schedules`,
    jobs: await sql`select id, name, state, data, created_on, started_on, completed_on, singleton_on, singleton_key from pgboss.job order by created_on, id`,
    workflows:
      await sql`select workflow_uuid, name, status, schedule_name, inputs from tlp_dbos.workflow_status order by workflow_uuid`,
    receipts: await sql`select * from prune_job_events_receipt order by workflow_id`,
    audit: await sql`select * from yuk1355_cron_audit order by sequence`,
  };
  observations.push(data);
  process.stdout.write(`cron observed stage=${stage} at=${data.at}\n`);
  return data;
}

async function pollSchedules(backend: 'pg-boss' | 'dbos' | 'none') {
  await expect
    .poll(
      async () => {
        const pg = await sql`select name from pgboss.schedule where name = 'prune_job_events'`;
        const dbos =
          await sql`select status from tlp_dbos.workflow_schedules where schedule_name = 'prune_job_events'`;
        return { pg: pg.length, dbos: dbos[0]?.status ?? 'PAUSED' };
      },
      { timeout: 10000, interval: 50 },
    )
    .toEqual({ pg: backend === 'pg-boss' ? 1 : 0, dbos: backend === 'dbos' ? 'ACTIVE' : 'PAUSED' });
}

beforeAll(async () => {
  // global-setup always creates a new Testcontainers Postgres; never accept a caller's DB.
  const url = new URL(z.url().parse(process.env.TEST_DATABASE_URL));
  expect(url.pathname).toMatch(/^\/test_fork_\d+$/);
  expect(['localhost', '127.0.0.1', '[::1]']).toContain(url.hostname);
  const adminUrl = new URL(url);
  adminUrl.pathname = '/postgres';
  const admin = postgres(adminUrl.toString(), { max: 1 });
  const databaseName = `test_fork_${Date.now()}`;
  try {
    // Clone the freshly migrated template, not a possibly reused Vitest worker DB.
    await admin.unsafe(`CREATE DATABASE "${databaseName}" TEMPLATE "test"`);
  } finally {
    await admin.end();
  }
  url.pathname = `/${databaseName}`;
  databaseUrl = url.toString();
  sql = postgres(url.toString(), { max: 3 });
  await promisify(execFile)(resolve('node_modules/.bin/esbuild'), [
    'tests/dbos-prune/worker.ts',
    '--bundle',
    '--platform=node',
    '--target=node24',
    '--format=cjs',
    '--outfile=.cache/yuk1355-cron-worker.cjs',
    '--external:pg-native',
    '--external:sharp',
    '--external:better-sqlite3',
    '--external:bufferutil',
    '--external:utf-8-validate',
    '--external:winston',
    '--external:winston-transport',
  ]);
  await sql`delete from contract_epoch`;
  boss = new PgBoss({
    connectionString: url.toString(),
    max: 2,
    supervise: false,
    schedule: false,
  });
  boss.on('error', (error) => {
    throw error;
  });
  await boss.start();
  await boss.createQueue('yuk1355_unknown_external');
  unrelatedJob = await boss.send('yuk1355_unknown_external', {
    outcome: 'unknown',
    nested: { attempt: 'uncheckpointed', replayAllowed: false },
  });
  await sql`update pgboss.job set state = 'failed' where id = ${unrelatedJob}::uuid`;
  // Test-only statement/row audit: records actual SQL effects and phase in their transaction.
  await sql.unsafe(`
    CREATE TABLE yuk1355_cron_audit (
      sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      at timestamptz NOT NULL DEFAULT clock_timestamp(),
      kind text NOT NULL, phase text NOT NULL, task_id text,
      transaction_id bigint NOT NULL DEFAULT txid_current(),
      backend_pid integer NOT NULL DEFAULT pg_backend_pid(), detail jsonb NOT NULL
    );
    CREATE FUNCTION yuk1355_cron_observe() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      INSERT INTO yuk1355_cron_audit(kind,phase,task_id,detail)
      SELECT (CASE WHEN TG_TABLE_NAME IN ('job','job_common') THEN 'job' ELSE TG_TABLE_NAME END) || ':' || TG_OP, phase,
        CASE WHEN TG_TABLE_NAME IN ('job','job_common') THEN to_jsonb(NEW)->>'id'
             WHEN TG_TABLE_NAME = 'prune_job_events_receipt' THEN to_jsonb(NEW)->>'workflow_id' END,
        coalesce(to_jsonb(NEW), '{}'::jsonb)
      FROM prune_job_events_control;
      RETURN NEW;
    END; $$;
    CREATE TRIGGER yuk1355_observe_job AFTER INSERT OR UPDATE OF state ON pgboss.job
      FOR EACH ROW EXECUTE FUNCTION yuk1355_cron_observe();
    CREATE TRIGGER yuk1355_observe_phase AFTER UPDATE ON prune_job_events_control
      FOR EACH ROW EXECUTE FUNCTION yuk1355_cron_observe();
    CREATE TRIGGER yuk1355_observe_receipt AFTER INSERT ON prune_job_events_receipt
      FOR EACH ROW EXECUTE FUNCTION yuk1355_cron_observe();
    CREATE TRIGGER yuk1355_observe_delete AFTER DELETE ON job_events
      FOR EACH STATEMENT EXECUTE FUNCTION yuk1355_cron_observe();
  `);
  observations.push({
    stage: 'fresh-container-database',
    database: url.pathname,
    port: url.port,
    server:
      await sql`select version(), current_database(), current_setting('fsync') as fsync, current_setting('synchronous_commit') as synchronous_commit`,
  });
});

afterAll(async () => {
  for (const child of children) {
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    observations.push({ stage: 'failure-cleanup', pid: child.pid, exit: await exited });
  }
  await boss?.stop();
  await sql?.end();
  if (process.env.TLP_PRUNE_CRON_EVIDENCE_PATH)
    await writeFile(
      process.env.TLP_PRUNE_CRON_EVIDENCE_PATH,
      `${JSON.stringify(
        {
          capturedAt: new Date().toISOString(),
          passed,
          dbos: dbosPackage.version,
          pgBoss: pgBossPackage.version,
          runner: {
            node: process.version,
            execPath: process.execPath,
            pgBoss: pgBossPackage.version,
            dbos: dbosPackage.version,
          },
          strategy: {
            productionCron: '0 4 * * *',
            testCron: '* * * * *',
            timezone: 'Asia/Shanghai',
            clocksChanged: false,
            pgMonitorSeconds: 1,
            pgForwardPollSeconds: 1,
            reconcileMilliseconds: 50,
            dbosScheduler: 'unmodified SDK dynamic scheduler and internal queue',
            barriers: [
              'real timekeeper target INSERT delayed before execution',
              'legacy consumer explicitly offWork until new draining worker',
              'business-committed callback delayed after receipt transaction',
            ],
          },
          observations,
          processLogs,
          sourceHashes: await Promise.all(
            [
              'src/server/durable/prune-worker.ts',
              'src/server/durable/prune-family.ts',
              'tests/dbos-prune/worker.ts',
              'tests/dbos-prune/cron.db.test.ts',
              'drizzle/0115_yuk1355_prune_backend.sql',
              'pnpm-lock.yaml',
              'node_modules/pg-boss/package.json',
              'node_modules/@dbos-inc/dbos-sdk/package.json',
              '.cache/yuk1355-cron-worker.cjs',
              'node_modules/pg-boss/dist/timekeeper.js',
              'node_modules/@dbos-inc/dbos-sdk/dist/src/scheduler/scheduler.js',
            ].map(async (path) => ({
              path,
              sha256: createHash('sha256')
                .update(await readFile(path))
                .digest('hex'),
            })),
          ),
        },
        null,
        2,
      )}\n`,
    );
});

it('observes actual minute ticks, cached legacy forwarding, drain, two DBOS schedulers and rollback', async () => {
  const marker = randomUUID();
  await sql`insert into job_events (business_table,business_id,event_type,payload,occurred_at)
    values ('yuk1355-cron',${marker},'legacy-old',${sql.json({ long: 'real cron synthetic telemetry '.repeat(100), nested: { outcomes: ['known', 'ambiguous'], error: null } })},now() - interval '31 days')`;
  const worker = startCronWorker();
  await worker.wait('ready');
  await pollSchedules('pg-boss');
  await worker.wait('forward-held', 75000);
  const firstHeld = await snapshot('first-real-tick-held');
  const [firstTick] = firstHeld.jobs.filter(
    (job) => job.name === '__pgboss__send-it' && job.state === 'active',
  );
  expect(firstTick).toMatchObject({ data: { name: 'prune_job_events' } });
  expect(firstHeld.jobs.filter((job) => job.name === 'prune_job_events')).toHaveLength(0);
  await worker.command({ kind: 'hold-legacy' });
  await worker.command({ kind: 'release-forward' });
  const forwarded = z
    .object({ rows: z.array(z.object({ id: z.string() })) })
    .parse(await worker.wait('forwarded'));
  const legacyId = forwarded.rows[0]?.id;
  expect(legacyId).toBeTruthy();
  await expect
    .poll(
      async () => (await sql`select state from pgboss.job where id = ${legacyId}::uuid`)[0]?.state,
    )
    .toBe('created');
  await worker.command({ kind: 'arm-forward' });
  await worker.wait('forward-held', 75000);
  const beforeDrain = await snapshot('second-real-tick-cached-before-drain');
  const [cached] = beforeDrain.jobs.filter(
    (job) => job.name === '__pgboss__send-it' && job.state === 'active',
  );
  expect(cached.id).not.toBe(firstTick.id);
  expect(beforeDrain.receipts).toHaveLength(0);
  // Keep another real tick in SEND_IT while the first forwarding callback is held.
  // It will be forwarded only after rollback, covering stale caches beyond cutover.
  await expect
    .poll(
      async () =>
        (
          await sql`select count(*)::int as count from pgboss.job where name = '__pgboss__send-it' and state = 'created'`
        )[0]?.count,
      { timeout: 75000, interval: 100 },
    )
    .toBe(1);
  const backlog = await snapshot('third-real-tick-backlogged-before-drain');
  const [lateCached] = backlog.jobs.filter(
    (job) => job.name === '__pgboss__send-it' && job.state === 'created',
  );
  await worker.command({ kind: 'transition', phase: 'draining-pg-boss' });
  await pollSchedules('none');
  const blocked = await worker.command({ kind: 'transition', phase: 'dbos' }, 'rejected');
  expect(blocked.error).toContain(String(legacyId));
  await snapshot('legacy-drain-blocks-cutover');
  const peer = startCronWorker();
  await peer.wait('ready');
  await expect
    .poll(
      async () => (await sql`select state from pgboss.job where id = ${legacyId}::uuid`)[0]?.state,
      { timeout: 15000 },
    )
    .toBe('completed');
  expect(await sql`select * from job_events where business_id = ${marker}`).toHaveLength(0);
  const drained = await snapshot('real-legacy-tick-drained');
  expect(drained.audit.filter((row) => row.kind === 'job_events:DELETE')).toHaveLength(1);
  expect(drained.audit.find((row) => row.kind === 'job_events:DELETE')?.phase).toBe(
    'draining-pg-boss',
  );
  await worker.command({ kind: 'transition', phase: 'dbos' });
  await pollSchedules('dbos');
  await worker.command({ kind: 'release-forward' });
  await worker.command({ kind: 'arm-forward' });
  const rejection = await worker.wait('forward-rejected');
  expect(rejection.error).toContain('producer fenced: dbos');
  await worker.wait('cron-error');
  await expect
    .poll(() => worker.has('forward-held') || peer.has('forward-held'), { timeout: 20000 })
    .toBe(true);
  const lateForwarder = worker.has('forward-held') ? worker : peer;
  await lateForwarder.wait('forward-held');
  const lateHeld = await snapshot('third-cached-tick-held-during-dbos');
  expect(lateHeld.jobs.find((job) => job.id === lateCached.id)?.state).toBe('active');
  await expect
    .poll(
      async () => (await sql`select state from pgboss.job where id = ${cached.id}::uuid`)[0]?.state,
      { timeout: 10000 },
    )
    .toBe('completed');
  const fenced = await snapshot('cached-forward-rejected-after-cutover');
  expect(fenced.jobs.filter((job) => job.name === 'prune_job_events')).toHaveLength(1);
  expect(
    fenced.audit.filter(
      (row) =>
        row.kind === 'job:INSERT' &&
        row.detail.name === 'prune_job_events' &&
        row.phase !== 'pg-boss',
    ),
  ).toHaveLength(0);
  await sql`insert into job_events (business_table,business_id,event_type,payload,occurred_at)
    values ('yuk1355-cron',${marker},'dbos-old','{}',now() - interval '31 days')`;
  await expect
    .poll(
      async () =>
        (await sql`select count(*)::int as count from prune_job_events_receipt`)[0]?.count,
      { timeout: 75000, interval: 100 },
    )
    .toBe(1);
  const native = await snapshot('real-dbos-cron-receipt-before-checkpoint');
  const [receipt] = native.receipts;
  expect(receipt.workflow_id).toMatch(
    /^sched-prune_job_events-\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/,
  );
  expect(native.workflows).toHaveLength(1);
  expect(native.workflows[0]).toMatchObject({
    workflow_uuid: receipt.workflow_id,
    name: 'prune_job_events',
    schedule_name: 'prune_job_events',
    status: 'PENDING',
  });
  expect(new Date(receipt.cutoff).getTime()).toBe(
    new Date(receipt.workflow_id.replace('sched-prune_job_events-', '')).getTime() - 30 * 86400000,
  );
  expect(receipt.deleted).toBe(1);
  expect(
    native.audit.filter((row) => row.kind === 'job_events:DELETE' && row.phase === 'dbos'),
  ).toHaveLength(1);
  await worker.command({ kind: 'transition', phase: 'draining-dbos' });
  await pollSchedules('none');
  expect(
    (await worker.command({ kind: 'transition', phase: 'pg-boss' }, 'rejected')).error,
  ).toContain(receipt.workflow_id);
  await snapshot('dbos-receipt-pending-blocks-rollback');
  await worker.command({ kind: 'release-business' });
  await peer.command({ kind: 'release-business' });
  await expect
    .poll(
      async () =>
        (
          await sql`select status from tlp_dbos.workflow_status where workflow_uuid = ${receipt.workflow_id}`
        )[0]?.status,
      { timeout: 15000 },
    )
    .toBe('SUCCESS');
  await worker.command({ kind: 'transition', phase: 'pg-boss' });
  await pollSchedules('none');
  await snapshot('rollback-phase-with-cron-cooldown');
  await worker.command({ kind: 'release-forward' });
  await peer.command({ kind: 'release-forward' });
  await sql`insert into job_events (business_table,business_id,event_type,payload,occurred_at)
    values ('yuk1355-cron',${marker},'rollback-old','{}',now() - interval '31 days')`;
  await expect
    .poll(
      async () =>
        (
          await sql`select count(*)::int as count from pgboss.job where name = 'prune_job_events' and state = 'completed'`
        )[0]?.count,
      { timeout: 10000, interval: 100 },
    )
    .toBe(2);
  const suppressed = await snapshot('late-cached-forward-completed-without-repeat-effect');
  expect(suppressed.audit.filter((row) => row.kind === 'job_events:DELETE')).toHaveLength(2);
  expect(await sql`select * from job_events where business_id = ${marker}`).toHaveLength(1);
  expect(suppressed.jobs.find((job) => job.id === lateCached.id)?.state).toBe('completed');
  await expect
    .poll(
      async () =>
        (
          await sql`select count(*)::int as count from pgboss.job where name = 'prune_job_events' and state = 'completed'`
        )[0]?.count,
      { timeout: 75000, interval: 100 },
    )
    .toBe(3);
  await pollSchedules('pg-boss');
  const rollback = await snapshot('real-pg-cron-after-rollback');
  expect(rollback.receipts).toHaveLength(1);
  expect(rollback.audit.filter((row) => row.kind === 'job_events:DELETE')).toHaveLength(3);
  expect(await sql`select * from job_events where business_id = ${marker}`).toHaveLength(0);
  const forbiddenInserts = rollback.audit.filter(
    (row) =>
      row.kind === 'job:INSERT' &&
      row.detail.name === 'prune_job_events' &&
      row.phase !== 'pg-boss',
  );
  expect(forbiddenInserts).toHaveLength(0);
  const summaries = await sql`select date_trunc('minute', at) as minute,
    count(*) filter (where kind = 'job_events:DELETE')::int as executions,
    array_agg(phase) filter (where kind = 'job_events:DELETE') as effect_phases
    from yuk1355_cron_audit group by 1 order by 1`;
  observations.push({
    stage: 'observed-result',
    legacyId,
    cachedTickId: cached.id,
    lateCachedTickId: lateCached.id,
    dbosWorkflowId: receipt.workflow_id,
    admittedLegacyTasks: rollback.jobs
      .filter((job) => job.name === 'prune_job_events')
      .map((job) => ({ id: job.id, state: job.state })),
    receiptCount: rollback.receipts.length,
    businessDeleteStatements: rollback.audit.filter((row) => row.kind === 'job_events:DELETE')
      .length,
    forbiddenLegacyInserts: forbiddenInserts.length,
    summaries,
  });
  expect(summaries.filter((row) => row.executions > 1)).toEqual([]);
  expect(
    (
      await sql`select state, retry_count, data from pgboss.job where id = ${unrelatedJob}::uuid`
    )[0],
  ).toMatchObject({
    state: 'failed',
    retry_count: 0,
    data: { outcome: 'unknown', nested: { replayAllowed: false } },
  });
  await worker.stop();
  await peer.stop();
  passed = true;
}, 390000);
