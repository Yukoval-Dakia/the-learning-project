// D1 — search_bank DomainTool（引擎在 bank-search.ts）。
// 找候选：自然语言 query + 结构化硬过滤；FTS + 向量并行召回 RRF 融合；返回
// 版本化 ref 候选卡片 + 诚实覆盖信息。返回的是候选，不保证每个语义条件已满
// 足（requirements.not_verified 回显）；「没搜到」不构成「库中没有」。
// 取代 query_questions 的查重职责：draft 默认包含（include_drafts=true 语义
// 延续），出题前先搜库防重复。工具只读，不碰 learner state，不做教学决策。

import { z } from 'zod';

import type { DomainTool, ToolContext } from '@/kernel/tools/types';
import {
  BankDifficultyFilterSchema,
  BankGapRequestSchema,
  BankSimilarToSchema,
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
    /** 知识点硬过滤：全部 id 必须是真实（live、未归档）科目 KC，未知 id 显式报错。 */
    knowledge_ids: z.array(z.string().min(1)).min(1).max(50).optional(),
    /** 'any'（默认）= 含任一 KC；'all' = 含全部 KC。仅在 knowledge_ids 存在时生效。 */
    knowledge_mode: z.enum(['any', 'all']).optional(),
    /** 难度硬过滤。authored = 作者难度 1–5 整数；calibrated = 标定难度 logit b
     * （校准未知的题被排除，绝不混入作者难度）。两基准互斥，不可同时给。 */
    difficulty: BankDifficultyFilterSchema.optional(),
    /** 调用方自带的「已见过」ref 列表（如学习者已作答题）；按 question 身份跨所有
     * revision 排除。本工具不查 learner state——名单只来自本输入。 */
    exclude_refs: z.array(z.string().min(1)).min(1).max(200).optional(),
    /** 以某道题的内容向量为向量通道查询（锚必须是 current revision 的 ref）。 */
    similar_to: BankSimilarToSchema.optional(),
    /** 'all'（默认，含未发布 draft——查重需要）| 'active' | 'draft'。 */
    draft_state: z.enum(['all', 'active', 'draft']).default('all'),
    /** 'any'（默认）| 'admitted'（自动可判且可服务）| 'withheld'。 */
    admission_state: z.enum(['any', 'admitted', 'withheld']).default('any'),
    limit: z.number().int().min(1).max(50).default(20),
  })
  .strict();

// Pi's existing tool bridge requires a top-level object. Keep the two wire
// forms mutually exclusive in the runtime schema; defaults apply only to new
// searches, so a cursor-only request never gains accidental scope fields.
export const SearchBankInputSchema = SearchBankNewFormSchema.extend({
  query: SearchBankNewFormSchema.shape.query.optional(),
  draft_state: z.enum(['all', 'active', 'draft']).optional(),
  admission_state: z.enum(['any', 'admitted', 'withheld']).optional(),
  limit: z.number().int().min(1).max(50).optional(),
  cursor: z.string().min(1).optional(),
}).superRefine((input, ctx) => {
  if (input.cursor !== undefined) {
    if (Object.keys(input).some((key) => key !== 'cursor')) {
      ctx.addIssue({
        code: 'custom',
        message: 'cursor must be supplied alone; changed conditions require a new search',
      });
    }
  } else if (input.query === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['query'],
      message: 'query is required for a new search',
    });
  }
});

