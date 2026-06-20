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

// P2 D2 / A8 — MISCONCEPTION_RECURRENCE_ENABLED is a module-level const in
// ./selection-constants. Its REAL default is false (dark-ship). We mock just this one
// export (EARLY_KLP pattern) so both flag directions stay covered regardless of the default:
//   - flag OFF (early/recurrence flag false, restored in beforeEach) → undefined for all
//     (byte-identical orchestrator/mfi path).
//   - flag ON (set true per-test) → the aggregate is computed.
const recurrenceFlag = { value: false };
vi.mock('@/capabilities/practice/server/selection-constants', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/capabilities/practice/server/selection-constants')>();
  return {
    ...actual,
    get MISCONCEPTION_RECURRENCE_ENABLED() {
      return recurrenceFlag.value;
    },
  };
});

// A4 inc-2 (YUK-436) — THETA_GRID_ENABLED is a module-level const in @/core/theta-grid
// (real default false, dark-ship). Same getter-mock pattern: control the flag explicitly
// so both directions stay covered; every other theta-grid export (klpScoreFromGrid,
// gridUpdate, uniformPrior, …) stays REAL via importOriginal.
const gridFlag = { value: false };
vi.mock('@/core/theta-grid', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/core/theta-grid')>();
  return {
    ...actual,
    get THETA_GRID_ENABLED() {
      return gridFlag.value;
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
import {
  type ThetaGridPosterior,
  gridUpdate,
  klpScoreFromGrid,
  uniformPrior,
} from '@/core/theta-grid';
import {
  item_calibration,
  item_family_calibration,
  knowledge,
  mastery_state,
  mistake_variant,
  question,
} from '@/db/schema';
import { eq } from 'drizzle-orm';
import { resetDb, testDb } from '../../../../tests/helpers/db';

const db = testDb();

beforeEach(() => {
  earlyKlpFlag.value = false; // restore dark-ship default before every test
  recurrenceFlag.value = false; // restore misconceptionRecurrence dark-ship default
  gridFlag.value = false; // restore THETA_GRID dark-ship default (A4 inc-2)
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

// P2 D2 / A8 — seed a question row carrying the given KCs (the misconceptionRecurrence
// KC-based linkage walks question.knowledge_ids @> [kc] to find probed questions).
async function seedQuestion(id: string, knowledgeIds: string[]): Promise<void> {
  const now = new Date();
  await db.insert(question).values({
    id,
    kind: 'short_answer',
    prompt_md: `prompt-${id}`,
    knowledge_ids: knowledgeIds,
    difficulty: 3,
    source: 'manual',
    draft_status: 'active',
    created_at: now,
    updated_at: now,
    version: 0,
  });
}

// P2 D2 / A8 — seed one mistake_variant row = one of THIS learner's recurrences of
// `causeCategory` on a mistake whose parent question is `parentQuestionId`.
//
// `status` defaults to 'active' (the confirmed-accepted mistake — the only status that
// counts toward misconceptionRecurrence). Pass 'draft' (pending acceptance), 'broken'
// (failed verify pass-2), or 'dismissed' (user-rejected false-positive cause) to seed a
// row that carries a cause_category but must NOT count (these all keep their cause_category
// after the status flip — see proposals/actions.ts dismiss + variant_verify.ts broken).
type MistakeVariantStatus = 'draft' | 'active' | 'broken' | 'dismissed';
async function seedMistake(
  parentQuestionId: string,
  causeCategory: string | null,
  status: MistakeVariantStatus = 'active',
): Promise<void> {
  const now = new Date();
  await db.insert(mistake_variant).values({
    id: newId(),
    parent_question_id: parentQuestionId,
    variant_question_id: null,
    proposal_event_id: null,
    status,
    failure_reasons: [],
    cause_category: causeCategory,
    created_at: now,
    updated_at: now,
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

// P2 D2 / A8 — misconceptionRecurrence (per-KC cause-family recurrence, soft, flag-gated).
//   Linkage (KC-based): candidate KC set K → questions with knowledge_ids @> [kc∈K] →
//   mistake_variant on parent_question_id, GROUP BY cause_category, MAX count → normalized
//   to 0-1 by owner-fixed RECURRENCE_NORM (=5). SELECTION-ONLY; NEVER zero-fill.
describe('collectCandidateSignals — misconceptionRecurrence (P2 D2 / A8)', () => {
  it('(1) flag ON: recurring cause_category on a candidate KC → finite 0-1 value rising with recurrence count', async () => {
    recurrenceFlag.value = true;
    await seedMastery('kc-mr', 0.0, 4);
    await seedCalibration('q-mr', 0.5);
    // A sibling question shares the candidate's KC and carries this learner's mistakes.
    await seedQuestion('q-sibling', ['kc-mr']);

    const candidate: CandidateInput = {
      refKind: 'question',
      refId: 'q-mr',
      role: 'diagnostic',
      kind: 'short_answer',
      knowledgeIds: ['kc-mr'],
      difficulty: 3,
    };

    // 2 recurrences of cause 'misread' on a KC-sibling question.
    await seedMistake('q-sibling', 'misread');
    await seedMistake('q-sibling', 'misread');
    const [twoRec] = await collectCandidateSignals(db, [candidate]);
    expect(twoRec.misconceptionRecurrence).toBeGreaterThan(0);
    expect(twoRec.misconceptionRecurrence).toBeLessThanOrEqual(1);
    expect(twoRec.misconceptionRecurrence).toBeCloseTo(2 / 5, 10); // 2 / RECURRENCE_NORM

    // Add 2 more recurrences of the SAME cause → the signal must RISE.
    await seedMistake('q-sibling', 'misread');
    await seedMistake('q-sibling', 'misread');
    const [fourRec] = await collectCandidateSignals(db, [candidate]);
    expect(fourRec.misconceptionRecurrence).toBeCloseTo(4 / 5, 10);
    expect(fourRec.misconceptionRecurrence as number).toBeGreaterThan(
      twoRec.misconceptionRecurrence as number,
    );
  });

  it('(1b) flag ON: saturates at 1.0 once recurrences reach the owner-fixed norm', async () => {
    recurrenceFlag.value = true;
    await seedMastery('kc-sat', 0.0, 4);
    await seedCalibration('q-sat', 0.5);
    await seedQuestion('q-sat-sib', ['kc-sat']);
    // 7 recurrences > RECURRENCE_NORM(5) → clamps to 1.0 (never exceeds 1).
    for (let i = 0; i < 7; i++) await seedMistake('q-sat-sib', 'overgeneralize');

    const [sig] = await collectCandidateSignals(db, [
      {
        refKind: 'question',
        refId: 'q-sat',
        role: 'diagnostic',
        kind: 'short_answer',
        knowledgeIds: ['kc-sat'],
        difficulty: 3,
      },
    ]);
    expect(sig.misconceptionRecurrence).toBe(1);
  });

  it('(1c) flag ON: the candidates OWN question mistakes also count (parent_question_id = candidate, shared KC)', async () => {
    recurrenceFlag.value = true;
    await seedMastery('kc-self', 0.0, 4);
    await seedCalibration('q-self', 0.5);
    // The candidate question itself carries the KC and is the parent of mistakes.
    await seedQuestion('q-self', ['kc-self']);
    await seedMistake('q-self', 'sign_error');
    await seedMistake('q-self', 'sign_error');
    await seedMistake('q-self', 'sign_error');

    const [sig] = await collectCandidateSignals(db, [
      {
        refKind: 'question',
        refId: 'q-self',
        role: 'diagnostic',
        kind: 'short_answer',
        knowledgeIds: ['kc-self'],
        difficulty: 3,
      },
    ]);
    expect(sig.misconceptionRecurrence).toBeCloseTo(3 / 5, 10);
  });

  it('(1d) flag ON: MAX across cause families (the most-recurring misconception), not the sum', async () => {
    recurrenceFlag.value = true;
    await seedMastery('kc-max', 0.0, 4);
    await seedCalibration('q-max', 0.5);
    await seedQuestion('q-max-sib', ['kc-max']);
    // cause A: 1 recurrence; cause B: 3 recurrences. MAX=3, NOT sum=4.
    await seedMistake('q-max-sib', 'cause_a');
    await seedMistake('q-max-sib', 'cause_b');
    await seedMistake('q-max-sib', 'cause_b');
    await seedMistake('q-max-sib', 'cause_b');

    const [sig] = await collectCandidateSignals(db, [
      {
        refKind: 'question',
        refId: 'q-max',
        role: 'diagnostic',
        kind: 'short_answer',
        knowledgeIds: ['kc-max'],
        difficulty: 3,
      },
    ]);
    expect(sig.misconceptionRecurrence).toBeCloseTo(3 / 5, 10); // MAX(1,3)/5, not 4/5.
  });

  it('(2) flag ON: NO cause data on the candidate KCs → undefined (NOT 0)', async () => {
    recurrenceFlag.value = true;
    await seedMastery('kc-nodata', 0.0, 4);
    await seedCalibration('q-nodata', 0.5);
    // A question on the KC exists but has NO mistakes; and a mistake exists on an
    // UNRELATED KC's question (must NOT leak in).
    await seedQuestion('q-nodata-sib', ['kc-nodata']);
    await seedQuestion('q-other', ['kc-unrelated']);
    await seedMistake('q-other', 'misread'); // different KC → excluded.

    const [sig] = await collectCandidateSignals(db, [
      {
        refKind: 'question',
        refId: 'q-nodata',
        role: 'diagnostic',
        kind: 'short_answer',
        knowledgeIds: ['kc-nodata'],
        difficulty: 3,
      },
    ]);
    // undefined = "no data" — distinct from a measured 0 (the NEVER-zero-fill contract).
    expect(sig.misconceptionRecurrence).toBeUndefined();
    expect(sig.misconceptionRecurrence).not.toBe(0);
  });

  it('(2b) flag ON: mistakes with NULL cause_category do not count (undefined, not 0)', async () => {
    recurrenceFlag.value = true;
    await seedMastery('kc-null', 0.0, 4);
    await seedCalibration('q-null', 0.5);
    await seedQuestion('q-null-sib', ['kc-null']);
    await seedMistake('q-null-sib', null); // no cause attributed → not a cause recurrence.

    const [sig] = await collectCandidateSignals(db, [
      {
        refKind: 'question',
        refId: 'q-null',
        role: 'diagnostic',
        kind: 'short_answer',
        knowledgeIds: ['kc-null'],
        difficulty: 3,
      },
    ]);
    expect(sig.misconceptionRecurrence).toBeUndefined();
  });

  it('(2d) flag ON: only confirmed (status=active) rows count — draft/dismissed/broken excluded', async () => {
    recurrenceFlag.value = true;
    await seedMastery('kc-status', 0.0, 4);
    await seedCalibration('q-status', 0.5);
    await seedQuestion('q-status-sib', ['kc-status']);
    // Same cause family across mixed statuses. Each non-active status carries a non-null
    // cause_category (that is exactly how the rows look in prod: variant_gen seeds the
    // cause at INSERT while status='draft'; dismiss/broken flip status without clearing
    // cause_category). Only the 2 active rows are confirmed-accepted recurrences.
    await seedMistake('q-status-sib', 'misread', 'active');
    await seedMistake('q-status-sib', 'misread', 'active');
    await seedMistake('q-status-sib', 'misread', 'draft'); // pending → must NOT count
    await seedMistake('q-status-sib', 'misread', 'dismissed'); // rejected → must NOT count
    await seedMistake('q-status-sib', 'misread', 'broken'); // failed verify → must NOT count

    const [sig] = await collectCandidateSignals(db, [
      {
        refKind: 'question',
        refId: 'q-status',
        role: 'diagnostic',
        kind: 'short_answer',
        knowledgeIds: ['kc-status'],
        difficulty: 3,
      },
    ]);
    // Only the 2 active rows count: 2/5, NOT 5/5 (which would double-count the
    // pending/rejected/broken rows and inflate the misconception signal).
    expect(sig.misconceptionRecurrence).toBeCloseTo(2 / 5, 10);
  });

  it('(2e) flag ON: ALL non-active rows (no active) → undefined (no confirmed recurrence)', async () => {
    recurrenceFlag.value = true;
    await seedMastery('kc-allpending', 0.0, 4);
    await seedCalibration('q-allpending', 0.5);
    await seedQuestion('q-allpending-sib', ['kc-allpending']);
    // Every row is draft/dismissed/broken — none is a confirmed-accepted mistake.
    await seedMistake('q-allpending-sib', 'misread', 'draft');
    await seedMistake('q-allpending-sib', 'misread', 'dismissed');
    await seedMistake('q-allpending-sib', 'misread', 'broken');

    const [sig] = await collectCandidateSignals(db, [
      {
        refKind: 'question',
        refId: 'q-allpending',
        role: 'diagnostic',
        kind: 'short_answer',
        knowledgeIds: ['kc-allpending'],
        difficulty: 3,
      },
    ]);
    // No confirmed rows → undefined (NOT 0, the NEVER-zero-fill contract).
    expect(sig.misconceptionRecurrence).toBeUndefined();
    expect(sig.misconceptionRecurrence).not.toBe(0);
  });

  it('(2c) flag ON: candidate with NO KCs → undefined (no KC anchor → no linkage)', async () => {
    recurrenceFlag.value = true;
    await seedCalibration('q-nokc', 0.5);
    const [sig] = await collectCandidateSignals(db, [
      {
        refKind: 'question',
        refId: 'q-nokc',
        role: 'diagnostic',
        kind: 'short_answer',
        knowledgeIds: [],
        difficulty: 3,
      },
    ]);
    expect(sig.misconceptionRecurrence).toBeUndefined();
  });

  it('(3) flag OFF (default): undefined regardless of cause data (byte-identical)', async () => {
    // recurrenceFlag.value stays false (beforeEach default). Same seed as the ON test (1).
    await seedMastery('kc-off', 0.0, 4);
    await seedCalibration('q-off', 0.5);
    await seedQuestion('q-off-sib', ['kc-off']);
    await seedMistake('q-off-sib', 'misread');
    await seedMistake('q-off-sib', 'misread');

    const candidate: CandidateInput = {
      refKind: 'question',
      refId: 'q-off',
      role: 'diagnostic',
      kind: 'short_answer',
      knowledgeIds: ['kc-off'],
      difficulty: 3,
    };
    const [sig] = await collectCandidateSignals(db, [candidate]);

    // Flag off → undefined even with recurring cause data present (dark-ship).
    expect(sig.misconceptionRecurrence).toBeUndefined();
    // And the mfiScore/diagnosticScore path is unaffected by the new signal (byte-identical).
    expect(sig.mfiScore).toBe(mfiScore(0.0, 0.5));
    expect(sig.scoreKind).toBe('mfi');
  });

  it('(3b) flag OFF: mfiScore/diagnosticScore are byte-identical with vs without cause data present', async () => {
    // Two identical candidates; one has recurring cause data on its KC, one does not.
    // With the flag off, their scoring fields must be bit-identical (signal is inert).
    await seedMastery('kc-iso', 0.0, 4);
    await seedCalibration('q-iso', 0.5);
    await seedQuestion('q-iso-sib', ['kc-iso']);
    await seedMistake('q-iso-sib', 'misread');
    await seedMistake('q-iso-sib', 'misread');

    const [withData] = await collectCandidateSignals(db, [
      {
        refKind: 'question',
        refId: 'q-iso',
        role: 'diagnostic',
        kind: 'short_answer',
        knowledgeIds: ['kc-iso'],
        difficulty: 3,
      },
    ]);
    expect(withData.mfiScore).toBe(mfiScore(0.0, 0.5));
    expect(withData.diagnosticScore).toBeGreaterThan(0); // diagnostic = MFI × uncertainty penalty
    expect(withData.misconceptionRecurrence).toBeUndefined();
  });

  it('(4) red line: misconceptionRecurrence is selection-only — the θ̂/p(L) update does not read it', async () => {
    // updateThetaForAttempt's input shape (UpdateThetaForAttemptInput) has NO field that
    // could carry misconceptionRecurrence; the value lives only on CollectedSignal in the
    // selection path. This test pins the structural separation: computing the selection
    // signal (flag ON) does not mutate any mastery_state row (θ̂/precision/evidence_count).
    recurrenceFlag.value = true;
    await seedMastery('kc-redline', 0.42, 7);
    await seedCalibration('q-redline', 0.5);
    await seedQuestion('q-redline-sib', ['kc-redline']);
    await seedMistake('q-redline-sib', 'misread');
    await seedMistake('q-redline-sib', 'misread');

    const before = await db
      .select()
      .from(mastery_state)
      .where(eq(mastery_state.subject_id, 'kc-redline'));

    const [sig] = await collectCandidateSignals(db, [
      {
        refKind: 'question',
        refId: 'q-redline',
        role: 'diagnostic',
        kind: 'short_answer',
        knowledgeIds: ['kc-redline'],
        difficulty: 3,
      },
    ]);
    // The selection signal IS produced (proves the read happened) ...
    expect(sig.misconceptionRecurrence).toBeCloseTo(2 / 5, 10);

    const after = await db
      .select()
      .from(mastery_state)
      .where(eq(mastery_state.subject_id, 'kc-redline'));

    // ... but the θ̂ / precision / evidence_count state is UNTOUCHED by the selection read
    // (collectCandidateSignals is pure-read; misconceptionRecurrence never feeds the θ path).
    expect(after[0].theta_hat).toBe(before[0].theta_hat);
    expect(after[0].theta_precision).toBe(before[0].theta_precision);
    expect(after[0].evidence_count).toBe(before[0].evidence_count);
    expect(after[0].theta_hat).toBeCloseTo(0.42, 10);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A4 inc-2 (YUK-436) — grid→KLP 选题接线（flag-gated dark-ship）。
//
// 当某 KC 有网格后验（theta_grid_json）且 THETA_GRID_ENABLED ON 时，候选信息分改用
// klpScoreFromGrid（对实际离散后验加权 Fisher），优先于点 MFI / Gaussian-KLP。flag OFF
// （默认）即便行里已有 shadow 网格也不读 → 选题评分逐位等同今天（bitwise 回归锚）。
// ─────────────────────────────────────────────────────────────────────────────
describe('A4 grid→KLP selection wiring (YUK-436, THETA_GRID_ENABLED)', () => {
  // Seed a mastery_state row carrying an explicit shadow grid posterior + θ̂/precision/evidence.
  async function seedMasteryWithGrid(
    knowledgeId: string,
    thetaHat: number,
    thetaPrecision: number,
    evidenceCount: number,
    grid: ThetaGridPosterior,
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
      theta_grid_json: grid,
      updated_at: now,
    });
  }

  // A non-uniform posterior (a few sequential folds) so its weighted-Fisher differs from
  // both the point MFI at θ̂ and the Gaussian-KLP reconstruction — makes the assertions
  // non-vacuous. θ_global = 0 in these tests (no `knowledge` row → effectiveThetaForKc
  // returns θ_KC, anchor 0).
  function shapedPosterior(): ThetaGridPosterior {
    let p = uniformPrior();
    for (let i = 0; i < 3; i++) p = gridUpdate(p, -1.2, 1); // correct answers at a hard b' shift mass up
    return p;
  }

  it('flag ON: KC with a grid posterior is scored by klpScoreFromGrid, scoreKind=klp_grid', async () => {
    gridFlag.value = true;
    const grid = shapedPosterior();
    await seedMasteryWithGrid('kc-grid-on', 0.3, 0.5, 2, grid);
    await seedCalibration('q-grid-on', 0.85);

    const [sig] = await collectCandidateSignals(db, [
      {
        refKind: 'question',
        refId: 'q-grid-on',
        role: 'diagnostic',
        kind: 'short_answer',
        knowledgeIds: ['kc-grid-on'],
        difficulty: 3,
      },
    ]);

    expect(sig.scoreKind).toBe('klp_grid');
    // Score is the posterior-weighted Fisher over the ACTUAL grid (θ_global=0).
    expect(sig.mfiScore).toBeCloseTo(klpScoreFromGrid(grid, 0.85, 0), 12);
    // Non-vacuous: distinct from BOTH point MFI and the Gaussian-KLP reconstruction.
    expect(sig.mfiScore).not.toBeCloseTo(mfiScore(0.3, 0.85), 6);
    expect(sig.mfiScore).not.toBeCloseTo(klpScore(0.3, 0.85, 0.5), 6);
  });

  it('flag ON: grid posterior takes PRECEDENCE over cold-start Gaussian KLP (both flags on)', async () => {
    gridFlag.value = true;
    earlyKlpFlag.value = true; // cold-start KC would be Gaussian-KLP, but grid wins
    const grid = shapedPosterior();
    await seedMasteryWithGrid('kc-grid-prec', 0.3, 0.5, 1, grid); // evidence 1 < EARLY_KLP_N
    await seedCalibration('q-grid-prec', 0.85);

    const [sig] = await collectCandidateSignals(db, [
      {
        refKind: 'question',
        refId: 'q-grid-prec',
        role: 'diagnostic',
        kind: 'short_answer',
        knowledgeIds: ['kc-grid-prec'],
        difficulty: 3,
      },
    ]);

    expect(sig.scoreKind).toBe('klp_grid');
    expect(sig.mfiScore).toBeCloseTo(klpScoreFromGrid(grid, 0.85, 0), 12);
  });

  it('flag OFF (default): a present grid posterior is IGNORED → point MFI, scoreKind=mfi (bitwise anchor)', async () => {
    // gridFlag stays false (beforeEach). Grid posterior IS in the row, but must not be read.
    const grid = shapedPosterior();
    await seedMasteryWithGrid('kc-grid-off', 0.3, 0.5, 10, grid); // warm → point MFI baseline
    await seedCalibration('q-grid-off', 0.85);

    const [sig] = await collectCandidateSignals(db, [
      {
        refKind: 'question',
        refId: 'q-grid-off',
        role: 'diagnostic',
        kind: 'short_answer',
        knowledgeIds: ['kc-grid-off'],
        difficulty: 3,
      },
    ]);

    expect(sig.scoreKind).toBe('mfi');
    expect(sig.mfiScore).toBe(mfiScore(0.3, 0.85)); // byte-identical to today
    expect(sig.scoreKind).not.toBe('klp_grid');
  });

  it('flag ON but NO grid posterior on the row → falls back to the Gaussian path (scoreKind!=klp_grid)', async () => {
    gridFlag.value = true;
    earlyKlpFlag.value = true;
    // No grid (seedMasteryWithEvidence-equivalent: theta_grid_json null) → grid branch skipped.
    const now = new Date();
    await db.insert(mastery_state).values({
      id: newId(),
      subject_kind: 'knowledge',
      subject_id: 'kc-grid-null',
      theta_hat: 0.3,
      evidence_count: 2,
      success_count: 1,
      fail_count: 0,
      last_outcome_at: now,
      theta_precision: 0.5,
      last_theta_delta: null,
      updated_at: now,
    });
    await seedCalibration('q-grid-null', 0.85);

    const [sig] = await collectCandidateSignals(db, [
      {
        refKind: 'question',
        refId: 'q-grid-null',
        role: 'diagnostic',
        kind: 'short_answer',
        knowledgeIds: ['kc-grid-null'],
        difficulty: 3,
      },
    ]);

    expect(sig.scoreKind).toBe('klp'); // cold-start Gaussian KLP, NOT klp_grid (no grid present)
    expect(sig.mfiScore).toBeCloseTo(klpScore(0.3, 0.85, 0.5), 12);
  });
});
