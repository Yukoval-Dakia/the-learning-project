// T-CS / YUK-168 — cross-subject scheduling v1 (round-robin selection).
//
// `handleReviewDue` no longer selects the page by a PLAIN global-due
// `combined.slice(0, limit)` (which lets one busy subject dominate). It
// round-robins the selection across the learning-subjects that have due items:
// cycle the subjects taking the next most-due item from each in turn until the
// limit is reached or the pool is exhausted. This file proves:
//   1. multi-subject round-robin balances the page across subjects (each
//      represented per the round-robin rule), every returned item is due, and
//      count <= limit;
//   2. only-due items ever appear;
//   3. single-subject → byte-identical to the pre-change global-due output
//      (degeneration / back-compat);
//   4. composition: with goals, the soft-bias re-rank still orders the
//      round-robin-selected set goal-first (set-preserving).
//
// A question's learning-subject is resolved from its first knowledge id's
// effective domain (knowledge_ids → parent chain → domain → SubjectProfile).
// We seed real `knowledge` rows with distinct domains so the questions resolve
// to wenyan / math / physics. Orphan ids (no knowledge row) fall back to the
// default profile (wenyan) — that is the single-subject degeneration path the
// existing route/soft-bias/part tests already exercise.
//
// DB test (testDb): imports @/db + tests/helpers/db → runs in the db config.

import { event, knowledge, material_fsrs_state, question } from '@/db/schema';
import type { ActiveGoal } from '@/server/goals/queries';
import { handleReviewDue } from '@/server/review/due-list';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';

const NOW = new Date('2026-05-30T12:00:00.000Z');
const T0 = new Date('2026-05-20T00:00:00.000Z');

