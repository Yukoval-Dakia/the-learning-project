import { beforeEach, describe, expect, it } from 'vitest';
import { knowledge, material_fsrs_state, question } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import type { ToolContext } from '@/kernel/tools/types';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { handleReviewDue, queryReviewDue } from './due-list';
import { getReviewDueTool } from './tools/question-context';

beforeEach(resetDb);

function context(): ToolContext {
  return {
    db: testDb(),
    taskRunId: 'review-query-contract',
    callerActor: { kind: 'agent', ref: 'copilot' },
  };
}

async function mixedPool() {
  const db = testDb();
  const now = new Date();
  await db.insert(knowledge).values([
    { id: 'k_math', name: '数学推断', domain: 'math', created_at: now, updated_at: now },
    { id: 'k_physics', name: '控制变量', domain: 'physics', created_at: now, updated_at: now },
    { id: 'k_new', name: '古文关系', domain: 'yuwen', created_at: now, updated_at: now },
  ]);
  const entries = [
    { id: 'math_first', knowledge_ids: ['k_math'] },
    { id: 'math_second', knowledge_ids: ['k_math'] },
    { id: 'physics_due', knowledge_ids: ['k_physics'] },
    { id: 'never_reviewed', knowledge_ids: ['k_new'] },
    { id: 'future', knowledge_ids: ['k_physics'] },
  ];
  await db.insert(question).values(
    entries.map((entry) => ({
      ...entry,
      kind: 'short_answer',
      prompt_md: `解释 ${entry.id} 的依据、边界和反例。`,
      reference_md: '检查证据链与独立变量。',
      source: 'manual',
      created_at: now,
      updated_at: now,
    })),
  );
  const states = [
    { id: 'math_first', offset: -40000 },
    { id: 'math_second', offset: -30000 },
    { id: 'physics_due', offset: -20000 },
    { id: 'future', offset: 86400000 },
  ];
  await db.insert(material_fsrs_state).values(
    states.map((entry) => {
      const due = new Date(now.getTime() + entry.offset);
      return {
        id: `fsrs_${entry.id}`,
        subject_kind: 'question',
        subject_id: entry.id,
        due_at: due,
        state: {
          due,
          stability: 1.5,
          difficulty: 5,
          scheduled_days: 1,
          learning_steps: 0,
          reps: 1,
          lapses: 0,
          state: 'review' as const,
          last_review: null,
        },
        updated_at: now,
      };
    }),
  );
  await writeEvent(db, {
    id: 'failure_original',
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'attempt',
    subject_kind: 'question',
    subject_id: 'never_reviewed',
    outcome: 'failure',
    session_id: null,
    payload: {
      answer_md: '将全部关系都读为代词，遗漏上下句指向。',
      answer_image_refs: [],
      referenced_knowledge_ids: ['k_new'],
    },
    created_at: now,
  });
}

describe('HTTP actionable queue and Pi diagnostic query contracts', () => {
  it('retains subject balancing and goal ordering in the typed HTTP query', async () => {
    await mixedPool();
    const deps = {
      listActiveGoalsFn: async () => [
        {
          id: 'goal_physics',
          title: '变量控制',
          subject_id: null,
          scope_knowledge_ids: ['k_physics'],
          scope_mode: 'explicit' as const,
          sequence_hint: 0,
        },
      ],
    };
    const selected = await queryReviewDue(
      testDb(),
      { limit: 3 },
      { listActiveGoalsFn: async () => [] },
    );
    expect(selected.rows.map((row) => row.id)).toEqual([
      'never_reviewed',
      'math_first',
      'physics_due',
    ]);
    const reordered = await queryReviewDue(testDb(), { limit: 3 }, deps);
    expect(reordered.rows.map((row) => row.id)).toEqual([
      'never_reviewed',
      'physics_due',
      'math_first',
    ]);
    const http = await handleReviewDue(new Request('http://local/api/review/due?limit=3'), {
      db: testDb(),
      ...deps,
    });
    expect(await http.json()).toEqual(JSON.parse(JSON.stringify(reordered)));
    expect(reordered.rows.map((row) => row.id)).not.toContain('future');
  });

  it('preserves Pi never-reviewed, overdue, future coverage and knowledge filtering', async () => {
    await mixedPool();
    const all = await getReviewDueTool.execute(context(), { limit: 20 });
    expect(all.rows.map((row) => row.question_id)).toEqual([
      'never_reviewed',
      'math_first',
      'math_second',
      'physics_due',
    ]);
    expect(all.queue_summary).toMatchObject({ never_reviewed_count: 1, overdue_count: 3 });
    expect(all.future_projections).toMatchObject([{ subject_id: 'future', timing: 'future' }]);
    expect(all.fsrs_projection_summary).toMatchObject({
      due_now_state_count: 3,
      future_state_count: 1,
      supports_actionable_queue_claim: false,
    });
    const filtered = await getReviewDueTool.execute(context(), {
      limit: 20,
      knowledgeIds: ['k_physics'],
    });
    expect(filtered.rows.map((row) => row.question_id)).toEqual(['physics_due']);
    expect(filtered.future_projections.map((row) => row.subject_id)).toEqual(['future']);
    expect(filtered.fsrs_projection_summary).toMatchObject({
      subject_scope: 'material_fsrs_state_rows_filtered_by_knowledge_ids',
      total_state_count: 2,
    });
    expect(filtered.queue_coverage).toMatchObject({
      completeness: 'unknown',
      supports_exhaustive_zero_claim: false,
    });
    expect(filtered.queue_assertion).toMatchObject({
      cleared: false,
      actionable_due_total_count: null,
    });
  });

  it('keeps a zero returned page unknown even when future projections exist', async () => {
    await mixedPool();
    const db = testDb();
    await db.insert(knowledge).values({
      id: 'k_future_only',
      name: '未来计划',
      domain: 'history',
      created_at: new Date(),
      updated_at: new Date(),
    });
    const due = new Date(Date.now() + 172800000);
    await db.insert(material_fsrs_state).values({
      id: 'future_only_projection',
      subject_kind: 'knowledge',
      subject_id: 'k_future_only',
      due_at: due,
      state: {
        due,
        stability: 1.5,
        difficulty: 5,
        scheduled_days: 2,
        learning_steps: 0,
        reps: 1,
        lapses: 0,
        state: 'review' as const,
        last_review: null,
      },
    });
    const empty = await getReviewDueTool.execute(context(), { knowledgeIds: ['k_future_only'] });
    expect(empty.rows).toEqual([]);
    expect(empty.future_projection_coverage).toMatchObject({
      total_future_count: 1,
      complete: true,
    });
    expect(empty.queue_coverage).toMatchObject({
      completeness: 'unknown',
      total_matching_count: null,
      supports_exhaustive_zero_claim: false,
    });
    expect(empty.queue_assertion).toMatchObject({
      cleared: null,
      actionable_due_returned_count: 0,
      actionable_due_total_count: null,
      queued_entity_count: null,
    });
  });
});
