// B1-W1 (ADR-0035) — applyItemPrior writer db tests.

import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { db } from '@/db/client';
import { item_calibration } from '@/db/schema';
import { resetDb } from '../../../tests/helpers/db';
import { applyItemPrior } from './item-calibration';

describe('applyItemPrior', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('is idempotent by question_id (onConflictDoNothing — no double write)', async () => {
    const q = createId();
    await applyItemPrior(db, {
      questionId: q,
      draft: { b_logit: 1.0, confidence: 0.5, reasoning: 'x' },
    });
    // Second apply with a different b must NOT overwrite (cold-start anchor is
    // write-once; firm-up is a separate slow path).
    await applyItemPrior(db, {
      questionId: q,
      draft: { b_logit: -2.0, confidence: 0.9, reasoning: 'y' },
    });

    const rows = await db
      .select()
      .from(item_calibration)
      .where(eq(item_calibration.question_id, q));
    expect(rows).toHaveLength(1);
    expect(rows[0].b).toBeCloseTo(1.0, 5); // first write wins
  });
});
