// YUK-143 / ADR-0025 — ND-5 CONSERVATION TEST (load-bearing invariant).
//
// The North-Star goal strand must be PURELY ADDITIVE: with active goal(s)
// present (and the Coach having run with a goal strand), the FSRS due-review
// queue — its ids, order, counts, due_at, fsrs_state — must be BYTE-IDENTICAL
// to the same fixture WITHOUT goals. A goal only adds direction (soft bias +
// tags); it must NOT suppress / hide / preempt / reschedule any review.
//
// This is the regression guard for the spec's hard constraint ND-5. If this
// test goes red after a goal/Coach change, the change violated ND-5 — fix the
// production code, never the test.
//
// DB test (testDb): NOT in fastTestInclude → runs in the vitest db config.

import type { ActiveGoal } from '@/capabilities/agency/server/goals/queries';
import { GET as getDue } from '@/capabilities/practice/api/due';
import { event, goal, material_fsrs_state, question } from '@/db/schema';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { runCoach } from './coach_daily';

const NOW = new Date('2026-05-30T12:00:00.000Z');
const MORE_PAST = new Date('2026-05-28T12:00:00.000Z'); // MORE overdue (earlier due_at)
const PAST = new Date('2026-05-29T12:00:00.000Z'); // overdue
// The /api/review/due handler compares against wall-clock `new Date()`, not NOW,
// so `FUTURE` must be far enough ahead that it stays not-yet-due at any real run
// time (the old 2026-06-30 value silently went stale — it is now in the past, so
// q_future leaked into the queue and the fixture became run-date-dependent).
const FUTURE = new Date('2099-06-30T12:00:00.000Z'); // not yet due (far future)

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

