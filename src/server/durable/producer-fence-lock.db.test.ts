import { mkdir, writeFile } from 'node:fs/promises';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { PgBoss } from 'pg-boss';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Db, Tx } from '@/db/client';
import * as schema from '@/db/schema';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { installPruneProducerFence } from './prune-family';
import { installReviewOrphanProducerFence } from './review-orphan-family';
import { installSessionOrphanProducerFence } from './session-orphan-backend';

const installers = [
  { name: 'prune', trigger: 'yuk1355_prune_producer', install: installPruneProducerFence },
  {
    name: 'review',
    trigger: 'yuk1393_review_orphan_producer',
    install: installReviewOrphanProducerFence,
  },
  {
    name: 'session',
    trigger: 'yuk1394_session_orphan_producer',
    install: installSessionOrphanProducerFence,
  },
];
const pairs = installers.flatMap((first) =>
  installers.filter((second) => second !== first).map((second) => ({ first, second })),
);
const evidence: unknown[] = [];
const ddlFailureSchema = z.object({
  message: z.string(),
  cause: z.object({ code: z.string(), message: z.string() }),
});
let boss: PgBoss | undefined;

function disposableForkUrl() {
  const url = new URL(z.url().parse(process.env.TEST_DATABASE_URL));
  if (
    !/^\/test_fork_\d+$/.test(url.pathname) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  )
    throw new Error('Disposable fork required');
  return url.toString();
}

async function resetControls() {
  await testDb().execute(sql`update prune_job_events_control set phase = 'pg-boss'`);
  await testDb().execute(
    sql`update review_orphan_control set phase = 'pg-boss', legacy_not_before = null`,
  );
  await testDb().execute(
    sql`update session_orphan_control set phase = 'pg-boss', legacy_not_before = null`,
  );
}

beforeAll(async () => {
  const url = disposableForkUrl();
  const [database] = await testDb().execute(sql`select current_database() as name`);
  expect(database?.name).toBe(new URL(url).pathname.slice(1));
  boss = new PgBoss({ connectionString: url, max: 2, schedule: false, supervise: false });
  boss.on('error', () => {});
  await boss.start();
  await resetControls();
  for (const family of [
    'prune_job_events',
    'prune_orphan_review_sessions',
    'prune_orphan_conversation_sessions',
    'prune_orphan_placement_sessions',
  ])
    await boss.createQueue(family);
});
beforeEach(async () => {
  await resetDb();
  await resetControls();
  // Existing triggers and pg-boss's real relation tree exercise trigger replacement.
  for (const installer of installers) await installer.install(testDb());
});
afterEach(resetControls);
afterAll(async () => {
  try {
    await boss?.stop();
  } finally {
    await mkdir('.cache', { recursive: true });
    await writeFile(
      '.cache/yuk1394-producer-fence-lock-evidence.json',
      JSON.stringify({ node: process.version, evidence }, null, 2),
    );
  }
});

async function installerConnection(beforeQuery: (query: string, tx: Tx) => Promise<void>) {
  const client = postgres(disposableForkUrl(), { max: 1 });
  const db: Db = drizzle(client, { schema });
  const [row] = await db.execute(sql`select pg_backend_pid() as pid`);
  const pid = z.number().int().parse(row?.pid);
  const queries: string[] = [];
  const transaction = db.transaction.bind(db);
  db.transaction = (body, config) =>
    transaction(async (tx) => {
      const execute = tx.execute.bind(tx);
      tx.execute = <TRow extends Record<string, unknown> = Record<string, unknown>>(
        query: Parameters<Tx['execute']>[0],
      ) => {
        const pending = execute<TRow>(query);
        const run = pending.execute.bind(pending);
        // Test-only latch on a real Drizzle query. Every SQL result comes from PostgreSQL.
        pending.execute = async () => {
          const text = pending.getQuery().sql;
          queries.push(text);
          await beforeQuery(text, tx);
          return run();
        };
        return pending;
      };
      return body(tx);
    }, config);
  return { db, pid, queries, close: () => client.end() };
}

async function locks(pids: number[]) {
  const advisory = await testDb().execute(sql`select pid, classid::text, objid::text,
    objsubid, mode, granted,
    classid = ((hashtextextended('pgboss:producer-fence:install:v1', 0) >> 32) & 4294967295)::oid
      and objid = (hashtextextended('pgboss:producer-fence:install:v1', 0) & 4294967295)::oid
      and objsubid = 1 as common
    from pg_locks where locktype = 'advisory' and pid in (${sql.join(pids, sql`, `)})
    order by pid, classid, objid, objsubid`);
  const relations = await testDb().execute(sql`with recursive targets(oid) as (
    select c.oid from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'pgboss' and c.relname in ('job','schedule')
    union select i.inhrelid from pg_inherits i join targets t on t.oid = i.inhparent
  ) select l.pid, l.relation::text as oid, c.relname, l.mode, l.granted
    from pg_locks l join pg_class c on c.oid = l.relation
    where l.locktype = 'relation' and l.pid in (${sql.join(pids, sql`, `)})
      and l.relation in (select oid from targets) order by l.pid, l.relation, l.mode`);
  const activity = await testDb().execute(sql`select pid, state, wait_event_type, wait_event,
    pg_blocking_pids(pid) as blockers, query from pg_stat_activity
    where pid in (${sql.join(pids, sql`, `)}) order by pid`);
  return { advisory, relations, activity };
}

