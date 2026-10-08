import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { learning_session } from '@/db/schema';
import {
  families,
  native,
  resetOrphans,
  startSession,
} from '../../../tests/dbos-session-orphan/support';
import { testDb } from '../../../tests/helpers/db';
import { runSessionOrphanTick } from '../durable/session-orphan-family';
import {
  abandonOrphanPlacementTx,
  abandonPlacementSession,
  completePlacementSession,
  loadPlacementSessionForUpdate,
  transitionPlacementSession,
} from './placement';

const family = families[1];
beforeEach(() => resetOrphans());
afterEach(() => resetOrphans('pg-boss'));
it('completion wins after selection and retains idempotent administrative semantics', async () => {
  await startSession(family, 'completed');
  expect(
    await runSessionOrphanTick(testDb(), native(family), async (e) => {
      if (e.kind === 'selection-committed') await completePlacementSession(testDb(), 'completed');
    }),
  ).toMatchObject({ abandoned: 0, skipped: 1 });
  expect(await transitionPlacementSession(testDb(), 'completed', 'completed')).toMatchObject({
    changed: false,
    previousStatus: 'completed',
    status: 'completed',
    allowedStatuses: [],
  });
  await expect(abandonPlacementSession(testDb(), 'completed')).rejects.toMatchObject({
    status: 409,
  });
  await expect(abandonPlacementSession(testDb(), 'missing')).rejects.toMatchObject({ status: 404 });
});
it('serializes with the actual loader used by /next; serving/version changes do not extend age', async () => {
  await startSession(family, 'next');
  let release: () => void = () => {},
    signal: () => void = () => {};
  const held = new Promise<void>((r) => {
    release = r;
  });
  const locked = new Promise<void>((r) => {
    signal = r;
  });
  const nextTx = testDb().transaction(async (tx) => {
    expect(await loadPlacementSessionForUpdate(tx, 'next')).toMatchObject({ status: 'started' });
    signal();
    await held;
    await tx.execute(
      sql`update learning_session set version = version + 3, updated_at = clock_timestamp() where id = 'next'`,
    );
  });
  await locked;
  const sweep = runSessionOrphanTick(testDb(), native(family));
  try {
    await expect
      .poll(
        async () =>
          (
            await testDb().execute(
              sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query like '%learning_session%'`,
            )
          )[0].n,
      )
      .toBeGreaterThan(0);
    release();
    await nextTx;
    expect(await sweep).toMatchObject({ abandoned: 1 });
    expect(
      (await testDb().select().from(learning_session).where(eq(learning_session.id, 'next')))[0],
    ).toMatchObject({ version: 11, status: 'abandoned' });
    await expect(completePlacementSession(testDb(), 'next')).rejects.toMatchObject({ status: 409 });
  } finally {
    release();
    await nextTx;
    await sweep;
  }
});
it('creates one original job event, no domain event and no changes to question/answer/theta/starter data', async () => {
  await startSession(family, 'isolated');
  // Catalog discovery includes the actual starter/theta tables at this revision.
  const catalog = await testDb().execute(
    sql`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' and (table_name in ('event','question','answer','knowledge') or table_name like '%theta%' or table_name like '%placement%') order by table_name`,
  );
  const before = new Map<string, unknown>();
  for (const row of catalog) {
    const name = String(row.table_name);
    if (!/^[a-z_]+$/.test(name)) throw new Error('Unsafe fixture table');
    before.set(
      name,
      await testDb().execute(
        sql.raw(`select to_jsonb(t) as row from "${name}" t order by to_jsonb(t)::text`),
      ),
    );
  }
  expect(await runSessionOrphanTick(testDb(), native(family))).toMatchObject({ abandoned: 1 });
  for (const [name, snapshot] of before)
    expect(
      await testDb().execute(
        sql.raw(`select to_jsonb(t) as row from "${name}" t order by to_jsonb(t)::text`),
      ),
    ).toEqual(snapshot);
  expect(
    await testDb().execute(
      sql`select payload from job_events where business_id = 'isolated' and event_type = 'placement.abandoned'`,
    ),
  ).toEqual([{ payload: {} }]);
});
it('the explicit Tx helper shares rollback with its caller, preserving wrapper behavior', async () => {
  await startSession(family, 'rollback');
  await expect(
    testDb().transaction(async (tx) => {
      expect(
        await abandonOrphanPlacementTx(tx, {
          sessionId: 'rollback',
          cutoff: '2026-10-08T18:00:00Z',
        }),
      ).toMatchObject({ kind: 'abandoned', fromVersion: 7, toVersion: 8 });
      throw new Error('caller rollback');
    }),
  ).rejects.toThrow('caller rollback');
  expect(
    (await testDb().select().from(learning_session).where(eq(learning_session.id, 'rollback')))[0],
  ).toMatchObject({ version: 7, status: 'started', ended_at: null });
  expect(
    await testDb().execute(sql`select id from job_events where business_id = 'rollback'`),
  ).toHaveLength(0);
});
