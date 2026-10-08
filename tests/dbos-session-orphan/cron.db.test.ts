import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { z } from 'zod';
import {
  type ChildExit,
  assertFixtureCanReset,
  assertSettledCronLedger,
  cleanupOwnedChildren,
  errorDiagnostic,
  waitForFixtureMessage,
} from '../dbos-review-orphan/fixture-process';

const exec = promisify(execFile);
const bundle = resolve(`.cache/yuk1394-session-cron-${process.pid}.cjs`);
const children = new Map<ChildProcess, Promise<ChildExit>>();
const observations: unknown[] = [];
const families = ['prune_orphan_conversation_sessions', 'prune_orphan_placement_sessions'] as const;
let family: (typeof families)[number] = families[0];
const logs: unknown[] = [];
let db: ReturnType<typeof postgres>;
let url: string;
let suiteBlocked: string | undefined =
  'Cron fixture setup has not established settled durable state';
let nativeBaseline: Awaited<ReturnType<typeof nativeLedger>>;
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
  const exit = new Promise<ChildExit>((resolveExit) => {
    child.once('exit', (code, signal) => resolveExit([code, signal]));
  });
  children.set(child, exit);
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
    return waitForFixtureMessage({
      messages,
      expected: kind,
      exited: () => child.exitCode !== null || child.signalCode !== null,
      evidence: () => log,
      timeoutMs: timeout,
    });
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
async function observeLegacySettled(selected: (typeof families)[number]) {
  let pending: readonly unknown[] = [];
  try {
    await expect
      .poll(
        async () => {
          pending = await db`select id::text,name,state::text from pgboss.job
        where (name in (${selected}, ${`${selected}_dlq`}) and (state <> 'completed' or name = ${`${selected}_dlq`}))
          or (name = '__pgboss__send-it' and state <> 'completed' and data->>'name' = ${selected})
        order by id`;
          return pending.length;
        },
        { timeout: 10000, interval: 50 },
      )
      .toBe(0);
  } finally {
    observations.push({
      legacySettlement: { family: selected, pending, observedAt: new Date().toISOString() },
    });
  }
}
async function nativeLedger() {
  return db.begin('read only', async (tx) => {
    await tx`set local statement_timeout = '3s'`;
    const [schema] = await tx`select to_regclass('tlp_dbos.workflow_status') as relation`;
    const workflows = schema.relation
      ? await tx`select workflow_uuid,name,status from tlp_dbos.workflow_status where name in (${families[0]},${families[1]}) order by workflow_uuid`
      : [];
    const ticks = await tx`select * from session_orphan_tick order by family,tick_id`;
    const receipts =
      await tx`select * from session_orphan_receipt order by family,tick_id,session_id`;
    const dispositions =
      await tx`select * from session_orphan_disposition order by family,backend,kind,task_id,tick_id,session_id`;
    const gaps = await tx`select t.family,t.tick_id,c->>'sessionId' as session_id
      from session_orphan_tick t cross join lateral jsonb_array_elements(t.candidates) c
      where not exists (select 1 from session_orphan_receipt r where r.family = t.family and r.tick_id = t.tick_id and r.session_id = c->>'sessionId')`;
    return { workflows, ticks, receipts, dispositions, gaps };
  });
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
  const initialLedger = await nativeLedger();
  observations.push({ initialLedger });
  assertSettledCronLedger(initialLedger);
  await db`delete from contract_epoch`;
  await db`update session_orphan_control set phase = 'pg-boss', phase_changed_at = clock_timestamp(), legacy_not_before = null`;
  await db`update prune_job_events_control set phase = 'pg-boss'`;
  suiteBlocked = undefined;
}, 60000);
beforeEach(async () => {
  assertFixtureCanReset(children.keys(), suiteBlocked);
  nativeBaseline = await nativeLedger();
  assertSettledCronLedger(nativeBaseline);
  observations.push({ scenario: expect.getState().currentTestName, nativeBaseline });
});
afterEach(async (context) => {
  if (suiteBlocked) return;
  const failed = context.task.result?.state === 'fail';
  if (failed) {
    suiteBlocked = `Failed scenario ${context.task.name}; prior durable evidence is retained`;
    observations.push({ failedScenario: context.task.name, preCleanupLogs: structuredClone(logs) });
    try {
      observations.push({ preCleanupLedger: await nativeLedger() });
    } catch (error) {
      observations.push({ observationFailure: errorDiagnostic(error) });
    }
  }
  try {
    await cleanupOwnedChildren(children);
    assertFixtureCanReset(children.keys());
    const after = await nativeLedger();
    observations.push({ scenario: context.task.name, afterCleanupLedger: after });
    if (!failed) assertSettledCronLedger(after);
    if (nativeBaseline)
      for (const table of ['workflows', 'ticks', 'receipts', 'dispositions'] as const)
        for (const row of nativeBaseline[table])
          expect(after[table], `Historical ${table} row must survive the scenario`).toContainEqual(
            row,
          );
  } catch (error) {
    suiteBlocked = `Scenario ${context.task.name} cleanup or ledger consistency failed`;
    observations.push({ cleanupOrConsistencyFailure: errorDiagnostic(error) });
    throw error;
  }
});
afterAll(async () => {
  let cleanupError: unknown;
  try {
    await cleanupOwnedChildren(children);
  } catch (error) {
    cleanupError = error;
    suiteBlocked = 'Final owned child cleanup did not establish process exit';
    observations.push({ finalCleanupFailure: errorDiagnostic(error) });
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
          bundleSha256: await readFile(bundle)
            .then((data) => createHash('sha256').update(data).digest('hex'))
            .catch(() => null),
          observations,
          logs,
          suiteBlocked,
        },
        null,
        2,
      ),
    );
  if (db) {
    if (!suiteBlocked)
      await db`update session_orphan_control set phase = 'pg-boss', legacy_not_before = null`;
    await db.end();
  }
  if (cleanupError) throw cleanupError;
});
for (const selected of families)
  it(`observes real ${selected} Timekeeper, mixed phases, native two-scheduler ticks/restart and independent rollback`, async () => {
    family = selected;
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
    await observeLegacySettled(family);
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
            await db`select tick_id from session_orphan_tick where family = ${family} and backend = 'dbos'`
          ).filter(
            (tick) =>
              !nativeBaseline.ticks.some(
                (prior) => prior.family === family && prior.tick_id === tick.tick_id,
              ),
          ).length,
        { timeout: 120000, interval: 100 },
      )
      .toBeGreaterThanOrEqual(3);
    second.child.send({ kind: 'transition', family: other, phase: 'draining-pg-boss' });
    await second.wait('ack');
    await observeLegacySettled(other);
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
    await observeLegacySettled(family);
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
