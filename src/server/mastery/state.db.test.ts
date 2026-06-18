// B1-W1 (ADR-0035) — mastery_state single-owner + θ̂ 接线层 db tests.

import { createId } from '@paralleldrive/cuid2';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { newId } from '@/core/ids';
import { thetaToMastery } from '@/core/theta';
import { db } from '@/db/client';
import {
  item_calibration,
  item_family_calibration,
  knowledge,
  mastery_state,
  question,
} from '@/db/schema';
import { resetDb } from '../../../tests/helpers/db';
import {
  getMasteryProjection,
  getMasteryState,
  updateThetaForAttempt,
  upsertMasteryState,
} from './state';

async function seedKnowledge(id: string) {
  const now = new Date();
  await db
    .insert(knowledge)
    .values({
      id,
      name: `K-${id}`,
      domain: 'wenyan',
      parent_id: null,
      created_at: now,
      updated_at: now,
      version: 0,
    })
    .onConflictDoNothing();
}

async function seedQuestion(id: string, knowledgeIds: string[], difficulty = 3) {
  const now = new Date();
  await db.insert(question).values({
    id,
    kind: 'short_answer',
    prompt_md: `Prompt ${id}`,
    reference_md: null,
    knowledge_ids: knowledgeIds,
    difficulty,
    source: 'manual',
    variant_depth: 0,
    created_at: now,
    updated_at: now,
    version: 0,
  });
}

async function readState(knowledgeId: string) {
  const rows = await db
    .select()
    .from(mastery_state)
    .where(
      and(eq(mastery_state.subject_kind, 'knowledge'), eq(mastery_state.subject_id, knowledgeId)),
    )
    .limit(1);
  return rows[0] ?? null;
}

describe('upsertMasteryState', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('inserts a new row then updates on conflict (subject_kind, subject_id)', async () => {
    const k = createId();
    await seedKnowledge(k);
    const now = new Date();

    await upsertMasteryState(db, {
      subject_id: k,
      theta_hat: 0.5,
      evidence_count: 1,
      success_count: 1,
      fail_count: 0,
      last_outcome_at: now,
    });
    let row = await readState(k);
    expect(row?.theta_hat).toBeCloseTo(0.5, 5);
    expect(row?.evidence_count).toBe(1);

    // Second write overwrites the same (kind, id).
    await upsertMasteryState(db, {
      subject_id: k,
      theta_hat: -0.3,
      evidence_count: 2,
      success_count: 1,
      fail_count: 1,
      last_outcome_at: now,
    });
    const rows = await db.select().from(mastery_state).where(eq(mastery_state.subject_id, k));
    expect(rows).toHaveLength(1); // ON CONFLICT — no duplicate row
    row = rows[0];
    expect(row?.theta_hat).toBeCloseTo(-0.3, 5);
    expect(row?.evidence_count).toBe(2);
    expect(row?.fail_count).toBe(1);
  });
});

describe('getMasteryState', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns null when no row exists (cold start)', async () => {
    expect(await getMasteryState(db, createId())).toBeNull();
  });

  it('returns the row when present', async () => {
    const k = createId();
    await seedKnowledge(k);
    await upsertMasteryState(db, {
      subject_id: k,
      theta_hat: 1.1,
      evidence_count: 3,
      success_count: 2,
      fail_count: 1,
      last_outcome_at: new Date(),
    });
    const state = await getMasteryState(db, k);
    expect(state?.theta_hat).toBeCloseTo(1.1, 5);
    expect(state?.success_count).toBe(2);
  });
});

