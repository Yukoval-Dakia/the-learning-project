// YUK-558 C5+C8④ — 一次性追溯 recompute（scripts/recompute-bcalib-cap.ts）的端到端 db 测。
// Imports the testDb helper + drives a real Postgres → MUST be a db test (NOT in fastTestInclude;
// note: `scripts/**/*.test.ts` 会落 unit 分区，故本测放 tests/integration/ 而非 scripts/)。
//
// 覆盖：① 对已 firm-up 的存量题重跑 recalibrateQuestion——**值幂等**（同标签集 ⇒ b_calib 逐位不变）
// + clip 可观测聚合（clip_activations / min_pi_seen）；② 单题失败（π=0 毒标签）被 per-question
// try/catch 吞，不阻断其余题（skipped_failed）。

import { createId } from '@paralleldrive/cuid2';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { newId } from '@/core/ids';
import { db } from '@/db/client';
import { difficulty_calibration_label, item_calibration, question } from '@/db/schema';
import { RECALIBRATION_MIN_LABELS, recalibrateQuestion } from '@/server/mastery/recalibration';
import { runRecomputeBCalibCap } from '../../scripts/recompute-bcalib-cap';
import { resetDb } from '../helpers/db';

const NOW = new Date('2026-06-16T04:50:00+08:00');

async function seedQuestion(id: string) {
  await db.insert(question).values({
    id,
    kind: 'short_answer',
    prompt_md: `Prompt ${id}`,
    reference_md: null,
    knowledge_ids: [],
    difficulty: 3,
    source: 'manual',
    draft_status: null,
    variant_depth: 0,
    created_at: NOW,
    updated_at: NOW,
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
    created_at: NOW,
    updated_at: NOW,
  });
}

async function seedLabels(
  questionId: string,
  count: number,
  opts: { bLabel?: number; pi?: number } = {},
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
      created_at: NOW,
    });
  }
}

async function seedOneLabel(questionId: string, opts: { bLabel: number; pi: number }) {
  await db.insert(difficulty_calibration_label).values({
    id: newId(),
    question_id: questionId,
    attempt_event_id: createId(),
    theta_snapshot: 0,
    outcome: 0,
    b_label: opts.bLabel,
    inclusion_probability: opts.pi,
    created_at: NOW,
  });
}

async function readCalibration(questionId: string) {
  const rows = await db
    .select()
    .from(item_calibration)
    .where(and(eq(item_calibration.question_id, questionId), eq(item_calibration.track, 'hard')))
    .limit(1);
  return rows[0] ?? null;
}

