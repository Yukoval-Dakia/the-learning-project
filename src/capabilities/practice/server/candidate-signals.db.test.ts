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

import { beforeEach, describe, expect, it, vi } from 'vitest';

// A3 (YUK-435) — EARLY_KLP_ENABLED is a module-level const. As of YUK-361 P1 go-live
// step 2 its REAL default is now TRUE (live). This suite controls the flag explicitly
// via the getter mock below (it does NOT rely on the real const default), so both
// directions stay tested regardless of the live default:
//   - OFF-path / baseline regressions (the bit-identical point-MFI anchor) run with an
//     EXPLICIT false (earlyKlpFlag.value=false, restored in beforeEach) → the pre-A3
//     baseline survives the flip and is NOT vacuous.
//   - ON-path tests set earlyKlpFlag.value=true (now also the live default).
// We mock just this one export of @/core/selection-signals and keep every other export
// (mfiScore, klpScore, diagnosticScore, …) as the REAL implementation via importOriginal.
const earlyKlpFlag = { value: false };
vi.mock('@/core/selection-signals', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/core/selection-signals')>();
  return {
    ...actual,
    get EARLY_KLP_ENABLED() {
      return earlyKlpFlag.value;
    },
  };
});

import {
  type CandidateInput,
  collectCandidateSignals,
} from '@/capabilities/practice/server/candidate-signals';
import { newId } from '@/core/ids';
import { klpScore, mfiScore } from '@/core/selection-signals';
import { difficultyToLogitB } from '@/core/theta';
import { item_calibration, item_family_calibration, knowledge, mastery_state } from '@/db/schema';
import { resetDb, testDb } from '../../../../tests/helpers/db';

const db = testDb();

beforeEach(() => {
  earlyKlpFlag.value = false; // restore dark-ship default before every test
  return resetDb();
});

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

// Seed a knowledge node with an explicit domain (for family_key subject derivation).
async function seedKnowledge(id: string, domain = 'wenyan'): Promise<void> {
  const now = new Date();
  await db.insert(knowledge).values({
    id,
    name: `K-${id}`,
    domain,
    parent_id: null,
    created_at: now,
    updated_at: now,
    version: 0,
  });
}