describe('getMasteryProjection (B1 double-truth fix — read from theta_hat, not the view)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns an empty map for empty input (no query)', async () => {
    expect((await getMasteryProjection(db, [])).size).toBe(0);
  });

  it('projects theta_hat → mastery = σ(θ̂) and derives theta_se from precision', async () => {
    const k = createId();
    await seedKnowledge(k);
    await upsertMasteryState(db, {
      subject_id: k,
      theta_hat: 1.2,
      evidence_count: 5,
      success_count: 4,
      fail_count: 1,
      last_outcome_at: new Date(),
      theta_precision: 4,
    });
    const proj = await getMasteryProjection(db, [k]);
    const row = proj.get(k);
    expect(row).toBeDefined();
    // mastery is the θ̂ projection — NOT the deprecated view's weighted success
    // rate (which here would be ~0.8) nor the <3-evidence 0.5 placeholder.
    expect(row?.mastery).toBeCloseTo(thetaToMastery(1.2), 10);
    expect(row?.theta_hat).toBeCloseTo(1.2, 5);
    // SE = 1/√precision = 1/√4 = 0.5.
    expect(row?.theta_se).toBeCloseTo(0.5, 10);
    expect(row?.success_count).toBe(4);
    expect(row?.fail_count).toBe(1);
  });

  it('cold start: θ̂=0 / precision=1 (DB defaults) → mastery 0.5, theta_se 1', async () => {
    const k = createId();
    await seedKnowledge(k);
    // A row at the DB defaults (e.g. seeded with no movement) — θ̂=0, precision=1.
    await upsertMasteryState(db, {
      subject_id: k,
      theta_hat: 0,
      evidence_count: 0,
      success_count: 0,
      fail_count: 0,
      last_outcome_at: new Date(),
      theta_precision: 1,
    });
    const row = (await getMasteryProjection(db, [k])).get(k);
    expect(row?.mastery).toBeCloseTo(0.5, 10);
    expect(row?.theta_se).toBeCloseTo(1, 10);
  });

  it('omits never-attempted nodes (no row) — absence = cold start, matches the old view NULL', async () => {
    const seeded = createId();
    const unseeded = createId();
    await seedKnowledge(seeded);
    await seedKnowledge(unseeded);
    await upsertMasteryState(db, {
      subject_id: seeded,
      theta_hat: -0.8,
      evidence_count: 2,
      success_count: 0,
      fail_count: 2,
      last_outcome_at: new Date(),
    });
    const proj = await getMasteryProjection(db, [seeded, unseeded]);
    expect(proj.has(seeded)).toBe(true);
    expect(proj.has(unseeded)).toBe(false);
    // A weak node (θ̂ < 0) projects below 0.5 — the deprecated view would have
    // FAKED this as 0.5 because evidence_count < 3.
    expect(proj.get(seeded)?.mastery).toBeLessThan(0.5);
  });

  it('after a real attempt, mastery tracks the moved θ̂ (end-to-end, not the view placeholder)', async () => {
    const k = createId();
    const q = createId();
    await seedKnowledge(k);
    await seedQuestion(q, [k], 3);
    // One correct attempt — θ̂ moves up from 0; evidence_count becomes 1 (< 3),
    // exactly the regime the deprecated view clamped to 0.5.
    await db.transaction(async (tx) => {
      await updateThetaForAttempt(tx, {
        knowledgeIds: [k],
        questionId: q,
        outcome: 1,
        difficulty: 3,
        attemptEventId: newId(),
        now: new Date(),
      });
    });
    const state = await getMasteryState(db, k);
    const row = (await getMasteryProjection(db, [k])).get(k);
    expect(state?.evidence_count).toBe(1);
    expect(row?.theta_hat).toBeCloseTo(state?.theta_hat ?? Number.NaN, 10);
    expect(row?.mastery).toBeCloseTo(thetaToMastery(state?.theta_hat ?? 0), 10);
    // The correct answer pushed θ̂ > 0 → mastery > 0.5, NOT clamped to 0.5.
    expect(row?.mastery).toBeGreaterThan(0.5);
  });
});

