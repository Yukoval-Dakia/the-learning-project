// ADR-0072 D1 — search_bank DomainTool（引擎在 bank-search.ts）。
//
// 找候选：自然语言 query + 结构化硬过滤；FTS + 向量并行召回 RRF 融合；返回
// 版本化 ref 候选卡片 + 诚实覆盖信息。返回的是候选，不保证每个语义条件已满
// 足（requirements.not_verified 回显）；「没搜到」不构成「库中没有」。
//
// 取代 query_questions 的查重职责：draft 默认包含（include_drafts=true 语义
// 延续），出题前先搜库防重复。工具只读，不碰 learner state，不做教学决策。

import { z } from 'zod';

import type { DomainTool, ToolContext } from '@/kernel/tools/types';
import {
  BankGapRequestSchema,
  BankUnsatisfiedConstraintsSchema,
  runSearchBank,
} from './bank-search';

const SearchBankNewFormSchema = z
  .object({
    /** 自然语言检索（中文直接可用；不要求知识点 ID / 题型枚举 / 难度数字）。 */
    query: z.string().trim().min(1).max(400),
    /** Subject profile id（如 'yuwen'）；省略 = 全学科。 */
    subject: z.string().min(1).optional(),
    /** 规范题型 label（choice / reading / computation …）。 */
    kind: z.string().min(1).optional(),
    source: z.string().min(1).optional(),
    within_refs: z.array(z.string().min(1)).max(200).optional(),
    /** 'all'（默认，含未发布 draft——查重需要）| 'active' | 'draft'。 */
    draft_state: z.enum(['all', 'active', 'draft']).default('all'),
    /** 'any'（默认）| 'admitted'（自动可判且可服务）| 'withheld'。 */
    admission_state: z.enum(['any', 'admitted', 'withheld']).default('any'),
    limit: z.number().int().min(1).max(50).default(20),
  })
  .strict();

const SearchBankCursorFormSchema = z.object({ cursor: z.string().min(1) }).strict();

export const SearchBankInputSchema = z.union([SearchBankNewFormSchema, SearchBankCursorFormSchema]);

export const SearchBankOutputSchema = z.object({
  scope_applied: z.object({
    subject: z.object({ profile: z.string(), knowledge_id_count: z.number().int() }).optional(),
    kind: z.object({ canonical: z.string(), persisted_forms: z.array(z.string()) }).optional(),
    source: z.string().optional(),
    within_refs: z.array(z.string()).optional(),
    draft_state: z.enum(['all', 'active', 'draft']),
    admission_state: z.enum(['any', 'admitted', 'withheld']),
  }),
  requirements: z.object({
    enforced: z.array(z.string()),
    not_verified: z.array(z.string()),
  }),
  hits: z.array(
    z.object({
      ref: z.string().nullable(),
      kind: z.enum(['question', 'group']),
      question_id: z.string(),
      group_id: z.string(),
      title: z.string(),
      draft_status: z.string().nullable(),
      admission: z
        .object({ state: z.enum(['admitted', 'withheld']), withheld_reason: z.string().nullable() })
        .nullable(),
      availability: z.enum(['general_pool', 'container_only']).nullable(),
      suspended: z.boolean(),
      source: z.string(),
      automatically_servable_part_ids: z.array(z.string()),
      source_tier: z.object({ tier: z.number().int(), name: z.string() }),
      difficulty: z.number().int(),
      knowledge_ids: z.array(z.string()),
      match_evidence: z.array(
        z.object({
          channel: z.enum(['fts', 'vector']),
          excerpt: z.string(),
        }),
      ),
      missing: z.array(z.string()),
    }),
  ),
  coverage: z.object({
    verdict: z.enum(['enough', 'sparse', 'none']),
    unsatisfied_constraints: z.array(BankUnsatisfiedConstraintsSchema),
    gap_request: BankGapRequestSchema.nullable(),
    candidate_pool_size: z.number().int(),
    retrieval_truncated: z.boolean(),
    page_has_more: z.boolean(),
    next_cursor: z.string().nullable(),
    unavailable_channels: z.array(z.enum(['fts', 'vector'])),
    complete: z.boolean(),
  }),
});

type SearchBankInput = z.infer<typeof SearchBankInputSchema>;
type SearchBankOutput = z.infer<typeof SearchBankOutputSchema>;

async function executeSearchBank(
  ctx: ToolContext,
  rawInput: SearchBankInput,
): Promise<SearchBankOutput> {
  const input = SearchBankInputSchema.parse(rawInput);
  const request =
    'cursor' in input
      ? { form: 'cursor' as const, cursor: input.cursor }
      : {
          form: 'new' as const,
          query: input.query,
          limit: input.limit,
          scope: {
            subject: input.subject,
            kind: input.kind,
            source: input.source,
            within_refs: input.within_refs,
            draft_state: input.draft_state,
            admission_state: input.admission_state,
          },
        };
  const output = await runSearchBank(ctx.db, request);
  return SearchBankOutputSchema.parse(output);
}

export const searchBankTool: DomainTool<SearchBankInput, SearchBankOutput> = {
  name: 'search_bank',
  description:
    'Search the question bank for CANDIDATES by natural-language query (Chinese works directly) with deterministic hard filters: subject / kind / source / draft_state (default all — drafts are visible for duplicate-avoidance before authoring) / admission_state (admitted = contains an automatically servable part; automatically_servable_part_ids names the exact eligible parts, not permission to issue the whole group). Full-text + vector recall are fused; results are candidates, NOT a guarantee every semantic condition holds (see requirements.not_verified), and no hits ≠ bank is empty. Each hit carries a versioned ref (read_bank input), a mutable question_id pointer (write_quiz input), and honest missing flags (e.g. no_published_revision on unpublished drafts). within_refs restricts to exact current versions; an empty list is an empty scope, and superseded/unresolvable refs error explicitly. Pagination retains the original bounded candidate snapshot for 15 minutes without repeating retrieval; changed or withdrawn candidates expire the cursor explicitly. Paginate ONLY with the returned cursor — it continues this exact search; a new query or changed filters must start a new search. coverage.verdict (enough/sparse/none) is retrieved candidate quantity, not semantic certification. Sparse/none echoes the whole unsatisfied query+scope combination and a content_coverage EvidenceDemand seed; filing still needs agent context and a gap-filing tool. Results are never padded or hard filters relaxed. coverage.complete tells whether this page exhausts the candidate pool with no channel truncation/unavailability.',
  effect: 'read',
  inputSchema: SearchBankInputSchema,
  outputSchema: SearchBankOutputSchema,
  costClass: 'cheap_llm',
  execute: executeSearchBank,
  summarize(_input, output) {
    return `search_bank · ${output.hits.length}/${output.coverage.candidate_pool_size} · ${output.coverage.complete ? 'complete' : 'incomplete'}`;
  },
  mirrorEvent: 'never',
};
