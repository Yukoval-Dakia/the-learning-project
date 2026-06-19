// B1 four-engine soft-track inc-1 (YUK-348) — RED-LINE compliance test (ADR-0035 决定 #4).
//
// THE MOST IMPORTANT TEST: kt_json is a PURE PERSISTENCE SINK with ZERO downstream
// consumer. Writing kt_json must NOT change any decision/display path. We prove it
// by asserting getMasteryProjection / effectiveB return BIT-IDENTICAL results with
// kt_json NULL vs populated. If any decision/display reader ever started reading
// kt_json, this test would break — that is the guard.
//
// Pairs with the grep proof (no production code outside the writer reads kt_json):
//   $ grep -rn 'kt_json' src/        → only: schema def, the writer (kt-calibration),
//                                       this writer's job, docs/tests.

import { createId } from '@paralleldrive/cuid2';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { db } from '@/db/client';
import { item_calibration, knowledge, mastery_state, question } from '@/db/schema';
import { resetDb } from '../../../tests/helpers/db';
import { applyItemPrior } from './item-calibration';
import { applyKtEstimate } from './kt-calibration';
import { estimateBkt } from './kt-estimator';
import { type ItemCalibrationBRow, effectiveB } from './recalibration';
import { getMasteryProjection, upsertMasteryState } from './state';

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

async function seedQuestion(id: string, knowledgeIds: string[]) {
  const now = new Date();
  await db.insert(question).values({
    id,
    kind: 'short_answer',
    prompt_md: `Prompt ${id}`,
    reference_md: null,
    knowledge_ids: knowledgeIds,
    difficulty: 3,
    source: 'manual',
    draft_status: null,
    variant_depth: 0,
    created_at: now,
    updated_at: now,
    version: 0,
  });
}

async function readCalibrationBRow(questionId: string): Promise<ItemCalibrationBRow | null> {
  const rows = await db
    .select({
      b: item_calibration.b,
      b_anchor: item_calibration.b_anchor,
      b_calib: item_calibration.b_calib,
    })
    .from(item_calibration)
    .where(and(eq(item_calibration.question_id, questionId), eq(item_calibration.track, 'hard')))
    .limit(1);
  return rows[0] ?? null;
}

describe('kt_json red line — pure persistence sink, zero downstream consumer (ADR-0035 决定 #4)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('getMasteryProjection & effectiveB are BIT-IDENTICAL with kt_json null vs populated', async () => {
    const kc = createId();
    const q = createId();
    await seedKnowledge(kc);
    await seedQuestion(q, [kc]);
    // Hard-track anchor (feeds the difficulty-aware p(L) β via getRepresentativeKcBeta).
    await applyItemPrior(db, {
      questionId: q,
      draft: { b_logit: 0.8, confidence: 0.5, reasoning: 'x' },
    });
    // A mastery_state row so the projection actually produces a record for the KC.
    await upsertMasteryState(db, {
      subject_id: kc,
      theta_hat: 0.4,
      evidence_count: 5,
      success_count: 3,
      fail_count: 2,
      last_outcome_at: new Date(),
    });

    // ── Capture decision/display outputs with kt_json NULL ──
    const projBefore = await getMasteryProjection(db, [kc]);
    const beforeRow = projBefore.get(kc);
    const effBBefore = effectiveB(await readCalibrationBRow(q));
    // Sanity: kt_json really is NULL right now.
    const calBefore = await db
      .select()
      .from(item_calibration)
      .where(eq(item_calibration.question_id, q));
    expect(calBefore[0].kt_json).toBeNull();

    // ── Populate kt_json (the soft-track write) ──
    await applyKtEstimate(db, {
      questionId: q,
      ktJson: estimateBkt([1, 0, 1, 1, 0]) as unknown as Record<string, unknown>,
    });
    const calAfter = await db
      .select()
      .from(item_calibration)
      .where(eq(item_calibration.question_id, q));
    expect(calAfter[0].kt_json).not.toBeNull(); // the write landed.

    // ── Re-capture decision/display outputs with kt_json POPULATED ──
    const projAfter = await getMasteryProjection(db, [kc]);
    const afterRow = projAfter.get(kc);
    const effBAfter = effectiveB(await readCalibrationBRow(q));

    // BIT-IDENTICAL: kt_json has zero downstream readers, so populating it changed
    // NOTHING in the decision (p(L) / β / effectiveB) or display projection.
    expect(afterRow).toEqual(beforeRow);
    expect(effBAfter).toBe(effBBefore);
    // Spot-check the load-bearing decision fields explicitly (not just deep-equal).
    expect(afterRow?.mastery).toBe(beforeRow?.mastery);
    expect(afterRow?.mastery_lo).toBe(beforeRow?.mastery_lo);
    expect(afterRow?.mastery_hi).toBe(beforeRow?.mastery_hi);
    expect(afterRow?.theta_hat).toBe(beforeRow?.theta_hat);
    expect(effBAfter).toBe(0.8); // anchor b unchanged by the kt_json write.
  });
});