describe('updateThetaForAttempt', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('single KC, correct answer: θ̂ rises, counts advance, evidence increments', async () => {
    const k = createId();
    const q = createId();
    await seedKnowledge(k);
    await seedQuestion(q, [k]);

    await db.transaction(async (tx) => {
      await updateThetaForAttempt(tx, {
        knowledgeIds: [k],
        questionId: q,
        outcome: 1,
        difficulty: 3, // → b=0 proxy
        attemptEventId: newId(),
        now: new Date(),
      });
    });

    const row = await readState(k);
    expect(row).not.toBeNull();
    expect(row?.theta_hat).toBeGreaterThan(0); // correct → θ̂ up
    expect(row?.evidence_count).toBe(1);
    expect(row?.success_count).toBe(1);
    expect(row?.fail_count).toBe(0);
  });

  it('single KC, wrong answer: θ̂ falls', async () => {
    const k = createId();
    const q = createId();
    await seedKnowledge(k);
    await seedQuestion(q, [k]);

    await db.transaction(async (tx) => {
      await updateThetaForAttempt(tx, {
        knowledgeIds: [k],
        questionId: q,
        outcome: 0,
        difficulty: 3,
        attemptEventId: newId(),
        now: new Date(),
      });
    });

    const row = await readState(k);
    expect(row?.theta_hat).toBeLessThan(0);
    expect(row?.fail_count).toBe(1);
  });

  it('multi KC, wrong answer: MLE conjunctive credit spares the mastered KC (A), blames the weaker one (B)', async () => {
    // owner 拍板 MLE / review SF-1: conjunctiveCredits uses the conjunctive
    // log-likelihood gradient — wrong credit_k = −(1−p_k)·P_item/(1−P_item). The
    // (1−p_k) sensitivity means the WEAKER KC falls more, the mastered KC is
    // spared. (The old self-authored per-KC-residual formula had a p_k·(1−p_k)
    // pathology where the bell-shape made an already-weak KC barely move — the
    // SF-1 bug this replaces.) A mastered θ=2 / B neutral θ=0.
    const kA = createId(); // mastered (high θ̂)
    const kB = createId(); // neutral (mid θ̂)
    const q = createId();
    await seedKnowledge(kA);
    await seedKnowledge(kB);
    await seedQuestion(q, [kA, kB]);

    // Both past cold start so the K factor is identical (kFloor); the asymmetry
    // is purely creditWeight + each KC's ICC residual.
    await upsertMasteryState(db, {
      subject_id: kA,
      theta_hat: 2,
      evidence_count: 10,
      success_count: 9,
      fail_count: 1,
      last_outcome_at: new Date(),
    });
    await upsertMasteryState(db, {
      subject_id: kB,
      theta_hat: 0,
      evidence_count: 10,
      success_count: 5,
      fail_count: 5,
      last_outcome_at: new Date(),
    });

    await db.transaction(async (tx) => {
      await updateThetaForAttempt(tx, {
        knowledgeIds: [kA, kB],
        questionId: q,
        outcome: 0, // wrong
        difficulty: 3, // b=0
        attemptEventId: newId(),
        now: new Date(),
      });
    });

    const rowA = await readState(kA);
    const rowB = await readState(kB);
    const dropA = 2 - (rowA?.theta_hat ?? 0); // how much A fell (>0)
    const dropB = 0 - (rowB?.theta_hat ?? 0); // how much B fell (>0)
    // Both fell, but the mastered KC (A) is SPARED: its drop is smaller than the
    // neutral KC (B). Without credit-assignment A would fall MORE (its larger ICC
    // residual) — that is exactly the "blame the mastered KC" pathology this avoids.
    expect(dropA).toBeGreaterThan(0);
    expect(dropB).toBeGreaterThan(0);
    expect(dropA).toBeLessThan(dropB);
  });

  it('weak difficulty-proxy anchor: Δθ̂ is ~0.3x the anchored-b update', async () => {
    const kProxy = createId();
    const kAnchored = createId();
    const qProxy = createId();
    const qAnchored = createId();
    await seedKnowledge(kProxy);
    await seedKnowledge(kAnchored);
    await seedQuestion(qProxy, [kProxy], 3); // no calibration row → difficulty proxy
    await seedQuestion(qAnchored, [kAnchored], 3);
    // Anchored question gets an item_calibration.b = 0 (same as difficulty=3 proxy
    // logit) so the ONLY difference is the proxy down-weight.
    await db.insert(item_calibration).values({
      id: newId(),
      question_id: qAnchored,
      b: 0,
      confidence: 0.9,
      track: 'hard',
      source: 'llm_prior',
      created_at: new Date(),
      updated_at: new Date(),
    });

    await db.transaction(async (tx) => {
      await updateThetaForAttempt(tx, {
        knowledgeIds: [kProxy],
        questionId: qProxy,
        outcome: 1,
        difficulty: 3,
        attemptEventId: newId(),
        now: new Date(),
      });
      await updateThetaForAttempt(tx, {
        knowledgeIds: [kAnchored],
        questionId: qAnchored,
        outcome: 1,
        difficulty: 3,
        attemptEventId: newId(),
        now: new Date(),
      });
    });

    const proxyTheta = (await readState(kProxy))?.theta_hat ?? 0;
    const anchoredTheta = (await readState(kAnchored))?.theta_hat ?? 0;
    expect(proxyTheta).toBeGreaterThan(0);
    expect(anchoredTheta).toBeGreaterThan(0);
    // Proxy Δ ≈ 0.3 * anchored Δ (DIFFICULTY_PROXY_WEIGHT).
    expect(proxyTheta).toBeCloseTo(anchoredTheta * 0.3, 5);
  });

  it('cold start uses the larger kCold step (evidence < 4)', async () => {
    const kCold = createId();
    const kWarm = createId();
    const qCold = createId();
    const qWarm = createId();
    await seedKnowledge(kCold);
    await seedKnowledge(kWarm);
    await seedQuestion(qCold, [kCold], 3);
    await seedQuestion(qWarm, [kWarm], 3);
    // Warm KC already past cold start.
    await upsertMasteryState(db, {
      subject_id: kWarm,
      theta_hat: 0,
      evidence_count: 10,
      success_count: 5,
      fail_count: 5,
      last_outcome_at: new Date(),
    });

    await db.transaction(async (tx) => {
      await updateThetaForAttempt(tx, {
        knowledgeIds: [kCold],
        questionId: qCold,
        outcome: 1,
        difficulty: 3,
        attemptEventId: newId(),
        now: new Date(),
      });
      await updateThetaForAttempt(tx, {
        knowledgeIds: [kWarm],
        questionId: qWarm,
        outcome: 1,
        difficulty: 3,
        attemptEventId: newId(),
        now: new Date(),
      });
    });

    const coldTheta = (await readState(kCold))?.theta_hat ?? 0;
    const warmTheta = (await readState(kWarm))?.theta_hat ?? 0;
    // Both started at θ=0, b=0 (difficulty=3 proxy → bWeight=0.3), outcome=1 →
    // Δ = k * 0.3 * 0.5. Cold k=0.4 → 0.06; warm k=0.12 → 0.018. The cold step
    // is strictly larger (the point of the cold-start segment).
    expect(coldTheta).toBeGreaterThan(warmTheta);
    expect(coldTheta).toBeCloseTo(0.06, 5);
    expect(warmTheta).toBeCloseTo(0.018, 5);
  });

  it('no-op when knowledgeIds is empty (unlabeled question)', async () => {
    const q = createId();
    await seedQuestion(q, []);
    await db.transaction(async (tx) => {
      await updateThetaForAttempt(tx, {
        knowledgeIds: [],
        questionId: q,
        outcome: 1,
        difficulty: 3,
        attemptEventId: newId(),
        now: new Date(),
      });
    });
    const rows = await db.select().from(mastery_state);
    expect(rows).toHaveLength(0);
  });

  // ── YUK-361 Phase 2 — θ precision 持久化（Urnings-Lite 不确定性） ──────────────
  it('persists theta_precision > 1 and last_theta_delta ≈ this attempt’s Δθ̂', async () => {
    const k = createId();
    const q = createId();
    await seedKnowledge(k);
    await seedQuestion(q, [k]);

    await db.transaction(async (tx) => {
      await updateThetaForAttempt(tx, {
        knowledgeIds: [k],
        questionId: q,
        outcome: 1,
        difficulty: 3, // → b=0 proxy
        attemptEventId: newId(),
        now: new Date(),
      });
    });

    const row = await readState(k);
    // Cold-start precision = 1; one attempt adds weight²·p(1−p) > 0 → strictly > 1.
    expect(row?.theta_precision).toBeGreaterThan(1);
    // Cold start θ_before = 0, so the persisted delta equals the new theta_hat.
    expect(row?.last_theta_delta).toBeCloseTo(row?.theta_hat ?? Number.NaN, 5);
  });

  it('anchored (item_calibration.b) question gains MORE precision than a difficulty-proxy question', async () => {
    // The proxy anchor down-weights the update with bWeight = 0.3, and precision
    // accumulates Fisher info scaled by weight² (= 0.09). The anchored question uses
    // bWeight = 1. With both at θ=0, b=0 (p=0.5 → I=0.25), the anchored precision
    // increment is 1·0.25 = 0.25 while the proxy is 0.09·0.25 = 0.0225 — so the
    // anchored question's precision increment is strictly the larger of the two.
    const kProxy = createId();
    const kAnchored = createId();
    const qProxy = createId();
    const qAnchored = createId();
    await seedKnowledge(kProxy);
    await seedKnowledge(kAnchored);
    await seedQuestion(qProxy, [kProxy], 3); // no calibration row → difficulty proxy
    await seedQuestion(qAnchored, [kAnchored], 3);
    // Anchored question gets item_calibration.b = 0 (same logit as difficulty=3 proxy)
    // so the ONLY difference driving the precision gap is the proxy bWeight.
    await db.insert(item_calibration).values({
      id: newId(),
      question_id: qAnchored,
      b: 0,
      confidence: 0.9,
      track: 'hard',
      source: 'llm_prior',
      created_at: new Date(),
      updated_at: new Date(),
    });

    await db.transaction(async (tx) => {
      await updateThetaForAttempt(tx, {
        knowledgeIds: [kProxy],
        questionId: qProxy,
        outcome: 1,
        difficulty: 3,
        attemptEventId: newId(),
        now: new Date(),
      });
      await updateThetaForAttempt(tx, {
        knowledgeIds: [kAnchored],
        questionId: qAnchored,
        outcome: 1,
        difficulty: 3,
        attemptEventId: newId(),
        now: new Date(),
      });
    });

    const proxyPrecision = (await readState(kProxy))?.theta_precision ?? 1;
    const anchoredPrecision = (await readState(kAnchored))?.theta_precision ?? 1;
    const proxyIncrement = proxyPrecision - 1; // cold-start base = 1
    const anchoredIncrement = anchoredPrecision - 1;
    expect(proxyIncrement).toBeGreaterThan(0);
    expect(anchoredIncrement).toBeGreaterThan(proxyIncrement);
    // Exact Fisher math: anchored 1²·0.25 = 0.25, proxy 0.3²·0.25 = 0.0225.
    expect(anchoredIncrement).toBeCloseTo(0.25, 5);
    expect(proxyIncrement).toBeCloseTo(0.09 * 0.25, 5);
  });
});

