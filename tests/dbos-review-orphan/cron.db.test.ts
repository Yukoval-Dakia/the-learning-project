import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { z } from 'zod';
import type { Db } from '@/db/client';
import {
  reviewOrphanObligations,
  reviewOrphanRollbackHorizon,
} from '@/server/durable/review-orphan-family';
import { clockSearchPath, nativeCron, reviewDeclarations, reviewFamily } from './fixture';
import {
  type ChildExit,
  assertFixtureCanReset,
  cleanupOwnedChildren,
  errorDiagnostic,
  waitForFixtureMessage,
} from './fixture-process';

const exec = promisify(execFile);
const bundle = resolve(`.cache/yuk1393-cron-${process.pid}.cjs`);
const children = new Map<ChildProcess, Promise<ChildExit>>();
const observations: unknown[] = [];
const logs: unknown[] = [];
let db: ReturnType<typeof postgres>;
let phaseQueries: Pick<Db, 'execute'>;
let url: string;
let producerSearchPath: string | undefined;
let clockInstalled = false;
let originalJobClock: string | undefined;
let suiteBlocked: string | undefined =
  'Cron fixture setup has not established settled durable state';
let nativeBaseline: Awaited<ReturnType<typeof nativeLedger>>;
const schema = z.object({ kind: z.string(), error: z.string().optional() }).passthrough();

const reviewLedgerSchema = z.object({
  workflows: z.array(
    z.object({ workflow_uuid: z.string(), name: z.literal(reviewFamily), status: z.string() }),
  ),
  ticks: z.array(
    z.object({
      tick_id: z.string(),
      backend: z.enum(['pg-boss', 'dbos']),
      candidates: z.array(z.object({ sessionId: z.string() })),
    }),
  ),
  receipts: z.array(z.object({ tick_id: z.string(), session_id: z.string() })),
});

function assertSettledReviewLedger(raw: unknown) {
  const ledger = reviewLedgerSchema.parse(raw);
  for (const workflow of ledger.workflows) {
    if (workflow.status !== 'SUCCESS')
      throw new Error(`Unsettled native workflow ${workflow.workflow_uuid}: ${workflow.status}`);
    if (
      !ledger.ticks.some(
        (tick) => tick.tick_id === workflow.workflow_uuid && tick.backend === 'dbos',
      )
    )
      throw new Error(`SUCCESS without admission ${workflow.name}/${workflow.workflow_uuid}`);
  }
  for (const tick of ledger.ticks) {
    if (
      tick.backend === 'dbos' &&
      !ledger.workflows.some((workflow) => workflow.workflow_uuid === tick.tick_id)
    )
      throw new Error(`Native admission without workflow ${tick.tick_id}`);
    for (const candidate of tick.candidates)
      if (
        !ledger.receipts.some(
          (receipt) =>
            receipt.tick_id === tick.tick_id && receipt.session_id === candidate.sessionId,
        )
      )
        throw new Error(`Frozen candidate without receipt ${tick.tick_id}/${candidate.sessionId}`);
  }
}

async function advanceClock(at: string) {
  await db`update review_cron_clock.state set frozen_at = null,
    offset_ms = greatest(offset_ms, ceil(extract(epoch from (${at}::timestamptz - pg_catalog.clock_timestamp())) * 1000)::bigint) where singleton`;
  expect(
    (await db`select review_cron_clock.clock_timestamp() >= ${at}::timestamptz as reached`)[0]
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
      TLP_REVIEW_TEST_PROCESS: '1',
      TLP_REVIEW_CRON_TEST: '1',
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
    child.send(command);
    return wait(expected, 10000);
  }
  async function stop() {
    child.send({ kind: 'stop' });
    expect(await exit).toEqual([0, null]);
  }
  return { child, messages: log.messages, wait, command, stop };
}

async function oldSession(id: string) {
  await db`insert into learning_session (id,type,status,started_at,version) values (${id},'review','started',clock_timestamp() - interval '7 hours',0)`;
}

async function receiptFor(id: string) {
  return db`select t.*, r.session_id,r.outcome from review_orphan_tick t join review_orphan_receipt r using (tick_id) where r.session_id = ${id}`;
}

