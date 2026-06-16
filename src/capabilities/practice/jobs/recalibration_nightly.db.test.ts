// YUK-372 L1 — active-PPI 重标定夜扫 job 的端到端 db 测（真实 Postgres）。
//
// hermetic 契约：每个 db 测在 beforeEach resetDb()。
//
// 验证候选预筛（攒够标签 + 窗内新标签 + 非 draft）+ 逐题 recalibrateQuestion firm-up +
// 单题失败隔离 + 无锚跳过。π_i gate 的完整矩阵在 L2 的 recalibration.db.test.ts；本测只放一条
// 薄边界 sentinel（consumer 侧）确认经真 hook 写的合法标签能被 job firm-up。

import { createId } from '@paralleldrive/cuid2';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { recordSelectionObservation } from '@/capabilities/practice/server/selection-observations';
import { newId } from '@/core/ids';
import { db } from '@/db/client';
import {
  difficulty_calibration_label,
  item_calibration,
  practice_stream_item,
  question,
} from '@/db/schema';
import {
  RECALIBRATION_MIN_LABELS,
  recordDifficultyCalibrationLabel,
} from '@/server/mastery/recalibration';
import { resetDb } from '../../../../tests/helpers/db';
import { runRecalibrationNightly } from './recalibration_nightly';

// 固定 job 运行时刻（Asia/Shanghai 2026-06-16 04:50，正是 cron 档），其候选窗起点 = 昨日
// （2026-06-15）本地日零点。
const JOB_NOW = new Date('2026-06-16T04:50:00+08:00');
// 「窗内」标签时刻：昨日（2026-06-15）当天 → 应被捞到。
const IN_WINDOW = new Date('2026-06-15T20:00:00+08:00');
// 「窗外」标签时刻：前天（2026-06-14）→ 不应单独触发候选（无新进展）。
const OUT_OF_WINDOW = new Date('2026-06-14T08:00:00+08:00');

async function seedQuestion(id: string, opts: { difficulty?: number; draftStatus?: string } = {}) {
  await db.insert(question).values({
    id,
    kind: 'short_answer',
    prompt_md: `Prompt ${id}`,
    reference_md: null,
    knowledge_ids: [],
    difficulty: opts.difficulty ?? 3,
    source: 'manual',
    draft_status: opts.draftStatus ?? null,
    variant_depth: 0,
    created_at: JOB_NOW,
    updated_at: JOB_NOW,
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
    created_at: JOB_NOW,
    updated_at: JOB_NOW,
  });
}

/** 直接种 N 条标签（绕过 hook），全部带指定 created_at。 */
async function seedLabels(
  questionId: string,
  count: number,
  opts: { bLabel?: number; pi?: number; createdAt?: Date } = {},
) {
  for (let i = 0; i < count; i++) {
    await db.insert(difficulty_calibration_label).values({
      id: newId(),
      question_id: questionId,
      attempt_event_id: createId(),
      theta_snapshot: 0,
      outcome: 0,
      b_label: opts.bLabel ?? 1.5,
      inclusion_probability: opts.pi ?? 0.5,
      created_at: opts.createdAt ?? IN_WINDOW,
    });
  }
}

async function readCalibration(questionId: string) {
  const rows = await db
    .select()
    .from(item_calibration)
    .where(and(eq(item_calibration.question_id, questionId), eq(item_calibration.track, 'hard')))
    .limit(1);
  return rows[0] ?? null;
}

