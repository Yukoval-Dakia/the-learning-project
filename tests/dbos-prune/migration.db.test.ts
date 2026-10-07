import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { PgBoss } from 'pg-boss';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

const ipcSchema = z
  .object({
    kind: z.enum(['ready', 'boundary', 'done', 'ack', 'rejected', 'failure']),
    error: z.string().optional(),
    pid: z.number().optional(),
    status: z.object({ status: z.string(), recoveryAttempts: z.number() }).passthrough().optional(),
    steps: z.array(z.object({ name: z.string() }).passthrough()).optional(),
  })
  .passthrough();
const children = new Set<ChildProcess>();
let sql: ReturnType<typeof postgres>;
let boss: PgBoss;
const evidence: unknown[] = [];
const execFileAsync = promisify(execFile);
function startWorker(options: { id?: string; pauseAt?: string; recover?: boolean } = {}) {
  const child = spawn(process.execPath, [resolve('.cache/yuk1355-worker.cjs')], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'test',
      DATABASE_URL: process.env.TEST_DATABASE_URL,
      TLP_PRUNE_TEST_PROCESS: '1',
      TLP_PRUNE_WORKFLOW_ID: options.id,
      TLP_PRUNE_PAUSE_AT: options.pauseAt,
      TLP_PRUNE_RECOVER: options.recover ? '1' : '0',
    },
  });
  children.add(child);
  const exited = once(child, 'exit');
  const messages: z.infer<typeof ipcSchema>[] = [];
  let logs = '';
  child.stdout?.on('data', (chunk) => {
    logs = (logs + String(chunk)).slice(-5000);
  });
  child.stderr?.on('data', (chunk) => {
    logs = (logs + String(chunk)).slice(-5000);
  });
  child.on('message', (message) => messages.push(ipcSchema.parse(message)));
  child.on('exit', () => children.delete(child));
  async function wait(kind: string) {
    let value: z.infer<typeof ipcSchema> | undefined;
    await expect
      .poll(
        () => {
          const failure = messages.find((message) => message.kind === 'failure');
          if (failure) throw new Error(`${failure.error}\n${logs}`);
          if (child.exitCode !== null || child.signalCode !== null)
            throw new Error(`Worker exited: ${logs}`);
          const index = messages.findIndex((message) => message.kind === kind);
          if (index !== -1) value = messages.splice(index, 1)[0];
          return value !== undefined;
        },
        { timeout: 20000, interval: 25 },
      )
      .toBe(true);
    return ipcSchema.parse(value);
  }
  async function command(
    message: { kind: string; phase?: string; id?: string; reason?: string },
    response = 'ack',
  ) {
    child.send(message);
    return wait(response);
  }
  async function stop() {
    child.send({ kind: 'stop' });
    expect(await exited).toEqual([0, null]);
  }
  return { child, exited, wait, command, stop };
}
async function schedules(expected: 'pg-boss' | 'dbos' | 'none') {
  await expect
    .poll(
      async () => {
        const pg = await sql`select * from pgboss.schedule where name = 'prune_job_events'`;
        const dbos =
          await sql`select status, cron_timezone, automatic_backfill from tlp_dbos.workflow_schedules where schedule_name = 'prune_job_events'`;
        return { pg: pg.length, dbos: dbos[0]?.status ?? 'PAUSED' };
      },
      { timeout: 10000, interval: 50 },
    )
    .toEqual({
      pg: expected === 'pg-boss' ? 1 : 0,
      dbos: expected === 'dbos' ? 'ACTIVE' : 'PAUSED',
    });
}
async function phase(value: string) {
  await sql`update prune_job_events_control set phase = ${value}`;
}
beforeAll(async () => {
  const url = new URL(z.url().parse(process.env.TEST_DATABASE_URL));
  expect(url.pathname).toMatch(/^\/test_fork_\d+$/);
  sql = postgres(url.toString(), { max: 3 });
  await execFileAsync(resolve('node_modules/.bin/esbuild'), [
    'tests/dbos-prune/worker.ts',
    '--bundle',
    '--platform=node',
    '--target=node24',
    '--format=cjs',
    '--outfile=.cache/yuk1355-worker.cjs',
    '--external:pg-native',
    '--external:sharp',
    '--external:better-sqlite3',
    '--external:bufferutil',
    '--external:utf-8-validate',
    '--external:winston',
    '--external:winston-transport',
  ]);
  // Housekeeping is epoch-agnostic under an active marker.
  await sql`delete from contract_epoch`;
  boss = new PgBoss({
    connectionString: url.toString(),
    max: 2,
    supervise: false,
    schedule: false,
  });
  boss.on('error', () => {});
  await boss.start();
});
afterAll(async () => {
  for (const child of children) {
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
  }
  await boss?.stop();
  await sql?.end();
  if (process.env.TLP_PRUNE_EVIDENCE_PATH)
    await writeFile(
      process.env.TLP_PRUNE_EVIDENCE_PATH,
      `${JSON.stringify(
        {
          capturedAt: new Date().toISOString(),
          dbos: '5.2.11',
          providerCalls: 0,
          evidence,
          sourceHashes: await Promise.all(
            [
              'src/server/durable/prune-family.ts',
              'src/server/durable/prune-worker.ts',
              'tests/dbos-prune/worker.ts',
              'tests/dbos-prune/migration.db.test.ts',
              'drizzle/0115_yuk1355_prune_backend.sql',
              'package.json',
              '.cache/yuk1355-worker.cjs',
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

describe('YUK-1355 prune full cutover/drain/rollback with real worker processes', () => {
  it('keeps old retry ownership, blocks failed/unknown obligations, and switches cron once', async () => {
    const worker = startWorker();
    await worker.wait('ready');
    await schedules('pg-boss');
    const cli = await execFileAsync(
      process.execPath,
      ['--import', 'tsx', 'scripts/prune-backend.ts', 'status'],
      {
        env: {
          PATH: process.env.PATH,
          NODE_ENV: 'test',
          DATABASE_URL: process.env.TEST_DATABASE_URL,
        },
      },
    );
    expect(JSON.parse(cli.stdout)).toMatchObject({ phase: 'pg-boss', dbosObligations: [] });
    const peer = startWorker();
    await peer.wait('ready');
    await schedules('pg-boss');
    const failed = await boss.send('prune_job_events', {});
    const retry = await boss.send('prune_job_events', {}, { startAfter: 600 });
    await sql`update pgboss.job set state = 'failed' where id = ${failed}::uuid`;
    await sql`update pgboss.job set state = 'retry' where id = ${retry}::uuid`;
    await worker.command({ kind: 'transition', phase: 'draining-pg-boss' });
    await schedules('none');
    await expect(boss.send('prune_job_events', {})).rejects.toThrow('producer fenced');
    await expect(
      boss.schedule('prune_job_events', '0 4 * * *', {}, { tz: 'Asia/Shanghai' }),
    ).rejects.toThrow('producer fenced');
    const rejected = await worker.command({ kind: 'transition', phase: 'dbos' }, 'rejected');
    expect(rejected.error).toContain('Prune drain blocked');
    await sql`update pgboss.job set start_after = now() where id = ${retry}::uuid`;
    await expect
      .poll(
        async () => (await sql`select state from pgboss.job where id = ${retry}::uuid`)[0]?.state,
        { timeout: 10000 },
      )
      .toBe('completed');
    await worker.command({
      kind: 'retire',
      id: String(failed),
      reason: 'Synthetic terminal prune tick retired; no external effect or replay',
    });
    await boss.createQueue('prune_job_events_dlq');
    const unexpectedDlq = await boss.send('prune_job_events_dlq', { externalResult: 'unknown' });
    await worker.command({ kind: 'transition', phase: 'dbos' }, 'rejected');
    await worker.command(
      { kind: 'retire', id: String(unexpectedDlq), reason: 'must reject unknown DLQ' },
      'rejected',
    );
    expect(
      (await sql`select state from pgboss.job where id = ${unexpectedDlq}::uuid`)[0]?.state,
    ).toBe('created');
    // Remove only this synthetic fixture after proving the implementation kept it.
    await sql`delete from pgboss.job where id = ${unexpectedDlq}::uuid`;
    // Unknown queue and provider outcome remain untouched by this family migration.
    await boss.createQueue('unknown_external_result');
    const unknown = await boss.send('unknown_external_result', {
      result: 'unknown',
      nested: { providerAttempt: 'uncheckpointed' },
    });
    await sql`update pgboss.job set state = 'failed' where id = ${unknown}::uuid`;
    await worker.command(
      { kind: 'retire', id: String(unknown), reason: 'must reject' },
      'rejected',
    );
    await worker.command({ kind: 'transition', phase: 'dbos' });
    await schedules('dbos');
    expect(
      (await sql`select state, retry_count, data from pgboss.job where id = ${unknown}::uuid`)[0],
    ).toMatchObject({ state: 'failed', retry_count: 0, data: { result: 'unknown' } });
    await worker.command({ kind: 'transition', phase: 'draining-dbos' });
    await schedules('none');
    await worker.command({ kind: 'transition', phase: 'pg-boss' });
    await schedules('pg-boss');
    await worker.stop();
    await peer.stop();
    evidence.push({
      scenario: 'cutover-drain-rollback-two-workers',
      legacyRetryCompleted: retry,
      retiredFailure: failed,
      unknownUntouched: unknown,
      scheduleRegistrationProjectionChecked: true,
      cronTickExecutionObserved: false,
    });
  });
  it.each(['business-committed', 'checkpoint-saved'])(
    'SIGKILL at %s recovers once and blocks early rollback',
    async (pauseAt) => {
      await phase('dbos');
      const id = randomUUID();
      await sql`insert into job_events (business_table,business_id,event_type,payload,occurred_at) values
      ('yuk1355',${id},'old',${sql.json({ text: 'Synthetic long nested telemetry '.repeat(100), branches: [{ kind: 'failure', reason: 'ambiguous' }] })},'2026-08-01'),
      ('yuk1355',${id},'recent','{}','2026-10-06')`;
      const worker = startWorker({ id, pauseAt });
      await worker.wait('boundary');
      expect(
        (await sql`select deleted from prune_job_events_receipt where workflow_id = ${id}`)[0]
          ?.deleted,
      ).toBeGreaterThanOrEqual(1);
      const [pending] =
        await sql`select status from tlp_dbos.workflow_status where workflow_uuid = ${id}`;
      expect(pending.status).toBe('PENDING');
      await worker.command({ kind: 'transition', phase: 'draining-dbos' });
      expect(
        (await worker.command({ kind: 'transition', phase: 'pg-boss' }, 'rejected')).error,
      ).toContain('Prune drain blocked');
      worker.child.kill('SIGKILL');
      expect(await worker.exited).toEqual([null, 'SIGKILL']);
      // A row arriving after the commit is older than the cutoff. Receipt reuse must
      // keep it, proving the destructive business transaction was not repeated.
      await sql`insert into job_events (business_table,business_id,event_type,payload,occurred_at) values ('yuk1355',${id},'late-old','{}','2026-08-01')`;
      const recovery = startWorker({ id, recover: true });
      const competingRecovery = startWorker({ id, recover: true });
      const done = await recovery.wait('done');
      const competingDone = await competingRecovery.wait('done');
      expect(competingDone.status?.status).toBe('SUCCESS');
      expect(done.status?.status).toBe('SUCCESS');
      expect(done.status?.recoveryAttempts).toBeGreaterThan(1);
      expect(done.steps?.map((step) => step.name)).toEqual(['prune-business-commit']);
      expect(
        (
          await sql`select event_type from job_events where business_id = ${id} order by event_type`
        ).map((r) => r.event_type),
      ).toEqual(['late-old', 'recent']);
      await recovery.command({ kind: 'transition', phase: 'pg-boss' });
      await schedules('pg-boss');
      await recovery.stop();
      await competingRecovery.stop();
      evidence.push({
        scenario: pauseAt,
        workflowId: id,
        killedPid: worker.child.pid,
        recoveredPid: done.pid,
        signal: 'SIGKILL',
        status: done.status,
        lateOldPreserved: true,
        checkpoints: done.steps,
      });
    },
    60000,
  );
});
