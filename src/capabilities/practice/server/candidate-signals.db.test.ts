// YUK-361 Phase 3 Step A (Task 7) — collectCandidateSignals DB 测试。
//
// 断言（来自 impl plan Step A + roadmap Task 7 Step 5）：
//   (1) thetaHat = 最弱 KC θ̂_min（多 KC 取 min theta_hat），precision 取该最弱 KC 的。
//   (2) b 来自 item_calibration（track='hard'）时 bSource='item_calibration'；缺标定时
//       difficulty 弱锚兜底 bSource='difficulty_proxy'。
//   (3) 冷启 KC（无 mastery_state 行）→ θ̂=0 / precision=1。
//   (4) recall-locked 题型（fill_blank/translation）→ recallLocked:true 且无 MFI 评分。
//   (5) §9.2 信号无数据时留 undefined（NOT 0）。
//
// 纯读、零行为变更。Follow selection-observations.db.test.ts / variant-rotation.db.test.ts
// 约定：resetDb() in beforeEach，testDb() 取 handle。

import {
  type CandidateInput,
  collectCandidateSignals,
} from '@/capabilities/practice/server/candidate-signals';
import { newId } from '@/core/ids';
import { difficultyToLogitB } from '@/core/theta';
import { item_calibration, mastery_state } from '@/db/schema';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';

const db = testDb();

beforeEach(() => resetDb());

// Seed one mastery_state row for a knowledge node with explicit θ̂ / precision.
async function seedMastery(
  knowledgeId: string,
  thetaHat: number,
  thetaPrecision: number,
): Promise<void> {
  const now = new Date();
  await db.insert(mastery_state).values({
    id: newId(),
    subject_kind: 'knowledge',
    subject_id: knowledgeId,
    theta_hat: thetaHat,
    evidence_count: 1,
    success_count: 1,
    fail_count: 0,
    last_outcome_at: now,
    theta_precision: thetaPrecision,
    last_theta_delta: null,
    updated_at: now,
  });
}

// Seed one item_calibration hard-track b anchor for a question.
async function seedCalibration(questionId: string, b: number): Promise<void> {
  await db.insert(item_calibration).values({
    id: newId(),
    question_id: questionId,
    b,
    confidence: 0.5,
    track: 'hard',
    source: 'llm_prior',
  });
}