// YUK-372 L3 — family b_delta composition (effectiveFamilyB) in the θ̂ anchor.
describe('updateThetaForAttempt — family b_delta composition (YUK-372 L3)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  async function seedItemCalibration(questionId: string, b: number) {
    await db.insert(item_calibration).values({
      id: newId(),
      question_id: questionId,
      b,
      b_anchor: b,
      confidence: 0.5,
      track: 'hard',
      source: 'llm_prior',
    });
  }

  async function seedFamily(familyKey: string, bDelta: number) {
    await db.insert(item_family_calibration).values({
      id: newId(),
      family_key: familyKey,
      b_delta: bDelta,
      evidence_count: 30,
      calibrated_n: 30,
      confidence: 0.6,
    });
  }

  // Run a single correct attempt and return the resulting θ̂ for the KC.
  async function runAttemptTheta(opts: {
    kid: string;
    qid: string;
    kind?: string;
    source?: string;
  }): Promise<number> {
    await db.transaction(async (tx) => {
      await updateThetaForAttempt(tx, {
        knowledgeIds: [opts.kid],
        questionId: opts.qid,
        outcome: 1,
        difficulty: 3,
        attemptEventId: newId(),
        now: new Date(),
        kind: opts.kind,
        source: opts.source,
      });
    });
    return (await readState(opts.kid))?.theta_hat ?? 0;
  }

  it('gate-passed family delta shifts the b anchor → θ̂ differs from the un-shifted anchor', async () => {
    // Baseline: same columnar b, NO family delta (no kind/source → family lookup skipped).
    const kBase = createId();
    const qBase = createId();
    await seedKnowledge(kBase);
    await seedQuestion(qBase, [kBase]);
    await seedItemCalibration(qBase, 0.0);
    const baseTheta = await runAttemptTheta({ kid: kBase, qid: qBase });

    // Family-shifted: same columnar b=0.0, but a gate-passed family delta of +1.0 → b=1.0.
    const kFam = createId();
    const qFam = createId();
    await seedKnowledge(kFam);
    await seedQuestion(qFam, [kFam]);
    await seedItemCalibration(qFam, 0.0);
    await seedFamily(`wenyan:${kFam}:short_answer:manual`, 1.0);
    const famTheta = await runAttemptTheta({
      kid: kFam,
      qid: qFam,
      kind: 'short_answer',
      source: 'manual',
    });

    // A harder effective b (b=1.0 vs 0.0) on a correct answer yields a larger θ̂ gain (more
    // surprise). The two θ̂ MUST differ — proving the family delta entered the anchor.
    expect(famTheta).not.toBeCloseTo(baseTheta, 6);
    expect(famTheta).toBeGreaterThan(baseTheta);
  });

  it('NO-OP bit-identical: kind/source present but NO family row → θ̂ identical to no-kind/source', async () => {
    // With family row absent, passing kind/source must produce the exact same θ̂ as omitting them.
    const kA = createId();
    const qA = createId();
    await seedKnowledge(kA);
    await seedQuestion(qA, [kA]);
    await seedItemCalibration(qA, 0.4);
    const withKindSource = await runAttemptTheta({
      kid: kA,
      qid: qA,
      kind: 'short_answer',
      source: 'manual', // family lookup runs but finds no row → b_delta absent → NO-OP.
    });

    const kB = createId();
    const qB = createId();
    await seedKnowledge(kB);
    await seedQuestion(qB, [kB]);
    await seedItemCalibration(qB, 0.4);
    const withoutKindSource = await runAttemptTheta({ kid: kB, qid: qB });

    // Bit-identical θ̂ (same b=0.4, same cold-start state, same outcome).
    expect(withKindSource).toBe(withoutKindSource);
  });

  // Codex review F2 — paper submit passes knowledgeIds=referencedKnowledgeIds whose [0] is the
  // SLOT primary, which can differ from the question primary (q.knowledge_ids[0]). The family_key
  // must resolve off the QUESTION primary (familyPrimaryKnowledgeId), not knowledgeIds[0].
  it('F2: family delta keys off familyPrimaryKnowledgeId (question primary), not knowledgeIds[0] (slot primary)', async () => {
    const kQuestionPrimary = createId(); // q.knowledge_ids[0] — canonical family base.
    const kSlotPrimary = createId(); // paper slot's assigned primary (≠ question primary).
    const qid = createId();
    await seedKnowledge(kQuestionPrimary);
    await seedKnowledge(kSlotPrimary);
    // Question's canonical primary is kQuestionPrimary (the family base).
    await seedQuestion(qid, [kQuestionPrimary, kSlotPrimary]);
    await seedItemCalibration(qid, 0.0);
    // Family row is keyed on the QUESTION primary (where the family write side records it).
    await seedFamily(`wenyan:${kQuestionPrimary}:short_answer:manual`, 1.0);

    // Baseline: NO family delta reaches the anchor (no kind/source → family lookup skipped).
    // Compute on the SLOT primary KC so we compare the same updated KC.
    const kBaseSlot = createId();
    const qBase = createId();
    await seedKnowledge(kBaseSlot);
    await seedQuestion(qBase, [kBaseSlot]);
    await seedItemCalibration(qBase, 0.0);
    const baseTheta = await runAttemptTheta({ kid: kBaseSlot, qid: qBase });

    // Paper-shaped call: knowledgeIds starts with the SLOT primary, but familyPrimaryKnowledgeId
    // is the QUESTION primary → family delta (+1.0) MUST enter the anchor.
    await db.transaction(async (tx) => {
      await updateThetaForAttempt(tx, {
        knowledgeIds: [kSlotPrimary], // slot primary leads (≠ question primary).
        questionId: qid,
        outcome: 1,
        difficulty: 3,
        attemptEventId: newId(),
        now: new Date(),
        kind: 'short_answer',
        source: 'manual',
        familyPrimaryKnowledgeId: kQuestionPrimary, // F2 fix: question primary, not knowledgeIds[0].
      });
    });
    const fixedTheta = (await readState(kSlotPrimary))?.theta_hat ?? 0;

    // The family delta shifted the effective b (0.0 → 1.0) → larger θ̂ gain than the un-shifted
    // baseline. If the lookup had keyed off knowledgeIds[0] (kSlotPrimary, which has NO family
    // row), it would have been a NO-OP and fixedTheta would equal baseTheta.
    expect(fixedTheta).not.toBeCloseTo(baseTheta, 6);
    expect(fixedTheta).toBeGreaterThan(baseTheta);
  });

  // Codex review F2 — control: the OLD behavior (keying off knowledgeIds[0] = slot primary, which
  // has no family row) is a NO-OP. This pins WHY the fix matters: same call but familyPrimary =
  // slot primary → family lookup misses → θ̂ identical to the no-delta baseline.
  it('F2 control: keying off the slot primary (no family row there) is a NO-OP', async () => {
    const kQuestionPrimary = createId();
    const kSlotPrimary = createId();
    const qid = createId();
    await seedKnowledge(kQuestionPrimary);
    await seedKnowledge(kSlotPrimary);
    await seedQuestion(qid, [kQuestionPrimary, kSlotPrimary]);
    await seedItemCalibration(qid, 0.0);
    // Family row exists ONLY on the question primary.
    await seedFamily(`wenyan:${kQuestionPrimary}:short_answer:manual`, 1.0);

    // Baseline θ̂ on a fresh slot KC with no family delta.
    const kBaseSlot = createId();
    const qBase = createId();
    await seedKnowledge(kBaseSlot);
    await seedQuestion(qBase, [kBaseSlot]);
    await seedItemCalibration(qBase, 0.0);
    const baseTheta = await runAttemptTheta({ kid: kBaseSlot, qid: qBase });

    // Buggy-shaped call: familyPrimaryKnowledgeId = slot primary (no family row) → miss → NO-OP.
    await db.transaction(async (tx) => {
      await updateThetaForAttempt(tx, {
        knowledgeIds: [kSlotPrimary],
        questionId: qid,
        outcome: 1,
        difficulty: 3,
        attemptEventId: newId(),
        now: new Date(),
        kind: 'short_answer',
        source: 'manual',
        familyPrimaryKnowledgeId: kSlotPrimary, // wrong key (slot primary) → no family row → NO-OP.
      });
    });
    const buggyTheta = (await readState(kSlotPrimary))?.theta_hat ?? 0;

    // No family delta reached the anchor → bit-identical to the no-delta baseline.
    expect(buggyTheta).toBe(baseTheta);
  });

  it('weak difficulty-proxy anchor + family delta coexist; bWeight stays keyed on the columnar (none) source', async () => {
    // No item_calibration row → columnar b = difficultyToLogitB(3) = 0 (weak proxy, bWeight=0.3).
    // A family delta is added ON TOP of the weak b; bWeight stays 0.3 (keyed on the columnar
    // anchor source = proxy), NOT double-down-weighted by the family delta.
    const kProxy = createId();
    const qProxy = createId();
    await seedKnowledge(kProxy);
    await seedQuestion(qProxy, [kProxy]);
    // NO item_calibration → proxy anchor.
    await seedFamily(`wenyan:${kProxy}:short_answer:manual`, 0.8);
    const proxyTheta = await runAttemptTheta({
      kid: kProxy,
      qid: qProxy,
      kind: 'short_answer',
      source: 'manual',
    });

    // Baseline proxy WITHOUT family delta (no kind/source).
    const kPlain = createId();
    const qPlain = createId();
    await seedKnowledge(kPlain);
    await seedQuestion(qPlain, [kPlain]);
    const plainProxyTheta = await runAttemptTheta({ kid: kPlain, qid: qPlain });

    // The family delta shifted the weak b → different θ̂; both still go through bWeight=0.3
    // (proxy), so the gain is modest but the delta clearly moved the anchor.
    expect(proxyTheta).not.toBeCloseTo(plainProxyTheta, 6);
  });
});
