import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { learning_session, session_orphan_receipt, session_orphan_tick } from '@/db/schema';
import {
  effects,
  families,
  native,
  resetOrphans,
  startSession,
} from '../../../tests/dbos-session-orphan/support';
import { testDb } from '../../../tests/helpers/db';
import {
  inspectSessionOrphanAdmission,
  inspectSessionOrphanOutcome,
  runSessionOrphanTick,
  sessionOrphanKey,
} from './session-orphan-family';

beforeEach(() => resetOrphans());
afterEach(() => resetOrphans('pg-boss'));
for (const family of families)
  describe(family, () => {
    it('serializes duplicate executors and overlapping native ticks', async () => {
      await startSession(family, 'duplicate');
      const request = native(family);
      const result = await Promise.all([
        runSessionOrphanTick(testDb(), request),
        runSessionOrphanTick(testDb(), request),
      ]);
      expect(result[0]).toEqual(result[1]);
      expect(await effects(family, 'duplicate')).toHaveLength(1);
      await startSession(family, 'overlap');
      let selected = 0;
      let release: () => void = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const boundary = async (event: { kind: string }) => {
        if (event.kind === 'selection-committed') {
          if (++selected === 2) release();
          await held;
        }
      };
      const overlapping = await Promise.all([
        runSessionOrphanTick(testDb(), native(family, 1), boundary),
        runSessionOrphanTick(testDb(), native(family, 2), boundary),
      ]);
      expect(overlapping.map((r) => r.abandoned).sort()).toEqual([0, 1]);
      expect(overlapping.map((r) => r.skipped).sort()).toEqual([0, 1]);
      expect(await effects(family, 'overlap')).toHaveLength(1);
    });
    it('preserves evidence after session deletion and refuses mutation or an outside candidate', async () => {
      await startSession(family, 'retained');
      const request = native(family);
      await runSessionOrphanTick(testDb(), request);
      const receipts = await testDb().select().from(session_orphan_receipt);
      const ticks = await testDb().select().from(session_orphan_tick);
      const immutableError = {
        cause: { code: 'P0001', message: 'session orphan execution evidence is immutable' },
      };
      await expect(testDb().delete(session_orphan_receipt)).rejects.toMatchObject(immutableError);
      expect(await testDb().select().from(session_orphan_receipt)).toEqual(receipts);
      await expect(
        testDb().update(session_orphan_tick).set({ candidates: [] }),
      ).rejects.toMatchObject(immutableError);
      expect(await testDb().select().from(session_orphan_tick)).toEqual(ticks);
      await testDb().delete(learning_session).where(eq(learning_session.id, 'retained'));
      const key = sessionOrphanKey(request);
      expect(
        await inspectSessionOrphanOutcome(testDb(), { ...key, sessionId: 'retained' }),
      ).toMatchObject({ kind: 'committed', outcome: { kind: 'abandoned' } });
      await expect(
        inspectSessionOrphanOutcome(testDb(), { ...key, sessionId: 'outside' }),
      ).rejects.toThrow('outside');
      expect(await inspectSessionOrphanAdmission(testDb(), request)).toMatchObject({
        kind: 'committed',
      });
    });
  });
