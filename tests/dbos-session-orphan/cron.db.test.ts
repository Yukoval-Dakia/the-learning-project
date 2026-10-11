import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { z } from 'zod';
import type { Db } from '@/db/client';
import {
  sessionOrphanObligations,
  sessionOrphanRollbackHorizon,
} from '@/server/durable/session-orphan-backend';
import {
  type ChildExit,
  assertFixtureCanReset,
  assertSettledCronLedger,
  cleanupOwnedChildren,
  errorDiagnostic,
  waitForFixtureMessage,
} from '../dbos-review-orphan/fixture-process';
import { clockSearchPath, nativeCron, sessionDeclarations } from './fixture';

const exec = promisify(execFile);
const bundle = resolve(`.cache/yuk1394-session-cron-${process.pid}.cjs`);
const children = new Map<ChildProcess, Promise<ChildExit>>();
const observations: unknown[] = [];
const families = ['prune_orphan_conversation_sessions', 'prune_orphan_placement_sessions'] as const;
let family: (typeof families)[number] = families[0];
const logs: unknown[] = [];
let db: ReturnType<typeof postgres>;
let phaseQueries: Pick<Db, 'execute'>;
let url: string;
let producerSearchPath: string | undefined;
let clockInstalled = false;
let suiteBlocked: string | undefined =
  'Cron fixture setup has not established settled durable state';
