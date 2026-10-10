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
import { COPILOT_SESSION_SELECTION_LOCK } from './conversation';

const family = families[0];
beforeEach(() => resetOrphans());
afterEach(() => resetOrphans('pg-boss'));
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
