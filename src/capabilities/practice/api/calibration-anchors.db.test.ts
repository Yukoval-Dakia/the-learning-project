// YUK-453 cold-start inc-A — POST /api/practice/calibration/anchors route db tests.
//
// Auth (x-internal-token) is enforced upstream by the /api/* composition-root
// middleware, not by the handler — these tests call the handler directly (the
// route-test convention; auth is a middleware-layer regression concern).

import { createId } from '@paralleldrive/cuid2';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { db } from '@/db/client';
import { item_calibration } from '@/db/schema';
import { resetDb } from '../../../../tests/helpers/db';
import { POST } from './calibration-anchors';

function makeReq(body: unknown): Request {
  return new Request('http://t/api/practice/calibration/anchors', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function readCalRow(questionId: string) {
  const rows = await db
    .select()
    .from(item_calibration)
    .where(and(eq(item_calibration.question_id, questionId), eq(item_calibration.track, 'hard')))
    .limit(1);
  return rows[0] ?? null;
}

describe('POST /api/practice/calibration/anchors', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('writes anchors end-to-end (body → item_calibration fixed_anchor rows) and returns them', async () => {
    const q1 = createId();
    const q2 = createId();
    const res = await POST(
      makeReq([
        { question_id: q1, bucket: 'easy' },
        { question_id: q2, bucket: 'very_hard' },
      ]),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      anchors: Array<{ question_id: string; bucket: string; b: number }>;
    };
    expect(json.anchors).toEqual([
      { question_id: q1, bucket: 'easy', b: -1 },
      { question_id: q2, bucket: 'very_hard', b: 2 },
    ]);

    const r1 = await readCalRow(q1);
    expect(r1?.b).toBeCloseTo(-1, 10);
    expect(r1?.b_anchor).toBeCloseTo(-1, 10);
    expect(r1?.source).toBe('fixed_anchor');
    expect(r1?.track).toBe('hard');

    const r2 = await readCalRow(q2);
    expect(r2?.b).toBeCloseTo(2, 10);
    expect(r2?.source).toBe('fixed_anchor');
  });

  it('is idempotent end-to-end — re-POSTing the same question upserts (no dup row)', async () => {
    const q = createId();
    await POST(makeReq([{ question_id: q, bucket: 'medium' }]));
    await POST(makeReq([{ question_id: q, bucket: 'hard' }]));
    const rows = await db
      .select()
      .from(item_calibration)
      .where(eq(item_calibration.question_id, q));
    expect(rows).toHaveLength(1);
    expect(rows[0].b).toBeCloseTo(1, 10); // latest write wins
  });

  it('rejects an invalid bucket (400 validation_error)', async () => {
    const res = await POST(makeReq([{ question_id: createId(), bucket: 'impossible' }]));
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe('validation_error');
  });

  it('rejects a missing question_id (400)', async () => {
    const res = await POST(makeReq([{ bucket: 'easy' }]));
    expect(res.status).toBe(400);
  });

  it('rejects an empty array (400 — at least one entry required)', async () => {
    const res = await POST(makeReq([]));
    expect(res.status).toBe(400);
  });

  it('rejects a non-JSON body (400)', async () => {
    const res = await POST(
      new Request('http://t/api/practice/calibration/anchors', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not json',
      }),
    );
    expect(res.status).toBe(400);
  });
});
