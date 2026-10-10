// B1 four-engine soft-track inc-1 (YUK-348) — applyKtEstimate soft-track writer db tests.
//
// Verifies: writes kt_json on a hard-track row; does NOT touch
// b/b_anchor/b_calib/confidence/other soft columns (irt_a/irt_c/cdm_json);
// idempotent; no hard-track row → no-op (no new row inserted).

import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

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
});