let nativeBaseline: Awaited<ReturnType<typeof nativeLedger>>;
const schema = z.object({ kind: z.string(), error: z.string().optional() }).passthrough();
async function advanceClock(at: string) {
  await db`update session_cron_clock.state set frozen_at = null,
    offset_ms = greatest(offset_ms, ceil(extract(epoch from (${at}::timestamptz - pg_catalog.clock_timestamp())) * 1000)::bigint) where singleton`;
  expect(
    (await db`select session_cron_clock.clock_timestamp() >= ${at}::timestamptz as reached`)[0]
      .reached,
  ).toBe(true);
}
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
  return { child, messages: log.messages, wait, command, stop };
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
  // Drizzle installs timestamp parsers on this client; initialize before taking any snapshots.
  phaseQueries = drizzle(db);
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
  const [producer] =
    await db`select prosrc, proconfig from pg_proc where oid = 'public.fence_session_orphan_producer()'::regprocedure`;
  const settings = z.array(z.string()).nullable().parse(producer.proconfig) ?? [];
  producerSearchPath = settings
    .find((value) => value.startsWith('search_path='))
    ?.slice('search_path='.length);
  await db`create schema if not exists session_cron_clock`;
  await db`create table if not exists session_cron_clock.state (singleton boolean primary key check (singleton), frozen_at timestamptz, offset_ms bigint not null)`;
  await db`insert into session_cron_clock.state values (true, null, 0) on conflict (singleton) do update set frozen_at = null, offset_ms = 0`;
  await db.unsafe(`create or replace function session_cron_clock.clock_timestamp() returns timestamptz language plpgsql volatile as $$
    declare clock record;
    begin
      select frozen_at, offset_ms into strict clock from session_cron_clock.state where singleton;
      return coalesce(clock.frozen_at, pg_catalog.clock_timestamp() + clock.offset_ms * interval '1 millisecond');
    end $$`);
  // The producer trigger runs on pg-boss's connection; only its application clock changes.
  await db.unsafe(
    `alter function public.fence_session_orphan_producer() set search_path to ${clockSearchPath}`,
  );
  clockInstalled = true;
  expect(
    (
      await db`select prosrc from pg_proc where oid = 'public.fence_session_orphan_producer()'::regprocedure`
    )[0].prosrc,
  ).toBe(producer.prosrc);
  await db`delete from contract_epoch`;
  await db`update session_orphan_control set phase = 'pg-boss', phase_changed_at = clock_timestamp(), legacy_not_before = null`;
  await db`update prune_job_events_control set phase = 'pg-boss'`;
  suiteBlocked = undefined;
}, 60000);
beforeEach(async () => {
  assertFixtureCanReset(children.keys(), suiteBlocked);
  nativeBaseline = await nativeLedger();
  assertSettledCronLedger(nativeBaseline);
  await db`update session_cron_clock.state set frozen_at = null, offset_ms = 0 where singleton`;
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
  if (clockInstalled && children.size === 0 && !cleanupError) {
    try {
      if (producerSearchPath === undefined)
        await db`alter function public.fence_session_orphan_producer() reset search_path`;
      else
        await db.unsafe(
          `alter function public.fence_session_orphan_producer() set search_path to '${producerSearchPath.replaceAll("'", "''")}'`,
        );
      await db`update session_cron_clock.state set frozen_at = null, offset_ms = 0 where singleton`;
    } catch (error) {
      cleanupError = error;
    }
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
for (const selected of families) {
  // @invariant concurrency: cutover and rollback preserve exactly-once receipts across two schedulers and restart
  // @fails-if ignore an active forwarder, duplicate receipts or admit rollback before the computed 60-second horizon; boundary assertions fail
  it(`observes real ${selected} Timekeeper, mixed phases, native two-scheduler ticks/restart and independent rollback`, async () => {
    family = selected;
    const started = performance.now();
    function phase(name: string) {
      const timing = {
        name,
        family,
        elapsedMs: Math.round(performance.now() - started),
        at: new Date().toISOString(),
      };
      observations.push({ phase: timing });
      console.info('cron-phase', JSON.stringify(timing));
    }
    phase('start');
    await db`update session_orphan_control set phase = 'pg-boss', phase_changed_at = clock_timestamp(), legacy_not_before = null`;
    const other = family === families[0] ? families[1] : families[0];
    const otherBefore = await db`select * from session_orphan_control where family = ${other}`;
    const first = start();
    await first.wait('ready');
    phase('legacy-ready');
    const id = `cron-${randomUUID()}`;
    await oldSession(id);
    const held = await first.wait('forward-held');
    observations.push({ held });
    phase('legacy-forward-held');
    await first.command({ kind: 'transition', phase: 'draining-pg-boss' });
    const noProof = await first.command({ kind: 'transition', phase: 'dbos' }, 'rejected');
    expect(noProof.error).toContain('Drain blocked');
    expect(noProof.error).toContain('"kind":"forwarder"');
    expect(noProof.error).toContain('"state":"active"');
    const drainingControl = await db`select * from session_orphan_control where family = ${family}`;
    const forwarders = await db`select id::text, created_on::text, state::text,
      (greatest(created_on, c.phase_changed_at) + interval '61 seconds')::text as aged_at
      from pgboss.job j cross join session_orphan_control c
      where j.name = '__pgboss__send-it' and j.state = 'active' and j.data->>'name' = ${family} and c.family = ${family}`;
    expect(forwarders).toHaveLength(1);
    const [forwarder] = forwarders;
    const forwarderId = z.string().parse(forwarder?.id);
    await advanceClock(z.string().parse(forwarder.aged_at));
    expect(
      (
        await db`select session_cron_clock.clock_timestamp() >= created_on + interval '61 seconds' as aged
      from pgboss.job where id = ${forwarderId}::uuid`
      )[0].aged,
    ).toBe(true);
    observations.push({ controlledForwarderAge: forwarder });
    phase('legacy-forwarder-logically-aged');
    expect(await receiptFor(id)).toHaveLength(0);
    const stillHeld = await first.command({ kind: 'transition', phase: 'dbos' }, 'rejected');
    expect(stillHeld.error).toContain('"kind":"forwarder"');
    expect(stillHeld.error).toContain('"state":"active"');
    expect(stillHeld.error).toContain(forwarderId);
    expect(await db`select * from session_orphan_control where family = ${family}`).toEqual(
      drainingControl,
    );
    expect(
      (await db`select state::text from pgboss.job where id = ${forwarderId}::uuid`)[0].state,
    ).toBe('active');
    await first.command({ kind: 'release-forward' });
    const rejected = await first.wait('forward-rejected');
    observations.push({ lateForwardRejected: rejected });
    expect(rejected.error).toContain('producer fenced');
    await observeLegacySettled(family);
    phase('legacy-forward-settled');
    expect(
      (await first.command({ kind: 'transition', phase: 'dbos' }, 'rejected')).error,
    ).toContain('quiescence');
    await first.command({
      kind: 'quiesce',
      reason:
        'Fixture observed held forwarder rejection and no pre-migration consumer exists in this disposable DB',
    });
    await first.command({ kind: 'transition', phase: 'dbos' });
    phase('native-cutover');
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
    phase('second-scheduler-ready');
    const probes = (messages: unknown[]) =>
      messages.flatMap((raw) => {
        const message = schema.parse(raw);
        return message.kind === 'native-scheduler-probe' &&
          typeof message.workflowId === 'string' &&
          message.workflowId.startsWith(`sched-${family}-`)
          ? [message.workflowId]
          : [];
      });
    await expect
      .poll(() => probes(first.messages).filter((id) => probes(second.messages).includes(id)), {
        timeout: 30000,
        interval: 100,
      })
      .not.toHaveLength(0);
    const overlappingSchedulerPoints = probes(first.messages).filter((id) =>
      probes(second.messages).includes(id),
    );
    observations.push({ overlappingSchedulerPoints });
    for (const point of overlappingSchedulerPoints)
      await expect
        .poll(
          async () =>
            await db`select w.status,t.backend from tlp_dbos.workflow_status w join session_orphan_tick t on t.tick_id = w.workflow_uuid and t.family = w.name where w.workflow_uuid = ${point}`,
          { timeout: 10000, interval: 100 },
        )
        .toEqual([{ status: 'SUCCESS', backend: 'dbos' }]);
    phase('two-scheduler-overlap');
    expect(
      await db`select schedule,cron_timezone,automatic_backfill from tlp_dbos.workflow_schedules where schedule_name = ${family}`,
    ).toEqual([
      {
        schedule: nativeCron,
        cron_timezone: (family === families[0]
          ? sessionDeclarations.conversationOrphans
          : sessionDeclarations.placementOrphans
        ).schedule.tz,
        automatic_backfill: false,
      },
    ]);
    await expect
      .poll(async () => (await receiptFor(id)).length, { timeout: 120000, interval: 100 })
      .toBe(1);
    phase('native-first-receipt');
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
    phase('first-scheduler-stopped');
    const next = `next-${randomUUID()}`;
    await oldSession(next);
    await expect
      .poll(async () => (await receiptFor(next)).length, { timeout: 120000, interval: 100 })
      .toBe(1);
    observations.push({ next: await receiptFor(next) });
    phase('survivor-receipt');
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
    phase('three-native-points');
    expect(await receiptFor(id)).toHaveLength(1);
    await expect
      .poll(
        async () =>
          (
            await db`select tick_id from session_orphan_tick where family = ${family} and backend = 'dbos' and candidates = '[]'::jsonb`
          ).filter(
            (tick) =>
              !nativeBaseline.ticks.some(
                (prior) => prior.family === family && prior.tick_id === tick.tick_id,
              ),
          ).length,
        { timeout: 10000, interval: 100 },
      )
      .toBeGreaterThanOrEqual(1);
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
    phase('both-families-native');
    const otherControl = await db`select * from session_orphan_control where family = ${other}`;
    const otherReceipts =
      await db`select * from session_orphan_receipt where family = ${other} order by tick_id,session_id`;
    // Both families have proved real native ticks; stop new ticks before boundary assertions.
    await second.command({ kind: 'pause-native' });
    await expect
      .poll(
        async () => {
          assertSettledCronLedger(await nativeLedger());
          return true;
        },
        { timeout: 10000, interval: 100 },
      )
      .toBe(true);
    await second.command({ kind: 'transition', phase: 'draining-dbos' });
    phase('rollback-draining');
    const [rollbackBarrier] =
      await db`select * from session_orphan_control where family = ${family}`;
    await observeLegacySettled(family);
    await expect
      .poll(() => sessionOrphanObligations(phaseQueries, { family, backend: 'dbos' }), {
        timeout: 10000,
        interval: 100,
      })
      .toEqual([]);
    await second.command({
      kind: 'quiesce',
      reason:
        'Two compatible workers only; first stopped; all native/legacy forwarding observed settled',
    });
    const horizon = await sessionOrphanRollbackHorizon(phaseQueries, family);
    const [expectedHorizon] = await db`select (greatest(c.phase_changed_at,
      coalesce((select max(substring(workflow_uuid from ${`sched-${family}-`.length + 1})::timestamptz)
        from tlp_dbos.workflow_status where name = ${family}), 'epoch'::timestamptz),
      coalesce((select max(tick_at) from session_orphan_tick where family = ${family} and backend = 'dbos'), c.phase_changed_at))
      + interval '60 seconds') = ${horizon}::timestamptz as matches
      from session_orphan_control c where c.family = ${family}`;
    expect(expectedHorizon.matches).toBe(true);
    const rollbackLedger = await nativeLedger();
    await db`update session_cron_clock.state set frozen_at = ${horizon}::timestamptz - interval '1 microsecond' where singleton`;
    const early = await second.command({ kind: 'transition', phase: 'pg-boss' }, 'rejected');
    expect(early.error).toContain('Rollback cooldown');
    expect(await db`select * from session_orphan_control where family = ${family}`).toEqual([
      rollbackBarrier,
    ]);
    expect(await nativeLedger()).toEqual(rollbackLedger);
    phase('early-rollback-rejected');
    await db`update session_cron_clock.state set frozen_at = ${horizon}::timestamptz where singleton`;
    await second.command({ kind: 'transition', phase: 'pg-boss' });
    await expect
      .poll(
        async () =>
          (await db`select phase from session_orphan_control where family = ${family}`)[0].phase,
        {
          timeout: 10000,
        },
      )
      .toBe('pg-boss');
    phase('rollback-accepted');
    expect(
      (
        await db`select legacy_not_before = ${horizon}::timestamptz as matches from session_orphan_control where family = ${family}`
      )[0].matches,
    ).toBe(true);
    observations.push({
      controlledRollbackBoundary: { horizon, before: '1 microsecond', at: horizon },
    });
    await advanceClock(horizon);
    const rolled = `rolled-${randomUUID()}`;
    await oldSession(rolled);
    await second.command({ kind: 'release-forward' });
    // Probe the real legacy producer/consumer immediately, without waiting for a new minute slot.
    const rollbackJob = await second.command({ kind: 'enqueue-legacy' });
    const rollbackJobId = z.string().parse(rollbackJob.legacyJobId);
    await expect
      .poll(async () => (await receiptFor(rolled)).length, { timeout: 120000, interval: 100 })
      .toBe(1);
    const legacy = await receiptFor(rolled);
    expect(legacy[0].backend).toBe('pg-boss');
    expect(legacy[0].provenance).toBe('legacy-first-admission');
    expect(legacy[0].tick_id).toBe(`legacy:${rollbackJobId}`);
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
    phase('rollback-legacy-receipt');
    expect(await db`select * from pgboss.schedule where name = 'prune_job_events'`).toHaveLength(1);
    await second.command({ kind: 'pause-native' });
    await expect
      .poll(
        async () => {
          assertSettledCronLedger(await nativeLedger());
          return true;
        },
        { timeout: 10000, interval: 100 },
      )
      .toBe(true);
    const settled = await nativeLedger();
    expect(
      await db`select schedule_name,status from tlp_dbos.workflow_schedules where schedule_name in (${families[0]},${families[1]}) order by schedule_name`,
    ).toEqual(families.map((schedule_name) => ({ schedule_name, status: 'PAUSED' })));
    await delay(2200);
    expect((await nativeLedger()).workflows).toEqual(settled.workflows);
    observations.push({ settledBeforeStop: settled });
    phase('native-ledger-settled-before-stop');
    await second.stop();
    phase('complete');
  }, 600000);
}
