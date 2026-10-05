// YUK-496 (方案 A) — DB tests for the item_calibration genesis anchor + projection coverage
// (testcontainer; CI-first — no local Postgres needed to author, the CI db partition runs them).
//
// The ticket's acceptance, exercised end-to-end against a real DB:
//   1. every item_calibration row gets an `experimental:genesis` anchor whose payload.row snapshots
//      the row's CURRENT values (backfillItemCalibrationGenesis),
//   2. audit:projection includes item_calibration and reports CLEAN after the backfill (not drift,
//      not empty),
//   3. b/confidence (and the rest of the row) survive the backfill+fold round-trip BYTE FOR BYTE,
//   4. the audit still has teeth: an out-of-band write drifts — including the DOCUMENTED 方案 A
//      boundary case (a legit post-anchor kt_json / b write is invisible to the log and surfaces
//      as drift until re-anchored),
//   5. the guarded shell rebuilds a tampered row from its anchor (b/confidence restored) and NEVER
//      deletes an un-anchored fold-null row.
//
// Hermetic: resetDb() in beforeEach.

import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { event, item_calibration } from '@/db/schema';
import { applyItemPrior } from '@/server/mastery/item-calibration';
import { auditProjection } from '../../../scripts/audit-projection';
import { backfillItemCalibrationGenesis } from '../../../scripts/backfill-genesis-events';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { gatherAndFoldItemCalibration } from './gather';
import { projectItemCalibrationGuarded } from './item_calibration';

const T0 = new Date('2026-08-26T00:00:00.000Z');
const T1 = new Date('2026-08-27T00:00:00.000Z');

// A rich post-firm-up, post-KT row — NOT a single-field happy path: both tracks populated,
// float4-realistic values, opaque jsonb, nulls where the table allows them.
async function insertRichRow(id: string, questionId: string): Promise<void> {
  await testDb()
    .insert(item_calibration)
    .values({
      id,
      question_id: questionId,
      b: -0.8420000038146973,
      confidence: 0.6200000047683716,
      track: 'hard',
      source: 'llm_prior',
      b_anchor: -0.8420000038146973,
      b_calib: -0.9100000262260437,
      calibration_n: 12,
      calibration_weight: 9.5,
      last_calibrated_at: T0,
      irt_a: null,
      irt_c: null,
      cdm_json: null,
      kt_json: { known: 0.82, learn: 0.18, slip: 0.1, guess: 0.25 },
      created_at: T0,
      updated_at: T1,
    });
}

async function readRow(id: string) {
  const rows = await testDb().select().from(item_calibration).where(eq(item_calibration.id, id));
  return rows[0] ?? null;
}

async function genesisEventsForRow(rowId: string) {
  return testDb().select().from(event).where(eq(event.subject_id, rowId));
}

