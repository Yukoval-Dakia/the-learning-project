// YUK-361 Phase 5 — 家族级 b_personalized 门控 update 路径 db 测。
//
// 验证 (Phase 5 step 5 + 本 driver 验收):
//   (a) n<20 / <5 distinct questions / 非客观 outcome → b_delta 不离 0；
//   (b) 全门控过后 → 收缩后的 b_delta 被应用；
//   (c) family_key 组装 + recordFamilyObservationForAttempt 端到端 (subject 派生);
//   (d) soft/subjective outcome 一条都不累 (isObjective=false 早返)。

import { createId } from '@paralleldrive/cuid2';
import { beforeEach, describe, expect, it } from 'vitest';

import { newId } from '@/core/ids';
import { db } from '@/db/client';
import { event, item_calibration, knowledge, mastery_state, question } from '@/db/schema';
import { resetDb } from '../../../tests/helpers/db';
import {
  FAMILY_MIN_DISTINCT_QUESTIONS,
  FAMILY_MIN_EVIDENCE,
  familyKey,
  getFamilyCalibration,
  recordFamilyObservationForAttempt,
} from './personalized-difficulty';

async function seedKnowledge(id: string, domain = 'yuwen') {
  const now = new Date();
  await db
    .insert(knowledge)
    .values({
      id,
      name: `K-${id}`,
      domain,
      parent_id: null,
      created_at: now,
      updated_at: now,
      version: 0,
    })
    .onConflictDoNothing();
}

async function seedQuestion(
  id: string,
  knowledgeIds: string[],
  kind = 'short_answer',
  source = 'manual',
  difficulty = 3,
) {
  const now = new Date();
  await db.insert(question).values({
    id,
    kind,
    prompt_md: `Prompt ${id}`,
    reference_md: null,
    knowledge_ids: knowledgeIds,
    difficulty,
    source,
    variant_depth: 0,
    created_at: now,
    updated_at: now,
    version: 0,
  });
}

async function seedItemCalibration(questionId: string, b: number) {
  const now = new Date();
  await db.insert(item_calibration).values({
    id: newId(),
    question_id: questionId,
    b,
    confidence: 0.5,
    track: 'hard',
    source: 'llm_prior',
    created_at: now,
    updated_at: now,
  });
}

async function readFamily(key: string) {
  return getFamilyCalibration(db, key);
}

/**
 * Seed an attempt/review event + a sibling judge event for `questionId` so the
 * OBSERVED-distinct query (finding #1) counts this question as having produced a
 * judged observation. `judgeRoute` controls objectivity (exact/keyword =
 * objective; semantic etc. = soft → not counted). `action` mirrors the two hot
 * paths (review = /api/review/submit, attempt = paper-submit). Returns the
 * attempt event id.
 */
async function seedJudgedAttemptEvent(
  questionId: string,
  judgeRoute: string,
  action: 'review' | 'attempt' = 'attempt',
): Promise<string> {
  const createdAt = new Date();
  const attemptId = newId();
  await db.insert(event).values({
    id: attemptId,
    actor_kind: 'user',
    actor_ref: 'self',
    action,
    subject_kind: 'question',
    subject_id: questionId,
    outcome: 'failure',
    payload: {},
    created_at: createdAt,
  });
  await db.insert(event).values({
    id: newId(),
    actor_kind: 'agent',
    actor_ref: 'test_judge',
    action: 'judge',
    subject_kind: 'event',
    subject_id: attemptId,
    outcome: 'success',
    payload: { judge_route: judgeRoute },
    caused_by_event_id: attemptId,
    created_at: createdAt,
  });
  return attemptId;
}

const now = () => new Date();

