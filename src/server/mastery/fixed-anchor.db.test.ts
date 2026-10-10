// YUK-453 cold-start inc-A — setFixedAnchor writer + bucket→logit map + read-path
// auto-read db tests.
//
// docs/design/2026-06-20-cold-start-day-one-design.md §5 inc-A + §4.1; §3 红线 3.

import { createId } from '@paralleldrive/cuid2';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { db } from '@/db/client';
import { item_calibration } from '@/db/schema';
import { resetDb } from '../../../tests/helpers/db';
import { type AnchorBucket, setFixedAnchor, setFixedAnchors } from './fixed-anchor';

async function readCalRow(questionId: string) {
  const rows = await db
    .select()
    .from(item_calibration)
    .where(and(eq(item_calibration.question_id, questionId), eq(item_calibration.track, 'hard')))
    .limit(1);
  return rows[0] ?? null;
}

describe('setFixedAnchor', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('is idempotent per question_id — re-setting upserts (no dup row), and updates b', async () => {
    const q = createId();
    await setFixedAnchor(db, { questionId: q, bucket: 'easy' }); // b=-1
    // owner revises the bucket — upsert must overwrite, not create a 2nd row.
    await setFixedAnchor(db, { questionId: q, bucket: 'very_hard' }); // b=+2

    const rows = await db
      .select()
      .from(item_calibration)
      .where(eq(item_calibration.question_id, q));
    expect(rows).toHaveLength(1); // single row — unique index honored
    expect(rows[0].b).toBeCloseTo(2, 10); // latest write wins (owner may revise)
    expect(rows[0].b_anchor).toBeCloseTo(2, 10);
    expect(rows[0].source).toBe('fixed_anchor');
  });

  it('does NOT clobber b_calib on upsert (de-biased column is recalibrator-owned)', async () => {
    const q = createId();
    await setFixedAnchor(db, { questionId: q, bucket: 'medium' });
    // Simulate a downstream recalibration having firmed up b_calib.
    await db
      .update(item_calibration)
      .set({ b_calib: 0.42 })
      .where(eq(item_calibration.question_id, q));
    // owner re-declares the anchor — b_calib must survive the upsert untouched.
    await setFixedAnchor(db, { questionId: q, bucket: 'hard' });
    const row = await readCalRow(q);
    expect(row?.b).toBeCloseTo(1, 10);
    expect(row?.b_calib).toBeCloseTo(0.42, 10);
  });
});

describe('setFixedAnchors (batch)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  // OCR major finding (PR #512): a sequential `await setFixedAnchor` loop with NO
  // wrapping transaction lets a mid-batch failure leave EARLIER anchors committed +
  // LATER ones not (partial write). The batch must be ATOMIC: any failure rolls back
  // ALL anchors. The forced error here is an invalid bucket on the 2nd entry —
  // `bucketToLogit` throws *after* the 1st entry's INSERT, so without the tx wrap the
  // 1st row would already be committed; with the wrap the throw rolls the whole batch.
  it('is atomic — a mid-batch failure rolls back ALL anchors (zero partial write)', async () => {
    const good1 = createId();
    const bad = createId();
    const good2 = createId();
    const inputs = [
      { questionId: good1, bucket: 'easy' as AnchorBucket },
      // Invalid bucket — bucketToLogit throws mid-batch (after good1 already INSERTed
      // inside the loop). Cast past the type so the runtime guard fires.
      { questionId: bad, bucket: 'nonexistent' as AnchorBucket },
      { questionId: good2, bucket: 'hard' as AnchorBucket },
    ];

    await expect(setFixedAnchors(db, inputs)).rejects.toThrow();

    // Full rollback: NONE of the three questions has a row — not even the first,
    // which succeeded before the throw. A partial write (good1 present) is the bug.
    expect(await readCalRow(good1)).toBeNull();
    expect(await readCalRow(bad)).toBeNull();
    expect(await readCalRow(good2)).toBeNull();
  });
});
