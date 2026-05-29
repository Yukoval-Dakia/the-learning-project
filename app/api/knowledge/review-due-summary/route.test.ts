// Wave 7 T-KG (YUK-142) Slice 2 — per-node FSRS due summary aggregation.
//
// Verifies the GROUP-BY aggregation correctness: overdue vs due_soon counts per
// knowledge node, fan-out across questions tagged with multiple knowledge_ids,
// the window boundary (far-future cards excluded), and the empty case.

import { material_fsrs_state, question } from '@/db/schema';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { GET } from './route';

const QUESTION_BASE = {
  kind: 'short_answer' as const,
  reference_md: null as string | null,
  difficulty: 3,
  source: 'manual' as const,
  variant_depth: 0,
  version: 0,
};

async function seedQuestion(id: string, knowledge_ids: string[]) {
  const db = testDb();
  const now = new Date();
  await db.insert(question).values({
    id,
    prompt_md: `P ${id}`,
    knowledge_ids,
    created_at: now,
    updated_at: now,
    ...QUESTION_BASE,
  });
}

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

async function seedFsrs(question_id: string, due_at: Date) {
  const db = testDb();
  await db.insert(material_fsrs_state).values({
    id: `f_${question_id}`,
    subject_kind: 'question',
    subject_id: question_id,
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
    // k1: 2 overdue (q_a, q_b) + 1 due_soon (q_c)
    await seedQuestion('q_a', ['k1']);
    await seedQuestion('q_b', ['k1']);
    await seedQuestion('q_c', ['k1']);
    await seedFsrs('q_a', new Date(now - 2 * DAY));
    await seedFsrs('q_b', new Date(now - 1 * HOUR));
    await seedFsrs('q_c', new Date(now + 6 * HOUR));

    // k2: 1 due_soon only (q_d)
    await seedQuestion('q_d', ['k2']);
    await seedFsrs('q_d', new Date(now + 12 * HOUR));

    const res = await getSummary();
    expect(res.status).toBe(200);
    const body = (await res.json()) as SummaryBody;

    expect(body.summary.k1).toEqual({ overdue: 2, due_soon: 1 });
    expect(body.summary.k2).toEqual({ overdue: 0, due_soon: 1 });
  });

  it('fans out a question tagged with multiple knowledge_ids into each node', async () => {
    const now = Date.now();
    await seedQuestion('q_multi', ['k1', 'k2', 'k3']);
    await seedFsrs('q_multi', new Date(now - 3 * DAY));

    const res = await getSummary();
    const body = (await res.json()) as SummaryBody;

    expect(body.summary.k1).toEqual({ overdue: 1, due_soon: 0 });
    expect(body.summary.k2).toEqual({ overdue: 1, due_soon: 0 });
    expect(body.summary.k3).toEqual({ overdue: 1, due_soon: 0 });
  });

  it('excludes cards due past the due_soon window', async () => {
    const now = Date.now();
    await seedQuestion('q_far', ['k1']);
    // due 3 days out — beyond the 24h window, must not appear at all.
    await seedFsrs('q_far', new Date(now + 3 * DAY));

    const res = await getSummary();
    const body = (await res.json()) as SummaryBody;
    expect(body.summary.k1).toBeUndefined();
  });

  it('ignores non-question fsrs subjects', async () => {
    const now = Date.now();
    await seedQuestion('q_real', ['k1']);
    await seedFsrs('q_real', new Date(now - DAY));
    // A stray fsrs row for a different subject_kind must not join into question.
    await testDb()
      .insert(material_fsrs_state)
      .values({
        id: 'f_other',
        subject_kind: 'artifact',
        subject_id: 'q_real',
        state: makeFsrsState(new Date(now - DAY).toISOString()) as never,
        due_at: new Date(now - DAY),
        last_review_event_id: null,
        updated_at: new Date(),
      });

    const res = await getSummary();
    const body = (await res.json()) as SummaryBody;
    expect(body.summary.k1).toEqual({ overdue: 1, due_soon: 0 });
  });
});
