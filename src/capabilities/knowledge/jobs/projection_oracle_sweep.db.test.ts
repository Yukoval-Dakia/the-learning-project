// The census and the after-census seam share one repeatable-read snapshot.

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Tx } from '@/db/client';
import { goal } from '@/db/schema';
import { backfillGoalGenesis } from '../../../../scripts/backfill-genesis-events';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { runProjectionOracleSweep } from './projection_oracle_sweep';

const T0 = new Date('2026-06-01T00:00:00.000Z');
const ALL_FLAGS = [
  'PROJECTION_IS_WRITER',
  'PROJECTION_IS_WRITER_ARTIFACT',
  'PROJECTION_IS_WRITER_QUESTION_BLOCK',
];

let savedFlags: Record<string, string | undefined>;

async function insertGoal(id: string, title = `Goal ${id}`): Promise<void> {
  await testDb()
    .insert(goal)
    .values({
      id,
      title,
      subject_id: null,
      scope_knowledge_ids: ['k_a'],
      sequence_hint: 0,
      status: 'active',
      source: 'manual',
      source_ref: null,
      created_at: T0,
      updated_at: T0,
      version: 0,
    });
}

describe('runProjectionOracleSweep', () => {
  beforeEach(async () => {
    await resetDb();
    savedFlags = {};
    for (const f of ALL_FLAGS) {
      savedFlags[f] = process.env[f];
      delete process.env[f]; // unretired flags OFF by default
    }
  });
  afterEach(() => {
    for (const f of ALL_FLAGS) {
      if (savedFlags[f] === undefined) delete process.env[f];
      else process.env[f] = savedFlags[f];
    }
  });

  it('M4: the REPEATABLE READ snapshot does not see a concurrent commit made mid-sweep', async () => {
    const db = testDb();
    await insertGoal('g1', 'Original');
    await backfillGoalGenesis(db, T0);

    let txSawTamper: string | undefined;
    const report = await runProjectionOracleSweep(db, {
      onAfterCensus: async (tx: Tx) => {
        // concurrent out-of-tx commit (separate pooled connection) tampers g1 AFTER the census read.
        await testDb().update(goal).set({ title: 'CONCURRENT' }).where(eq(goal.id, 'g1'));
        // the sweep's REPEATABLE READ tx must STILL see the ORIGINAL title (snapshot isolation).
        const [row] = await tx.select({ title: goal.title }).from(goal).where(eq(goal.id, 'g1'));
        txSawTamper = row?.title;
      },
    });

    // inside the snapshot, the concurrent tamper is invisible → the census saw g1 clean → 0 anomalies.
    expect(txSawTamper).toBe('Original');
    expect(report.anomalies).toBe(0);
    // and the concurrent write DID land (a fresh sweep, new snapshot, would now see the tamper).
    const [live] = await db.select({ title: goal.title }).from(goal).where(eq(goal.id, 'g1'));
    expect(live?.title).toBe('CONCURRENT');
  });
});
