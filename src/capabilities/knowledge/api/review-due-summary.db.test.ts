// Wave 7 T-KG (YUK-142) Slice 2 — per-node FSRS due summary aggregation.
//
// Verifies the GROUP-BY aggregation correctness: overdue vs due_soon counts per
// knowledge FSRS subject, the window boundary (far-future cards excluded), and
// the empty case.

import { material_fsrs_state } from '@/db/schema';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { GET } from './review-due-summary';

function makeFsrsState(dueIso: string) {
  return {
    due: dueIso,
    stability: 1.5,
    difficulty: 5,
    elapsed_days: 0,
    scheduled_days: 1,
    learning_steps: 0,
    reps: 1,
    lapses: 0,
    state: 'review',
    last_review: null,
  };
}

async function seedKnowledgeFsrs(knowledgeId: string, due_at: Date) {
  const db = testDb();
  await db.insert(material_fsrs_state).values({
    id: `f_${knowledgeId}`,
    subject_kind: 'knowledge',
    subject_id: knowledgeId,
    state: makeFsrsState(due_at.toISOString()) as never,
    due_at,
    last_review_event_id: null,
    updated_at: new Date(),
  });
}

async function getSummary() {
  return GET();
}

type SummaryBody = {
  now: string;
  due_soon_window_hours: number;
  summary: Record<string, { overdue: number; due_soon: number }>;
};

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// Mirrors DUE_SOON_WINDOW_HOURS (24) in the route — the exclusive upper bound.
const DUE_SOON_WINDOW_MS = 24 * HOUR;

describe('GET /api/knowledge/review-due-summary', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns an empty summary when nothing is due', async () => {
    const res = await getSummary();
    expect(res.status).toBe(200);
    const body = (await res.json()) as SummaryBody;
    expect(body.summary).toEqual({});
    expect(body.due_soon_window_hours).toBe(24);
    expect(typeof body.now).toBe('string');
  });

  it('aggregates overdue vs due_soon counts per knowledge node', async () => {
    const now = Date.now();
    await seedKnowledgeFsrs('k_overdue_old', new Date(now - 2 * DAY));
    await seedKnowledgeFsrs('k_overdue_recent', new Date(now - 1 * HOUR));
    await seedKnowledgeFsrs('k_soon', new Date(now + 6 * HOUR));

    const res = await getSummary();
    expect(res.status).toBe(200);
    const body = (await res.json()) as SummaryBody;

    expect(body.summary.k_overdue_old).toEqual({ overdue: 1, due_soon: 0 });
    expect(body.summary.k_overdue_recent).toEqual({ overdue: 1, due_soon: 0 });
    expect(body.summary.k_soon).toEqual({ overdue: 0, due_soon: 1 });
  });

  it('excludes cards due past the due_soon window', async () => {
    const now = Date.now();
    // due 3 days out — beyond the 24h window, must not appear at all.
    await seedKnowledgeFsrs('k_far', new Date(now + 3 * DAY));

    const res = await getSummary();
    const body = (await res.json()) as SummaryBody;
    expect(body.summary.k_far).toBeUndefined();
  });

  it('excludes a card at the exclusive 24h upper bound (due_at >= now+24h dropped)', async () => {
    // The inner subquery filter is `due_at < now + 24h` (EXCLUSIVE), so a card
    // sitting exactly at the window edge must be dropped entirely — it is
    // neither overdue nor due_soon. Seed a hair PAST the edge (the route
    // computes `now` itself a few ms after this test's clock, so anything <=
    // testNow+24h could slip just inside the route window; +1min pins it firmly
    // at/over the exclusive boundary regardless of execution timing).
    const now = Date.now();
    await seedKnowledgeFsrs('k_edge', new Date(now + DUE_SOON_WINDOW_MS + 60_000));

    const res = await getSummary();
    const body = (await res.json()) as SummaryBody;
    expect(body.summary.k_edge).toBeUndefined();
  });

  it('counts a card at the now-seam as overdue (inclusive due_at <= now)', async () => {
    // Canonical executeGetReviewDue uses `lte(due_at, now)` — a card due at or
    // before now is OVERDUE, not due_soon. Both a card exactly at the test clock
    // and one 1ms before it are in the past relative to the route's own (later)
    // `now`, so both must land in overdue with zero due_soon.
    const now = Date.now();
    await seedKnowledgeFsrs('k_seam', new Date(now));
    await seedKnowledgeFsrs('k_just_before', new Date(now - 1));

    const res = await getSummary();
    const body = (await res.json()) as SummaryBody;
    expect(body.summary.k_seam).toEqual({ overdue: 1, due_soon: 0 });
    expect(body.summary.k_just_before).toEqual({ overdue: 1, due_soon: 0 });
  });

  it('ignores non-knowledge fsrs subjects', async () => {
    const now = Date.now();
    await seedKnowledgeFsrs('k_real', new Date(now - DAY));
    // A stray fsrs row for a different subject_kind must not count as a node.
    await testDb()
      .insert(material_fsrs_state)
      .values({
        id: 'f_other',
        subject_kind: 'question',
        subject_id: 'k_real',
        state: makeFsrsState(new Date(now - DAY).toISOString()) as never,
        due_at: new Date(now - DAY),
        last_review_event_id: null,
        updated_at: new Date(),
      });

    const res = await getSummary();
    const body = (await res.json()) as SummaryBody;
    expect(body.summary.k_real).toEqual({ overdue: 1, due_soon: 0 });
  });
});