async function seedQuestion(id: string, createdAt: Date, knowledge_ids: string[] = ['k1']) {
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

async function seedFsrsState(questionId: string, dueAt: Date) {
  await testDb()
    .insert(material_fsrs_state)
    .values({
      id: `f_${questionId}`,
      subject_kind: 'question',
      subject_id: questionId,
      state: makeFsrsState(dueAt) as never,
      due_at: dueAt,
      last_review_event_id: null,
      updated_at: NOW,
    });
}

async function seedFailureAttempt(questionId: string, createdAt: Date) {
  await testDb()
    .insert(event)
    .values({
      id: `evt_attempt_${questionId}`,
      session_id: null,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'attempt',
      subject_kind: 'question',
      subject_id: questionId,
      outcome: 'failure',
      payload: { answer_md: 'wrong', answer_image_refs: [], referenced_knowledge_ids: ['k1'] },
      caused_by_event_id: null,
      task_run_id: null,
      cost_micro_usd: null,
      created_at: createdAt,
    });
}

/**
 * Seed a representative review fixture: an overdue card, a not-yet-due card,
 * and a never-reviewed card (failure attempt, no FSRS state row). Covers all
 * three branches of /api/review/due.
 *
 * X6 fix (redline-audit 2026-07-07): the fixture ALSO seeds a second, MORE-overdue
 * off-goal card (`q_overdue_offgoal`, knowledge `k2` ∉ goal scope `k1`). Without a
 * non-goal-relevant overdue item the soft re-rank (`rerankOverdueByGoals`) hits its
 * `others.length === 0` early-return (due-list.ts) and never reorders — so a byte-
 * identical (order-included) assertion stayed green only because the re-rank was a
 * no-op, leaving the reorder path unguarded here. With the off-goal card present the
 * overdue segment is {q_overdue_offgoal (more due), q_overdue (goal-relevant)}, so
 * an active goal genuinely floats `q_overdue` ahead of `q_overdue_offgoal` and the
 * ORDER changes — while the id-SET / counts / due_at / fsrs_state stay identical.
 */
async function seedReviewFixture() {
  await seedQuestion('q_overdue', new Date('2026-05-01T00:00:00.000Z'));
  await seedQuestion('q_overdue_offgoal', new Date('2026-05-01T12:00:00.000Z'), ['k2']);
  await seedQuestion('q_future', new Date('2026-05-02T00:00:00.000Z'));
  await seedQuestion('q_never', new Date('2026-05-03T00:00:00.000Z'));
  // q_overdue_offgoal is MORE overdue (earlier due_at) → it precedes q_overdue in
  // the baseline (no-goals) overdue order, so the goal re-rank has to move it.
  await seedFsrsState('q_overdue_offgoal', MORE_PAST);
  await seedFsrsState('q_overdue', PAST);
  await seedFsrsState('q_future', FUTURE);
  await seedFailureAttempt('q_overdue', new Date('2026-04-20T00:00:00.000Z'));
  await seedFailureAttempt('q_never', new Date('2026-05-03T01:00:00.000Z'));
}

type DueQueueRow = { id: string; knowledge_ids: string[]; fsrs_state: unknown };

async function captureDueQueue(): Promise<{ rows: DueQueueRow[] }> {
  const res = await getDue(new Request('http://localhost/api/review/due?limit=50'));
  return (await res.json()) as { rows: DueQueueRow[] };
}

/**
 * Order-INDEPENDENT ND-5 fingerprint. The id-SET, the count, and the per-id
 * fsrs_state (which carries every `due`) must be identical with vs without goals
 * — that is the SET-level conservation the four ND-5 prohibitions guarantee
 * structurally (goal data never enters the due SELECT stage). ORDER is
 * deliberately NOT part of the fingerprint: from W10 (YUK-167) the goal soft-bias
 * (rerankOverdueByGoals) MAY reorder the overdue segment of the already-selected
 * page, so an order-sensitive equality would false-red on a legal reorder.
 */
function dueQueueFingerprint(queue: { rows: DueQueueRow[] }) {
  return {
    count: queue.rows.length,
    sortedIds: queue.rows.map((r) => r.id).sort(),
    // fsrs_state keyed by id (order-independent) → proves no item was re-dued and
    // the same set of due times / states is returned.
    fsrsById: Object.fromEntries(queue.rows.map((r) => [r.id, r.fsrs_state])),
    // knowledge_ids keyed by id — restores the per-row payload coverage the old
    // order-sensitive toEqual had (a legal reorder must re-emit rows untouched).
    knowledgeById: Object.fromEntries(queue.rows.map((r) => [r.id, r.knowledge_ids])),
  };
}

async function snapshotFsrsRows() {
  const rows = await testDb()
    .select({
      subject_id: material_fsrs_state.subject_id,
      due_at: material_fsrs_state.due_at,
      state: material_fsrs_state.state,
    })
    .from(material_fsrs_state)
    .orderBy(material_fsrs_state.subject_id);
  return rows.map((r) => ({
    subject_id: r.subject_id,
    due_at: r.due_at.toISOString(),
    state: r.state,
  }));
}

// CoachTask stub that emits a goal-oriented strand referencing the active goal.
function coachWithGoalStrand(activeGoals: ActiveGoal[]) {
  const g = activeGoals[0];
  return async () => ({
    task_run_id: 'task_coach_goal',
    text: JSON.stringify({
      daily_focus: '今天先复盘，再朝目标推进',
      review_session_proposal: { count: 12, estimated_minutes: 20 },
      plan_adjustments: [],
      maintenance_proposals: [],
      goal_ids: g ? [g.id] : [],
      goal_strand: g
        ? [
            {
              serves_goal_id: g.id,
              knowledge_ids: g.scope_knowledge_ids,
              focus: '推进目标覆盖的薄弱节点',
            },
          ]
        : [],
    }),
    finishReason: 'stop',
    usage: { inputTokens: 1, outputTokens: 2 },
    cost_usd: 0.001,
  });
}

describe('ND-5 conservation — North-Star goal strand is purely additive', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('FSRS due queue is byte-identical with vs without active goals + Coach goal strand', async () => {
    const db = testDb();

    // 1. Baseline: review fixture, NO goals. Capture the due queue + FSRS rows.
    await seedReviewFixture();
    const baselineQueue = await captureDueQueue();
    const baselineFsrs = await snapshotFsrsRows();

    // 2. Introduce an active goal whose scope overlaps the review knowledge,
    //    then run the Coach WITH a goal strand (the full additive path).
    await db.insert(goal).values({
      id: 'goal_1',
      title: '能流畅读《史记》',
      subject_id: 'wenyan',
      scope_knowledge_ids: ['k1'],
      sequence_hint: 0,
      status: 'active',
      source: 'goal_scope_proposal',
      source_ref: 'p_goal_1',
      created_at: NOW,
      updated_at: NOW,
    });

    const activeGoals: ActiveGoal[] = [
      {
        id: 'goal_1',
        title: '能流畅读《史记》',
        subject_id: 'wenyan',
        scope_knowledge_ids: ['k1'],
        sequence_hint: 0,
      },
    ];

    const coachResult = await runCoach(db, 'daily', {
      listProposalInboxRowsFn: async () => [],
      listActiveGoalsFn: async () => activeGoals,
      buildMcpServerFn: () => ({ name: 'fake-loom' }) as never,
      runAgentTaskFn: coachWithGoalStrand(activeGoals),
      writeEventFn: async (_db, input) => input.id,
      now: () => NOW,
    });
    // Coach ran and emitted a plan (the goal strand is in its output).
    expect(coachResult.processed).toBe(1);

    // 3. Re-capture the due queue + FSRS rows AFTER the goal + Coach run.
    const afterQueue = await captureDueQueue();
    const afterFsrs = await snapshotFsrsRows();

    // ND-5 (SET-level conservation — the four prohibitions): the id-SET, count,
    // every due_at + fsrs_state are identical with vs without goals. Goals
    // neither suppressed, hid, preempted, nor rescheduled any review.
    expect(dueQueueFingerprint(afterQueue)).toEqual(dueQueueFingerprint(baselineQueue));
    // And the underlying FSRS state rows (due times) are untouched (Coach side:
    // runCoach never UPDATEs material_fsrs_state / changes due).
    expect(afterFsrs).toEqual(baselineFsrs);

    // ORDER-level: the W10 goal soft-bias (rerankOverdueByGoals) DID reorder the
    // overdue segment. `q_overdue_offgoal` (knowledge k2 ∉ goal scope, and MORE
    // overdue) leads the goal-relevant `q_overdue` in the no-goals baseline; with
    // the active goal the goal-relevant card floats ahead of it. Asserting the
    // order genuinely CHANGED proves the re-rank path is actually exercised here
    // — guarding against the fixture regressing to an all-goal-relevant no-op
    // (the pre-2026-07-07 degeneration this test used to hide). The full
    // behavioral matrix for the re-rank (over-limit 命门 guard, stable partition,
    // off-safe) is owned by src/capabilities/practice/api/due-soft-bias.db.test.ts.
    const baselineOrder = baselineQueue.rows.map((r) => r.id);
    const afterOrder = afterQueue.rows.map((r) => r.id);
    expect(afterOrder).not.toEqual(baselineOrder);
    // baseline: more-overdue off-goal precedes the goal-relevant card…
    expect(baselineOrder.indexOf('q_overdue_offgoal')).toBeLessThan(
      baselineOrder.indexOf('q_overdue'),
    );
    // …after the goal soft-bias, the goal-relevant card floats ahead of it.
    expect(afterOrder.indexOf('q_overdue')).toBeLessThan(afterOrder.indexOf('q_overdue_offgoal'));
  });
});