async function observeLegacySettled() {
  let pending: readonly unknown[] = [];
  try {
    await expect
      .poll(
        async () => {
          pending = await db`select id::text,name,state::text from pgboss.job
        where (name in (${reviewFamily}, ${`${reviewFamily}_dlq`}) and (state <> 'completed' or name = ${`${reviewFamily}_dlq`}))
          or (name = '__pgboss__send-it' and state <> 'completed' and data->>'name' = ${reviewFamily})
        order by id`;
          return pending.length;
        },
        { timeout: 10000, interval: 50 },
      )
      .toBe(0);
  } finally {
    observations.push({
      legacySettlement: { family: reviewFamily, pending, observedAt: new Date().toISOString() },
    });
  }
}

async function nativeLedger() {
  return db.begin('read only', async (tx) => {
    await tx`set local statement_timeout = '3s'`;
    const [schema] = await tx`select to_regclass('tlp_dbos.workflow_status') as relation`;
    const workflows = schema.relation
      ? await tx`select workflow_uuid,name,status from tlp_dbos.workflow_status where name = ${reviewFamily} order by workflow_uuid`
      : [];
    const ticks = await tx`select * from review_orphan_tick order by tick_id`;
    const receipts = await tx`select * from review_orphan_receipt order by tick_id,session_id`;
    const dispositions =
      await tx`select * from review_orphan_disposition order by backend,kind,task_id`;
    const gaps = await tx`select t.tick_id,c->>'sessionId' as session_id
      from review_orphan_tick t cross join lateral jsonb_array_elements(t.candidates) c
      where not exists (select 1 from review_orphan_receipt r where r.tick_id = t.tick_id and r.session_id = c->>'sessionId')`;
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
  // Vitest reuses its worker fork across files; keep this cron ledger in a fresh clone.
  const adminTarget = new URL(target);
  adminTarget.pathname = '/postgres';
  const admin = postgres(adminTarget.toString(), { max: 1 });
  const databaseName = `test_fork_${Date.now()}${process.pid}`;
  try {
    await admin.unsafe(`CREATE DATABASE "${databaseName}" TEMPLATE "test"`);
  } finally {
    await admin.end();
  }
  target.pathname = `/${databaseName}`;
  url = target.toString();
  db = postgres(url, { max: 3, connection: { search_path: clockSearchPath } });
  phaseQueries = drizzle(db);
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
  const initialLedger = await nativeLedger();
  observations.push({ initialLedger });
  assertSettledReviewLedger(initialLedger);

  const [producer] =
    await db`select prosrc, proconfig from pg_proc where oid = 'public.fence_review_orphan_producer()'::regprocedure`;
  const settings = z.array(z.string()).nullable().parse(producer.proconfig) ?? [];
  producerSearchPath = settings
    .find((value) => value.startsWith('search_path='))
    ?.slice('search_path='.length);
  await db`create schema if not exists review_cron_clock`;
  await db`create table if not exists review_cron_clock.state (singleton boolean primary key check (singleton), frozen_at timestamptz, offset_ms bigint not null)`;
  await db`insert into review_cron_clock.state values (true, null, 0) on conflict (singleton) do update set frozen_at = null, offset_ms = 0`;
  await db.unsafe(`create or replace function review_cron_clock.clock_timestamp() returns timestamptz language plpgsql volatile as $$
    declare clock record;
    begin
      select frozen_at, offset_ms into strict clock from review_cron_clock.state where singleton;
      return coalesce(clock.frozen_at, pg_catalog.clock_timestamp() + clock.offset_ms * interval '1 millisecond');
    end $$`);
  await db.unsafe(
    `alter function public.fence_review_orphan_producer() set search_path to ${clockSearchPath}`,
  );
  clockInstalled = true;
  expect(
    (
      await db`select prosrc from pg_proc where oid = 'public.fence_review_orphan_producer()'::regprocedure`
    )[0].prosrc,
  ).toBe(producer.prosrc);

  await db`delete from contract_epoch`;
  await db`update review_orphan_control set phase = 'pg-boss', phase_changed_at = clock_timestamp(), legacy_not_before = null`;
  await db`update prune_job_events_control set phase = 'pg-boss'`;
  suiteBlocked = undefined;
}, 60000);

beforeEach(async () => {
  assertFixtureCanReset(children.keys(), suiteBlocked);
  nativeBaseline = await nativeLedger();
  assertSettledReviewLedger(nativeBaseline);
  await db`update review_cron_clock.state set frozen_at = null, offset_ms = 0 where singleton`;
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
    if (!failed) assertSettledReviewLedger(after);
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
        await db`alter function public.fence_review_orphan_producer() reset search_path`;
      else
        await db.unsafe(
          `alter function public.fence_review_orphan_producer() set search_path to '${producerSearchPath.replaceAll("'", "''")}'`,
        );
      await db`update review_cron_clock.state set frozen_at = null, offset_ms = 0 where singleton`;
      if (originalJobClock) await db.unsafe(originalJobClock);
    } catch (error) {
      cleanupError = error;
    }
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
      await db`update review_orphan_control set phase = 'pg-boss', legacy_not_before = null`;
    await db.end();
  }
  if (cleanupError) throw cleanupError;
});

