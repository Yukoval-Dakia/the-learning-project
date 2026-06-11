// ADR-0032 D9 / M-2 (YUK-304 lane B) — query_questions: the copilot 题池查询.
//
// "knowledge X 上已有哪些题" — duplicate-avoidance read before authoring new
// questions (the quiz-gen SKILL.md methodology step ①). WRAPS the YUK-280
// listQuestions reader (src/server/questions/list.ts — the same logic behind
// GET /api/questions); zero query-logic duplication, the route is untouched.
//
// Deliberate divergence from the API default: include_drafts defaults TRUE here
// (the API defaults false). The tool's purpose is duplicate-avoidance — a draft
// the copilot authored two turns ago MUST be visible or it will author the same
// question again.

import { z } from 'zod';

import { resolveSubjectKnowledgeIds } from '@/capabilities/knowledge/server/domain';
import { listQuestions } from '@/server/questions/list';
import type { DomainTool, ToolContext } from './types';

const QueryQuestionsInputSchema = z.object({
  /** Any-match (OR of containment) over question.knowledge_ids. */
  knowledge_id: z.array(z.string().min(1)).optional(),
  /** Subject profile id (e.g. 'wenyan') — resolved to its knowledge-id set server-side. */
  subject: z.string().min(1).optional(),
  kind: z.string().min(1).optional(),
  source: z.string().min(1).optional(),
  difficulty: z.number().int().min(1).max(5).optional(),
  include_drafts: z.boolean().default(true),
  // The schema max(50) is the read bound (LIMITED_TOOLS has no entry for this
  // tool; context-throttle falls through for unregistered tools).
  limit: z.number().int().min(1).max(50).default(20),
  offset: z.number().int().min(0).default(0),
});
type QueryQuestionsInput = z.input<typeof QueryQuestionsInputSchema>;

const QueryQuestionsOutputSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      kind: z.string(),
      difficulty: z.number().int(),
      knowledge_ids: z.array(z.string()),
      /** 'draft' = not yet accepted into the pool; null = active/legacy. */
      draft_status: z.string().nullable(),
      source: z.string(),
      source_tier: z.object({ tier: z.number().int(), name: z.string() }),
      /** ≤200-char prompt excerpt (listQuestions preview). */
      prompt_preview: z.string(),
    }),
  ),
  total: z.number().int(),
});
type QueryQuestionsOutput = z.infer<typeof QueryQuestionsOutputSchema>;

async function executeQueryQuestions(
  ctx: ToolContext,
  rawInput: QueryQuestionsInput,
): Promise<QueryQuestionsOutput> {
  const input = QueryQuestionsInputSchema.parse(rawInput);

  // Subject → knowledge-id set, exactly like the route (app/api/questions/route.ts):
  // undefined = no subject filter; [] = subject labels no questions → empty list.
  const subjectKnowledgeIds =
    input.subject !== undefined
      ? await resolveSubjectKnowledgeIds(ctx.db, input.subject)
      : undefined;

  const result = await listQuestions(ctx.db, {
    knowledgeIds:
      input.knowledge_id && input.knowledge_id.length > 0 ? input.knowledge_id : undefined,
    subjectKnowledgeIds,
    source: input.source,
    kind: input.kind,
    difficulty: input.difficulty,
    includeDrafts: input.include_drafts,
    limit: input.limit,
    offset: input.offset,
  });

  return {
    items: result.items.map((item) => ({
      id: item.id,
      kind: item.kind,
      difficulty: item.difficulty,
      knowledge_ids: item.knowledge_ids,
      draft_status: item.draft_status,
      source: item.source,
      source_tier: item.source_tier,
      prompt_preview: item.prompt_md,
    })),
    total: result.total,
  };
}

export const queryQuestionsTool: DomainTool<QueryQuestionsInput, QueryQuestionsOutput> = {
  name: 'query_questions',
  description:
    'List existing questions in the bank, filtered by knowledge_id / subject / kind / source / difficulty. Drafts are INCLUDED by default (set include_drafts=false to exclude) — use this BEFORE authoring a new question via author_question, to avoid duplicating one that already exists (including a draft you authored earlier). Read-only.',
  effect: 'read',
  inputSchema: QueryQuestionsInputSchema,
  outputSchema: QueryQuestionsOutputSchema,
  costClass: 'local',
  execute: executeQueryQuestions,
  summarize(_input, output) {
    return `query_questions · ${output.items.length}/${output.total}`;
  },
  mirrorEvent: 'never',
};
