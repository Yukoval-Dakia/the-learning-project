import { event, knowledge, material_fsrs_state, mistake_variant, question } from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
import { createId } from '@paralleldrive/cuid2';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { queryMistakesTool } from './query-mistakes';
import type { ToolContext } from './types';

function ctx(): ToolContext {
  return {
    db: testDb(),
    taskRunId: 'tr_test',
    callerActor: { kind: 'user', ref: 'test' },
  };
}

async function seedKnowledge(id: string, name: string) {
  const db = testDb();
  const now = new Date();
  await db.insert(knowledge).values({
    id,
    name,
    domain: 'wenyan',
    created_at: now,
    updated_at: now,
  });
}

async function seedQuestion(id: string, knowledgeIds: string[]) {
  const db = testDb();
  const now = new Date();
  await db.insert(question).values({
    id,
    kind: 'short_answer',
    prompt_md: `prompt for ${id} — ${'x'.repeat(10)}`,
    reference_md: 'ref',
    source: 'manual',
    knowledge_ids: knowledgeIds,
    created_at: now,
    updated_at: now,
  });
}

async function seedFailureAttempt(
  attemptId: string,
  questionId: string,
  knowledgeIds: string[],
  createdAt = new Date(),
) {
  await writeEvent(testDb(), {
    id: attemptId,
    session_id: null,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'attempt',
    subject_kind: 'question',
    subject_id: questionId,
    outcome: 'failure',
    payload: {
      answer_md: 'wrong answer',
      answer_image_refs: [],
      referenced_knowledge_ids: knowledgeIds,
    },
    created_at: createdAt,
  });
}

async function seedJudge(attemptId: string, primary: string, knowledgeIds: string[]) {
  await writeEvent(testDb(), {
    id: createId(),
    session_id: null,
    actor_kind: 'agent',
    actor_ref: 'AttributionTask',
    action: 'judge',
    subject_kind: 'event',
    subject_id: attemptId,
    outcome: 'success',
    caused_by_event_id: attemptId,
    payload: {
      cause: {
        primary_category: primary,
        secondary_categories: [],
        analysis_md: `agent says ${primary}`,
        confidence: 0.9,
      },
      referenced_knowledge_ids: knowledgeIds,
    },
    created_at: new Date(),
  });
}

async function seedFsrsState(questionId: string, dueAt: Date) {
  const db = testDb();
  await db.insert(material_fsrs_state).values({
    id: createId(),
    subject_kind: 'question',
    subject_id: questionId,
    state: { stability: 0, difficulty: 0, due: dueAt.toISOString(), reps: 0, lapses: 0 } as never,
    due_at: dueAt,
    last_review_event_id: null,
    updated_at: new Date(),
  });
}

