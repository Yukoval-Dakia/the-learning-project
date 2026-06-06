// YUK-203 U4 / D5 / CO §6.1 — ReviewPlanTask DomainTools DB test.
//
// Covers: write_review_plan contract validation + tool_quiz artifact shape
// (flat ToolState transition encoding) + needs[] round-trip; and
// select_review_question_candidates routing through the due path with the
// Guard-B draft exclusion (draft_status='draft' questions never enter the pool).

import { eq } from 'drizzle-orm';
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

async function seedQuestion(opts: {
  id: string;
  knowledgeId: string;
  draft: boolean;
  // Extra knowledge ids the question also covers (so an assignment may legally
  // reference them). Defaults to [].
  extraKnowledgeIds?: string[];
  // YUK-226 S2-5a — override source/metadata so a seeded question derives a
  // specific tier (deriveSourceTier reads both). Defaults: source='test',
  // metadata={} → tier 4 generated.
  source?: string;
  metadata?: Record<string, unknown>;
}) {
  const now = new Date();
  await db.insert(question).values({
    id: opts.id,
    kind: 'short_answer',
    prompt_md: `题目 ${opts.id}`,
    reference_md: '参考',
    rubric_json: { required_points: ['p'] } as never,
    choices_md: null,
    judge_kind_override: 'semantic',
    knowledge_ids: [opts.knowledgeId, ...(opts.extraKnowledgeIds ?? [])],
    difficulty: 3,
    source: opts.source ?? 'test',
    source_ref: opts.knowledgeId,
    draft_status: opts.draft ? 'draft' : null,
    created_by: { by: 'ai', task_kind: 'QuizGenTask', task_run_id: 'tr' } as never,
    metadata: (opts.metadata ?? {}) as never,
    created_at: now,
    updated_at: now,
  });
}