describe('runRecomputeBCalibCap (YUK-558 一次性追溯 recompute)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('recomputes 2 firmed-up questions (1 fluke) — value idempotent (b_calib bit-identical on rerun) + clip observable', async () => {
    // Q1: fluke batch (11 honest @π=0.5 label 0 + 1 fluke @π=4e-4 label 2, b_anchor=0) → clip 1.
    const q1 = createId();
    await seedQuestion(q1);
    await seedItemCalibration(q1, 0.0);
    await seedLabels(q1, RECALIBRATION_MIN_LABELS - 1, { bLabel: 0.0, pi: 0.5 });
    await seedOneLabel(q1, { bLabel: 2.0, pi: 4e-4 });
    // Q2: homogeneous batch (12 @π=0.5) → clip 0.
    const q2 = createId();
    await seedQuestion(q2);
    await seedItemCalibration(q2, 0.5);
    await seedLabels(q2, RECALIBRATION_MIN_LABELS, { bLabel: 1.5, pi: 0.5 });

    // Firm up both (sets b_calib IS NOT NULL → they become recompute candidates).
    await recalibrateQuestion(db, q1);
    await recalibrateQuestion(db, q2);

    const first = await runRecomputeBCalibCap(db);
    expect(first.considered).toBe(2);
    expect(first.recalibrated).toBe(2);
    expect(first.clip_activations).toBeGreaterThanOrEqual(1); // Q1 fluke clipped.
    expect(first.min_pi_seen).toBeCloseTo(4e-4, 12);
    expect(first.max_pi_seen).toBeCloseTo(0.5, 12); // largest π (honest 0.5) across both batches (min-max π face).
    // identity: every considered question lands in exactly one bucket (no operator blind spot).
    expect(first.recalibrated + first.skipped_failed + first.skipped_not_updated).toBe(
      first.considered,
    );

    const b1q1 = (await readCalibration(q1))?.b_calib as number;
    const b1q2 = (await readCalibration(q2))?.b_calib as number;
    expect(b1q1).not.toBeNull();

    // Rerun → **value idempotent**: b_calib bit-for-bit unchanged（同标签集 ⇒ 同全量重算输出）。
    const second = await runRecomputeBCalibCap(db);
    expect(second.considered).toBe(2);
    expect(second.recalibrated).toBe(2);
    expect((await readCalibration(q1))?.b_calib as number).toBe(b1q1);
    expect((await readCalibration(q2))?.b_calib as number).toBe(b1q2);
  });

  it('isolates a per-question failure (π=0 poisoned label) — skipped_failed=1, others still recompute', async () => {
    const good1 = createId();
    const good2 = createId();
    const bad = createId();
    for (const q of [good1, good2, bad]) {
      await seedQuestion(q);
      await seedItemCalibration(q, 0.5);
      await seedLabels(q, RECALIBRATION_MIN_LABELS, { bLabel: 1.5, pi: 0.5 });
      await recalibrateQuestion(db, q); // firm up all three → b_calib IS NOT NULL (candidates).
    }
    // Poison `bad` AFTER firm-up with a π=0 label → recompute rerun throws positivity →
    // per-question catch swallows → skipped_failed, without aborting good1/good2.
    await seedOneLabel(bad, { bLabel: 1.0, pi: 0 });

    const result = await runRecomputeBCalibCap(db);
    expect(result.considered).toBe(3);
    expect(result.recalibrated).toBe(2);
    expect(result.skipped_failed).toBe(1);
    expect((await readCalibration(good1))?.b_calib).not.toBeNull();
    expect((await readCalibration(good2))?.b_calib).not.toBeNull();
  });

  // YUK-558 bot 轮 — updated=false 无异常（no_anchor）落 skipped_not_updated + reason 分桶，
  // 闭合 considered === recalibrated + skipped_failed + skipped_not_updated 恒等（operator 视野修复）。
  it('counts updated=false (no exception, no_anchor) into skipped_not_updated with reason breakdown + identity', async () => {
    // Candidate: b_calib IS NOT NULL (so it is a recompute candidate) but NO anchor (b/b_anchor both
    // NULL) → recalibrateQuestion returns {updated:false, reason:'no_anchor'} WITHOUT throwing.
    const noAnchor = createId();
    await seedQuestion(noAnchor);
    await db.insert(item_calibration).values({
      id: newId(),
      question_id: noAnchor,
      b: null,
      b_anchor: null,
      b_calib: 1.5, // makes it a recompute candidate (b_calib IS NOT NULL)
      calibration_n: RECALIBRATION_MIN_LABELS,
      confidence: 0.5,
      track: 'hard',
      source: 'llm_prior',
      created_at: NOW,
      updated_at: NOW,
    });
    await seedLabels(noAnchor, RECALIBRATION_MIN_LABELS, { bLabel: 1.5, pi: 0.5 });
    // A healthy candidate alongside it, so the identity spans a mixed batch.
    const good = createId();
    await seedQuestion(good);
    await seedItemCalibration(good, 0.5);
    await seedLabels(good, RECALIBRATION_MIN_LABELS, { bLabel: 1.5, pi: 0.5 });
    await recalibrateQuestion(db, good); // firm up → b_calib IS NOT NULL (candidate).

    const result = await runRecomputeBCalibCap(db);
    expect(result.considered).toBe(2);
    expect(result.recalibrated).toBe(1);
    expect(result.skipped_failed).toBe(0);
    expect(result.skipped_not_updated).toBe(1);
    expect(result.skipped_by_reason.no_anchor).toBe(1);
    // identity holds: considered === recalibrated + skipped_failed + skipped_not_updated.
    expect(result.recalibrated + result.skipped_failed + result.skipped_not_updated).toBe(
      result.considered,
    );
  });
});
