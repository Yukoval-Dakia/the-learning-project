// YUK-167 / ADR-0025 — North-Star W10 review soft-bias (ND-5 load-bearing).
//
// Active goals add a SOFT, goal-relevant re-rank of the OVERDUE review items:
// items whose knowledge_ids intersect the union of active goals'
// scope_knowledge_ids float to the front of the overdue segment, stably.
//
// ND-5 命门: the re-rank changes ONLY the ORDER. The returned set of ids, the
// count, every due_at, and fsrs_state must be byte-identical to the no-goals
// output. The re-rank therefore runs AFTER the FSRS due-ordering + limit have
// chosen the returned page — never on the pre-limit pool. If the set-equality
// assertion below goes red, the change violated ND-5 — fix the route, never
// the test.
//
// DB test (testDb): NOT in fastTestInclude → runs in the vitest db config.

import { handleReviewDue } from '@/capabilities/practice/server/due-list';
// handleReviewDue is the deps-injectable handler behind the GET route. It lives
// in @/capabilities/practice/server/due-list, not the route module, because Next's generated
// route-type validator rejects any non-handler export from route.ts (YUK-67).
import { event, goal, material_fsrs_state, question } from '@/db/schema';
import type { ActiveGoal } from '@/server/goals/queries';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';

const NOW = new Date('2026-05-30T12:00:00.000Z');

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