describe('collectCandidateSignals — question candidates', () => {
  it('(1) multi-KC thetaHat = weakest-KC θ̂_min, precision = that KC precision', async () => {
    // KC-strong θ̂=1.2 precision=8; KC-weak θ̂=-0.5 precision=3. Expect θ̂_min picks weak.
    await seedMastery('kc-strong', 1.2, 8);
    await seedMastery('kc-weak', -0.5, 3);

    const cand: CandidateInput = {
      refKind: 'question',
      refId: 'q-multi',
      role: 'diagnostic',
      kind: 'short_answer', // application → not recall-locked
      knowledgeIds: ['kc-strong', 'kc-weak'],
      difficulty: 3,
    };
    const [sig] = await collectCandidateSignals(db, [cand]);

    expect(sig.thetaHat).toBeCloseTo(-0.5, 10); // weakest, not strong, not averaged
    expect(sig.thetaPrecision).toBeCloseTo(3, 10); // weakest KC's own precision
  });

  it('(2a) b from item_calibration when present → bSource=item_calibration', async () => {
    await seedMastery('kc-a', 0.3, 4);
    await seedCalibration('q-cal', 0.85);

    const [sig] = await collectCandidateSignals(db, [
      {
        refKind: 'question',
        refId: 'q-cal',
        role: 'diagnostic',
        kind: 'short_answer',
        knowledgeIds: ['kc-a'],
        difficulty: 5, // present but must be IGNORED in favour of calibration b
      },
    ]);

    expect(sig.b).toBeCloseTo(0.85, 10);
    expect(sig.bSource).toBe('item_calibration');
    // MFI score computed (application + θ̂ + b present).
    expect(sig.mfiScore).toBeGreaterThan(0);
    expect(sig.diagnosticScore).toBeGreaterThan(0);
  });

  it('(2b) difficulty_proxy fallback when no calibration → bSource=difficulty_proxy', async () => {
    await seedMastery('kc-b', 0.1, 4);

    const [sig] = await collectCandidateSignals(db, [
      {
        refKind: 'question',
        refId: 'q-no-cal',
        role: 'diagnostic',
        kind: 'short_answer',
        knowledgeIds: ['kc-b'],
        difficulty: 4,
      },
    ]);

    expect(sig.b).toBeCloseTo(difficultyToLogitB(4), 10);
    expect(sig.bSource).toBe('difficulty_proxy');
  });

  it('(2c) no calibration and no difficulty → b undefined, bSource=none, no MFI', async () => {
    await seedMastery('kc-c', 0.2, 4);

    const [sig] = await collectCandidateSignals(db, [
      {
        refKind: 'question',
        refId: 'q-no-b',
        role: 'diagnostic',
        kind: 'short_answer',
        knowledgeIds: ['kc-c'],
        // no difficulty
      },
    ]);

    expect(sig.b).toBeUndefined();
    expect(sig.bSource).toBe('none');
    expect(sig.mfiScore).toBeUndefined();
    expect(sig.diagnosticScore).toBeUndefined();
  });

  it('(3) cold-start KC (no mastery_state row) → θ̂=0, precision=1', async () => {
    // No seedMastery — the KC has never been practised.
    const [sig] = await collectCandidateSignals(db, [
      {
        refKind: 'question',
        refId: 'q-cold',
        role: 'new_check',
        kind: 'short_answer',
        knowledgeIds: ['kc-never-seen'],
        difficulty: 3,
      },
    ]);

    expect(sig.thetaHat).toBe(0);
    expect(sig.thetaPrecision).toBe(1);
  });

  it('(3b) mixed cold + seeded KC: cold θ̂=0 is the weakest → picks cold precision=1', async () => {
    await seedMastery('kc-warm', 0.9, 6); // seeded θ̂=0.9
    // 'kc-cold2' has no row → cold-start θ̂=0 < 0.9, so it is the weakest.
    const [sig] = await collectCandidateSignals(db, [
      {
        refKind: 'question',
        refId: 'q-mixed',
        role: 'diagnostic',
        kind: 'reading',
        knowledgeIds: ['kc-warm', 'kc-cold2'],
        difficulty: 3,
      },
    ]);

    expect(sig.thetaHat).toBe(0); // cold-start θ̂_min
    expect(sig.thetaPrecision).toBe(1); // cold-start precision
  });

  it('(4) recall-locked kind (fill_blank) → recallLocked:true, no MFI score', async () => {
    await seedMastery('kc-recall', -0.3, 5);
    await seedCalibration('q-recall', 0.4); // even with full anchors, recall items skip MFI

    const [sig] = await collectCandidateSignals(db, [
      {
        refKind: 'question',
        refId: 'q-recall',
        role: 'diagnostic',
        kind: 'fill_blank', // recall (ADR-0030)
        knowledgeIds: ['kc-recall'],
        difficulty: 3,
      },
    ]);

    expect(sig.recallLocked).toBe(true);
    expect(sig.mfiScore).toBeUndefined(); // recall items must NOT be fed MFI
    expect(sig.diagnosticScore).toBeUndefined();
    // θ̂ / b still collected (telemetry), just not scored.
    expect(sig.thetaHat).toBeCloseTo(-0.3, 10);
    expect(sig.b).toBeCloseTo(0.4, 10);
  });

  it('(4b) translation kind is also recall-locked', async () => {
    await seedMastery('kc-tr', 0.1, 4);
    const [sig] = await collectCandidateSignals(db, [
      {
        refKind: 'question',
        refId: 'q-tr',
        role: 'diagnostic',
        kind: 'translation',
        knowledgeIds: ['kc-tr'],
        difficulty: 3,
      },
    ]);
    expect(sig.recallLocked).toBe(true);
    expect(sig.mfiScore).toBeUndefined();
  });

  it('(4c) application kind (choice) is NOT recall-locked and gets a score', async () => {
    await seedMastery('kc-app', 0.2, 4);
    const [sig] = await collectCandidateSignals(db, [
      {
        refKind: 'question',
        refId: 'q-app',
        role: 'diagnostic',
        kind: 'choice',
        knowledgeIds: ['kc-app'],
        difficulty: 3,
      },
    ]);
    expect(sig.recallLocked).toBe(false);
    expect(sig.mfiScore).toBeGreaterThan(0);
  });

  it('(5) §9.2 fields are undefined when no data source exists (NOT zero)', async () => {
    await seedMastery('kc-92', 0.0, 4);
    const [sig] = await collectCandidateSignals(db, [
      {
        refKind: 'question',
        refId: 'q-92',
        role: 'diagnostic',
        kind: 'short_answer',
        knowledgeIds: ['kc-92'],
        difficulty: 3,
      },
    ]);

    // undefined means "no data"; 0 would mean "measured zero" — the distinction matters
    // for the Step C scorer (MFI-only degradation vs treating signal as a hard zero).
    expect(sig.examRelevance).toBeUndefined();
    expect(sig.misconceptionRecurrence).toBeUndefined();
    expect(sig.transferGap).toBeUndefined();
    expect(sig.examRelevance).not.toBe(0);
  });

  it('no knowledge_ids → thetaHat/thetaPrecision undefined, no MFI', async () => {
    await seedCalibration('q-no-kc', 0.5);
    const [sig] = await collectCandidateSignals(db, [
      {
        refKind: 'question',
        refId: 'q-no-kc',
        role: 'diagnostic',
        kind: 'short_answer',
        knowledgeIds: [],
        difficulty: 3,
      },
    ]);
    expect(sig.thetaHat).toBeUndefined();
    expect(sig.thetaPrecision).toBeUndefined();
    expect(sig.b).toBeCloseTo(0.5, 10); // b still resolved from calibration
    expect(sig.mfiScore).toBeUndefined(); // no θ̂ → no MFI
  });
});

