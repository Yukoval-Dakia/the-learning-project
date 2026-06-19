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
import {
  ANCHOR_BUCKET_LOGITS,
  type AnchorBucket,
  bucketToLogit,
  setFixedAnchor,
  setFixedAnchors,
} from './fixed-anchor';
import { effectiveB } from './recalibration';

async function readCalRow(questionId: string) {
  const rows = await db
    .select()
    .from(item_calibration)
    .where(and(eq(item_calibration.question_id, questionId), eq(item_calibration.track, 'hard')))
    .limit(1);
  return rows[0] ?? null;
}

describe('bucketToLogit (owner-fixed 5-bucket scale)', () => {
  it('maps all 5 buckets to the owner-fixed logit constants', () => {
    expect(bucketToLogit('very_easy')).toBe(-2);
    expect(bucketToLogit('easy')).toBe(-1);
    expect(bucketToLogit('medium')).toBe(0);
    expect(bucketToLogit('hard')).toBe(1);
    expect(bucketToLogit('very_hard')).toBe(2);
  });

  it('the const table is the single source of truth (symmetric ±2 scale)', () => {
    expect(ANCHOR_BUCKET_LOGITS).toEqual({
      very_easy: -2,
      easy: -1,
      medium: 0,
      hard: 1,
      very_hard: 2,
    });
    for (const [bucket, b] of Object.entries(ANCHOR_BUCKET_LOGITS)) {
      expect(bucketToLogit(bucket as AnchorBucket)).toBe(b);
    }
  });
});

describe('setFixedAnchor', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('writes a hard-track fixed_anchor row { b:1, track:"hard", source:"fixed_anchor" } for "hard"', async () => {
    const q = createId();
    const written = await setFixedAnchor(db, { questionId: q, bucket: 'hard' });
    expect(written).toEqual({ questionId: q, bucket: 'hard', b: 1 });

    const row = await readCalRow(q);
    expect(row).not.toBeNull();
    expect(row?.b).toBeCloseTo(1, 10);
    expect(row?.b_anchor).toBeCloseTo(1, 10);
    expect(row?.track).toBe('hard');
    expect(row?.source).toBe('fixed_anchor');
    expect(row?.confidence).toBeCloseTo(1, 10);
    // b_calib is the de-biased column owned by the batch recalibrator — never set here.
    expect(row?.b_calib).toBeNull();
    // Soft-track columns stay NULL (n=1 structurally non-estimable, ADR-0035).
    expect(row?.irt_a).toBeNull();
    expect(row?.irt_c).toBeNull();
    expect(row?.cdm_json).toBeNull();
    expect(row?.kt_json).toBeNull();
  });

  it('writes the correct logit for every bucket', async () => {
    for (const [bucket, expected] of Object.entries(ANCHOR_BUCKET_LOGITS)) {
      const q = createId();
      await setFixedAnchor(db, { questionId: q, bucket: bucket as AnchorBucket });
      const row = await readCalRow(q);
      expect(row?.b).toBeCloseTo(expected, 10);
      expect(row?.b_anchor).toBeCloseTo(expected, 10);
      expect(row?.source).toBe('fixed_anchor');
    }
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

describe('fixed_anchor read path (effectiveB auto-reads — NO read-path change, §3 红线 3)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('effectiveB returns the fixed_anchor b for a question (b_calib ?? b_anchor ?? b)', async () => {
    const q = createId();
    await setFixedAnchor(db, { questionId: q, bucket: 'very_hard' }); // b=+2
    const row = await readCalRow(q);
    // effectiveB is the EXACT helper the θ̂ update path reads (state.ts:492). No new
    // read code — the non-NULL b_anchor is auto-preferred.
    expect(effectiveB(row)).toBeCloseTo(2, 10);
  });

  it('effectiveB prefers the owner fixed_anchor b_anchor over the (same-source) b', async () => {
    const q = createId();
    await setFixedAnchor(db, { questionId: q, bucket: 'very_easy' }); // b = b_anchor = -2
    const row = await readCalRow(q);
    // b_calib NULL → falls through to b_anchor (-2), which == b here.
    expect(effectiveB(row)).toBeCloseTo(-2, 10);
  });
});

describe('setFixedAnchors (batch)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('writes several anchors and returns the rows in input order', async () => {
    const inputs = [
      { questionId: createId(), bucket: 'very_easy' as const },
      { questionId: createId(), bucket: 'medium' as const },
      { questionId: createId(), bucket: 'very_hard' as const },
    ];
    const rows = await setFixedAnchors(db, inputs);
    expect(rows).toEqual([
      { questionId: inputs[0].questionId, bucket: 'very_easy', b: -2 },
      { questionId: inputs[1].questionId, bucket: 'medium', b: 0 },
      { questionId: inputs[2].questionId, bucket: 'very_hard', b: 2 },
    ]);
    for (const input of inputs) {
      const row = await readCalRow(input.questionId);
      expect(row?.source).toBe('fixed_anchor');
    }
  });
});