async function seedOverdue(id: string, knowledge_ids: string[], dueAt: Date, createdAt: Date) {
  await seedQuestion(id, knowledge_ids, createdAt);
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

// A never-reviewed card: a question row + a failure-attempt event, but NO
// material_fsrs_state row. It surfaces via the event-stream slice and lands in
// `newRows` (fsrs_state === null), forming the contiguous HEAD of `combined`
// ahead of the overdue tail. Mirrors part-regression.test.ts seedFailureAttempt.
async function seedNeverReviewed(id: string, knowledge_ids: string[], createdAt: Date) {
  await seedQuestion(id, knowledge_ids, createdAt);
  await testDb()
    .insert(event)
    .values({
      id: `evt_attempt_${id}`,
      session_id: null,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'attempt',
      subject_kind: 'question',
      subject_id: id,
      outcome: 'failure',
      payload: {
        answer_md: 'wrong',
        answer_image_refs: [],
        referenced_knowledge_ids: knowledge_ids,
      },
      caused_by_event_id: null,
      task_run_id: null,
      cost_micro_usd: null,
      created_at: createdAt,
    });
}

async function seedGoal(id: string, scope_knowledge_ids: string[]) {
  await testDb()
    .insert(goal)
    .values({
      id,
      title: `goal ${id}`,
      subject_id: 'wenyan',
      scope_knowledge_ids,
      sequence_hint: 0,
      status: 'active',
      source: 'goal_scope_proposal',
      source_ref: `p_${id}`,
      created_at: NOW,
      updated_at: NOW,
    });
}

type DueRow = {
  id: string;
  question_id: string;
  fsrs_state: unknown;
  knowledge_ids: string[];
  created_at: string;
};

async function getDue(deps?: Parameters<typeof handleReviewDue>[1]): Promise<DueRow[]> {
  const res = await handleReviewDue(new Request('http://localhost/api/review/due?limit=50'), deps);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { rows: DueRow[] };
  return body.rows;
}

async function getDueWithLimit(
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

/** Set/count/due_at fingerprint that the re-rank must NOT change (ND-5). */
function setFingerprint(rows: DueRow[]) {
  return {
    count: rows.length,
    sortedIds: rows.map((r) => r.id).sort(),
    // due_at[] keyed by id so it is order-independent — proves no item was
    // re-dued and the same set of due times is returned.
    dueAtById: Object.fromEntries(
      rows.map((r) => [r.id, (r.fsrs_state as { due?: string } | null)?.due ?? null]),
    ),
  };
}

// Overdue fixture: four overdue cards with distinct due_at so the baseline
// (no-goals) order is deterministic: a, b, c, d (due_at asc). b and d carry
// the goal-scoped knowledge 'k2'; a and c do not.
const T0 = new Date('2026-05-20T00:00:00.000Z');
async function seedOverdueFixture() {
  await seedOverdue('q_a', ['k1'], new Date('2026-05-25T00:00:00.000Z'), T0);
  await seedOverdue('q_b', ['k2'], new Date('2026-05-26T00:00:00.000Z'), T0);
  await seedOverdue('q_c', ['k3'], new Date('2026-05-27T00:00:00.000Z'), T0);
  await seedOverdue('q_d', ['k2'], new Date('2026-05-28T00:00:00.000Z'), T0);
}

// Over-limit fixture that genuinely exercises the JS `combined.slice(0, limit)`
// 命门. Subtlety: the overdue SQL query already applies ORDER BY due_at + LIMIT,
// so the overdue segment alone can never exceed `limit` rows in `combined` — the
// JS slice would be a no-op and a pre-slice re-rank could not change the set.
// The JS slice only DROPS items when never-reviewed cards (fsrs_state === null,
// the HEAD of `combined`) consume part of the budget while the SQL still returns
// a full `limit` overdue rows. So we seed ONE never-reviewed head card plus
// THREE overdue cards; with limit=3, combined.length === 4 > 3 and the JS slice
// drops the most-due-tail overdue card `o_3`. `o_3` is goal-relevant (k2) and is
// the LESS-due item that a NAIVE pre-slice re-rank would float into the page over
// the more-due `o_2`, changing WHICH ids are returned. See the red-green proof.
async function seedOverLimitFixture() {
  // Head: one never-reviewed card (no FSRS state) → fsrs_state === null.
  await seedNeverReviewed('q_new', ['k1'], T0);
  // Overdue tail, due_at asc → SQL returns o_1, o_2, o_3 (most-due first).
  await seedOverdue('o_1', ['k1'], new Date('2026-05-25T00:00:00.000Z'), T0);
  await seedOverdue('o_2', ['k1'], new Date('2026-05-26T00:00:00.000Z'), T0);
  await seedOverdue('o_3', ['k2'], new Date('2026-05-27T00:00:00.000Z'), T0);
}

const noGoals = { listActiveGoalsFn: async (): Promise<ActiveGoal[]> => [] };
function withGoalScope(...scope: string[]) {
  return {
    listActiveGoalsFn: async (): Promise<ActiveGoal[]> => [
      {
        id: 'goal_1',
        title: 'g',
        subject_id: 'wenyan',
        scope_knowledge_ids: scope,
        sequence_hint: 0,
      },
    ],
  };
}

describe('YUK-167 review soft-bias — goal-relevant re-rank (ND-5)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('ND-5: returned id-SET + count + due_at[] are IDENTICAL with vs without goals (only order changes)', async () => {
    await seedOverdueFixture();

    const baseline = await getDue(noGoals);
    const biased = await getDue(withGoalScope('k2'));

    // LOAD-BEARING: the set, count and every due_at are byte-identical.
    expect(setFingerprint(biased)).toEqual(setFingerprint(baseline));

    // ...and yet the ORDER differs (goal-relevant items floated to the front).
    const baselineOrder = baseline.map((r) => r.id);
    const biasedOrder = biased.map((r) => r.id);
    expect(baselineOrder).toEqual(['q_a', 'q_b', 'q_c', 'q_d']);
    expect(biasedOrder).not.toEqual(baselineOrder);
    expect(biasedOrder).toEqual(['q_b', 'q_d', 'q_a', 'q_c']);
  });

  it('ND-5 OVER-LIMIT (命门 guard): combined.length > limit → the SAME page is returned with vs without goals; a less-due goal-relevant item is NOT pulled into the page over a more-due one', async () => {
    await seedOverLimitFixture();

    // limit=3 with 1 never-reviewed head + 3 overdue rows → combined.length === 4
    // > 3, so `page = combined.slice(0, limit)` genuinely DROPS the most-due-tail
    // overdue card `o_3`. `o_3` is goal-relevant (k2) and falls outside the page.
    const baseline = await getDueWithLimit(3, noGoals);
    const biased = await getDueWithLimit(3, withGoalScope('k2'));

    // Sanity: the page is the limit (slice genuinely exercised — 4 candidates,
    // 3 returned) and the head never-reviewed card leads (legacy contract).
    expect(baseline).toHaveLength(3);
    expect(baseline[0]?.id).toBe('q_new');

    // ND-5: the SAME page is returned in both runs — set, count and every due_at
    // byte-identical. Re-rank only reorders WITHIN the overdue segment of the
    // page; it does NOT pull the less-due goal-relevant `o_3` into the page over
    // the more-due `o_2`.
    expect(setFingerprint(biased)).toEqual(setFingerprint(baseline));

    // Concretely: the returned set is {q_new, o_1, o_2} — `o_3` stays out
    // despite being goal-relevant, because it is the least-due of the overdue
    // cards and was dropped by the slice. With no goal-relevant item INSIDE the
    // page's overdue segment (o_1, o_2 are both k1), the order is unchanged.
    expect(baseline.map((r) => r.id)).toEqual(['q_new', 'o_1', 'o_2']);
    expect(biased.map((r) => r.id)).toEqual(['q_new', 'o_1', 'o_2']);

    // RED-GREEN PROOF (命门): if the re-rank ran BEFORE the slice, it would float
    // the relevant overdue item `o_3` to the front of the overdue segment of the
    // FULL combined → [q_new, o_3, o_1, o_2], so slice(0,3) would return
    // {q_new, o_3, o_1} — pulling the less-due `o_3` IN over the more-due `o_2`
    // and changing the returned set. The set-equality assertion above would then
    // go red. `o_3` must be absent from the returned page.
    expect(biased.map((r) => r.id)).not.toContain('o_3');
  });

  it('is a STABLE partition — relative order preserved within the relevant and the non-relevant groups', async () => {
    await seedOverdueFixture();
    const biased = (await getDue(withGoalScope('k2'))).map((r) => r.id);

    // relevant group keeps b-before-d (original order), others keep a-before-c.
    expect(biased.indexOf('q_b')).toBeLessThan(biased.indexOf('q_d'));
    expect(biased.indexOf('q_a')).toBeLessThan(biased.indexOf('q_c'));
    // every relevant item precedes every non-relevant item.
    expect(biased.indexOf('q_d')).toBeLessThan(biased.indexOf('q_a'));
  });

  it('OFF-safe: no active goals → order byte-identical to today', async () => {
    await seedOverdueFixture();
    const baseline = await getDue(noGoals);
    const empty = await getDue({ listActiveGoalsFn: async () => [] });
    expect(empty.map((r) => r.id)).toEqual(baseline.map((r) => r.id));
    expect(empty.map((r) => r.id)).toEqual(['q_a', 'q_b', 'q_c', 'q_d']);
  });

  it('a goal whose scope intersects NO overdue items → order unchanged', async () => {
    await seedOverdueFixture();
    const baseline = await getDue(noGoals);
    const biased = await getDue(withGoalScope('k_nonexistent'));
    expect(biased.map((r) => r.id)).toEqual(baseline.map((r) => r.id));
    expect(setFingerprint(biased)).toEqual(setFingerprint(baseline));
  });

  it('all overdue items goal-relevant → order unchanged (nothing to float)', async () => {
    await seedOverdueFixture();
    const baseline = await getDue(noGoals);
    const biased = await getDue(withGoalScope('k1', 'k2', 'k3'));
    expect(biased.map((r) => r.id)).toEqual(baseline.map((r) => r.id));
    expect(setFingerprint(biased)).toEqual(setFingerprint(baseline));
  });

  it('default (real listActiveGoals) reads the goal table — biases when a goal row exists', async () => {
    await seedOverdueFixture();
    await seedGoal('goal_real', ['k2']);
    // No deps → route uses the real listActiveGoals against the seeded goal row.
    const biased = await getDue();
    expect(biased.map((r) => r.id)).toEqual(['q_b', 'q_d', 'q_a', 'q_c']);
  });
});
