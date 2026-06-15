// B1-W1 (ADR-0035) — mastery_state single-owner + θ̂ 接线层 db tests.

import { createId } from '@paralleldrive/cuid2';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { newId } from '@/core/ids';
import { db } from '@/db/client';
import { item_calibration, knowledge, mastery_state, question } from '@/db/schema';
import { resetDb } from '../../../tests/helpers/db';
import { getMasteryState, updateThetaForAttempt, upsertMasteryState } from './state';

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
