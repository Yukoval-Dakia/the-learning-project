import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryReviewDue as publicQueryReviewDue } from '@/capabilities/practice/public';
import type { Db, Tx } from '@/db/client';
import { knowledge, material_fsrs_state, question } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { ApiError } from '@/kernel/http';
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

async function mixedPool(db: Db | Tx = testDb()) {
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
  it('reads uncommitted rows and goals through the injected transaction', async () => {
    const db = testDb();
    const rollback = new Error('discard injected transaction fixtures');
    await expect(
      db.transaction(async (tx) => {
        await mixedPool(tx);
        const listActiveGoalsFn = vi.fn(async (activeDb: Db | Tx) => {
          expect(activeDb).toBe(tx);
          return [
            {
              id: 'transaction_goal',
              title: '控制变量',
              subject_id: null,
              scope_knowledge_ids: ['k_physics'],
              scope_mode: 'explicit' as const,
              sequence_hint: 0,
            },
          ];
        });
        // The singleton uses another connection and cannot see these rows.
        const result = await publicQueryReviewDue(tx, { limit: 200 }, { listActiveGoalsFn });
        expect(result.rows.map((row) => row.id)).toEqual([
          'never_reviewed',
          'physics_due',
          'math_first',
          'math_second',
        ]);
        expect(result.rows[0]).toMatchObject({
          activity_ref: { kind: 'question', id: 'never_reviewed' },
          fsrs_subject_kind: 'knowledge',
          fsrs_subject_id: 'k_new',
          fsrs_state: null,
          last_failure_event: {
            id: 'failure_original',
            correction_state: { state: 'active', effective_event_id: 'failure_original' },
          },
        });
        expect(result.rows.every((row) => row.created_at instanceof Date)).toBe(true);
        expect(listActiveGoalsFn).toHaveBeenCalledExactlyOnceWith(tx);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect((await queryReviewDue(db)).rows).toEqual([]);
  });

  it('applies typed default, integer and bounded limits without a Request', async () => {
    const db = testDb();
    const now = new Date();
    const due = new Date(now.getTime() - 1000);
    const entries = Array.from({ length: 205 }, (_, index) => ({
      id: `limit_${String(index).padStart(3, '0')}`,
      kind: 'short_answer',
      prompt_md: '逐步说明证据、假设与反例。'.repeat(110),
      reference_md: '核对每一步推论的适用范围。'.repeat(110),
      knowledge_ids: [],
      source: 'manual',
      created_at: new Date(now.getTime() + index),
      updated_at: now,
    }));
    await db.insert(question).values(entries);
    await db.insert(material_fsrs_state).values(
      entries.map((entry) => ({
        id: `state_${entry.id}`,
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
      })),
    );
    for (const [limit, expected] of [
      [undefined, 20],
      [Number.NaN, 20],
      [0, 1],
      [-5, 1],
      [2.9, 2],
      [200, 200],
      [1000, 200],
      [Number.POSITIVE_INFINITY, 200],
      [Number.NEGATIVE_INFINITY, 1],
    ] as const) {
      const result = await queryReviewDue(db, { limit, now });
      expect(result.rows, `limit=${limit}`).toHaveLength(expected);
      expect(result.rows[0]).toMatchObject({
        id: 'limit_000',
        prompt_md: entries[0].prompt_md.slice(0, 1000),
        reference_md: entries[0].reference_md.slice(0, 1000),
      });
    }
    expect((await queryReviewDue(db, { now: new Date(due.getTime() - 1) })).rows).toEqual([]);
    expect((await queryReviewDue(db, { limit: 1, now: due })).rows).toHaveLength(1);
    for (const [raw, expected] of [
      ['', 20],
      ['abc', 20],
      ['0', 1],
      ['1e2', 1],
      ['2.9', 2],
      ['999', 200],
    ] as const) {
      const response = await handleReviewDue(
        new Request(`http://local/api/review/due?limit=${raw}`),
        { db },
      );
      expect(response.status).toBe(200);
      expect((await response.json()).rows, `HTTP limit=${raw}`).toHaveLength(expected);
    }
  });

  it('propagates typed errors and preserves HTTP error mapping', async () => {
    await mixedPool();
    const error = new ApiError('due_read_unavailable', 'Review read unavailable', 409);
    const deps = {
      listActiveGoalsFn: async () => {
        throw error;
      },
    };
    await expect(queryReviewDue(testDb(), {}, deps)).rejects.toBe(error);
    const response = await handleReviewDue(new Request('http://local/api/review/due'), {
      db: testDb(),
      ...deps,
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'due_read_unavailable',
      message: 'Review read unavailable',
    });
  });
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
