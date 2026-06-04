// YUK-203 U4 / D5 / CO §6.1 — ReviewPlanTask DomainTools DB test.
//
// Covers: write_review_plan contract validation + tool_quiz artifact shape
// (flat ToolState transition encoding) + needs[] round-trip; and
// select_review_question_candidates routing through the due path with the
// Guard-B draft exclusion (draft_status='draft' questions never enter the pool).

import { beforeEach, describe, expect, it } from 'vitest';

import { artifact, knowledge, material_fsrs_state, question } from '@/db/schema';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import {
  type ReviewPlanContractT,
  selectReviewQuestionCandidatesTool,
  writeReviewPlanTool,
} from './review-plan-tools';
import type { ToolContext } from './types';

const db = testDb();

function ctx(): ToolContext {
  return {
    db,
    taskRunId: 'tr_review_plan_test',
    callerActor: { kind: 'agent', ref: 'review_plan' },
  };
}

async function seedKnowledge(id: string) {
  const now = new Date();
  await db.insert(knowledge).values({
    id,
    name: id,
    domain: 'wenyan',
    parent_id: null,
    merged_from: [],
    proposed_by_ai: false,
    approval_status: 'approved',
    created_at: now,
    updated_at: now,
    version: 0,
  });
}

async function seedQuestion(opts: { id: string; knowledgeId: string; draft: boolean }) {
  const now = new Date();
  await db.insert(question).values({
    id: opts.id,
    kind: 'short_answer',
    prompt_md: `题目 ${opts.id}`,
    reference_md: '参考',
    rubric_json: { required_points: ['p'] } as never,
    choices_md: null,
    judge_kind_override: 'semantic',
    knowledge_ids: [opts.knowledgeId],
    difficulty: 3,
    source: 'test',
    source_ref: opts.knowledgeId,
    draft_status: opts.draft ? 'draft' : null,
    created_by: { by: 'ai', task_kind: 'QuizGenTask', task_run_id: 'tr' } as never,
    metadata: {} as never,
    created_at: now,
    updated_at: now,
  });
}

async function seedDueKnowledgeFsrs(knowledgeId: string) {
  const now = new Date();
  await db.insert(material_fsrs_state).values({
    id: `fsrs_${knowledgeId}`,
    subject_kind: 'knowledge',
    subject_id: knowledgeId,
    // Minimal FSRS card; only due_at <= now matters for the due query.
    state: {
      due: new Date(now.getTime() - 1000).toISOString(),
      stability: 1,
      difficulty: 5,
      elapsed_days: 1,
      scheduled_days: 1,
      reps: 1,
      lapses: 0,
      state: 2,
      last_review: new Date(now.getTime() - 86_400_000).toISOString(),
    } as never,
    due_at: new Date(now.getTime() - 1000),
    updated_at: now,
  });
}

function validPlan(overrides: Partial<ReviewPlanContractT> = {}): ReviewPlanContractT {
  return {
    subject_ids: ['wenyan'],
    labels: { paper_kind: 'daily', intent_tags: ['weak_recovery'] },
    rationale: '复盘虚词',
    sections: [
      {
        subject_id: 'wenyan',
        knowledge_ids: ['k_zhi'],
        assignments: [
          {
            question_id: 'q_active',
            primary_knowledge_id: 'k_zhi',
            secondary_knowledge_ids: [],
          },
        ],
      },
    ],
    guardrail_checks: {
      within_time_budget: true,
      candidate_pool_only: true,
      every_assignment_has_primary_knowledge: true,
      no_direct_scheduler_mutation: true,
    },
    needs: [],
    ...overrides,
  };
}

describe('write_review_plan', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('writes a tool_quiz artifact with the flat ToolState transition encoding', async () => {
    const out = await writeReviewPlanTool.execute(ctx(), {
      plan: validPlan(),
      mode: 'initial_plan',
    });
    expect(out.question_count).toBe(1);
    expect(out.subject_ids).toEqual(['wenyan']);

    const rows = await db.select().from(artifact);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.type).toBe('tool_quiz');
    expect(row.tool_kind).toBe('review_plan');
    expect(row.intent_source).toBe('review_plan');
    // Flat ToolState: question_ids + the full plan in session_meta (U5 promotes).
    const toolState = row.tool_state as { question_ids: string[]; session_meta: { mode: string } };
    expect(toolState.question_ids).toEqual(['q_active']);
    expect(toolState.session_meta.mode).toBe('initial_plan');
  });

  it('round-trips needs[] on the output', async () => {
    const out = await writeReviewPlanTool.execute(ctx(), {
      plan: validPlan({
        needs: [{ kind: 'question_generation', knowledge_id: 'k_qi', reason: 'no candidate' }],
      }),
      mode: 'initial_plan',
    });
    expect(out.needs).toEqual([
      { kind: 'question_generation', knowledge_id: 'k_qi', reason: 'no candidate' },
    ]);
  });

  it('rejects when subject_ids != unique(sections[].subject_id)', async () => {
    await expect(
      writeReviewPlanTool.execute(ctx(), {
        plan: validPlan({ subject_ids: ['wenyan', 'math'] }),
        mode: 'initial_plan',
      }),
    ).rejects.toThrow(/subject_ids invariant/);
  });

  it('rejects when guardrail every_assignment_has_primary_knowledge is false', async () => {
    await expect(
      writeReviewPlanTool.execute(ctx(), {
        plan: validPlan({
          guardrail_checks: {
            within_time_budget: true,
            candidate_pool_only: true,
            every_assignment_has_primary_knowledge: false,
            no_direct_scheduler_mutation: true,
          },
        }),
        mode: 'initial_plan',
      }),
    ).rejects.toThrow(/every_assignment_has_primary_knowledge/);
  });
});

describe('select_review_question_candidates', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('excludes draft questions (Guard-B) via the due path', async () => {
    await seedKnowledge('k_zhi');
    await seedQuestion({ id: 'q_active', knowledgeId: 'k_zhi', draft: false });
    await seedQuestion({ id: 'q_draft', knowledgeId: 'k_zhi', draft: true });
    await seedDueKnowledgeFsrs('k_zhi');

    const out = await selectReviewQuestionCandidatesTool.execute(ctx(), {
      knowledgeIds: ['k_zhi'],
      constraints: { limit: 10 },
    });
    const ids = out.candidates.map((c) => c.question_id);
    expect(ids).toContain('q_active');
    expect(ids).not.toContain('q_draft');
  });
});
