// compose_presentation：录入 agent 的展示层工具。
//
// 给定 draft question_block 或已发布 revision 的引用 + 一份 presentation 文档：
//   1. 解析该题的契约（structure / response_spec / scoring_basis）——
//      revision 直接读冻结字段；draft 经与发布同一 normalizer
//      （normalizeQuestionRowToContract，导入块发布走的单行路径）从
//      structured 树推导（会得到的契约）；
//   2. 过 zod 形状门 + validatePresentation（与发布 barrier 同一道绑定校验）；
//   3. 有问题返回 typed issues（不写）；干净时按 save 决定写回 draft 容器
//      question_block.structured 的【presentation 一个键】—— 其它键一概不碰
//      （edit_question 并行 lane 拥有该容器的其余编辑面）。
//
// revision 不可变：revision 引用只做校验，不接受 save。
//
// 写纪律：save 走 block-structured-edit 的 canonical 事件通道
// （setPresentation → persistStructured：experimental:edit_question_block_structured
// op=set_presentation + job event + genesis-anchor 检查 + 投影 write-through）——
// raw tx.update 对 fold 不可见，rebuild 会抹掉展示层。

import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';

import { setPresentation } from '@/capabilities/ingestion/server/block-structured-edit';
import { capturedQuestionShape } from '@/capabilities/ingestion/server/captured-question-shape';
import {
  Presentation,
  type PresentationIssue,
  type PresentationT,
  validatePresentation,
} from '@/core/schema/assessment';
import type { StructuredQuestionT } from '@/core/schema/structured_question';
import { structuredToPromptMarkdown } from '@/core/schema/structured_question';
import type { Db, Tx } from '@/db/client';
import { question_block, question_revision, source_asset } from '@/db/schema';
import type { NormalizableQuestionRow } from '@/kernel/records/assessment-normalization';
import { normalizeQuestionRowToContract } from '@/kernel/records/assessment-normalization';
import { OpaqueJsonInput } from '@/kernel/tools/types';
import type { DomainTool, ToolContext } from './types';

const ComposePresentationInputSchema = z
  .object({
    /** DRAFT question_block id（validate；save=true 时写回 structured.presentation）。 */
    block_id: z.string().min(1).optional(),
    /** 已发布 revision id（只校验 —— revision 不可变，不接受 save）。 */
    revision_id: z.string().min(1).optional(),
    /** presentation 文档（blocks-v1）；先过形状门，再过绑定校验。 */
    presentation: OpaqueJsonInput,
    /** 缺省 false = 只校验；true 需要 block_id（revision 引用拒绝 save）。 */
    save: z.boolean().optional(),
  })
  .refine((input) => (input.block_id != null) !== (input.revision_id != null), {
    message: 'exactly one of block_id / revision_id is required',
  });
type ComposePresentationInput = z.infer<typeof ComposePresentationInputSchema>;

const PresentationIssueSchema = z.object({
  code: z.string().min(1),
  detail: z.string(),
});

const ComposePresentationOutputSchema = z.object({
  status: z.enum([
    'valid',
    'saved',
    'invalid',
    'skipped:not_found',
    'skipped:not_draft',
    'skipped:null_structured',
    'skipped:revision_readonly',
    'rejected_input',
    'unresolvable_contract',
  ]),
  block_id: z.string().optional(),
  revision_id: z.string().optional(),
  /** validatePresentation / 形状门的 typed issues（invalid/rejected_input 时非空）。 */
  issues: z.array(PresentationIssueSchema),
  /** save 成功后的新 block.version。 */
  block_version: z.number().int().min(0).optional(),
});
type ComposePresentationOutput = z.infer<typeof ComposePresentationOutputSchema>;

/** draft block → normalizer 行投影（与导入/发布同一形状来源，review R1）。 */
function draftRowProjection(
  blockId: string,
  structured: StructuredQuestionT,
  payload: {
    reference_md: string | null;
    figures: { asset_id: string }[];
  },
): NormalizableQuestionRow {
  const shape = capturedQuestionShape(structured);
  return {
    id: blockId,
    kind: shape.kind,
    // 导入把块铸成 question 行时 prompt_md = structuredToPromptMarkdown(
    // structured)（auto-enroll / import-completion 同一派生函数），reference_md
    // 取块列 —— 与发布读到的行逐字同源，stem material id 因此与真实发布一致。
    prompt_md: structuredToPromptMarkdown(structured),
    reference_md: payload.reference_md,
    rubric_json: null,
    choices_md: shape.choices_md,
    judge_kind_override: null,
    structured,
    figures: payload.figures as NormalizableQuestionRow['figures'],
  };
}

/** 与发布同一 normalizer（单行路径）推导 draft 的（未来）契约；失败返回 null（不伪造）。 */
async function deriveDraftContract(
  db: Db | Tx,
  blockId: string,
  structured: StructuredQuestionT,
  payload: { reference_md: string | null; figures: { asset_id: string }[] },
) {
  const assetIds = [...new Set(payload.figures.map((figure) => figure.asset_id))];
  const figureDigests: Record<string, string> = {};
  if (assetIds.length > 0) {
    const assetRows = await db
      .select({ assetId: source_asset.id, sha256: source_asset.sha256 })
      .from(source_asset)
      .where(inArray(source_asset.id, assetIds));
    for (const row of assetRows) figureDigests[row.assetId] = row.sha256;
  }
  try {
    return normalizeQuestionRowToContract({
      ...draftRowProjection(blockId, structured, payload),
      figureDigests: Object.keys(figureDigests).length > 0 ? figureDigests : null,
    });
  } catch {
    return null;
  }
}

