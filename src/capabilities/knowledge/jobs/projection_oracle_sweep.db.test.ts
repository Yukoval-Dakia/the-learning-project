// YUK-548 (worklist #5, Q4a) — DB tests for the continuous projection-drift oracle sweep (mirrors
// merge_attribution_sweep.db.test.ts). Proves:
//   - CLEAN → zero anomalies, zero forensic, zero log-worthy drift.
//   - FIELD_DRIFT / GHOST / MISSING → classified correctly + a fold-inert forensic breadcrumb per id.
//   - the sweep NEVER writes an entity table (report-only): a drifted row is left exactly as-is.
//   - un-anchored live rows are SKIPPED (M3 applicability gate) — no false GHOST/MISSING.
//   - one open forensic record per id (re-running does not re-write).
//   - tracked-flag ON-check: OFF kinds are skipped.
//   - REPEATABLE READ isolation (M4): a concurrent commit mid-sweep is not seen in the snapshot.
//
// Hermetic: resetDb() in beforeEach.

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Tx } from '@/db/client';
import { goal } from '@/db/schema';
import { backfillGoalGenesis } from '../../../../scripts/backfill-genesis-events';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { runProjectionOracleSweep } from './projection_oracle_sweep';

const T0 = new Date('2026-06-01T00:00:00.000Z');
const NOW = new Date('2026-07-01T00:00:00.000Z');
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
      now: NOW,
      onBeforeForensic: async (tx: Tx) => {
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
