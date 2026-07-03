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

import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Tx } from '@/db/client';
import { event, goal } from '@/db/schema';
import { backfillGoalGenesis } from '../../../../scripts/backfill-genesis-events';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { runProjectionOracleSweep } from './projection_oracle_sweep';

const T0 = new Date('2026-06-01T00:00:00.000Z');
const NOW = new Date('2026-07-01T00:00:00.000Z');
const GOAL_FLAG = 'PROJECTION_IS_WRITER_GOAL';
const ALL_FLAGS = [
  'PROJECTION_IS_WRITER',
  'PROJECTION_IS_WRITER_GOAL',
  'PROJECTION_IS_WRITER_MISTAKE_VARIANT',
  'PROJECTION_IS_WRITER_LEARNING_ITEM',
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

async function forensicEvents(): Promise<{ subject_id: string; subject_kind: string }[]> {
  return testDb()
    .select({ subject_id: event.subject_id, subject_kind: event.subject_kind })
    .from(event)
    .where(eq(event.action, 'experimental:projection_oracle_flagged'));
}

describe('runProjectionOracleSweep', () => {
  beforeEach(async () => {
    await resetDb();
    savedFlags = {};
    for (const f of ALL_FLAGS) {
      savedFlags[f] = process.env[f];
      delete process.env[f]; // every kind OFF by default
    }
  });
  afterEach(() => {
    for (const f of ALL_FLAGS) {
      if (savedFlags[f] === undefined) delete process.env[f];
      else process.env[f] = savedFlags[f];
    }
  });

  it('OFF: every kind flag off → all skipped, zero audited, zero anomalies', async () => {
    const db = testDb();
    await insertGoal('g1');
    await backfillGoalGenesis(db, T0);

    const report = await runProjectionOracleSweep(db, { now: NOW });

    expect(report.auditedKinds).toEqual([]);
    expect(report.skippedKinds).toContain('goal');
    expect(report.anomalies).toBe(0);
    expect(report.forensicWritten).toBe(0);
  });

  it('CLEAN: an ON, coherently-backfilled entity → zero anomalies, zero forensic', async () => {
    const db = testDb();
    process.env[GOAL_FLAG] = '1';
    await insertGoal('g1');
    await backfillGoalGenesis(db, T0);

    const report = await runProjectionOracleSweep(db, { now: NOW });

    expect(report.auditedKinds).toContain('goal');
    expect(report.anomalies).toBe(0);
    expect(report.forensicWritten).toBe(0);
    expect(await forensicEvents()).toEqual([]);
  });

  it('FIELD_DRIFT: an out-of-band value change is classified + a fold-inert forensic is written; the row is NOT touched', async () => {
    const db = testDb();
    process.env[GOAL_FLAG] = '1';
    await insertGoal('g1', 'Original');
    await backfillGoalGenesis(db, T0);
    // out-of-band structural mutation → live diverges from fold(genesis).
    await db.update(goal).set({ title: 'TAMPERED' }).where(eq(goal.id, 'g1'));

    const report = await runProjectionOracleSweep(db, { now: NOW });

    expect(report.fieldDrift).toBe(1);
    expect(report.anomalies).toBe(1);
    expect(report.forensicWritten).toBe(1);
    // the forensic breadcrumb is fold-inert (subject_kind 'projection_oracle', queried by no gather).
    const forensic = await forensicEvents();
    expect(forensic).toHaveLength(1);
    expect(forensic[0]?.subject_kind).toBe('projection_oracle');
    expect(forensic[0]?.subject_id).toBe('goal:g1');
    // REPORT-ONLY: the sweep did NOT repair the row — it is still tampered, and no rows were added.
    const rows = await db.select({ title: goal.title }).from(goal);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe('TAMPERED');
  });

  it('GHOST: an event-only row (live row dropped) is classified GHOST', async () => {
    const db = testDb();
    process.env[GOAL_FLAG] = '1';
    await insertGoal('g_ghost');
    await backfillGoalGenesis(db, T0);
    await db.delete(goal).where(eq(goal.id, 'g_ghost')); // events remain, live row gone

    const report = await runProjectionOracleSweep(db, { now: NOW });

    expect(report.ghost).toBe(1);
    expect(report.anomalies).toBe(1);
    const forensic = await forensicEvents();
    expect(forensic[0]?.subject_id).toBe('goal:g_ghost');
  });

  it('MISSING: an index-anchored row whose base event was dropped folds null → classified MISSING', async () => {
    const db = testDb();
    process.env[GOAL_FLAG] = '1';
    await insertGoal('g_missing');
    await backfillGoalGenesis(db, T0); // genesis event + index anchor
    // drop the genesis EVENT, keep the index anchor + live row → still "anchored", but folds null.
    await db
      .delete(event)
      .where(
        and(
          eq(event.subject_kind, 'goal'),
          eq(event.subject_id, 'g_missing'),
          eq(event.action, 'experimental:genesis'),
        ),
      );

    const report = await runProjectionOracleSweep(db, { now: NOW });

    expect(report.missing).toBe(1);
    expect(report.anomalies).toBe(1);
  });

  it('M3: an un-anchored live row (no genesis, no index) is SKIPPED — no false GHOST/MISSING', async () => {
    const db = testDb();
    process.env[GOAL_FLAG] = '1';
    await insertGoal('g_unanchored'); // NO backfill → no genesis, no index anchor

    const report = await runProjectionOracleSweep(db, { now: NOW });

    // it folds to null (no base) and the live row is present, but the anchor gate SKIPs it (a
    // pre-event-sourced / §9.3 row is fold-blind — reporting it would be a false positive).
    expect(report.anomalies).toBe(0);
    expect(report.forensicWritten).toBe(0);
  });

  it('one open forensic record per id: re-running the sweep does not re-write the breadcrumb', async () => {
    const db = testDb();
    process.env[GOAL_FLAG] = '1';
    await insertGoal('g1', 'Original');
    await backfillGoalGenesis(db, T0);
    await db.update(goal).set({ title: 'TAMPERED' }).where(eq(goal.id, 'g1'));

    const first = await runProjectionOracleSweep(db, { now: NOW });
    expect(first.forensicWritten).toBe(1);
    const second = await runProjectionOracleSweep(db, { now: NOW });
    // still flagged as an anomaly, but NO new forensic (the open record already exists).
    expect(second.fieldDrift).toBe(1);
    expect(second.forensicWritten).toBe(0);
    expect(await forensicEvents()).toHaveLength(1);
  });

  it('M4: the REPEATABLE READ snapshot does not see a concurrent commit made mid-sweep', async () => {
    const db = testDb();
    process.env[GOAL_FLAG] = '1';
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