export const SearchBankOutputSchema = z.object({
  scope_applied: z.object({
    subject: z.object({ profile: z.string(), knowledge_id_count: z.number().int() }).optional(),
    kind: z.object({ canonical: z.string(), persisted_forms: z.array(z.string()) }).optional(),
    source: z.string().optional(),
    within_refs: z.array(z.string()).optional(),
    knowledge: z
      .object({
        ids: z.array(z.string()),
        mode: z.enum(['any', 'all']),
        resolved_count: z.number().int(),
      })
      .optional(),
    difficulty: z
      .object({
        basis: z.enum(['authored', 'calibrated']),
        range: z.tuple([z.number(), z.number()]),
        scale: z.enum(['authored_1_5', 'calibrated_logit_b']),
      })
      .optional(),
    exclude_refs: z
      .object({ refs: z.array(z.string()), excluded_question_ids: z.number().int() })
      .optional(),
    similar_to: z
      .object({
        question_ref: z.string(),
        aspect: z.literal('content'),
        vector_available: z.boolean(),
      })
      .optional(),
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
          /** fts 命中强度：'strong' 计入 verdict；'weak' 只在候选列表展示。 */
          strength: z.enum(['strong', 'weak']).optional(),
          /** vector 专有：命中时该题向量与查询向量的 cosine 距离（越小越近）。 */
          distance: z.number().optional(),
          /** vector 专有：是否通过 检索计入规则（天花板 + top-1 margin）；
           * false = 只在候选列表展示，不抬 verdict（同 fts weak 语义）。 */
          counted: z.boolean().optional(),
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
    /** 计入 verdict 的候选数（fts 强命中 ∪ 通过检索规则的向量命中）；weak 词法命中
     * 与 counted=false 的向量命中不计入。 */
    counted_pool_size: z.number().int(),
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
  const form = SearchBankInputSchema.parse(rawInput);
  const input =
    form.cursor !== undefined ? { cursor: form.cursor } : SearchBankNewFormSchema.parse(form);
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
            knowledge_ids: input.knowledge_ids,
            knowledge_mode: input.knowledge_mode,
            difficulty: input.difficulty,
            exclude_refs: input.exclude_refs,
            similar_to: input.similar_to,
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
    'Search the question bank for CANDIDATES by natural-language query (Chinese works directly) with deterministic hard filters: subject / kind / source / knowledge_ids+knowledge_mode (any|all, live subject KCs only — unknown ids error) / difficulty {basis: authored(1-5 integer) | calibrated(logit b; unknown calibration excluded, never mixed with authored)} with range [lo,hi] / exclude_refs (learner-side seen list; excluded by question identity across all revisions — the tool never reads learner state) / similar_to {question_ref, aspect:content} (reuses the anchor current-revision content vector as the vector query; an anchor whose vector is missing or not current for its content/EMBED_VERSION degrades honestly to FTS) / draft_state (default all — drafts are visible for duplicate-avoidance before authoring) / admission_state (admitted = contains an automatically servable part; automatically_servable_part_ids names the exact eligible parts, not permission to issue the whole group). Full-text + vector recall are fused; results are candidates, NOT a guarantee every semantic condition holds (see requirements.not_verified), and no hits ≠ bank is empty. Each hit carries a versioned ref (read_bank input), a mutable question_id pointer (write_quiz input), and honest missing flags (e.g. no_published_revision on unpublished drafts). within_refs restricts to exact current versions; an empty list is an empty scope, and superseded/unresolvable refs error explicitly. The effective scope (resolved KC counts, difficulty basis+scale, exclusion count, similar_to vector availability) is echoed in scope_applied. Pagination retains the original bounded candidate snapshot for 15 minutes without repeating retrieval; changed or withdrawn candidates expire the cursor explicitly. Paginate ONLY with the returned cursor — it continues this exact search; a new query or changed filters must start a new search. coverage.verdict (enough/sparse/none) is retrieved candidate quantity, not semantic certification — and it counts only strong fts matches plus vector hits that pass the retrieval rule (an absolute distance ceiling AND a decisive top-1 margin over rank 2, YUK-1516; parameters provisional pending real-bank calibration): fts matches carry match_evidence.strength, vector matches carry match_evidence.distance and match_evidence.counted, and weak lexical hits / counted=false vector hits (a lone shared term, or a top-1 without a decisive margin) stay listed as candidates but never lift the verdict, so a topic the bank lacks still yields none and a mintable gap_request. coverage.counted_pool_size is the verdict-counted number; candidate_pool_size includes weak hits. Sparse/none echoes the whole unsatisfied query+scope combination and a content_coverage EvidenceDemand seed; filing still needs agent context and file_bank_gap, which holds the gap when the search was incomplete (gap_request.complete=false). Results are never padded or hard filters relaxed. coverage.complete tells whether this page exhausts the candidate pool with no channel truncation/unavailability.',
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
