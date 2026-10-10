import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import postgres from 'postgres';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { z } from 'zod';

const exec = promisify(execFile);
const bundle = resolve(`.cache/yuk1393-cron-${process.pid}.cjs`);
const children = new Set<ChildProcess>();
const observations: unknown[] = [];
const logs: unknown[] = [];
let db: ReturnType<typeof postgres>;
let url: string;
const schema = z.object({ kind: z.string(), error: z.string().optional() }).passthrough();
function start() {
  const child = spawn(process.execPath, [bundle], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: {
      PATH: process.env.PATH,
      NODE_PATH: resolve('node_modules'),
      NODE_ENV: 'test',
      DATABASE_URL: url,
      TLP_REVIEW_TEST_PROCESS: '1',
      TLP_REVIEW_CRON_TEST: '1',
    },
  });
  children.add(child);
  const exit = once(child, 'exit');
  const messages: z.infer<typeof schema>[] = [];
  const log = { pid: child.pid, messages: [] as unknown[], stdout: '', stderr: '' };
  logs.push(log);
  child.stdout?.on('data', (c) => {
    log.stdout += String(c);
  });
  child.stderr?.on('data', (c) => {
    log.stderr += String(c);
  });
  child.on('message', (m) => {
    messages.push(schema.parse(m));
    log.messages.push(m);
  });
  child.on('exit', () => children.delete(child));
  async function wait(kind: string, timeout = 90000) {
    let message: z.infer<typeof schema> | undefined;
    await expect
      .poll(
        () => {
          const failure = messages.find((m) => m.kind === 'failure');
          if (failure) throw new Error(`${failure.error}\n${log.stderr}`);
          const index = messages.findIndex((m) =>
            kind === 'ack-or-rejected' ? ['ack', 'rejected'].includes(m.kind) : m.kind === kind,
          );
          if (index >= 0) message = messages.splice(index, 1)[0];
          return !!message;
        },
        { timeout, interval: 50 },
      )
      .toBe(true);
    return schema.parse(message);
  }
  async function command(
    command: { kind: string; phase?: string; reason?: string },
    expected = 'ack',
  ) {
    child.send(command);
    return wait(expected, 10000);
  }
  async function stop() {
    child.send({ kind: 'stop' });
    expect(await exit).toEqual([0, null]);
  }
  return { child, wait, command, stop };
}
async function oldSession(id: string) {
  await db`insert into learning_session (id,type,status,started_at,version) values (${id},'review','started',clock_timestamp() - interval '7 hours',0)`;
}
async function receiptFor(id: string) {
  return db`select t.*, r.session_id,r.outcome from review_orphan_tick t join review_orphan_receipt r using (tick_id) where r.session_id = ${id}`;
}
beforeAll(async () => {
  const target = new URL(z.url().parse(process.env.TEST_DATABASE_URL));
  if (
    !/^\/test_fork_\d+$/.test(target.pathname) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)
  )
    throw new Error('Cron fixture refuses default/non-disposable database');
  url = target.toString();
  db = postgres(url, { max: 3 });
  await exec(resolve('node_modules/.bin/esbuild'), [
    'tests/dbos-review-orphan/worker.ts',
    '--bundle',
    '--platform=node',
    '--target=node24',
    '--format=cjs',
    `--outfile=${bundle}`,
    '--external:pg-native',
    '--external:sharp',
    '--external:better-sqlite3',
    '--external:bufferutil',
    '--external:utf-8-validate',
    '--external:winston',
    '--external:winston-transport',
  ]);
  await db`delete from contract_epoch`;
  await db`truncate review_orphan_disposition, review_orphan_receipt, review_orphan_tick, learning_session, job_events cascade`;
  await db`update review_orphan_control set phase = 'pg-boss', phase_changed_at = clock_timestamp(), legacy_not_before = null`;
  await db`update prune_job_events_control set phase = 'pg-boss'`;
}, 60000);
afterAll(async () => {
  for (const child of children) {
    const exit = once(child, 'exit');
    child.kill('SIGKILL');
    await exit;
  }
  if (process.env.TLP_REVIEW_CRON_EVIDENCE_PATH)
    await writeFile(
      process.env.TLP_REVIEW_CRON_EVIDENCE_PATH,
      JSON.stringify(
        {
          capturedAt: new Date().toISOString(),
          node: process.version,
          execPath: process.execPath,
          bundle,
          bundleSha256: createHash('sha256')
            .update(await readFile(bundle))
            .digest('hex'),
          observations,
          logs,
        },
        null,
        2,
      ),
    );
  if (db) {
    await db`update review_orphan_control set phase = 'pg-boss', legacy_not_before = null`;
    await db.end();
  }
});
it('observes real Timekeeper forwarding, native two-scheduler ticks/restart and safe rollback', async () => {
  const first = start();
  await first.wait('ready');
  const id = `cron-${randomUUID()}`;
  await oldSession(id);
  const held = await first.wait('forward-held');
  observations.push({ held });
  await first.command({ kind: 'transition', phase: 'draining-pg-boss' });
  const noProof = await first.command({ kind: 'transition', phase: 'dbos' }, 'rejected');
  expect(noProof.error).toContain('drain blocked');
  expect(noProof.error).toContain('"kind":"forwarder"');
  expect(noProof.error).toContain('"state":"active"');
  // Keep a real forwarder suspended longer than the 60-second source lookback.
  const barrier = Date.now();
  await expect
    .poll(() => Date.now() - barrier >= 61000, { timeout: 65000, interval: 1000 })
    .toBe(true);
  expect(await receiptFor(id)).toHaveLength(0);
  await first.command({ kind: 'release-forward' });
  const rejected = await first.wait('forward-rejected');
  observations.push({ lateForwardRejected: rejected });
  expect(rejected.error).toContain('producer fenced');
  await expect
    .poll(
      async () =>
        (
          await db`select count(*)::int as n from pgboss.job where name = '__pgboss__send-it' and state <> 'completed' and data::text like '%prune_orphan_review_sessions%'`
        )[0].n,
      { timeout: 10000 },
    )
    .toBe(0);
  expect((await first.command({ kind: 'transition', phase: 'dbos' }, 'rejected')).error).toContain(
    'quiescence',
  );
  await first.command({
    kind: 'quiesce',
    reason:
      'Fixture observed held forwarder rejection and no pre-migration consumer exists in this disposable DB',
  });
  await first.command({ kind: 'transition', phase: 'dbos' });
  const second = start();
  await second.wait('ready');
  await expect
    .poll(async () => (await receiptFor(id)).length, { timeout: 120000, interval: 100 })
    .toBe(1);
  const native = await receiptFor(id);
  observations.push({ native });
  expect(native[0].tick_id).toMatch(/^sched-prune_orphan_review_sessions-/);
  expect(native[0].provenance).toBe('scheduled');
  expect(native[0].outcome.kind).toBe('abandoned');
  expect(new Date(native[0].tick_at).getTime() - new Date(native[0].cutoff).getTime()).toBe(
    6 * 3600000,
  );
  expect(
    await db`select * from job_events where business_id = ${id} and event_type = 'review.abandoned'`,
  ).toHaveLength(1);
  await first.stop();
  const next = `next-${randomUUID()}`;
  await oldSession(next);
  await expect
    .poll(async () => (await receiptFor(next)).length, { timeout: 120000, interval: 100 })
    .toBe(1);
  observations.push({ next: await receiptFor(next) });
  // Empty native admissions still occupy their scheduled point and rollback horizon.
  await expect
    .poll(
      async () =>
        (await db`select count(*)::int as n from review_orphan_tick where backend = 'dbos'`)[0].n,
      { timeout: 120000, interval: 100 },
    )
    .toBeGreaterThanOrEqual(3);
  await second.command({ kind: 'transition', phase: 'draining-dbos' });
  await second.command({
    kind: 'quiesce',
    reason:
      'Two compatible workers only; first stopped; all native/legacy forwarding observed settled',
  });
  const early = await second.command({ kind: 'transition', phase: 'pg-boss' }, 'rejected');
  expect(early.error).toMatch(/cooldown|drain blocked/);
  await expect
    .poll(
      async () => {
        const response = await second.command(
          { kind: 'transition', phase: 'pg-boss' },
          'ack-or-rejected',
        );
        return response.kind === 'ack';
      },
      { timeout: 80000, interval: 1000 },
    )
    .toBe(true);
  await expect
    .poll(async () => (await db`select phase from review_orphan_control`)[0].phase, {
      timeout: 10000,
    })
    .toBe('pg-boss');
  const rolled = `rolled-${randomUUID()}`;
  await oldSession(rolled);
  await second.command({ kind: 'release-forward' });
  await expect
    .poll(async () => (await receiptFor(rolled)).length, { timeout: 120000, interval: 100 })
    .toBe(1);
  const legacy = await receiptFor(rolled);
  expect(legacy[0].backend).toBe('pg-boss');
  expect(legacy[0].provenance).toBe('legacy-first-admission');
  observations.push({ rollback: legacy });
  expect(await db`select * from pgboss.schedule where name = 'prune_job_events'`).toHaveLength(1);
  await second.stop();
}, 600000);