describe('queryMistakesTool', () => {
  beforeEach(async () => {
    await resetDb();
    await seedKnowledge('k_xuci', '虚词');
    await seedKnowledge('k_shici', '实词');
  });

  it('returns default 20-limit list of failure attempts with prompt snippets', async () => {
    await seedQuestion('q1', ['k_xuci']);
    await seedQuestion('q2', ['k_shici']);
    await seedFailureAttempt('att_1', 'q1', ['k_xuci']);
    await seedFailureAttempt('att_2', 'q2', ['k_shici']);

    const output = await queryMistakesTool.execute(ctx(), {});

    expect(output.total).toBe(2);
    expect(output.mistakes.map((m) => m.question_id).sort()).toEqual(['q1', 'q2']);
    expect(output.mistakes.every((m) => m.prompt_snippet.length > 0)).toBe(true);
    expect(output.filter_applied.limit).toBe(20);
  });

  it('filters by causeCategoryId via effective cause resolution', async () => {
    await seedQuestion('q1', ['k_xuci']);
    await seedQuestion('q2', ['k_xuci']);
    await seedFailureAttempt('att_1', 'q1', ['k_xuci']);
    await seedFailureAttempt('att_2', 'q2', ['k_xuci']);
    await seedJudge('att_1', 'concept', ['k_xuci']);
    await seedJudge('att_2', 'memory', ['k_xuci']);

    const output = await queryMistakesTool.execute(ctx(), {
      filter: { causeCategoryId: 'concept' },
    });

    expect(output.total).toBe(1);
    expect(output.mistakes[0].question_id).toBe('q1');
    expect(output.mistakes[0].cause?.primary_category).toBe('concept');
    expect(output.filter_applied.cause).toBe('concept');
  });

  it('filters by knowledgeId before cause resolution', async () => {
    await seedQuestion('q1', ['k_xuci']);
    await seedQuestion('q2', ['k_shici']);
    await seedFailureAttempt('att_1', 'q1', ['k_xuci']);
    await seedFailureAttempt('att_2', 'q2', ['k_shici']);

    const output = await queryMistakesTool.execute(ctx(), {
      filter: { knowledgeId: 'k_xuci' },
    });

    expect(output.total).toBe(1);
    expect(output.mistakes[0].question_id).toBe('q1');
    expect(output.filter_applied.knowledge).toBe('k_xuci');
  });

  it('filters by dueWithinDays using material_fsrs_state', async () => {
    await seedQuestion('q1', ['k_xuci']);
    await seedQuestion('q2', ['k_xuci']);
    await seedFailureAttempt('att_1', 'q1', ['k_xuci']);
    await seedFailureAttempt('att_2', 'q2', ['k_xuci']);
    // q1 due in 1 day, q2 due in 30 days
    await seedFsrsState('q1', new Date(Date.now() + 86_400_000));
    await seedFsrsState('q2', new Date(Date.now() + 30 * 86_400_000));

    const output = await queryMistakesTool.execute(ctx(), {
      filter: { dueWithinDays: 7 },
    });

    expect(output.total).toBe(1);
    expect(output.mistakes[0].question_id).toBe('q1');
    expect(output.mistakes[0].review_state?.due_at).toBeTruthy();
    expect(output.filter_applied.due_within_days).toBe(7);
  });

  it('includes variants when includeVariants=true', async () => {
    await seedQuestion('q1', ['k_xuci']);
    await seedFailureAttempt('att_1', 'q1', ['k_xuci']);
    const db = testDb();
    const now = new Date();
    await db.insert(mistake_variant).values({
      id: 'mv_1',
      parent_question_id: 'q1',
      variant_question_id: null,
      proposal_event_id: null,
      status: 'pending',
      failure_reasons: [],
      cause_category: 'concept',
      created_at: now,
      updated_at: now,
    });

    const output = await queryMistakesTool.execute(ctx(), { includeVariants: true });

    expect(output.mistakes[0].variants).toEqual([{ id: 'mv_1', status: 'pending' }]);
  });

  it('caps limit at 50 and rejects 0 via Zod', async () => {
    await expect(queryMistakesTool.execute(ctx(), { filter: { limit: 100 } })).rejects.toThrow();
    await expect(queryMistakesTool.execute(ctx(), { filter: { limit: 0 } })).rejects.toThrow();
  });

  it('returns empty list with stable schema when no mistakes exist', async () => {
    const output = await queryMistakesTool.execute(ctx(), {});
    expect(output.total).toBe(0);
    expect(output.mistakes).toEqual([]);
    expect(output.filter_applied.limit).toBe(20);
  });

  it('summarize formats folded UI string', () => {
    const summary = queryMistakesTool.summarize(
      { filter: { causeCategoryId: 'concept', dueWithinDays: 7 } },
      {
        mistakes: [
          {
            event_id: 'e',
            question_id: 'q',
            prompt_snippet: 'p',
            attempted_at: 'now',
            cause: null,
            review_state: { due_at: 'now', is_due: true },
            knowledge_ids: [],
          },
        ],
        total: 1,
        filter_applied: {
          cause: 'concept',
          knowledge: null,
          due_within_days: 7,
          since_days: null,
          limit: 20,
        },
      },
    );
    expect(summary).toContain('mistakes');
    expect(summary).toContain('1 rows');
    expect(summary).toContain('1 due');
    expect(summary).toContain('cause=concept');
    expect(summary).toContain('due≤7d');
  });

  it('contract: mirrorEvent / effect / costClass match spec', () => {
    expect(queryMistakesTool.mirrorEvent).toBe('when_user_visible');
    expect(queryMistakesTool.effect).toBe('read');
    expect(queryMistakesTool.costClass).toBe('local');
  });

  it.todo('returns successful empty result for unsupported subject (no crash)');
  // Reserved by spec; nothing in current schema declares subject-level
  // support boundaries — the tool is subject-agnostic for now. Promote to
  // a real test once SubjectProfile.judgeCapabilities gates tool access.
  void event; // satisfy import-side-effect ESLint policy if introduced later
});