describe('item_calibration genesis backfill + projection coverage (YUK-496 方案 A)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('backfill seeds one anchor per row; audit:projection reports CLEAN; b/confidence byte-for-byte', async () => {
    const db = testDb();
    // Row 1: the real B1 writer path (applyItemPrior — the exact insert the ticket names).
    await applyItemPrior(db, {
      questionId: 'q_coldstart',
      draft: { b_logit: 0.25, confidence: 0.3, reasoning: '基础文言虚词题，课内反复出现' },
    });
    const coldRows = await db
      .select()
      .from(item_calibration)
      .where(eq(item_calibration.question_id, 'q_coldstart'));
    expect(coldRows).toHaveLength(1);
    const coldRow = coldRows[0];

    // Row 2: a rich direct row (post-firm-up + KT shape — the hard case for byte-for-byte).
    await insertRichRow('ic_rich', 'q_rich');

    // Snapshot the pre-backfill truth (the values the anchor MUST preserve).
    const richBefore = await readRow('ic_rich');

    const counts = await backfillItemCalibrationGenesis(db, T1);
    expect(counts.seeded).toBe(2);
    expect(counts.skipped).toBe(0);

    // (1) every row carries exactly ONE genesis anchor with subject_kind='item_calibration'.
    for (const rowId of [coldRow.id, 'ic_rich']) {
      const evs = await genesisEventsForRow(rowId);
      expect(evs.filter((e) => e.action === 'experimental:genesis')).toHaveLength(1);
    }

    // (3) byte-for-byte round-trip: fold(genesis) === the pre-backfill row, by field name.
    const foldedRich = await gatherAndFoldItemCalibration(db, 'ic_rich');
    expect(foldedRich?.b).toBe(richBefore?.b);
    expect(foldedRich?.b_anchor).toBe(richBefore?.b_anchor);
    expect(foldedRich?.b_calib).toBe(richBefore?.b_calib);
    expect(foldedRich?.confidence).toBe(richBefore?.confidence);
    expect(foldedRich?.calibration_n).toBe(richBefore?.calibration_n);
    expect(foldedRich?.calibration_weight).toBe(richBefore?.calibration_weight);
    expect(foldedRich?.kt_json).toEqual(richBefore?.kt_json);
    expect(foldedRich?.last_calibrated_at).toEqual(richBefore?.last_calibrated_at);
    expect(foldedRich?.created_at).toEqual(richBefore?.created_at);
    expect(foldedRich?.updated_at).toEqual(richBefore?.updated_at);
    const foldedCold = await gatherAndFoldItemCalibration(db, coldRow.id);
    expect(foldedCold?.b).toBe(coldRow.b);
    expect(foldedCold?.confidence).toBe(coldRow.confidence);

    // (2) audit:projection includes item_calibration and is CLEAN (no drift, rows counted).
    const result = await auditProjection(db);
    expect(result.ok).toBe(true);
    expect(result.checkedItemCalibrations).toBe(2);
    expect(result.drift).toEqual([]);
  });

  it('idempotent: a second run anchors nothing (skips the already-anchored rows)', async () => {
    const db = testDb();
    await insertRichRow('ic_rich', 'q_rich');
    await backfillItemCalibrationGenesis(db, T1);
    const second = await backfillItemCalibrationGenesis(db, T1);
    expect(second.seeded).toBe(0);
    expect(second.skipped).toBe(1);
    const evs = await genesisEventsForRow('ic_rich');
    expect(evs.filter((e) => e.action === 'experimental:genesis')).toHaveLength(1);
  });

  it('out-of-band drift is flagged — including the documented 方案 A post-anchor mutation case', async () => {
    const db = testDb();
    await insertRichRow('ic_a', 'q_a');
    await insertRichRow('ic_b', 'q_b');
    await backfillItemCalibrationGenesis(db, T1);
    expect((await auditProjection(db)).ok).toBe(true); // sanity: clean before the out-of-band write

    // A b corruption (out-of-band write bypassing the anchor) — the MFI/θ̂-load-bearing column.
    await db.update(item_calibration).set({ b: 9.99 }).where(eq(item_calibration.id, 'ic_a'));

    const result = await auditProjection(db);
    expect(result.ok).toBe(false);
    expect(result.drift).toHaveLength(1);
    expect(result.drift[0]?.subject_kind).toBe('item_calibration');
    expect(result.drift[0]?.id).toBe('ic_a');
    expect(result.drift[0]?.diffs.some((d) => d.startsWith('b:'))).toBe(true);
    expect(result.drift.some((r) => r.id === 'ic_b')).toBe(false);
  });

  it('the guarded shell rebuilds a tampered row from its anchor (b/confidence restored, not empty)', async () => {
    const db = testDb();
    await insertRichRow('ic_re', 'q_re');
    const before = await readRow('ic_re');
    await backfillItemCalibrationGenesis(db, T1);

    // Tamper BOTH the difficulty and the confidence out-of-band.
    await db
      .update(item_calibration)
      .set({ b: 5, confidence: 1 })
      .where(eq(item_calibration.id, 'ic_re'));

    await projectItemCalibrationGuarded(db, 'ic_re');

    const after = await readRow('ic_re');
    expect(after).not.toBeNull(); // NOT an empty rebuild — the row survives
    expect(after?.b).toBe(before?.b); // restored byte-for-byte from the anchor
    expect(after?.confidence).toBe(before?.confidence);
    expect(after?.b_calib).toBe(before?.b_calib);
    expect(after?.kt_json).toEqual(before?.kt_json);
  });

  it('the guarded shell NEVER deletes an un-anchored fold-null row (fold-blindness, not a revert)', async () => {
    const db = testDb();
    // An event-less row born AFTER the backfill (the documented 方案 A window: applyItemPrior
    // keeps its imperative insert until the next backfill run anchors it).
    await applyItemPrior(db, {
      questionId: 'q_new_after_backfill',
      draft: { b_logit: -1.5, confidence: 0.4, reasoning: '多步综合证明，需拆解三个子条件' },
    });
    const rows = await db
      .select()
      .from(item_calibration)
      .where(eq(item_calibration.question_id, 'q_new_after_backfill'));
    const rowId = rows[0].id;

    await projectItemCalibrationGuarded(db, rowId); // fold-null (no anchor) → must NOT delete

    const survived = await readRow(rowId);
    expect(survived).not.toBeNull();
    expect(survived?.b).toBe(-1.5);
  });

  it('the un-anchored post-backfill row surfaces as drift in the value audit (honest signal, re-anchored by the next run)', async () => {
    const db = testDb();
    await insertRichRow('ic_anchored', 'q_1');
    await backfillItemCalibrationGenesis(db, T1);
    expect((await auditProjection(db)).ok).toBe(true);

    // A NEW row born after the backfill via the untouched B1 writer — event-less today.
    await applyItemPrior(db, {
      questionId: 'q_late',
      draft: { b_logit: 0.75, confidence: 0.55, reasoning: '单体推导题，一步代入即可' },
    });
    let result = await auditProjection(db);
    expect(result.ok).toBe(false); // present → fold-null drift (the documented blind-spot signal)

    // The documented remediation: re-run the backfill (the gate-flow order backfill → audit).
    const counts = await backfillItemCalibrationGenesis(db, T1);
    expect(counts.seeded).toBe(1);
    expect(counts.skipped).toBe(1);
    result = await auditProjection(db);
    expect(result.ok).toBe(true);
    expect(result.checkedItemCalibrations).toBe(2);
  });
});