// @invariant concurrency: real scheduler takeover and rollback retain admissions and session receipts without replay
// @fails-if duplicate native owners change committed receipts, a frozen candidate lacks a receipt, or pre-horizon rollback succeeds
it('observes real Timekeeper forwarding, native two-scheduler ticks/restart and safe rollback', async () => {
  const started = performance.now();
  function phase(name: string) {
    const timing = {
      name,
      family: reviewFamily,
      elapsedMs: Math.round(performance.now() - started),
      at: new Date().toISOString(),
    };
    observations.push({ phase: timing });
    console.info('cron-phase', JSON.stringify(timing));
  }
  phase('start');
  await db`update review_orphan_control set phase = 'pg-boss', phase_changed_at = clock_timestamp(), legacy_not_before = null`;

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
  expect(noProof.error).toContain('drain blocked');
  expect(noProof.error).toContain('"kind":"forwarder"');
  expect(noProof.error).toContain('"state":"active"');

  const drainingControl = await db`select * from review_orphan_control`;
  const forwarders = await db`select id::text, created_on::text, state::text,
    (greatest(created_on, c.phase_changed_at) + interval '61 seconds')::text as aged_at
    from pgboss.job j cross join review_orphan_control c
    where j.name = '__pgboss__send-it' and j.state = 'active' and j.data->>'name' = ${reviewFamily}`;
  expect(forwarders).toHaveLength(1);
  const [forwarder] = forwarders;
  const forwarderId = z.string().parse(forwarder?.id);

  // Age the forwarder logically beyond 60s without wall-clock sleeping
  await advanceClock(z.string().parse(forwarder.aged_at));
  expect(
    (
      await db`select review_cron_clock.clock_timestamp() >= created_on + interval '61 seconds' as aged
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
  expect(await db`select * from review_orphan_control`).toEqual(drainingControl);

  expect(
    (await db`select state::text from pgboss.job where id = ${forwarderId}::uuid`)[0].state,
  ).toBe('active');
  await first.command({ kind: 'release-forward' });
  const rejected = await first.wait('forward-rejected');
  observations.push({ lateForwardRejected: rejected });
  expect(rejected.error).toContain('producer fenced');

  await observeLegacySettled();
  phase('legacy-forward-settled');

  expect((await first.command({ kind: 'transition', phase: 'dbos' }, 'rejected')).error).toContain(
    'quiescence',
  );
  await first.command({
    kind: 'quiesce',
    reason:
      'Fixture observed held forwarder rejection and no pre-migration consumer exists in this disposable DB',
  });
  await first.command({ kind: 'transition', phase: 'dbos' });
  phase('native-cutover');

  const second = start();
  await second.wait('ready');
  phase('second-scheduler-ready');

  const probes = (messages: unknown[]) =>
    messages.flatMap((raw) => {
      const message = schema.parse(raw);
      return message.kind === 'native-scheduler-probe' &&
        typeof message.workflowId === 'string' &&
        message.workflowId.startsWith(`sched-${reviewFamily}-`)
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
          await db`select w.status,t.backend from tlp_dbos.workflow_status w join review_orphan_tick t on t.tick_id = w.workflow_uuid where w.workflow_uuid = ${point}`,
        { timeout: 10000, interval: 100 },
      )
      .toEqual([{ status: 'SUCCESS', backend: 'dbos' }]);
  phase('two-scheduler-overlap');

  expect(
    await db`select schedule,cron_timezone,automatic_backfill from tlp_dbos.workflow_schedules where schedule_name = ${reviewFamily}`,
  ).toEqual([
    {
      schedule: nativeCron,
      cron_timezone: reviewDeclarations.reviewOrphans.schedule.tz,
      automatic_backfill: false,
    },
  ]);

  await expect
    .poll(async () => (await receiptFor(id)).length, { timeout: 120000, interval: 100 })
    .toBe(1);
  phase('native-first-receipt');
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
        (await db`select tick_id from review_orphan_tick where backend = 'dbos'`).filter(
          (tick) => !nativeBaseline.ticks.some((prior) => prior.tick_id === tick.tick_id),
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
          await db`select tick_id from review_orphan_tick where backend = 'dbos' and candidates = '[]'::jsonb`
        ).filter((tick) => !nativeBaseline.ticks.some((prior) => prior.tick_id === tick.tick_id))
          .length,
      { timeout: 10000, interval: 100 },
    )
    .toBeGreaterThanOrEqual(1);

  await second.command({ kind: 'pause-native' });
  await expect
    .poll(
      async () => {
        assertSettledReviewLedger(await nativeLedger());
        return true;
      },
      { timeout: 10000, interval: 100 },
    )
    .toBe(true);

  await second.command({ kind: 'transition', phase: 'draining-dbos' });
  phase('rollback-draining');
  const [rollbackBarrier] = await db`select * from review_orphan_control`;

  await observeLegacySettled();
  await expect
    .poll(() => reviewOrphanObligations(phaseQueries, 'dbos'), {
      timeout: 10000,
      interval: 100,
    })
    .toEqual([]);

  await second.command({
    kind: 'quiesce',
    reason:
      'Two compatible workers only; first stopped; all native/legacy forwarding observed settled',
  });

  const horizon = await reviewOrphanRollbackHorizon(phaseQueries);
  const [expectedHorizon] = await db`select (greatest(c.phase_changed_at,
    coalesce((select max(substring(workflow_uuid from ${'sched-prune_orphan_review_sessions-'.length + 1})::timestamptz)
      from tlp_dbos.workflow_status where name = 'prune_orphan_review_sessions'), 'epoch'::timestamptz),
    coalesce((select max(tick_at) from review_orphan_tick where backend = 'dbos'), c.phase_changed_at))
    + interval '60 seconds') = ${horizon}::timestamptz as matches
    from review_orphan_control c`;
  expect(expectedHorizon.matches).toBe(true);

  const rollbackLedger = await nativeLedger();
  await db`update review_cron_clock.state set frozen_at = ${horizon}::timestamptz - interval '1 microsecond' where singleton`;
  const early = await second.command({ kind: 'transition', phase: 'pg-boss' }, 'rejected');
  expect(early.error).toContain('rollback cooldown');
  expect(await db`select * from review_orphan_control`).toEqual([rollbackBarrier]);
  expect(await nativeLedger()).toEqual(rollbackLedger);
  phase('early-rollback-rejected');

  await db`update review_cron_clock.state set frozen_at = ${horizon}::timestamptz where singleton`;
  await second.command({ kind: 'transition', phase: 'pg-boss' });
  await expect
    .poll(async () => (await db`select phase from review_orphan_control`)[0].phase, {
      timeout: 10000,
    })
    .toBe('pg-boss');
  phase('rollback-accepted');
  expect(
    (
      await db`select legacy_not_before = ${horizon}::timestamptz as matches from review_orphan_control`
    )[0].matches,
  ).toBe(true);
  observations.push({
    controlledRollbackBoundary: { horizon, before: '1 microsecond', at: horizon },
  });

  await advanceClock(horizon);
  const rolled = `rolled-${randomUUID()}`;
  await oldSession(rolled);
  await second.command({ kind: 'release-forward' });

  const [jobClock] =
    await db`select pg_get_functiondef('pgboss.job_now()'::regprocedure) as definition`;
  originalJobClock = z.string().parse(jobClock.definition);
  await db.unsafe(
    `create or replace function pgboss.job_now() returns timestamptz language sql volatile as $$ select review_cron_clock.clock_timestamp() $$`,
  );
  await second.command({ kind: 'sync-clock' });
  const rollbackForward = z
    .object({ rows: z.array(z.object({ id: z.string() })) })
    .parse(await second.wait('forwarded'));
  expect(rollbackForward.rows).toHaveLength(1);
  const rollbackJobId = rollbackForward.rows[0].id;
  expect((await db`select name from pgboss.job where id = ${rollbackJobId}::uuid`)[0].name).toBe(
    reviewFamily,
  );
  observations.push({ rollbackForward });
  await expect
    .poll(async () => (await receiptFor(rolled)).length, { timeout: 120000, interval: 100 })
    .toBe(1);
  const legacy = await receiptFor(rolled);
  expect(legacy[0].backend).toBe('pg-boss');
  expect(legacy[0].provenance).toBe('legacy-first-admission');
  observations.push({ rollback: legacy });
  expect(await db`select * from pgboss.schedule where name = ${reviewFamily}`).toHaveLength(1);
  await second.stop();
  phase('test-complete');
}, 600000);