describe('collectCandidateSignals — paper candidates', () => {
  it('paper candidate passes through with role only, no IRT/MFI', async () => {
    const [sig] = await collectCandidateSignals(db, [
      {
        refKind: 'paper',
        refId: 'paper-1',
        role: 'paper',
      },
    ]);

    expect(sig.refKind).toBe('paper');
    expect(sig.refId).toBe('paper-1');
    expect(sig.role).toBe('paper');
    expect(sig.thetaHat).toBeUndefined();
    expect(sig.b).toBeUndefined();
    expect(sig.bSource).toBe('none');
    expect(sig.mfiScore).toBeUndefined();
    expect(sig.examRelevance).toBeUndefined();
  });
});

describe('collectCandidateSignals — batch', () => {
  it('preserves input order across mixed question + paper candidates', async () => {
    await seedMastery('kc-batch', 0.1, 4);
    const sigs = await collectCandidateSignals(db, [
      {
        refKind: 'question',
        refId: 'q1',
        role: 'diagnostic',
        kind: 'short_answer',
        knowledgeIds: ['kc-batch'],
        difficulty: 3,
      },
      { refKind: 'paper', refId: 'p1', role: 'paper' },
      {
        refKind: 'question',
        refId: 'q2',
        role: 'frontier',
        kind: 'choice',
        knowledgeIds: ['kc-batch'],
        difficulty: 2,
      },
    ]);
    expect(sigs.map((s) => s.refId)).toEqual(['q1', 'p1', 'q2']);
    expect(sigs.map((s) => s.refKind)).toEqual(['question', 'paper', 'question']);
  });
});