async function seedDueQuestionFsrs(questionId: string) {
  const now = new Date();
  await db.insert(material_fsrs_state).values({
    id: `fsrs_q_${questionId}`,
    // Legacy question-keyed FSRS row (subject_kind='question') — the branch
    // codex #3357817910 flagged for the missing draft filter.
    subject_kind: 'question',
    subject_id: questionId,
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
    // Existence backstop (#3357652733): q_active must resolve to a real,
    // non-draft question for the happy-path contract tests to persist.
    await seedKnowledge('k_zhi');
    await seedQuestion({ id: 'q_active', knowledgeId: 'k_zhi', draft: false });
  });

  // Shared helper: re-seed q_active so it also covers k_secondary, and add a
  // q_secondary that covers k_qi — so coverage-valid plans in the union test
  // (and below) pass the #3357817923 coverage gate.
  async function reseedWithCoverage() {
    await seedQuestion({
      id: 'q_active_cov',
      knowledgeId: 'k_zhi',
      draft: false,
      extraKnowledgeIds: ['k_secondary'],
    });
    await seedQuestion({ id: 'q_secondary', knowledgeId: 'k_qi', draft: false });
  }

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

  // #3357652733 — existence + non-draft backstop against planner hallucination.
  it('rejects a hallucinated (non-existent) assignment question_id', async () => {
    await expect(
      writeReviewPlanTool.execute(ctx(), {
        plan: validPlan({
          sections: [
            {
              subject_id: 'wenyan',
              knowledge_ids: ['k_zhi'],
              assignments: [
                {
                  question_id: 'q_ghost',
                  primary_knowledge_id: 'k_zhi',
                  secondary_knowledge_ids: [],
                },
              ],
            },
          ],
        }),
        mode: 'initial_plan',
      }),
    ).rejects.toThrow(/do not exist.*q_ghost/);
    // Nothing persisted on rejection.
    expect(await db.select().from(artifact)).toHaveLength(0);
  });

  it('rejects a draft assignment question_id (Guard-B, unrunnable)', async () => {
    await seedQuestion({ id: 'q_draft', knowledgeId: 'k_zhi', draft: true });
    await expect(
      writeReviewPlanTool.execute(ctx(), {
        plan: validPlan({
          sections: [
            {
              subject_id: 'wenyan',
              knowledge_ids: ['k_zhi'],
              assignments: [
                {
                  question_id: 'q_draft',
                  primary_knowledge_id: 'k_zhi',
                  secondary_knowledge_ids: [],
                },
              ],
            },
          ],
        }),
        mode: 'initial_plan',
      }),
    ).rejects.toThrow(/draft.*q_draft/);
  });

  it('passes when all assignment question_ids exist and are non-draft', async () => {
    const out = await writeReviewPlanTool.execute(ctx(), {
      plan: validPlan(),
      mode: 'initial_plan',
    });
    expect(out.question_count).toBe(1);
    expect(await db.select().from(artifact)).toHaveLength(1);
  });

  // #3357652748 — knowledge_ids derived from the full union even when
  // section-level knowledge_ids is omitted.
  it('derives artifact knowledge_ids from the assignment union when section knowledge_ids omitted', async () => {
    await reseedWithCoverage();
    const out = await writeReviewPlanTool.execute(ctx(), {
      plan: validPlan({
        sections: [
          {
            subject_id: 'wenyan',
            // section-level knowledge_ids EMPTY (the .default([]) runtime state
            // when the planner omits them) — the artifact must still carry the
            // full union derived from the assignments.
            knowledge_ids: [],
            assignments: [
              {
                question_id: 'q_active_cov',
                primary_knowledge_id: 'k_zhi',
                secondary_knowledge_ids: ['k_secondary'],
              },
              {
                question_id: 'q_secondary',
                primary_knowledge_id: 'k_qi',
                secondary_knowledge_ids: [],
              },
            ],
          },
        ],
      }),
      mode: 'initial_plan',
    });

    const rows = await db.select().from(artifact).where(eq(artifact.id, out.artifact_id));
    expect(rows).toHaveLength(1);
    // Union of every assignment's primary + secondary knowledge ids.
    expect([...rows[0].knowledge_ids].sort()).toEqual(['k_qi', 'k_secondary', 'k_zhi']);
  });

  // #3357817927 — refuse an empty paper (no assignments → questionIds empty).
  it('rejects an empty review paper (no assignments)', async () => {
    await expect(
      writeReviewPlanTool.execute(ctx(), {
        plan: validPlan({ subject_ids: [], sections: [] }),
        mode: 'initial_plan',
      }),
    ).rejects.toThrow(/refusing to write an empty review paper/);
    expect(await db.select().from(artifact)).toHaveLength(0);
  });

  it('rejects when every section has empty assignments', async () => {
    await expect(
      writeReviewPlanTool.execute(ctx(), {
        plan: validPlan({
          sections: [{ subject_id: 'wenyan', knowledge_ids: ['k_zhi'], assignments: [] }],
        }),
        mode: 'initial_plan',
      }),
    ).rejects.toThrow(/refusing to write an empty review paper/);
    expect(await db.select().from(artifact)).toHaveLength(0);
  });

  // #3357817923 — assignment knowledge id not in the question's coverage.
  it('rejects an assignment knowledge_id outside the question coverage (reject, not intersect)', async () => {
    await expect(
      writeReviewPlanTool.execute(ctx(), {
        plan: validPlan({
          sections: [
            {
              subject_id: 'wenyan',
              knowledge_ids: ['k_zhi'],
              assignments: [
                {
                  // q_active only covers k_zhi; k_ghost is a hallucinated id.
                  question_id: 'q_active',
                  primary_knowledge_id: 'k_zhi',
                  secondary_knowledge_ids: ['k_ghost'],
                },
              ],
            },
          ],
        }),
        mode: 'initial_plan',
      }),
    ).rejects.toThrow(/not in the question's knowledge_ids coverage.*q_active→k_ghost/);
    expect(await db.select().from(artifact)).toHaveLength(0);
  });

  it('rejects a primary_knowledge_id outside the question coverage', async () => {
    await expect(
      writeReviewPlanTool.execute(ctx(), {
        plan: validPlan({
          sections: [
            {
              subject_id: 'wenyan',
              knowledge_ids: ['k_zhi'],
              assignments: [
                {
                  question_id: 'q_active',
                  primary_knowledge_id: 'k_other', // q_active does not cover k_other
                  secondary_knowledge_ids: [],
                },
              ],
            },
          ],
        }),
        mode: 'initial_plan',
      }),
    ).rejects.toThrow(/not in the question's knowledge_ids coverage.*q_active→k_other/);
  });

  // #3357817933 — any FALSE guardrail rejects the plan.
  it('rejects when guardrail candidate_pool_only is false', async () => {
    await expect(
      writeReviewPlanTool.execute(ctx(), {
        plan: validPlan({
          guardrail_checks: {
            within_time_budget: true,
            candidate_pool_only: false,
            every_assignment_has_primary_knowledge: true,
            no_direct_scheduler_mutation: true,
          },
        }),
        mode: 'initial_plan',
      }),
    ).rejects.toThrow(/guardrail_checks must all be true.*candidate_pool_only/);
    expect(await db.select().from(artifact)).toHaveLength(0);
  });

  it('rejects when guardrail within_time_budget or no_direct_scheduler_mutation is false', async () => {
    await expect(
      writeReviewPlanTool.execute(ctx(), {
        plan: validPlan({
          guardrail_checks: {
            within_time_budget: false,
            candidate_pool_only: true,
            every_assignment_has_primary_knowledge: true,
            no_direct_scheduler_mutation: false,
          },
        }),
        mode: 'initial_plan',
      }),
    ).rejects.toThrow(/guardrail_checks must all be true/);
  });

  // #3357932409 — section.knowledge_ids must be ⊆ the validated assignment
  // primary/secondary set; a stray/mistyped section id is rejected.
  it('rejects a section knowledge_id not covered by any assignment', async () => {
    await expect(
      writeReviewPlanTool.execute(ctx(), {
        plan: validPlan({
          sections: [
            {
              subject_id: 'wenyan',
              // k_typo is not any assignment's primary/secondary knowledge.
              knowledge_ids: ['k_zhi', 'k_typo'],
              assignments: [
                {
                  question_id: 'q_active',
                  primary_knowledge_id: 'k_zhi',
                  secondary_knowledge_ids: [],
                },
              ],
            },
          ],
        }),
        mode: 'initial_plan',
      }),
    ).rejects.toThrow(/section knowledge_id.*not covered by any assignment.*wenyan→k_typo/);
    expect(await db.select().from(artifact)).toHaveLength(0);
  });

  it('derives artifact knowledge_ids only from validated assignments (ignores section-only ids)', async () => {
    // section.knowledge_ids ⊆ assignment set (k_zhi present) → passes; the
    // derived artifact knowledge_ids are exactly the assignment primary/secondary.
    const out = await writeReviewPlanTool.execute(ctx(), {
      plan: validPlan({
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
      }),
      mode: 'initial_plan',
    });
    const rows = await db.select().from(artifact).where(eq(artifact.id, out.artifact_id));
    expect([...rows[0].knowledge_ids].sort()).toEqual(['k_zhi']);
  });

  // #3357961871 — duplicate question_ids across assignments are rejected.
  it('rejects duplicate question_ids across assignments', async () => {
    await expect(
      writeReviewPlanTool.execute(ctx(), {
        plan: validPlan({
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
                {
                  question_id: 'q_active',
                  primary_knowledge_id: 'k_zhi',
                  secondary_knowledge_ids: [],
                },
              ],
            },
          ],
        }),
        mode: 'initial_plan',
      }),
    ).rejects.toThrow(/duplicate assignment question_id.*q_active/);
    expect(await db.select().from(artifact)).toHaveLength(0);
  });

  // #3357817915 — only one plan may be written per run (ctx.taskRunId).
  it('rejects a second write_review_plan within the same run (idempotency)', async () => {
    const first = await writeReviewPlanTool.execute(ctx(), {
      plan: validPlan(),
      mode: 'initial_plan',
    });
    expect(first.question_count).toBe(1);
    // Same ctx() ⇒ same taskRunId ⇒ second write rejected.
    await expect(
      writeReviewPlanTool.execute(ctx(), { plan: validPlan(), mode: 'initial_plan' }),
    ).rejects.toThrow(/already exists for this run/);
    // Exactly one artifact persisted.
    expect(await db.select().from(artifact)).toHaveLength(1);
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

  // #3357817910 — the LEGACY question-keyed FSRS branch of executeGetReviewDue
  // (subject_kind='question') also excludes draft questions. A draft question
  // with a mis-written question-level FSRS row must NOT enter the candidate
  // pool even though it has no knowledge-level projection.
  it('excludes a draft question reached via the legacy question-keyed FSRS row', async () => {
    await seedKnowledge('k_zhi');
    await seedQuestion({ id: 'q_active', knowledgeId: 'k_zhi', draft: false });
    await seedQuestion({ id: 'q_draft', knowledgeId: 'k_zhi', draft: true });
    // Legacy question-keyed due rows (NOT a knowledge-level projection).
    await seedDueQuestionFsrs('q_active');
    await seedDueQuestionFsrs('q_draft');

    const out = await selectReviewQuestionCandidatesTool.execute(ctx(), {
      knowledgeIds: ['k_zhi'],
      constraints: { limit: 10 },
    });
    const ids = out.candidates.map((c) => c.question_id);
    expect(ids).toContain('q_active');
    expect(ids).not.toContain('q_draft');
  });

  // YUK-226 S2-5a.1/5a.2 — read model carries source + derived tier.
  it('carries source + derived tier on candidates (tier 1 authentic via ingestion provenance)', async () => {
    await seedKnowledge('k_zhi');
    await seedQuestion({
      id: 'q_auth',
      knowledgeId: 'k_zhi',
      draft: false,
      source: 'vision_paper',
      metadata: { ingestion_session_id: 'sess_1' },
    });
    await seedDueQuestionFsrs('q_auth');

    const out = await selectReviewQuestionCandidatesTool.execute(ctx(), {
      knowledgeIds: ['k_zhi'],
      constraints: { limit: 10 },
    });
    const cand = out.candidates.find((c) => c.question_id === 'q_auth');
    expect(cand).toBeDefined();
    expect(cand?.source).toBe('vision_paper');
    expect(cand?.source_tier).toBe(1);
  });

  // YUK-226 S2-5a.3 — tier-preference ordering: authentic (tier 1) sorts ahead of
  // generated (tier 4) within the same failure grouping.
  it('orders higher tiers first (authentic before generated)', async () => {
    await seedKnowledge('k_zhi');
    // Both overdue via the legacy question-keyed FSRS branch; same reason group.
    await seedQuestion({
      id: 'q_gen',
      knowledgeId: 'k_zhi',
      draft: false,
      source: 'quiz_gen',
      metadata: {},
    });
    await seedQuestion({
      id: 'q_auth',
      knowledgeId: 'k_zhi',
      draft: false,
      source: 'vision_paper',
      metadata: { ingestion_session_id: 'sess_1' },
    });
    await seedDueQuestionFsrs('q_gen');
    await seedDueQuestionFsrs('q_auth');

    const out = await selectReviewQuestionCandidatesTool.execute(ctx(), {
      knowledgeIds: ['k_zhi'],
      constraints: { limit: 10 },
    });
    const ids = out.candidates.map((c) => c.question_id);
    expect(ids.indexOf('q_auth')).toBeLessThan(ids.indexOf('q_gen'));
  });

  // YUK-226 S2-5a.3 / OF-2 (plan §12) — within tier 2 (web_sourced),
  // whitelist_match=false demotes BEHIND whitelist_match=true.
  it('demotes off-whitelist tier-2 questions behind on-whitelist (OF-2)', async () => {
    await seedKnowledge('k_zhi');
    const webMeta = (whitelist: boolean) => ({
      source_ref_kind: 'url',
      web_sourced: {
        url: 'https://example.com/q',
        title: 't',
        fetched_at: '2026-06-06T00:00:00Z',
        whitelist_match: whitelist,
        // extract is REQUIRED by WebSourcedProvenance since YUK-223 / PR #313
        // (provenance.ts:63). Without it safeParse fails and deriveSourceTier
        // falls through to tier 4, defeating the tier-2 demotion-ordering this
        // test guards. Supply a non-empty extract so the row derives tier 2.
        extract: '示例题干抽取',
      },
    });
    await seedQuestion({
      id: 'q_off',
      knowledgeId: 'k_zhi',
      draft: false,
      source: 'web_sourced',
      metadata: webMeta(false),
    });
    await seedQuestion({
      id: 'q_on',
      knowledgeId: 'k_zhi',
      draft: false,
      source: 'web_sourced',
      metadata: webMeta(true),
    });
    await seedDueQuestionFsrs('q_off');
    await seedDueQuestionFsrs('q_on');

    const out = await selectReviewQuestionCandidatesTool.execute(ctx(), {
      knowledgeIds: ['k_zhi'],
      constraints: { limit: 10 },
    });
    // Both derive tier 2 (web_sourced + source_ref_kind='url' + parseable block).
    expect(out.candidates.find((c) => c.question_id === 'q_on')?.source_tier).toBe(2);
    expect(out.candidates.find((c) => c.question_id === 'q_off')?.source_tier).toBe(2);
    const ids = out.candidates.map((c) => c.question_id);
    expect(ids.indexOf('q_on')).toBeLessThan(ids.indexOf('q_off'));
  });
});
