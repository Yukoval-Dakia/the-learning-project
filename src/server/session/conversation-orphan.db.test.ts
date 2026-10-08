import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { job_events, learning_session } from '@/db/schema';
import {
  families,
  native,
  resetOrphans,
  startSession,
} from '../../../tests/dbos-session-orphan/support';
import { testDb } from '../../../tests/helpers/db';
import { runSessionOrphanTick } from '../durable/session-orphan-family';
import {
  COPILOT_SESSION_SELECTION_LOCK,
  abandonConversation,
  abandonOrphanConversationTx,
  assertAcceptingTurns,
  endConversation,
  idleConversation,
} from './conversation';

const family = families[0];
beforeEach(() => resetOrphans());
afterEach(() => resetOrphans('pg-boss'));
it('resume and a new input/version between selection and mutation do not reset orphan age', async () => {
  await startSession(family, 'resume');
  await idleConversation(testDb(), 'resume');
  expect(
    await runSessionOrphanTick(testDb(), native(family), async (e) => {
      if (e.kind !== 'selection-committed') return;
      await assertAcceptingTurns(testDb(), 'resume');
      await testDb()
        .insert(job_events)
        .values({
          business_table: 'learning_session',
          business_id: 'resume',
          event_type: 'conversation.user_turn',
          payload: {
            content: '最新输入'.repeat(500),
            annotations: { intent: 'continue', uncertainty: [0.1, 0.9] },
          },
        });
      await testDb().execute(
        sql`update learning_session set version = version + 4, updated_at = clock_timestamp() where id = 'resume'`,
      );
    }),
  ).toMatchObject({ abandoned: 1 });
  const [row] = await testDb()
    .select()
    .from(learning_session)
    .where(eq(learning_session.id, 'resume'));
  expect(row).toMatchObject({ status: 'abandoned', version: 14 });
  expect(
    (
      await testDb().execute(
        sql`select payload from job_events where business_id = 'resume' and event_type = 'conversation.abandoned'`,
      )
    )[0].payload,
  ).toEqual({ from_status: 'active', reason: 'orphan_cron' });
});
it('explicit end wins when committed first; abandonment wins when committed first, preserving wrapper errors', async () => {
  await startSession(family, 'end-first');
  expect(
    await runSessionOrphanTick(testDb(), native(family), async (e) => {
      if (e.kind === 'selection-committed') await endConversation(testDb(), 'end-first');
    }),
  ).toMatchObject({ skipped: 1, abandoned: 0 });
  await startSession(family, 'abandon-first');
  await runSessionOrphanTick(testDb(), native(family, 1));
  await expect(endConversation(testDb(), 'abandon-first')).rejects.toMatchObject({ status: 409 });
  await expect(abandonConversation(testDb(), 'missing')).rejects.toMatchObject({ status: 404 });
});
it('actually waits on selection before taking the candidate row lock', async () => {
  await startSession(family, 'locked');
  let releaseSelection: () => void = () => {},
    signalSelection: () => void = () => {};
  const selected = new Promise<void>((r) => {
    signalSelection = r;
  });
  const heldSelection = new Promise<void>((r) => {
    releaseSelection = r;
  });
  const selectionTx = testDb().transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${COPILOT_SESSION_SELECTION_LOCK}))`,
    );
    signalSelection();
    await heldSelection;
  });
  await selected;
  let releaseRow: () => void = () => {},
    signalRow: () => void = () => {};
  const heldRow = new Promise<void>((r) => {
    releaseRow = r;
  });
  const rowLocked = new Promise<void>((r) => {
    signalRow = r;
  });
  const sweep = runSessionOrphanTick(testDb(), native(family));
  try {
    await expect
      .poll(
        async () =>
          (
            await testDb().execute(
              sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event = 'advisory' and query like '%pg_advisory_xact_lock%'`,
            )
          )[0].n,
      )
      .toBeGreaterThan(0);
    const rowTx = testDb().transaction(async (tx) => {
      await tx.execute(sql`set local lock_timeout = '2s'`);
      await tx.execute(sql`select id from learning_session where id = 'locked' for update`);
      signalRow();
      await heldRow;
      await tx.execute(sql`update learning_session set version = version + 3 where id = 'locked'`);
    });
    await rowLocked;
    releaseSelection();
    await selectionTx;
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
    releaseRow();
    await rowTx;
    expect(await sweep).toMatchObject({ abandoned: 1 });
    expect(
      (await testDb().select().from(learning_session).where(eq(learning_session.id, 'locked')))[0]
        .version,
    ).toBe(11);
  } finally {
    releaseSelection();
    releaseRow();
    await selectionTx;
    await sweep;
  }
});
it('same explicit Tx rolls back the original event and transition when its caller fails', async () => {
  await startSession(family, 'rollback');
  await expect(
    testDb().transaction(async (tx) => {
      expect(
        await abandonOrphanConversationTx(tx, {
          sessionId: 'rollback',
          cutoff: '2026-10-08T18:00:00Z',
        }),
      ).toMatchObject({ kind: 'abandoned' });
      throw new Error('caller rollback');
    }),
  ).rejects.toThrow('caller rollback');
  expect(
    (await testDb().select().from(learning_session).where(eq(learning_session.id, 'rollback')))[0],
  ).toMatchObject({ version: 7, status: 'active', ended_at: null });
  expect(
    await testDb().execute(sql`select id from job_events where business_id = 'rollback'`),
  ).toHaveLength(0);
});
