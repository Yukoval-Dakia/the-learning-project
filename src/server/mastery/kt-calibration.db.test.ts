// B1 four-engine soft-track inc-1 (YUK-348) — applyKtEstimate soft-track writer db tests.
//
// Verifies: writes kt_json on a hard-track row; does NOT touch
// b/b_anchor/b_calib/confidence/other soft columns (irt_a/irt_c/cdm_json);
// idempotent; no hard-track row → no-op (no new row inserted).

import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { newId } from '@/core/ids';
import { db } from '@/db/client';
import { item_calibration } from '@/db/schema';
import { resetDb } from '../../../tests/helpers/db';
import { applyItemPrior } from './item-calibration';
import { applyKtEstimate } from './kt-calibration';
import { estimateBkt } from './kt-estimator';

async function readRow(questionId: string) {
  const rows = await db
    .select()
    .from(item_calibration)
    .where(eq(item_calibration.question_id, questionId));
  return rows;
}

describe('applyKtEstimate', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('writes kt_json on an existing hard-track row', async () => {
    const q = createId();
    await applyItemPrior(db, {
      questionId: q,
      draft: { b_logit: 1.4, confidence: 0.5, reasoning: 'x' },
    });

    const kt = estimateBkt([1, 0, 1]) as unknown as Record<string, unknown>;
    await applyKtEstimate(db, { questionId: q, ktJson: kt });

    const rows = await readRow(q);
    expect(rows).toHaveLength(1);
    expect(rows[0].kt_json).toEqual(kt);
    expect(rows[0].track).toBe('hard');
  });

  it('does NOT touch hard-track b/b_anchor/confidence or sibling soft columns', async () => {
    const q = createId();
    await applyItemPrior(db, {
      questionId: q,
      draft: { b_logit: 1.4, confidence: 0.5, reasoning: 'x' },
    });
    const before = (await readRow(q))[0];

    await applyKtEstimate(db, {
      questionId: q,
      ktJson: estimateBkt([1, 1, 0]) as unknown as Record<string, unknown>,
    });

    const after = (await readRow(q))[0];
    // Hard-track columns untouched.
    expect(after.b).toBe(before.b);
    expect(after.b_anchor).toBe(before.b_anchor);
    expect(after.b_calib).toBe(before.b_calib); // NULL stays NULL
    expect(after.confidence).toBe(before.confidence);
    expect(after.calibration_n).toBe(before.calibration_n);
    expect(after.calibration_weight).toBe(before.calibration_weight);
    expect(after.track).toBe(before.track);
    expect(after.source).toBe(before.source);
    // Sibling soft-track columns untouched (only kt_json is this writer's surface).
    expect(after.irt_a).toBeNull();
    expect(after.irt_c).toBeNull();
    expect(after.cdm_json).toBeNull();
    // kt_json is the only changed column.
    expect(after.kt_json).not.toBeNull();
  });

  it('is idempotent — re-applying the same estimate yields the same kt_json', async () => {
    const q = createId();
    await applyItemPrior(db, {
      questionId: q,
      draft: { b_logit: 0, confidence: 0.5, reasoning: 'x' },
    });
    const kt = estimateBkt([1, 0, 1, 1]) as unknown as Record<string, unknown>;
    await applyKtEstimate(db, { questionId: q, ktJson: kt });
    const first = (await readRow(q))[0].kt_json;
    await applyKtEstimate(db, { questionId: q, ktJson: kt });
    const second = (await readRow(q))[0].kt_json;
    expect(second).toEqual(first);
    // Still exactly one row (UPDATE-only, no insert).
    expect(await readRow(q)).toHaveLength(1);
  });

  it('overwrites kt_json on a subsequent apply (whole-column overwrite, no merge)', async () => {
    const q = createId();
    await applyItemPrior(db, {
      questionId: q,
      draft: { b_logit: 0, confidence: 0.5, reasoning: 'x' },
    });
    await applyKtEstimate(db, {
      questionId: q,
      ktJson: estimateBkt([1]) as unknown as Record<string, unknown>,
    });
    const next = estimateBkt([0, 0, 0]) as unknown as Record<string, unknown>;
    await applyKtEstimate(db, { questionId: q, ktJson: next });
    expect((await readRow(q))[0].kt_json).toEqual(next);
  });

  it('no hard-track row → no-op (does NOT insert a new row)', async () => {
    const q = createId();
    // No applyItemPrior → no item_calibration row at all.
    await applyKtEstimate(db, {
      questionId: q,
      ktJson: estimateBkt([1, 0]) as unknown as Record<string, unknown>,
    });
    expect(await readRow(q)).toHaveLength(0); // never inserted.
  });

  it('only-soft-track row present (no hard row) → no-op (UPDATE filters track=hard)', async () => {
    // Defensive: directly seed a NON-hard-track row; the writer must not touch it.
    const q = createId();
    await db.insert(item_calibration).values({
      id: newId(),
      question_id: q,
      b: 1.0,
      confidence: 0.3,
      track: 'soft',
      source: 'test',
      created_at: new Date(),
      updated_at: new Date(),
    });
    await applyKtEstimate(db, {
      questionId: q,
      ktJson: estimateBkt([1, 1]) as unknown as Record<string, unknown>,
    });
    const rows = await readRow(q);
    expect(rows).toHaveLength(1);
    expect(rows[0].kt_json).toBeNull(); // soft-track row untouched (track != hard).
  });
});