function makeFsrsState(due: Date) {
  return {
    due: due.toISOString(),
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

// A root knowledge node whose `domain` resolves to a SubjectProfile. domain
// strings map via the profile alias table: 'wenyan' | 'math' | 'physics'.
async function seedKnowledge(id: string, domain: string) {
  await testDb()
    .insert(knowledge)
    .values({
      id,
      name: `k ${id}`,
      domain,
      parent_id: null,
      created_at: NOW,
      updated_at: NOW,
    });
}

async function seedQuestion(id: string, knowledge_ids: string[], createdAt: Date) {
  await testDb()
    .insert(question)
    .values({
      id,
      kind: 'short_answer',
      prompt_md: `P ${id}`,
      reference_md: null,
      knowledge_ids,
      difficulty: 3,
      source: 'manual',
      variant_depth: 0,
      version: 0,
      created_at: createdAt,
      updated_at: createdAt,
    });
}

async function seedOverdue(id: string, knowledge_ids: string[], dueAt: Date) {
  await seedQuestion(id, knowledge_ids, T0);
  await testDb()
    .insert(material_fsrs_state)
    .values({
      id: `f_${id}`,
      subject_kind: 'question',
      subject_id: id,
      state: makeFsrsState(dueAt) as never,
      due_at: dueAt,
      last_review_event_id: null,
      updated_at: NOW,
    });
}

type DueRow = {
  id: string;
  question_id: string;
  fsrs_state: unknown;
  knowledge_ids: string[];
};

async function getDue(
  limit: number,
  deps?: Parameters<typeof handleReviewDue>[1],
): Promise<DueRow[]> {
  const res = await handleReviewDue(
    new Request(`http://localhost/api/review/due?limit=${limit}`),
    deps,
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { rows: DueRow[] };
  return body.rows;
}

const noGoals = { listActiveGoalsFn: async (): Promise<ActiveGoal[]> => [] };
function withGoalScope(...scope: string[]) {
  return {
    listActiveGoalsFn: async (): Promise<ActiveGoal[]> => [
      {
        id: 'goal_1',
        title: 'g',
        subject_id: null,
        scope_knowledge_ids: scope,
        sequence_hint: 0,
      },
    ],
  };
}

describe('YUK-168 cross-subject scheduling — round-robin selection', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('balances the page across subjects round-robin instead of one subject dominating', async () => {
    // Three knowledge domains → three subjects.
    await seedKnowledge('k_wen', 'wenyan');
    await seedKnowledge('k_math', 'math');
    await seedKnowledge('k_phys', 'physics');

    // wenyan dominates the GLOBAL due order (its three cards are the most-due),
    // then math, then physics. A plain global-due slice(0,3) would return three
    // wenyan cards and starve math + physics. Round-robin must surface one of
    // each within the first three.
    //   wenyan: w1 (most due), w2, w3
    //   math:   m1, m2
    //   physics:p1
    await seedOverdue('w1', ['k_wen'], new Date('2026-05-21T00:00:00.000Z'));
    await seedOverdue('w2', ['k_wen'], new Date('2026-05-22T00:00:00.000Z'));
    await seedOverdue('w3', ['k_wen'], new Date('2026-05-23T00:00:00.000Z'));
    await seedOverdue('m1', ['k_math'], new Date('2026-05-24T00:00:00.000Z'));
    await seedOverdue('m2', ['k_math'], new Date('2026-05-25T00:00:00.000Z'));
    await seedOverdue('p1', ['k_phys'], new Date('2026-05-26T00:00:00.000Z'));

    const ids = (await getDue(3, noGoals)).map((r) => r.id);

    // First round-robin pass: most-due item of each subject, in first-seen
    // (most-due) subject order → wenyan, math, physics.
    expect(ids).toEqual(['w1', 'm1', 'p1']);
    // Contrast: the plain global-due page would have been ['w1', 'w2', 'w3'].
    expect(ids).not.toEqual(['w1', 'w2', 'w3']);
  });

  it('keeps within-subject due_at order across rounds and fills to limit', async () => {
    await seedKnowledge('k_wen', 'wenyan');
    await seedKnowledge('k_math', 'math');

    await seedOverdue('w1', ['k_wen'], new Date('2026-05-21T00:00:00.000Z'));
    await seedOverdue('w2', ['k_wen'], new Date('2026-05-22T00:00:00.000Z'));
    await seedOverdue('m1', ['k_math'], new Date('2026-05-23T00:00:00.000Z'));
    await seedOverdue('m2', ['k_math'], new Date('2026-05-24T00:00:00.000Z'));

    const ids = (await getDue(4, noGoals)).map((r) => r.id);
    // Round 1: w1, m1 (most-due each). Round 2: w2, m2. Within-subject due_at
    // order preserved (w1 before w2, m1 before m2).
    expect(ids).toEqual(['w1', 'm1', 'w2', 'm2']);
    expect(ids.indexOf('w1')).toBeLessThan(ids.indexOf('w2'));
    expect(ids.indexOf('m1')).toBeLessThan(ids.indexOf('m2'));
  });

  it('only returns DUE items — never a non-due card', async () => {
    await seedKnowledge('k_wen', 'wenyan');
    await seedKnowledge('k_math', 'math');

    // Two overdue (due in the past) + one NOT-yet-due (future) per subject.
    await seedOverdue('w_due', ['k_wen'], new Date('2026-05-21T00:00:00.000Z'));
    await seedOverdue('m_due', ['k_math'], new Date('2026-05-22T00:00:00.000Z'));
    await seedOverdue('w_future', ['k_wen'], new Date('2999-01-01T00:00:00.000Z'));
    await seedOverdue('m_future', ['k_math'], new Date('2999-01-01T00:00:00.000Z'));

    const ids = (await getDue(50, noGoals)).map((r) => r.id).sort();
    expect(ids).toEqual(['m_due', 'w_due']);
  });

  it('count never exceeds limit even with multiple subjects', async () => {
    await seedKnowledge('k_wen', 'wenyan');
    await seedKnowledge('k_math', 'math');
    for (let i = 0; i < 5; i += 1) {
      await seedOverdue(`w${i}`, ['k_wen'], new Date(`2026-05-2${i + 1}T00:00:00.000Z`));
      await seedOverdue(`m${i}`, ['k_math'], new Date(`2026-05-1${i + 1}T00:00:00.000Z`));
    }
    const rows = await getDue(3, noGoals);
    expect(rows.length).toBe(3);
  });

  it('single-subject degeneration: page is byte-identical to plain global-due order', async () => {
    // All cards resolve to ONE subject (real wenyan knowledge node). With a
    // single subject the round-robin has exactly one bucket → emits it in due_at
    // order → identical to the pre-change `combined.slice(0, limit)`.
    await seedKnowledge('k_wen', 'wenyan');
    await seedOverdue('q_c', ['k_wen'], new Date('2026-05-23T00:00:00.000Z'));
    await seedOverdue('q_a', ['k_wen'], new Date('2026-05-21T00:00:00.000Z'));
    await seedOverdue('q_b', ['k_wen'], new Date('2026-05-22T00:00:00.000Z'));

    const ids = (await getDue(10, noGoals)).map((r) => r.id);
    // Pre-change global-due order = due_at asc = a, b, c.
    expect(ids).toEqual(['q_a', 'q_b', 'q_c']);
  });

  it('orphan knowledge ids degenerate to the default subject (single bucket → global-due order)', async () => {
    // No `knowledge` rows seeded → every first-knowledge-id is unresolvable →
    // default profile → single subject → global-due order. This is exactly the
    // path the existing route/soft-bias/part fixtures rely on.
    await seedOverdue('q_c', ['k_missing'], new Date('2026-05-23T00:00:00.000Z'));
    await seedOverdue('q_a', ['k_missing'], new Date('2026-05-21T00:00:00.000Z'));
    await seedOverdue('q_b', ['k_missing'], new Date('2026-05-22T00:00:00.000Z'));

    const ids = (await getDue(10, noGoals)).map((r) => r.id);
    expect(ids).toEqual(['q_a', 'q_b', 'q_c']);
  });

  it('composes with soft-bias: goal-relevant items ordered first WITHIN the round-robin-selected set', async () => {
    await seedKnowledge('k_wen', 'wenyan');
    await seedKnowledge('k_math', 'math');

    // Round-robin over {wenyan: w1, w2}, {math: m1, m2}. With limit=4 all four
    // are selected; round-robin order (no goals) = [w1, m1, w2, m2]. A goal
    // scoped to the math knowledge node floats the math (goal-relevant) cards to
    // the front of the OVERDUE segment, stably — set unchanged, order changes.
    await seedOverdue('w1', ['k_wen'], new Date('2026-05-21T00:00:00.000Z'));
    await seedOverdue('m1', ['k_math'], new Date('2026-05-22T00:00:00.000Z'));
    await seedOverdue('w2', ['k_wen'], new Date('2026-05-23T00:00:00.000Z'));
    await seedOverdue('m2', ['k_math'], new Date('2026-05-24T00:00:00.000Z'));

    const baseline = (await getDue(4, noGoals)).map((r) => r.id);
    expect(baseline).toEqual(['w1', 'm1', 'w2', 'm2']);

    const biased = (await getDue(4, withGoalScope('k_math'))).map((r) => r.id);
    // Same SET, only ORDER changes: goal-relevant (k_math) m1, m2 lead, then the
    // non-relevant w1, w2 — each group preserving its round-robin relative order.
    expect([...biased].sort()).toEqual([...baseline].sort());
    expect(biased).toEqual(['m1', 'm2', 'w1', 'w2']);
  });
});
