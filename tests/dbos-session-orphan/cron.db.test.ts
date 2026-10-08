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
const bundle = resolve(`.cache/yuk1394-session-cron-${process.pid}.cjs`);
const children = new Set<ChildProcess>();
const observations: unknown[] = [];
const families = ['prune_orphan_conversation_sessions', 'prune_orphan_placement_sessions'] as const;
let family: (typeof families)[number] = families[0];
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
      TLP_SESSION_TEST_PROCESS: '1',
      TLP_SESSION_FAMILY: family,
      TLP_SESSION_CRON_TEST: '1',
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
    child.send({ ...command, family });
    return wait(expected, 10000);
  }
  async function stop() {
    child.send({ kind: 'stop' });
    expect(await exit).toEqual([0, null]);
  }
  return { child, wait, command, stop };
}
async function oldSession(id: string) {
  await db`insert into learning_session (id,type,status,started_at,version) values (${id},${family === families[0] ? 'conversation' : 'placement'},${family === families[0] ? 'active' : 'started'},clock_timestamp() - interval '7 hours',0)`;
}
async function receiptFor(id: string) {
  return db`select t.*, r.session_id,r.outcome from session_orphan_tick t join session_orphan_receipt r using (family,tick_id) where t.family = ${family} and r.session_id = ${id}`;
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
    'tests/dbos-session-orphan/worker.ts',
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
  await db`truncate session_orphan_disposition, session_orphan_receipt, session_orphan_tick, learning_session, job_events cascade`;
  await db`update session_orphan_control set phase = 'pg-boss', phase_changed_at = clock_timestamp(), legacy_not_before = null`;
  await db`update prune_job_events_control set phase = 'pg-boss'`;
}, 60000);
afterAll(async () => {
  for (const child of children) {
    const exit = once(child, 'exit');
    child.kill('SIGKILL');
    await exit;
  }
  if (process.env.TLP_SESSION_CRON_EVIDENCE_PATH)
    await writeFile(
      process.env.TLP_SESSION_CRON_EVIDENCE_PATH,
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
    await db`update session_orphan_control set phase = 'pg-boss', legacy_not_before = null`;
    await db.end();
  }
});
for (const selected of families)
  it(`observes real ${selected} Timekeeper, mixed phases, native two-scheduler ticks/restart and independent rollback`, async () => {
    family = selected;
    await db`truncate session_orphan_disposition, session_orphan_receipt, session_orphan_tick, learning_session, job_events cascade`;
    await db`update session_orphan_control set phase = 'pg-boss', phase_changed_at = clock_timestamp(), legacy_not_before = null`;
    const other = family === families[0] ? families[1] : families[0];
    const otherBefore = await db`select * from session_orphan_control where family = ${other}`;
    const first = start();
    await first.wait('ready');
    const id = `cron-${randomUUID()}`;
    await oldSession(id);
    const held = await first.wait('forward-held');
    observations.push({ held });
    await first.command({ kind: 'transition', phase: 'draining-pg-boss' });
    const noProof = await first.command({ kind: 'transition', phase: 'dbos' }, 'rejected');
    expect(noProof.error).toContain('Drain blocked');
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
            await db`select count(*)::int as n from pgboss.job where name = '__pgboss__send-it' and state <> 'completed' and data::text like ${`%${family}%`}`
          )[0].n,
        { timeout: 10000 },
      )
      .toBe(0);
    expect(
      (await first.command({ kind: 'transition', phase: 'dbos' }, 'rejected')).error,
    ).toContain('quiescence');
    await first.command({
      kind: 'quiesce',
      reason:
        'Fixture observed held forwarder rejection and no pre-migration consumer exists in this disposable DB',
    });
    await first.command({ kind: 'transition', phase: 'dbos' });
    expect(await db`select * from session_orphan_control where family = ${other}`).toEqual(
      otherBefore,
    );
    await expect
      .poll(
        async () =>
          (
            await db`select options->>'missed' as missed from pgboss.schedule where name = ${other}`
          )[0]?.missed,
      )
      .toBe('skip');
    const second = start();
    await second.wait('ready');
    await expect
      .poll(async () => (await receiptFor(id)).length, { timeout: 120000, interval: 100 })
      .toBe(1);
    const native = await receiptFor(id);
    observations.push({ native });
    expect(native[0].tick_id).toMatch(new RegExp(`^sched-${family}-`));
    expect(native[0].provenance).toBe('scheduled');
    expect(native[0].outcome.kind).toBe('abandoned');
    expect(new Date(native[0].tick_at).getTime() - new Date(native[0].cutoff).getTime()).toBe(
      6 * 3600000,
    );
    expect(
      await db`select * from job_events where business_id = ${id} and event_type = ${family === families[0] ? 'conversation.abandoned' : 'placement.abandoned'}`,
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
          (
            await db`select count(*)::int as n from session_orphan_tick where family = ${family} and backend = 'dbos'`
          )[0].n,
        { timeout: 120000, interval: 100 },
      )
      .toBeGreaterThanOrEqual(3);
    second.child.send({ kind: 'transition', family: other, phase: 'draining-pg-boss' });
    await second.wait('ack');
    await expect
      .poll(
        async () =>
          (
            await db`select count(*)::int as n from pgboss.job where name = '__pgboss__send-it' and state <> 'completed' and data->>'name' = ${other}`
          )[0].n,
        { timeout: 10000 },
      )
      .toBe(0);
    second.child.send({
      kind: 'quiesce',
      family: other,
      reason:
        'Observed no pre-lane consumer; only current compatible process remains and forwarders settled',
    });
    await second.wait('ack');
    second.child.send({ kind: 'transition', family: other, phase: 'dbos' });
    await second.wait('ack');
    const otherId = `both-native-${randomUUID()}`;
    await db`insert into learning_session (id,type,status,started_at) values (${otherId},${other === families[0] ? 'conversation' : 'placement'},${other === families[0] ? 'active' : 'started'},clock_timestamp() - interval '7 hours')`;
    await expect
      .poll(
        async () =>
          (
            await db`select r.* from session_orphan_receipt r join session_orphan_tick t using (family,tick_id) where r.family = ${other} and r.session_id = ${otherId} and t.backend = 'dbos'`
          ).length,
        { timeout: 120000 },
      )
      .toBe(1);
    const otherControl = await db`select * from session_orphan_control where family = ${other}`;
    const otherReceipts =
      await db`select * from session_orphan_receipt where family = ${other} order by tick_id,session_id`;
    await second.command({ kind: 'transition', phase: 'draining-dbos' });
    await second.command({
      kind: 'quiesce',
      reason:
        'Two compatible workers only; first stopped; all native/legacy forwarding observed settled',
    });
    const early = await second.command({ kind: 'transition', phase: 'pg-boss' }, 'rejected');
    expect(early.error).toMatch(/cooldown|Drain blocked/);
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
      .poll(
        async () =>
          (await db`select phase from session_orphan_control where family = ${family}`)[0].phase,
        {
          timeout: 10000,
        },
      )
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
    expect(await db`select * from session_orphan_control where family = ${other}`).toEqual(
      otherControl,
    );
    expect(
      await db`select * from session_orphan_receipt where family = ${other} and session_id = ${otherId}`,
    ).toEqual(otherReceipts.filter((r) => r.session_id === otherId));
    const [policy] =
      await db`select options->>'missed' as missed from pgboss.schedule where name = ${family}`;
    expect(policy.missed).toBe('skip');
    const legacyId = String(legacy[0].tick_id).slice(7);
    expect((await db`select name from pgboss.job where id = ${legacyId}::uuid`)[0].name).toBe(
      family,
    );
    observations.push({ rollback: legacy });
    expect(await db`select * from pgboss.schedule where name = 'prune_job_events'`).toHaveLength(1);
    await second.stop();
  }, 600000);
it('retains production 04:25 and 04:35 Asia/Shanghai declarations and previous-date UTC mapping', async () => {
  const source = await readFile('src/capabilities/observability/manifest.ts', 'utf8');
  for (const [offset, expected] of [
    [25, '2026-10-09T20:25:00.000Z'],
    [35, '2026-10-09T20:35:00.000Z'],
  ] as const) {
    expect(source).toContain(`schedule: { cron: '${offset} 4 * * *', tz: 'Asia/Shanghai' }`);
    const [row] =
      await db`select to_char(( ${`2026-10-10 04:${offset}:00`}::timestamp at time zone 'Asia/Shanghai') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as utc`;
    expect(new Date(row.utc).toISOString()).toBe(expected);
  }
});
