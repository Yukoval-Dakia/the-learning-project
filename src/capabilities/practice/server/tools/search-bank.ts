// D1 — search_bank DomainTool（引擎在 bank-search.ts）。
// 找候选：自然语言 query + 结构化硬过滤；FTS + 向量并行召回 RRF 融合；返回
// 版本化 ref 候选卡片 + 诚实覆盖信息。返回的是候选，不保证每个语义条件已满
// 足（requirements.not_verified 回显）；「没搜到」不构成「库中没有」。
// 取代 query_questions 的查重职责：draft 默认包含（include_drafts=true 语义
// 延续），出题前先搜库防重复。工具只读，不碰 learner state，不做教学决策。

import { z } from 'zod';
import type { DomainTool, ToolContext } from '@/kernel/tools/types';
import {
  BankSearchV2Error,
  BankSearchV2ErrorSchema,
  BankSearchV2NewSchema,
  BankSearchV2OutputSchema,
} from './bank-requirements';
import {
  BankDifficultyFilterSchema,
  BankGapRequestSchema,
  BankSimilarToSchema,
  BankUnsatisfiedConstraintsSchema,
  runSearchBank,
} from './bank-search';
import { resumeBankSearchSnapshot } from './bank-search-snapshot';
import { runBankSemanticSearch } from './bank-semantic-search';

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
  contract_version: z.union([z.literal(1), z.literal(2)]).optional(),
  requirements: BankSearchV2NewSchema.shape.requirements,
  scope: BankSearchV2NewSchema.shape.scope,
  use: BankSearchV2NewSchema.shape.use.optional(),
  need: BankSearchV2NewSchema.shape.need,
  anchors: BankSearchV2NewSchema.shape.anchors,
  supersedes_search_id: BankSearchV2NewSchema.shape.supersedes_search_id,
  page_size: z.number().int().min(1).max(50).optional(),
}).superRefine((input, ctx) => {
  if (input.cursor !== undefined) {
    if (Object.keys(input).some((key) => key !== 'cursor' && key !== 'contract_version')) {
      ctx.addIssue({
        code: 'custom',
        message: 'cursor must be supplied alone; changed conditions require a new search',
      });
    }
  } else if (input.contract_version === 2) {
    const parsed = BankSearchV2NewSchema.safeParse(input);
    if (!parsed.success)
      for (const issue of parsed.error.issues)
        ctx.addIssue({ code: 'custom', path: issue.path, message: issue.message });
  } else if (
    Object.keys(input).some((key) =>
      [
        'requirements',
        'scope',
        'use',
        'need',
        'anchors',
        'supersedes_search_id',
        'page_size',
      ].includes(key),
    )
  ) {
    ctx.addIssue({
      code: 'custom',
      message: 'v2 fields require explicit contract_version=2; refusing legacy downgrade',
    });
  } else if (input.query === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['query'],
      message: 'query is required for a new search',
    });
  }
});

const SearchBankLegacyOutputSchema = z.object({
  contract_version: z.literal(1),
  semantic_status: z.literal('legacy_candidate_only'),
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
    recall_scan: z
      .array(z.object({ channel: z.string(), scanned: z.number().int(), stop: z.string() }))
      .optional(),
  }),
});

export const SearchBankOutputSchema = z.union([
  SearchBankLegacyOutputSchema,
  BankSearchV2OutputSchema,
  BankSearchV2ErrorSchema,
]);

type SearchBankInput = z.infer<typeof SearchBankInputSchema>;
type SearchBankOutput = z.infer<typeof SearchBankOutputSchema>;
async function executeSearchBank(
  ctx: ToolContext,
  rawInput: SearchBankInput,
): Promise<SearchBankOutput> {
  const form = SearchBankInputSchema.parse(rawInput);
  if (form.contract_version === 2) {
    try {
      return form.cursor
        ? await resumeBankSearchSnapshot(ctx, form.cursor)
        : await runBankSemanticSearch(ctx, BankSearchV2NewSchema.parse(form));
    } catch (error) {
      if (error instanceof BankSearchV2Error)
        return { contract_version: 2, status: 'error', code: error.code, detail: error.message };
      throw error;
    }
  }
  const { contract_version: _version, ...legacyForm } = form;
  const input =
    form.cursor !== undefined ? { cursor: form.cursor } : SearchBankNewFormSchema.parse(legacyForm);
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
  return SearchBankLegacyOutputSchema.parse({
    ...output,
    contract_version: 1,
    semantic_status: 'legacy_candidate_only',
  });
}

export const searchBankTool: DomainTool<SearchBankInput, SearchBankOutput> = {
  name: 'search_bank',
  description:
    'The only question-bank search entrance. Prefer contract_version=2 with original query, explicit requirements[{id,statement,importance:required|preferred}], use:inspect|practice, optional deterministic scope, optional need:{count}, and independent page_size (1–50). Query-only v2 uses a configured interpretation task and returns original spans/ambiguities. V2 checks each authorized immutable revision against every condition and same-task joint requirements; exact source citations are validated. Only all-required supported + joint supported + selected parts available can count as matched. Missing media, incomplete reads, task/parse failures remain unknown. Inspect preserves unpublished drafts as unverified; practice reuses the real issuance gate before each channel cap. Restricted roles use public-text FTS only: existing answer-bearing vectors are unavailable until visibility projections ship. Private/owner use FTS + vector/RRF; recall thresholds do not decide semantic matches. No need means fulfillment=not_assessed. Results disclose scan/verification budgets, before/after rank, task/cost evidence and incomplete recall; no hits never proves bank absence. V2 cursor is server-signed and actor/role/request/result-bound, continues the stored 15-minute snapshot without embedding/model calls; changed/withdrawn versions explicitly stale. Use only {contract_version:2,cursor} to continue. Anchors accept exact question_ref plus preserve/change statements. This slice cannot redeem search evidence for file_bank_gap or versioned quiz/issuance; registered demand and predecessor bindings explicitly reject until their authority is connected. No gap writes, generation, learner-state reads, goal changes or issuance. V1 flat query/limit/scope fields remain legacy_candidate_only; old enough/sparse/none and limit are candidate recall quantities, never v2 fulfillment. New v2 fields never silently downgrade to v1.',
  effect: 'read',
  inputSchema: SearchBankInputSchema,
  outputSchema: SearchBankOutputSchema,
  costClass: 'cheap_llm',
  execute: executeSearchBank,
  summarize(_input, output) {
    if (output.contract_version === 2)
      return output.status === 'error'
        ? `search_bank · ${output.code}`
        : `search_bank · ${output.matched_count} confirmed · ${output.fulfillment}`;
    return `search_bank · ${output.hits.length}/${output.coverage.candidate_pool_size} · legacy candidates`;
  },
  mirrorEvent: 'never',
};