export const composePresentationTool: DomainTool<
  ComposePresentationInput,
  ComposePresentationOutput
> = {
  name: 'compose_presentation',
  description:
    "Validate (and optionally save) a blocks-v1 presentation for one question: a draft question_block (block_id) or a frozen published revision (revision_id — validate only, revisions are immutable). Validates against that question's structure/response_spec/scoring_basis with the same binding validation as the publish barrier; returns typed issues on failure. With save=true on a block_id it writes the presentation into question_block.structured under the single `presentation` key (nothing else).",
  effect: 'write',
  inputSchema: ComposePresentationInputSchema,
  outputSchema: ComposePresentationOutputSchema,
  costClass: 'local',
  async execute(
    ctx: ToolContext,
    input: ComposePresentationInput,
  ): Promise<ComposePresentationOutput> {
    const shaped = Presentation.safeParse(input.presentation);
    if (!shaped.success) {
      return {
        status: 'rejected_input',
        block_id: input.block_id,
        revision_id: input.revision_id,
        issues: shaped.error.issues.slice(0, 10).map((issue) => ({
          code: 'malformed_presentation',
          detail: `${issue.path.join('.')}: ${issue.message}`,
        })),
      };
    }
    const presentation: PresentationT = shaped.data;

    // revision 引用：冻结契约上校验；不可变 —— save 拒绝。
    if (input.revision_id != null) {
      if (input.save === true) {
        return {
          status: 'skipped:revision_readonly',
          revision_id: input.revision_id,
          issues: [],
        };
      }
      const [revision] = await ctx.db
        .select({
          structure: question_revision.structure,
          response_spec: question_revision.response_spec,
          scoring_basis: question_revision.scoring_basis,
        })
        .from(question_revision)
        .where(eq(question_revision.revision_id, input.revision_id))
        .limit(1);
      if (revision == null) {
        return { status: 'skipped:not_found', revision_id: input.revision_id, issues: [] };
      }
      const issues = validatePresentation(
        presentation,
        revision.structure,
        revision.response_spec,
        revision.scoring_basis,
      );
      return {
        status: issues.length === 0 ? 'valid' : 'invalid',
        revision_id: input.revision_id,
        issues,
      };
    }

    // draft 引用：锁定行后在同一事务内推导契约 → 校验 → （save）写回。
    const blockId = input.block_id as string;
    return ctx.db.transaction(async (tx) => {
      const [block] = await tx
        .select()
        .from(question_block)
        .where(eq(question_block.id, blockId))
        .for('update')
        .limit(1);
      if (block == null) {
        return { status: 'skipped:not_found' as const, block_id: blockId, issues: [] };
      }
      if (block.status !== 'draft') {
        return { status: 'skipped:not_draft' as const, block_id: blockId, issues: [] };
      }
      if (block.structured == null) {
        return { status: 'skipped:null_structured' as const, block_id: blockId, issues: [] };
      }
      const contract = await deriveDraftContract(tx, blockId, block.structured, {
        reference_md: block.reference_md,
        figures: block.figures ?? [],
      });
      if (contract == null) {
        return { status: 'unresolvable_contract' as const, block_id: blockId, issues: [] };
      }
      const issues: PresentationIssue[] = validatePresentation(
        presentation,
        contract.structure,
        contract.response_spec,
        contract.scoring_basis,
      );
      if (issues.length > 0) {
        return { status: 'invalid' as const, block_id: blockId, issues };
      }
      if (input.save !== true) {
        return { status: 'valid' as const, block_id: blockId, issues: [] };
      }
      // save 走 canonical 事件通道（setPresentation →
      // persistStructured：op=set_presentation 的
      // experimental:edit_question_block_structured + job event + genesis-anchor
      // 检查 + 投影 write-through）；raw tx.update 对 fold 不可见，rebuild 会
      // 静默抹掉展示层。同一事务（savepoint）内执行，校验与写入原子。
      const saved = await setPresentation(tx, {
        blockId,
        structured: { ...block.structured, presentation },
        actorRef: ctx.callerActor.ref,
      });
      if (saved.status !== 'written') {
        return {
          status: saved.status as ComposePresentationOutput['status'],
          block_id: blockId,
          issues: [],
        };
      }
      return {
        status: 'saved' as const,
        block_id: blockId,
        issues: [],
        block_version: saved.version,
      };
    });
  },
  summarize(input, output) {
    const ref = input.block_id ?? input.revision_id ?? '?';
    return `compose_presentation ${ref.slice(0, 8)}: ${output.status}${
      output.issues.length > 0 ? ` (${output.issues.map((issue) => issue.code).join(',')})` : ''
    }`;
  },
  mirrorEvent: 'when_causal',
};
