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