describe('mastery_state θ̂ 锚组合 (effectiveFamilyB 消费接缝 sanity)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  // ── finding #3 修复回归 — 残差用 PRE-attempt θ̂（thetaBefore），不读 POSTERIOR ────
  // hook 在 updateThetaForAttempt 之后调用，mastery_state.theta_hat 已被本次作答移动
  // （POSTERIOR）。残差必须对着**作答前**的 θ̂ 算（mirror state.ts thetaBefore=s.theta
  // 纪律）。caller 在 Elo 下移前捕获 θ̂ 传入 thetaBefore；hook 优先用它，不读已移动的
  // mastery_state。本测：mastery_state 种 POSTERIOR θ̂=-3（远低），thetaBefore 传 -1，
  // 全答错。两者残差都 <clamp 且不同：θ=-1 → wrong residual=1/(1-σ(-1))≈1.368；若误读
  // mastery_state(θ=-3) → 1/(1-σ(-3))≈1.0497。b_delta = shrink(residual, 20) = 0.5·residual。
  it('(finding #3) 残差用传入的 PRE-attempt thetaBefore，而非已移动的 mastery_state θ̂', async () => {
    const k = createId();
    await seedKnowledge(k, 'yuwen');
    const qs: string[] = [];
    for (let i = 0; i < FAMILY_MIN_DISTINCT_QUESTIONS; i++) {
      const q = createId();
      await seedQuestion(q, [k], 'short_answer', 'manual');
      await seedItemCalibration(q, 0); // bAnchor=0
      await seedJudgedAttemptEvent(q, 'keyword'); // observed-distinct=5
      qs.push(q);
    }
    // 种一个 POSTERIOR θ̂=-3（代表本次作答 Elo 下移后的值）。若 hook 误读它，残差会偏。
    await db.insert(mastery_state).values({
      id: newId(),
      subject_kind: 'knowledge',
      subject_id: k,
      theta_hat: -3.0,
      evidence_count: 20,
      success_count: 0,
      fail_count: 20,
      last_outcome_at: now(),
      theta_precision: 5,
      updated_at: now(),
    });

    // 40 次全答错，PRE-attempt θ̂ = -1（作答前），bAnchor=0。两门首次都过在 n=20，
    // 折进 n=20..40 共 21 条 → calibrated_n=21。residual 每次相同（θ 固定）→ 运行均值
    // = residual，b_delta = shrink(residual, 21)。
    const TOTAL = 40;
    for (let i = 0; i < TOTAL; i++) {
      const q = qs[i % qs.length];
      await db.transaction(async (tx) => {
        await recordFamilyObservationForAttempt(tx, {
          primaryKnowledgeId: k,
          questionId: q,
          kind: 'short_answer',
          source: 'manual',
          difficulty: 3,
          outcome: 0,
          judgeRoute: 'keyword',
          thetaBefore: -1.0, // PRE-attempt θ̂（作答前），≠ mastery_state 的 -3
          now: now(),
        });
      });
    }

    const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
    const wrongResidual = (theta: number) => {
      const p = sigmoid(theta); // b=0
      const fisher = Math.max(p * (1 - p), 0.05);
      return -(0 - p) / fisher;
    };
    const row = await readFamily(familyKey('yuwen', k, 'short_answer', 'manual'));
    expect(row?.evidence_count).toBe(TOTAL);
    // 折进 n=20..40 → calibrated_n=21（n 门在 newN≥20 时过；distinct 早已 5）。
    const cn = row?.calibrated_n ?? 0;
    expect(cn).toBe(TOTAL - FAMILY_MIN_EVIDENCE + 1); // 21
    const shrink = (raw: number, n: number) => (n / (n + 20)) * raw;
    const expectedFromBefore = shrink(wrongResidual(-1.0), cn); // 用 thetaBefore=-1 的残差
    const wrongIfReadPosterior = shrink(wrongResidual(-3.0), cn); // 误读 mastery_state(-3)
    expect(row?.b_delta).toBeCloseTo(expectedFromBefore, 4);
    // 与误读 POSTERIOR θ=-3 的值明显不同（证明没读 mastery_state）。
    expect(Math.abs((row?.b_delta ?? 0) - wrongIfReadPosterior)).toBeGreaterThan(0.05);
  });
});