// Seed an item_family_calibration row with a (gate-passed) non-zero b_delta.
async function seedFamilyCalibration(familyKey: string, bDelta: number): Promise<void> {
  await db.insert(item_family_calibration).values({
    id: newId(),
    family_key: familyKey,
    b_delta: bDelta,
    evidence_count: 30,
    calibrated_n: 30,
    confidence: 0.6,
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

  it('(4d) undefined kind → recallLocked:true (fail CLOSED, review CLUSTER D)', async () => {
    // 一道身份不明的候选（kind 缺失，如目标题被硬删 / kind 列丢失）。fail-open（旧行为）
    // 会把它当 application 喂 sampler/MFI，违反铁律③（recall-locked = 同题永不被抽样）。
    // 现保守锁 recall：宁可确定性透传也不让不明候选进随机抽样。
    await seedMastery('kc-unknown-kind', 0.2, 4);
    await seedCalibration('q-unknown-kind', 0.3); // 即便有全锚，未知 kind 也不算 MFI
    const [sig] = await collectCandidateSignals(db, [
      {
        refKind: 'question',
        refId: 'q-unknown-kind',
        role: 'diagnostic',
        // kind 故意省略 → fail-closed 锁 recall。
        knowledgeIds: ['kc-unknown-kind'],
        difficulty: 3,
      },
    ]);
    expect(sig.recallLocked).toBe(true);
    expect(sig.mfiScore).toBeUndefined(); // 锁 recall ⇒ 不算 MFI（不进 sampler 评分）
    expect(sig.diagnosticScore).toBeUndefined();
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

// A3 (YUK-435) — KLP cold-start early selection + scoreKind provenance.
describe('collectCandidateSignals — KLP early selection (A3, YUK-435)', () => {
  // Seed a mastery_state row with an EXPLICIT evidence_count (the cold-start regime gate).
  async function seedMasteryWithEvidence(
    knowledgeId: string,
    thetaHat: number,
    thetaPrecision: number,
    evidenceCount: number,
  ): Promise<void> {
    const now = new Date();
    await db.insert(mastery_state).values({
      id: newId(),
      subject_kind: 'knowledge',
      subject_id: knowledgeId,
      theta_hat: thetaHat,
      evidence_count: evidenceCount,
      success_count: Math.max(evidenceCount - 1, 0),
      fail_count: 0,
      last_outcome_at: now,
      theta_precision: thetaPrecision,
      last_theta_delta: null,
      updated_at: now,
    });
  }

  it('flag OFF (default): cold-start KC scored by point MFI, scoreKind=mfi (BITWISE regression anchor)', async () => {
    // evidence_count=1 < EARLY_KLP_N(4): would be KLP IF the flag were on. With the
    // dark-ship default (false) it MUST be the exact point-MFI byte, scoreKind='mfi'.
    await seedMasteryWithEvidence('kc-off-cold', 0.3, 0.5, 1);
    await seedCalibration('q-off-cold', 0.85);

    const [sig] = await collectCandidateSignals(db, [
      {
        refKind: 'question',
        refId: 'q-off-cold',
        role: 'diagnostic',
        kind: 'short_answer',
        knowledgeIds: ['kc-off-cold'],
        difficulty: 3,
      },
    ]);

    // BITWISE-identical to point MFI (toBe, not toBeCloseTo): flag-off scoring is
    // byte-for-byte today's behaviour, on a KC that WOULD trigger KLP if flag were on.
    expect(sig.mfiScore).toBe(mfiScore(0.3, 0.85));
    expect(sig.scoreKind).toBe('mfi');
    // And it must NOT be the KLP value (proves the branch is actually gated off).
    expect(sig.mfiScore).not.toBe(klpScore(0.3, 0.85, 0.5));
  });

  it('flag OFF (default): warm KC also scored by point MFI, scoreKind=mfi', async () => {
    await seedMasteryWithEvidence('kc-off-warm', 0.2, 6, 10); // evidence_count=10 ≥ 4
    await seedCalibration('q-off-warm', 0.5);

    const [sig] = await collectCandidateSignals(db, [
      {
        refKind: 'question',
        refId: 'q-off-warm',
        role: 'diagnostic',
        kind: 'short_answer',
        knowledgeIds: ['kc-off-warm'],
        difficulty: 3,
      },
    ]);

    expect(sig.mfiScore).toBe(mfiScore(0.2, 0.5));
    expect(sig.scoreKind).toBe('mfi');
  });

  it('flag ON: cold-start KC (evidence_count < EARLY_KLP_N) scored by KLP, scoreKind=klp', async () => {
    earlyKlpFlag.value = true;
    // evidence_count=2 < 4 → cold-start regime → KLP. precision=0.5 (wide SE) so KLP
    // is observably DIFFERENT from point MFI (not a degenerate SE→0 coincidence).
    await seedMasteryWithEvidence('kc-on-cold', 0.3, 0.5, 2);
    await seedCalibration('q-on-cold', 0.85);

    const [sig] = await collectCandidateSignals(db, [
      {
        refKind: 'question',
        refId: 'q-on-cold',
        role: 'diagnostic',
        kind: 'short_answer',
        knowledgeIds: ['kc-on-cold'],
        difficulty: 3,
      },
    ]);

    expect(sig.scoreKind).toBe('klp');
    // The collected score field carries the KLP value (posterior-weighted), not point MFI.
    expect(sig.mfiScore).toBeCloseTo(klpScore(0.3, 0.85, 0.5), 12);
    expect(sig.mfiScore).not.toBeCloseTo(mfiScore(0.3, 0.85), 6);
  });

  it('flag ON: warm KC (evidence_count ≥ EARLY_KLP_N) falls back to point MFI, scoreKind=mfi', async () => {
    earlyKlpFlag.value = true;
    await seedMasteryWithEvidence('kc-on-warm', 0.3, 0.5, 4); // evidence_count=4 == N → warm
    await seedCalibration('q-on-warm', 0.85);

    const [sig] = await collectCandidateSignals(db, [
      {
        refKind: 'question',
        refId: 'q-on-warm',
        role: 'diagnostic',
        kind: 'short_answer',
        knowledgeIds: ['kc-on-warm'],
        difficulty: 3,
      },
    ]);

    expect(sig.scoreKind).toBe('mfi');
    expect(sig.mfiScore).toBe(mfiScore(0.3, 0.85)); // bitwise point MFI past the regime
  });

  it('flag ON: cold-start gate uses the WEAKEST KC evidence_count (the θ̂_min KC)', async () => {
    earlyKlpFlag.value = true;
    // weakest KC (θ̂=-0.5) is cold (evidence_count=1 < 4); the stronger KC is warm.
    // The gate must follow the SAME KC whose θ̂/precision is used for scoring (weakest).
    await seedMasteryWithEvidence('kc-weak-cold', -0.5, 0.5, 1);
    await seedMasteryWithEvidence('kc-strong-warm', 1.2, 8, 20);
    await seedCalibration('q-mixed-gate', 0.2);

    const [sig] = await collectCandidateSignals(db, [
      {
        refKind: 'question',
        refId: 'q-mixed-gate',
        role: 'diagnostic',
        kind: 'short_answer',
        knowledgeIds: ['kc-weak-cold', 'kc-strong-warm'],
        difficulty: 3,
      },
    ]);

    // weakest θ̂=-0.5, its precision=0.5, its evidence_count=1 → cold → KLP on the weak KC.
    expect(sig.thetaHat).toBeCloseTo(-0.5, 10);
    expect(sig.scoreKind).toBe('klp');
    expect(sig.mfiScore).toBeCloseTo(klpScore(-0.5, 0.2, 0.5), 12);
  });

  it('flag ON: cold-start KC with no mastery_state row (evidence_count=0) → KLP', async () => {
    earlyKlpFlag.value = true;
    // No seedMastery: cold-start defaults θ̂=0, precision=1, and evidence_count must
    // default to 0 (< 4) → cold regime → KLP.
    await seedCalibration('q-never-seen', 0.85);

    const [sig] = await collectCandidateSignals(db, [
      {
        refKind: 'question',
        refId: 'q-never-seen',
        role: 'new_check',
        kind: 'short_answer',
        knowledgeIds: ['kc-never-seen-klp'],
        difficulty: 3,
      },
    ]);

    expect(sig.thetaHat).toBe(0);
    expect(sig.thetaPrecision).toBe(1);
    expect(sig.scoreKind).toBe('klp');
    expect(sig.mfiScore).toBeCloseTo(klpScore(0, 0.85, 1), 12);
  });

  it('flag ON: recall-locked KC still gets NO score and NO scoreKind (KLP never reached)', async () => {
    earlyKlpFlag.value = true;
    await seedMasteryWithEvidence('kc-recall-klp', -0.3, 0.5, 1); // cold
    await seedCalibration('q-recall-klp', 0.4);

    const [sig] = await collectCandidateSignals(db, [
      {
        refKind: 'question',
        refId: 'q-recall-klp',
        role: 'diagnostic',
        kind: 'fill_blank', // recall-locked → no MFI/KLP scoring at all
        knowledgeIds: ['kc-recall-klp'],
        difficulty: 3,
      },
    ]);

    expect(sig.recallLocked).toBe(true);
    expect(sig.mfiScore).toBeUndefined();
    expect(sig.diagnosticScore).toBeUndefined();
    expect(sig.scoreKind).toBeUndefined();
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

// YUK-372 L3 — family b_delta composition (effectiveFamilyB) in the selection signal layer.
describe('collectCandidateSignals — family b_delta composition (YUK-372 L3)', () => {
  it('gate-passed family (b_delta≠0) shifts b by the delta and moves mfiScore', async () => {
    const kid = 'kc-fam';
    await seedKnowledge(kid, 'wenyan');
    await seedMastery(kid, 0.0, 4);
    await seedCalibration('q-fam', 0.85); // columnar b = 0.85
    // family_key = `${subject=wenyan}:${kid}:${kind=short_answer}:${source=manual}`.
    const familyKey = `wenyan:${kid}:short_answer:manual`;
    const bDelta = 0.5;
    await seedFamilyCalibration(familyKey, bDelta);

    const [sig] = await collectCandidateSignals(db, [
      {
        refKind: 'question',
        refId: 'q-fam',
        role: 'diagnostic',
        kind: 'short_answer',
        knowledgeIds: [kid],
        difficulty: 3,
        source: 'manual',
      },
    ]);

    // effectiveFamilyB(0.85, {b_delta:0.5}) = 1.35.
    expect(sig.b).toBeCloseTo(0.85 + bDelta, 10);
    expect(sig.bSource).toBe('item_calibration');
    // mfiScore reflects the shifted b (θ̂=0, b=1.35), NOT the un-shifted 0.85.
    expect(sig.mfiScore).toBeCloseTo(mfiScore(0.0, 0.85 + bDelta), 10);
    expect(sig.mfiScore).not.toBeCloseTo(mfiScore(0.0, 0.85), 6);
  });

  it('NO-OP regression: no family row → b + mfiScore bit-identical to no-source baseline', async () => {
    const kid = 'kc-noop';
    await seedKnowledge(kid, 'wenyan');
    await seedMastery(kid, 0.0, 4);
    await seedCalibration('q-noop', 0.85);
    // NO item_family_calibration row for this family.

    const withSource = await collectCandidateSignals(db, [
      {
        refKind: 'question',
        refId: 'q-noop',
        role: 'diagnostic',
        kind: 'short_answer',
        knowledgeIds: [kid],
        difficulty: 3,
        source: 'manual', // family lookup runs but finds no row → b_delta absent → NO-OP.
      },
    ]);
    const noSource = await collectCandidateSignals(db, [
      {
        refKind: 'question',
        refId: 'q-noop',
        role: 'diagnostic',
        kind: 'short_answer',
        knowledgeIds: [kid],
        difficulty: 3,
        // no source → family lookup skipped entirely.
      },
    ]);

    // Bit-identical: missing family row composes to the columnar b unchanged.
    expect(withSource[0].b).toBe(noSource[0].b);
    expect(withSource[0].mfiScore).toBe(noSource[0].mfiScore);
    expect(withSource[0].b).toBeCloseTo(0.85, 10);
  });

  it('subject derivation: orphan/unknown-domain KC → "unknown" segment (not the default profile)', async () => {
    // KC has NO knowledge row at all (orphan) → getEffectiveDomain throws → 'unknown' segment.
    const kid = 'kc-orphan';
    await seedMastery(kid, 0.0, 4);
    await seedCalibration('q-orphan', 0.85);
    // family_key uses 'unknown' subject → seed the family row under that key.
    const familyKey = `unknown:${kid}:short_answer:manual`;
    await seedFamilyCalibration(familyKey, 0.4);

    const [sig] = await collectCandidateSignals(db, [
      {
        refKind: 'question',
        refId: 'q-orphan',
        role: 'diagnostic',
        kind: 'short_answer',
        knowledgeIds: [kid],
        difficulty: 3,
        source: 'manual',
      },
    ]);

    // The 'unknown'-keyed family delta applied → proves orphan resolves to 'unknown', not 'wenyan'.
    expect(sig.b).toBeCloseTo(0.85 + 0.4, 10);
  });

  it('batch preserves input order with family-keyed candidates + source-missing falls back to pure effectiveB', async () => {
    const kid = 'kc-mix';
    await seedKnowledge(kid, 'wenyan');
    await seedMastery(kid, 0.0, 4);
    await seedCalibration('q-fam2', 0.85);
    await seedCalibration('q-plain', 0.85);
    await seedFamilyCalibration(`wenyan:${kid}:short_answer:manual`, 0.5);

    const sigs = await collectCandidateSignals(db, [
      {
        refKind: 'question',
        refId: 'q-fam2',
        role: 'diagnostic',
        kind: 'short_answer',
        knowledgeIds: [kid],
        difficulty: 3,
        source: 'manual', // family-keyed → delta applies.
      },
      { refKind: 'paper', refId: 'p-mix', role: 'paper' },
      {
        refKind: 'question',
        refId: 'q-plain',
        role: 'diagnostic',
        kind: 'short_answer',
        knowledgeIds: [kid],
        difficulty: 3,
        // no source → pure effectiveB, no delta.
      },
    ]);

    expect(sigs.map((s) => s.refId)).toEqual(['q-fam2', 'p-mix', 'q-plain']);
    expect(sigs[0].b).toBeCloseTo(0.85 + 0.5, 10); // family delta applied.
    expect(sigs[2].b).toBeCloseTo(0.85, 10); // no delta (source missing).
  });
});