describe('runRecalibrationNightly', () => {
  beforeEach(async () => {
    await resetDb();
  });

  // (a) enough labels in-window → recalibrated=1, b_calib non-NULL.
  it('firms up b_calib for a question with enough in-window labels', async () => {
    const q = createId();
    await seedQuestion(q);
    await seedItemCalibration(q, 0.5);
    await seedLabels(q, RECALIBRATION_MIN_LABELS, { bLabel: 1.5, createdAt: IN_WINDOW });

    const result = await runRecalibrationNightly(db, { now: JOB_NOW });

    expect(result.considered).toBe(1);
    expect(result.recalibrated).toBe(1);
    const cal = await readCalibration(q);
    expect(cal?.b_calib).not.toBeNull();
    expect(cal?.b_calib as number).toBeCloseTo(1.5, 4);
    expect(cal?.calibration_n).toBe(RECALIBRATION_MIN_LABELS);
  });

  // (b) in-window labels but total < threshold → not even a candidate (HAVING count gate),
  // b_calib stays NULL.
  it('does not recalibrate a question below the label threshold', async () => {
    const q = createId();
    await seedQuestion(q);
    await seedItemCalibration(q, 0.5);
    await seedLabels(q, RECALIBRATION_MIN_LABELS - 1, { createdAt: IN_WINDOW });

    const result = await runRecalibrationNightly(db, { now: JOB_NOW });

    expect(result.considered).toBe(0); // HAVING count >= threshold filters it out pre-write.
    expect(result.recalibrated).toBe(0);
    const cal = await readCalibration(q);
    expect(cal?.b_calib).toBeNull();
  });

  // (c) historically enough labels but NONE in the trigger window → not a candidate (no new
  // progress this nightly).
  it('does not pick a question whose labels are all outside the trigger window', async () => {
    const q = createId();
    await seedQuestion(q);
    await seedItemCalibration(q, 0.5);
    await seedLabels(q, RECALIBRATION_MIN_LABELS, { createdAt: OUT_OF_WINDOW });

    const result = await runRecalibrationNightly(db, { now: JOB_NOW });

    expect(result.considered).toBe(0);
    expect(result.recalibrated).toBe(0);
    const cal = await readCalibration(q);
    expect(cal?.b_calib).toBeNull();
  });

  // (d) candidate with enough in-window labels but NO anchor (no item_calibration row) →
  // skipped_no_anchor, no crash.
  it('counts a no-anchor candidate as skipped_no_anchor without crashing', async () => {
    const q = createId();
    await seedQuestion(q);
    // NO item_calibration row → recalibrateQuestion returns no_anchor.
    await seedLabels(q, RECALIBRATION_MIN_LABELS, { createdAt: IN_WINDOW });

    const result = await runRecalibrationNightly(db, { now: JOB_NOW });

    expect(result.considered).toBe(1);
    expect(result.recalibrated).toBe(0);
    expect(result.skipped_no_anchor).toBe(1);
  });

  // (e) empty DB → considered=0.
  it('returns zero counts on an empty database', async () => {
    const result = await runRecalibrationNightly(db, { now: JOB_NOW });
    expect(result).toEqual({
      considered: 0,
      recalibrated: 0,
      skipped_below: 0,
      skipped_no_anchor: 0,
      skipped_failed: 0,
    });
  });

  // (f) one question's recalibration fails → others still proceed (per-question isolation).
  // Force a failure by making one candidate's item_calibration carry a NaN-inducing state is
  // hard; instead seed two healthy candidates and a third with a poisoned label (NaN π would
  // throw positivity in ppiPlusMean) to exercise the per-question swallow.
  it('isolates a per-question recalibration failure: others still firm up', async () => {
    const good1 = createId();
    const good2 = createId();
    const bad = createId();
    for (const q of [good1, good2, bad]) {
      await seedQuestion(q);
      await seedItemCalibration(q, 0.5);
    }
    await seedLabels(good1, RECALIBRATION_MIN_LABELS, { bLabel: 1.5, createdAt: IN_WINDOW });
    await seedLabels(good2, RECALIBRATION_MIN_LABELS, { bLabel: 1.2, createdAt: IN_WINDOW });
    // `bad`: enough labels (so it is a candidate) but one carries π=0 → ppiPlusMean throws
    // positivity → per-question catch swallows it → skipped_failed.
    await seedLabels(bad, RECALIBRATION_MIN_LABELS - 1, { bLabel: 1.0, createdAt: IN_WINDOW });
    await db.insert(difficulty_calibration_label).values({
      id: newId(),
      question_id: bad,
      attempt_event_id: createId(),
      theta_snapshot: 0,
      outcome: 0,
      b_label: 1.0,
      inclusion_probability: 0, // positivity violation → recalibrateQuestion throws.
      created_at: IN_WINDOW,
    });

    const result = await runRecalibrationNightly(db, { now: JOB_NOW });

    expect(result.considered).toBe(3);
    expect(result.recalibrated).toBe(2); // both good questions firmed up.
    expect(result.skipped_failed).toBe(1); // the poisoned one swallowed, not aborting the run.
    expect((await readCalibration(good1))?.b_calib).not.toBeNull();
    expect((await readCalibration(good2))?.b_calib).not.toBeNull();
    expect((await readCalibration(bad))?.b_calib).toBeNull(); // never firmed up.
  });

  // (g) L2-boundary thin sentinel (consumer side): a label written by the REAL
  // recordDifficultyCalibrationLabel hook (legitimate π_i joined from a materialized softmax
  // slot) is a valid candidate label for the job. We drive the hook ONCE (the
  // practice_stream_item (date, ref_id) unique constraint allows only one slot per question per
  // day, so a full threshold via the hook would need 12 distinct days — overkill for a boundary
  // sentinel), then top up to threshold with directly-seeded labels in the same window. The job
  // must firm up b_calib. This pins that hook-written labels are consumed end-to-end; it does NOT
  // re-test the π_i matched-stream-slot gate matrix (that is L2's scope).
  it('L2-boundary sentinel: a real-hook π_i label counts toward firm-up', async () => {
    const q = createId();
    await seedQuestion(q);
    await seedItemCalibration(q, 0.5);

    const day = '2026-06-15'; // in-window (yesterday-local)
    const attemptNow = new Date(`${day}T20:00:00+08:00`);
    const slotId = newId();
    await db.insert(practice_stream_item).values({
      id: slotId,
      date: day,
      position: 0,
      item_kind: 'question',
      ref_id: q,
      source: 'decay',
      status: 'done',
      reasoning: 'sentinel slot',
      added_by: 'composer_live',
      signals: {},
      created_at: attemptNow,
      updated_at: attemptNow,
    });
    await recordSelectionObservation(db, {
      date: day,
      streamItemId: slotId,
      refKind: 'question',
      refId: q,
      policy: 'softmax_mfi',
      selected: true,
      inclusionProbability: 0.5,
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
        now: attemptNow,
        // YUK-372 L2 — thread the answered slot id (hook now requires it for the π_i direct join).
        streamItemId: slotId,
      });
    });

    // Sanity: the hook wrote exactly one legitimate π_i label.
    const hookLabels = await db
      .select()
      .from(difficulty_calibration_label)
      .where(eq(difficulty_calibration_label.question_id, q));
    expect(hookLabels).toHaveLength(1);
    expect(hookLabels[0].inclusion_probability).toBeCloseTo(0.5, 6);

    // Top up to threshold with directly-seeded in-window labels (the boundary sentinel is about
    // the hook label being consumed, not re-proving the hook's gate).
    await seedLabels(q, RECALIBRATION_MIN_LABELS - 1, { createdAt: IN_WINDOW });

    const result = await runRecalibrationNightly(db, { now: JOB_NOW });
    expect(result.recalibrated).toBe(1);
    expect((await readCalibration(q))?.b_calib).not.toBeNull();
  });

  // G5: a draft question is excluded even if it has enough in-window labels.
  it('excludes a draft question from the candidate set (G5)', async () => {
    const q = createId();
    await seedQuestion(q, { draftStatus: 'draft' });
    await seedItemCalibration(q, 0.5);
    await seedLabels(q, RECALIBRATION_MIN_LABELS, { createdAt: IN_WINDOW });

    const result = await runRecalibrationNightly(db, { now: JOB_NOW });
    expect(result.considered).toBe(0);
    expect((await readCalibration(q))?.b_calib).toBeNull();
  });
});
