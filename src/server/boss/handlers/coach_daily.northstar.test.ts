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

import { event, goal, material_fsrs_state, question } from '@/db/schema';
import { runCoach } from '@/server/boss/handlers/coach_daily';
import type { ActiveGoal } from '@/server/goals/queries';
import { beforeEach, describe, expect, it } from 'vitest';
import { GET as getDue } from '@/capabilities/practice/api/due';
import { resetDb, testDb } from '../../../../tests/helpers/db';

const NOW = new Date('2026-05-30T12:00:00.000Z');
const PAST = new Date('2026-05-29T12:00:00.000Z'); // overdue
const FUTURE = new Date('2026-06-30T12:00:00.000Z'); // not yet due

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

async function seedQuestion(id: string, createdAt: Date) {
  await testDb()
    .insert(question)
    .values({
      id,
      kind: 'short_answer',
      prompt_md: `P ${id}`,
      reference_md: null,
      knowledge_ids: ['k1'],
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
 */
async function seedReviewFixture() {
  await seedQuestion('q_overdue', new Date('2026-05-01T00:00:00.000Z'));
  await seedQuestion('q_future', new Date('2026-05-02T00:00:00.000Z'));
  await seedQuestion('q_never', new Date('2026-05-03T00:00:00.000Z'));
  await seedFsrsState('q_overdue', PAST);
  await seedFsrsState('q_future', FUTURE);
  await seedFailureAttempt('q_overdue', new Date('2026-04-20T00:00:00.000Z'));
  await seedFailureAttempt('q_never', new Date('2026-05-03T01:00:00.000Z'));
}

async function captureDueQueue(): Promise<unknown> {
  const res = await getDue(new Request('http://localhost/api/review/due?limit=50'));
  return (await res.json()) as { rows: unknown[] };
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

    // ND-5: the FSRS due queue is byte-identical — goals neither suppressed,
    // hid, preempted, nor rescheduled any review.
    expect(afterQueue).toEqual(baselineQueue);
    // And the underlying FSRS state rows (due times) are untouched.
    expect(afterFsrs).toEqual(baselineFsrs);
  });
});