async function triggerSnapshot(trigger: string) {
  return testDb().execute(sql`select t.oid::text, t.tgrelid::text, t.tgname,
    t.tgfoid::text, t.tgenabled, pg_get_triggerdef(t.oid) as definition
    from pg_trigger t where t.tgname = ${trigger} order by t.tgrelid`);
}

async function runConcurrentPair(
  first: (typeof installers)[number],
  second: (typeof installers)[number],
  failDdl: boolean,
) {
  const paused = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const snapshot = await triggerSnapshot(first.trigger);
  const a = await installerConnection(async (query, tx) => {
    if (query === `DROP TRIGGER IF EXISTS ${first.trigger} ON pgboss.job`) {
      paused.resolve();
      await release.promise;
    }
    if (
      failDdl &&
      query.startsWith(`CREATE TRIGGER ${first.trigger} `) &&
      query.includes('ON pgboss.schedule ')
    ) {
      // The actual installer CREATE fails in PG after the job replacement and schedule DROP.
      await tx.execute(sql`set local search_path = pg_catalog`);
    }
  });
  const b = await installerConnection(async (query) => {
    // If B bypasses the common lock, capture that boundary before allowing its DDL.
    if (query.startsWith('DROP TRIGGER ')) await release.promise;
  });
  const firstDone = Promise.allSettled([first.install(a.db)]);
  let secondDone: typeof firstDone | undefined;
  try {
    await expect
      .poll(() => a.queries.some((q) => q.startsWith('DROP TRIGGER ')), { timeout: 5000 })
      .toBe(true);
    await paused.promise;
    const held = await locks([a.pid, b.pid]);
    evidence.push({
      first: first.name,
      second: second.name,
      failDdl,
      pids: { first: a.pid, second: b.pid },
      stage: 'first-drop',
      ...held,
    });
    expect(held.advisory.filter((l) => l.pid === a.pid)).toHaveLength(2);
    expect(held.advisory).toContainEqual(
      expect.objectContaining({ pid: a.pid, common: true, granted: true }),
    );
    expect(held.relations).toEqual([]);

    secondDone = Promise.allSettled([second.install(b.db)]);
    await expect
      .poll(
        async () => {
          const state = await locks([a.pid, b.pid]);
          if (
            state.advisory.some((l) => l.pid === b.pid && l.common === true && l.granted === false)
          )
            return 'common-lock-wait';
          if (b.queries.some((q) => q.startsWith('DROP TRIGGER '))) return 'target-drop';
          return 'starting';
        },
        { timeout: 5000 },
      )
      .not.toBe('starting');
    const waiting = await locks([a.pid, b.pid]);
    evidence.push({
      first: first.name,
      second: second.name,
      failDdl,
      pids: { first: a.pid, second: b.pid },
      stage: b.queries.some((q) => q.startsWith('DROP TRIGGER '))
        ? 'second-bypassed-lock'
        : 'second-waits',
      queries: { a: [...a.queries], b: [...b.queries] },
      ...waiting,
    });
    expect(waiting.advisory.filter((l) => l.pid === b.pid)).toEqual([
      expect.objectContaining({ common: true, granted: false, mode: 'ExclusiveLock' }),
    ]);
    expect(waiting.relations).toEqual([]);
    expect(waiting.activity).toContainEqual(
      expect.objectContaining({
        pid: b.pid,
        wait_event_type: 'Lock',
        wait_event: 'advisory',
        blockers: [a.pid],
      }),
    );
    expect(b.queries.some((q) => q.startsWith('DROP TRIGGER '))).toBe(false);

    release.resolve();
    const [result] = await firstDone;
    let ddlFailure: z.infer<typeof ddlFailureSchema> | null = null;
    if (failDdl) {
      expect(result.status).toBe('rejected');
      if (result.status !== 'rejected') throw new Error('Expected PostgreSQL CREATE failure');
      ddlFailure = ddlFailureSchema.parse(result.reason);
      expect(ddlFailure.cause.code).toBe('42883');
      expect(ddlFailure.message).toContain(`CREATE TRIGGER ${first.trigger}`);
      expect(ddlFailure.message).toContain('ON pgboss.schedule');
      expect(await triggerSnapshot(first.trigger)).toEqual(snapshot);
    } else expect(result.status).toBe('fulfilled');
    expect(await secondDone).toEqual([{ status: 'fulfilled', value: undefined }]);
    const finished = await locks([a.pid, b.pid]);
    evidence.push({
      first: first.name,
      second: second.name,
      failDdl,
      pids: { first: a.pid, second: b.pid },
      stage: 'released',
      status: result.status,
      ddlFailure,
      queries: { a: a.queries, b: b.queries },
      ...finished,
    });
    expect(finished.advisory).toEqual([]);
    expect(finished.relations).toEqual([]);
    for (const installer of [first, second]) {
      const triggers = await triggerSnapshot(installer.trigger);
      expect(triggers.length).toBeGreaterThanOrEqual(2);
      expect(triggers.every((t) => t.tgenabled === 'O')).toBe(true);
    }
  } finally {
    release.resolve();
    await firstDone;
    await secondDone;
    await Promise.all([a.close(), b.close()]);
  }
}

describe('shared producer-fence installer transaction', () => {
  it.each(pairs)(
    '$first.name blocks $second.name before target relation locks',
    async ({ first, second }) => {
      await runConcurrentPair(first, second, false);
    },
  );
  it.each(installers)('$name rolls back failed DDL and releases the common lock', async (first) => {
    const second = installers.find((installer) => installer !== first);
    if (!second) throw new Error('Different-family installer required');
    await runConcurrentPair(first, second, true);
  });
});
