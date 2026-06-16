// YUK-361 Phase 6 (Task 11) — active-PPI 重标定 db 测。
//
// 验证：
//   (A) recordDifficultyCalibrationLabel —— π_i join（只 softmax_mfi selected 观测）/
//       非客观判分 skip / partial skip / θ-before 入 theta_snapshot / 无真 π_i skip /
//       去重（同 attempt 不重复）/ SAVEPOINT 隔离（label 写错不回滚主 attempt）。
//   (B) recalibrateQuestion —— 标签 < 阈值 → no-op（b_calib 保持 NULL，数据闸）；
//       ≥ 阈值 → b_calib firm-up（PPI++ AIPW）；无锚 → no_anchor no-op。
//   (C) effectiveB end-to-end —— b_calib NULL → 退回 b_anchor；set → 用 b_calib。

import { createId } from '@paralleldrive/cuid2';
import { and, eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { recordSelectionObservation } from '@/capabilities/practice/server/selection-observations';
import { newId } from '@/core/ids';
import { db } from '@/db/client';
import { difficulty_calibration_label, item_calibration, question } from '@/db/schema';
import { resetDb } from '../../../tests/helpers/db';
import {
  RECALIBRATION_MIN_LABELS,
  effectiveB,
  impliedBLabel,
  recalibrateQuestion,
  recordDifficultyCalibrationLabel,
} from './recalibration';

function now() {
  return new Date();
}

async function seedQuestion(id: string, difficulty = 3) {
  await db.insert(question).values({
    id,
    kind: 'short_answer',
    prompt_md: `Prompt ${id}`,
    reference_md: null,
    knowledge_ids: [],
    difficulty,
    source: 'manual',
    variant_depth: 0,
    created_at: now(),
    updated_at: now(),
    version: 0,
  });
}

async function seedItemCalibration(questionId: string, b: number) {
  await db.insert(item_calibration).values({
    id: newId(),
    question_id: questionId,
    b,
    b_anchor: b,
    confidence: 0.5,
    track: 'hard',
    source: 'llm_prior',
    created_at: now(),
    updated_at: now(),
  });
}

/** 写一条 softmax_mfi selected 观测（真 π_i），供 label hook join。 */
async function seedSoftmaxObservation(questionId: string, pi: number, date = '2026-06-16') {
  await recordSelectionObservation(db, {
    date,
    refKind: 'question',
    refId: questionId,
    policy: 'softmax_mfi',
    selected: true,
    inclusionProbability: pi,
    signals: {},
  });
}

async function readLabels(questionId: string) {
  return db
    .select()
    .from(difficulty_calibration_label)
    .where(eq(difficulty_calibration_label.question_id, questionId));
}

async function readCalibration(questionId: string) {
  const rows = await db
    .select()
    .from(item_calibration)
    .where(and(eq(item_calibration.question_id, questionId), eq(item_calibration.track, 'hard')))
    .limit(1);
  return rows[0] ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// (A) label hook
// ─────────────────────────────────────────────────────────────────────────────
describe('recordDifficultyCalibrationLabel', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('softmax-selected objective attempt → writes a label with the joined π_i + θ-before', async () => {
    const q = createId();
    await seedQuestion(q, 3);
    await seedItemCalibration(q, 0.5);
    await seedSoftmaxObservation(q, 0.3);

    await db.transaction(async (tx) => {
      await recordDifficultyCalibrationLabel(tx, {
        questionId: q,
        attemptEventId: createId(),
        difficulty: 3,
        outcome: 0, // wrong
        judgeRoute: 'exact',
        thetaBefore: 0.5,
        now: now(),
      });
    });

    const labels = await readLabels(q);
    expect(labels).toHaveLength(1);
    expect(labels[0].inclusion_probability).toBeCloseTo(0.3, 6);
    expect(labels[0].theta_snapshot).toBeCloseTo(0.5, 6); // θ-before used
    expect(labels[0].outcome).toBe(0);
    // b_label = impliedBLabel(θ-before=0.5, b_anchor=0.5, outcome=0) — anchored IRT reverse.
    expect(labels[0].b_label).toBeCloseTo(impliedBLabel(0.5, 0.5, 0), 6);
    // wrong answer → b_label > b_anchor (题更难).
    expect(labels[0].b_label).toBeGreaterThan(0.5);
  });

  it('non-objective judge route (semantic) → skip (no label, §6)', async () => {
    const q = createId();
    await seedQuestion(q, 3);
    await seedItemCalibration(q, 0.5);
    await seedSoftmaxObservation(q, 0.3);

    await db.transaction(async (tx) => {
      await recordDifficultyCalibrationLabel(tx, {
        questionId: q,
        attemptEventId: createId(),
        difficulty: 3,
        outcome: 1,
        judgeRoute: 'semantic', // LLM-backed, subjective → not in b-truth channel
        thetaBefore: 0,
        now: now(),
      });
    });

    expect(await readLabels(q)).toHaveLength(0);
  });

  it('partial outcome → skip (难度反推语义歧义)', async () => {
    const q = createId();
    await seedQuestion(q, 3);
    await seedItemCalibration(q, 0.5);
    await seedSoftmaxObservation(q, 0.3);

    await db.transaction(async (tx) => {
      await recordDifficultyCalibrationLabel(tx, {
        questionId: q,
        attemptEventId: createId(),
        difficulty: 3,
        outcome: 1,
        attemptOutcome: 'partial',
        judgeRoute: 'exact',
        thetaBefore: 0,
        now: now(),
      });
    });

    expect(await readLabels(q)).toHaveLength(0);
  });

  it('no softmax observation (legacy/due item, no real π_i) → skip', async () => {
    const q = createId();
    await seedQuestion(q, 3);
    await seedItemCalibration(q, 0.5);
    // NO seedSoftmaxObservation — legacy/due item has no real π_i.

    await db.transaction(async (tx) => {
      await recordDifficultyCalibrationLabel(tx, {
        questionId: q,
        attemptEventId: createId(),
        difficulty: 3,
        outcome: 0,
        judgeRoute: 'exact',
        thetaBefore: 0,
        now: now(),
      });
    });

    expect(await readLabels(q)).toHaveLength(0);
  });

  it('legacy-policy observation does NOT count as real π_i → skip', async () => {
    const q = createId();
    await seedQuestion(q, 3);
    await seedItemCalibration(q, 0.5);
    // A legacy observation (deterministic selection, not random sampling).
    await recordSelectionObservation(db, {
      date: '2026-06-16',
      refKind: 'question',
      refId: q,
      policy: 'legacy',
      selected: true,
      inclusionProbability: 1, // deterministic placeholder, not a real IPW weight
      signals: {},
    });

    await db.transaction(async (tx) => {
      await recordDifficultyCalibrationLabel(tx, {
        questionId: q,
        attemptEventId: createId(),
        difficulty: 3,
        outcome: 0,
        judgeRoute: 'exact',
        thetaBefore: 0,
        now: now(),
      });
    });

    expect(await readLabels(q)).toHaveLength(0);
  });

  it('falls back to weak difficulty anchor when no item_calibration row', async () => {
    const q = createId();
    await seedQuestion(q, 4);
    // NO item_calibration row — anchor falls to difficultyToLogitB(4).
    await seedSoftmaxObservation(q, 0.5);

    await db.transaction(async (tx) => {
      await recordDifficultyCalibrationLabel(tx, {
        questionId: q,
        attemptEventId: createId(),
        difficulty: 4,
        outcome: 0,
        judgeRoute: 'keyword',
        thetaBefore: 0,
        now: now(),
      });
    });

    const labels = await readLabels(q);
    expect(labels).toHaveLength(1);
    // b_anchor = difficultyToLogitB(4) = (4-3)*0.85 = 0.85.
    expect(labels[0].b_label).toBeCloseTo(impliedBLabel(0, 0.85, 0), 6);
  });

  it('duplicate attempt_event_id → at most one label (onConflictDoNothing)', async () => {
    const q = createId();
    await seedQuestion(q, 3);
    await seedItemCalibration(q, 0.5);
    await seedSoftmaxObservation(q, 0.3);
    const eid = createId();

    for (const out of [0, 1] as const) {
      await db.transaction(async (tx) => {
        await recordDifficultyCalibrationLabel(tx, {
          questionId: q,
          attemptEventId: eid,
          difficulty: 3,
          outcome: out,
          judgeRoute: 'exact',
          thetaBefore: 0,
          now: now(),
        });
      });
    }

    expect(await readLabels(q)).toHaveLength(1);
  });

  it('SAVEPOINT isolation — a label-write DB error does NOT roll back the main attempt write', async () => {
    const q = createId();
    await seedQuestion(q, 3);
    await seedItemCalibration(q, 0.5);
    await seedSoftmaxObservation(q, 0.3);

    await db.transaction(async (tx) => {
      // (1) main attempt write proxy (θ̂/FSRS/event represented by a question row mutate).
      await tx.update(question).set({ prompt_md: 'main-write' }).where(eq(question.id, q));

      // (2) SAVEPOINT-wrapped label write that forces a DB-level error → poisons only the
      //     savepoint, not the outer tx (mirror the established Phase 5 pattern).
      try {
        await tx.transaction(async (sp) => {
          await sp.execute(sql`SELECT CAST('not-a-number' AS integer)`);
        });
      } catch {
        // hook best-effort swallow.
      }

      // (3) outer tx still writable → not poisoned (would throw 25P02 if it were).
      await tx.update(question).set({ prompt_md: 'main-write-after' }).where(eq(question.id, q));
    });

    const rows = await db.select().from(question).where(eq(question.id, q));
    expect(rows).toHaveLength(1);
    expect(rows[0].prompt_md).toBe('main-write-after'); // step (3) ran → tx survived.
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (B) recalibrateQuestion — data-gated firm-up
// ─────────────────────────────────────────────────────────────────────────────
describe('recalibrateQuestion (data-gated AIPW firm-up)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  /** 直接种 N 条标签（绕过 hook，专测重标定数学/门控）。 */
  async function seedLabels(questionId: string, bLabels: number[], pi = 0.5) {
    for (const bl of bLabels) {
      await db.insert(difficulty_calibration_label).values({
        id: newId(),
        question_id: questionId,
        attempt_event_id: createId(),
        theta_snapshot: 0,
        outcome: 0,
        b_label: bl,
        inclusion_probability: pi,
        created_at: now(),
      });
    }
  }

  it('below threshold → no-op (b_calib stays NULL, data gate)', async () => {
    const q = createId();
    await seedQuestion(q, 3);
    await seedItemCalibration(q, 0.5);
    await seedLabels(q, Array(RECALIBRATION_MIN_LABELS - 1).fill(1.2));

    const result = await recalibrateQuestion(db, q);
    expect(result.updated).toBe(false);
    expect(result.reason).toBe('below_threshold');
    expect(result.labelCount).toBe(RECALIBRATION_MIN_LABELS - 1);

    const cal = await readCalibration(q);
    expect(cal?.b_calib).toBeNull(); // never firmed up below threshold
    expect(cal?.calibration_n).toBe(0);
  });

  it('at/above threshold → firm-up b_calib via PPI++ AIPW', async () => {
    const q = createId();
    await seedQuestion(q, 3);
    await seedItemCalibration(q, 0.5); // b_anchor = 0.5
    // All labels say the true difficulty is ~1.5 (anchor under-estimated). π=0.5 uniform.
    await seedLabels(q, Array(RECALIBRATION_MIN_LABELS).fill(1.5), 0.5);

    const result = await recalibrateQuestion(db, q);
    expect(result.updated).toBe(true);
    expect(result.reason).toBe('ok');
    expect(result.labelCount).toBe(RECALIBRATION_MIN_LABELS);

    const cal = await readCalibration(q);
    expect(cal?.calibration_n).toBe(RECALIBRATION_MIN_LABELS);
    expect(cal?.last_calibrated_at).not.toBeNull();
    expect(cal?.calibration_weight).toBeCloseTo(RECALIBRATION_MIN_LABELS * 0.5, 6); // Σπ_i
    // b_calib should move toward the labels (≈1.5), away from the anchor 0.5.
    expect(cal?.b_calib).not.toBeNull();
    expect(cal?.b_calib as number).toBeGreaterThan(0.5);
    expect(cal?.b_calib as number).toBeCloseTo(1.5, 4);
  });

  it('after firm-up, effectiveB(row) uses b_calib over b_anchor', async () => {
    const q = createId();
    await seedQuestion(q, 3);
    await seedItemCalibration(q, 0.5);
    await seedLabels(q, Array(RECALIBRATION_MIN_LABELS).fill(1.5), 0.5);
    await recalibrateQuestion(db, q);

    const cal = await readCalibration(q);
    expect(effectiveB(cal)).toBeCloseTo(cal?.b_calib as number, 6);
    expect(effectiveB(cal)).not.toBeCloseTo(0.5, 2); // not the anchor anymore
  });

  it('no anchor (no item_calibration row) → no_anchor no-op even with labels', async () => {
    const q = createId();
    await seedQuestion(q, 3);
    await seedLabels(q, Array(RECALIBRATION_MIN_LABELS).fill(1.5));

    const result = await recalibrateQuestion(db, q);
    expect(result.updated).toBe(false);
    expect(result.reason).toBe('no_anchor');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (C) effectiveB read-compat end-to-end (column-level)
// ─────────────────────────────────────────────────────────────────────────────
describe('effectiveB read-compat (column-level, end-to-end)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('b_calib NULL → effectiveB falls to b_anchor (NO-OP today)', async () => {
    const q = createId();
    await seedQuestion(q, 3);
    await seedItemCalibration(q, 0.7); // b=0.7, b_anchor=0.7, b_calib=NULL
    const cal = await readCalibration(q);
    expect(cal?.b_calib).toBeNull();
    expect(effectiveB(cal)).toBeCloseTo(0.7, 6);
  });

  it('b_calib set → effectiveB uses b_calib', async () => {
    const q = createId();
    await seedQuestion(q, 3);
    await seedItemCalibration(q, 0.7);
    await db
      .update(item_calibration)
      .set({ b_calib: -0.4 })
      .where(eq(item_calibration.question_id, q));
    const cal = await readCalibration(q);
    expect(effectiveB(cal)).toBeCloseTo(-0.4, 6);
  });
});
