// compose_presentation：录入 agent 的展示层工具。
//
// 给定 draft question_block 或已发布 revision 的引用 + 一份 presentation 文档：
//   1. 解析该题的契约（structure / response_spec / scoring_basis）——
//      revision 直接读冻结字段；v2 draft 复用 submit 的 draftDocumentToContract；
//      legacy 树保留 normalizeQuestionRowToContract 的单行路径；
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

import { eq } from 'drizzle-orm';
import { z } from 'zod';

import { setPresentation } from '@/capabilities/ingestion/server/block-structured-edit';
import { writeCustomCodeAsset } from '@/capabilities/ingestion/server/custom-code-assets';
import { encodeDraftRef, parseDraftRef } from '@/core/question-draft-ref';
import { Presentation, type PresentationT, validatePresentation } from '@/core/schema/assessment';
import { question_revision } from '@/db/schema';
import { OpaqueJsonInput } from '@/kernel/tools/types';
import type { DomainTool, ToolContext } from './types';

const ComposePresentationInputSchema = z
  .object({
    /** 独立惰性代码资产写入；省略 action 保持既有 presentation 模式。 */
    action: z.literal('write_custom_code').optional(),
    /** 仅代码模式；asset_id/digest/mime/归属全部由服务端生成。 */
    code: z.string().min(1).optional(),
    /** DRAFT question_block id（validate；save=true 时写回 structured.presentation）。 */
    block_id: z.string().min(1).optional(),
    /** edit_question 返回的版本化草稿身份；v2 save 必须携带版本。 */
    draft_ref: z.string().min(1).optional(),
    expected_draft_version: z.number().int().min(0).optional(),
    /** v2 save 必填；同 key 同输入重放原回执，同 key 异输入冲突。 */
    request_id: z.string().min(1).optional(),
    /** 已发布 revision id（只校验 —— revision 不可变，不接受 save）。 */
    revision_id: z.string().min(1).optional(),
    /** presentation 文档（blocks-v1）；先过形状门，再过绑定校验。 */
    presentation: OpaqueJsonInput.optional(),
    /** 缺省 false = 只校验；true 需要 block_id（revision 引用拒绝 save）。 */
    save: z.boolean().optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.action === 'write_custom_code') {
      if (
        input.code == null ||
        input.draft_ref == null ||
        input.block_id != null ||
        input.revision_id != null ||
        input.expected_draft_version != null ||
        input.request_id != null ||
        input.presentation !== undefined ||
        input.save !== undefined
      ) {
        ctx.addIssue({
          code: 'custom',
          message: 'write_custom_code accepts only action, current draft_ref and code',
        });
      }
    } else if (input.code !== undefined || input.presentation === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'presentation mode requires presentation and never accepts code',
      });
    }
  })
  .refine(
    (input) =>
      [input.block_id, input.draft_ref, input.revision_id].filter((ref) => ref != null).length ===
      1,
    { message: 'exactly one of block_id / draft_ref / revision_id is required' },
  );
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
    'unsupported_contract',
    'conflict',
    'custom_code_saved',
  ]),
  block_id: z.string().optional(),
  revision_id: z.string().optional(),
  /** validatePresentation / 形状门的 typed issues（invalid/rejected_input 时非空）。 */
  issues: z.array(PresentationIssueSchema),
  /** save 成功后的新 block.version。 */
  block_version: z.number().int().min(0).optional(),
  draft_ref: z.string().optional(),
  draft_version: z.number().int().min(0).optional(),
  request_id: z.string().optional(),
  replayed: z.boolean().optional(),
  reason: z.string().optional(),
  current_draft_ref: z.string().optional(),
  current_draft_version: z.number().int().min(0).optional(),
  /** Only write_custom_code returns these server-verified immutable asset fields. */
  asset_id: z.string().optional(),
  digest: z.string().optional(),
  byte_size: z.number().int().min(1).optional(),
  mime: z.literal('text/javascript').optional(),
  reused: z.boolean().optional(),
  preview: z.literal('not_run').optional(),
  serving: z.literal('withheld').optional(),
});
type ComposePresentationOutput = z.infer<typeof ComposePresentationOutputSchema>;

export const composePresentationTool: DomainTool<
  ComposePresentationInput,
  ComposePresentationOutput
> = {
  name: 'compose_presentation',
  description:
    "With no action, validate (and optionally save) a blocks-v1 presentation for a draft (draft_ref from edit_question, or legacy block_id) or frozen revision (revision_id, validate only). Supply presentation, not prose. v2 drafts use submit's contract conversion and binding validators; malformed/unsupported declarations fail explicitly. For v2 save=true, provide draft_ref (or block_id + expected_draft_version) and request_id. Save changes only presentation through canonical edit events, returns the new draft_ref/draft_version for subsequent edit_question/submit_question. Reuse the same request_id and input only to replay the original receipt; conflicts must be resolved explicitly. Separately, action=write_custom_code accepts only the current own R8 draft_ref and code (1..256 KiB UTF-8, no script-closing/comment/NUL sequences). It stores inert immutable bytes and returns server-derived asset_id/digest/byte_size/mime; reuse those exact refs in a subsequent presentation compose. It never changes the draft version. No code execution or preview occurs; custom blocks remain withheld. Neither saved code nor presentation validity grants admission.",
  effect: 'write',
  inputSchema: ComposePresentationInputSchema,
  outputSchema: ComposePresentationOutputSchema,
  costClass: 'local',
  async execute(
    ctx: ToolContext,
    input: ComposePresentationInput,
  ): Promise<ComposePresentationOutput> {
    const parsedInput = ComposePresentationInputSchema.safeParse(input);
    if (!parsedInput.success) {
      return {
        status: 'rejected_input',
        issues: parsedInput.error.issues.slice(0, 10).map((issue) => ({
          code: 'invalid_compose_input',
          detail: `${issue.path.join('.')}: ${issue.message}`,
        })),
      };
    }
    input = parsedInput.data;
    if (input.action === 'write_custom_code') {
      if (input.draft_ref == null || input.code == null) {
        return {
          status: 'rejected_input',
          issues: [{ code: 'missing_code_input', detail: 'requires draft_ref and code' }],
        };
      }
      return writeCustomCodeAsset(ctx, { draftRef: input.draft_ref, code: input.code });
    }
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

    const ref = input.draft_ref != null ? parseDraftRef(input.draft_ref) : null;
    if (
      (input.draft_ref != null &&
        (ref == null ||
          ref.blockId.length === 0 ||
          encodeDraftRef(ref.blockId, ref.version) !== input.draft_ref)) ||
      (ref != null &&
        input.expected_draft_version != null &&
        input.expected_draft_version !== ref.version)
    ) {
      return {
        status: 'rejected_input',
        issues: [
          { code: 'invalid_draft_ref', detail: 'draft_ref/version must identify one version' },
        ],
      };
    }
    const blockId = ref?.blockId ?? (input.block_id as string);
    const expectedVersion = input.expected_draft_version ?? ref?.version;
    // The owner validates the locked draft and owns lock/replay/CAS/save ordering;
    // raw tx.update would be invisible to fold/rebuild.
    const saved = await setPresentation(ctx.db, {
      blockId,
      presentation,
      expectedVersion,
      requestId: input.request_id,
      save: input.save === true,
      actorRef: ctx.callerActor.ref,
    });
    return {
      status:
        saved.status === 'written'
          ? 'saved'
          : saved.status === 'validated'
            ? 'valid'
            : saved.status === 'skipped:block_not_found'
              ? 'skipped:not_found'
              : saved.status,
      block_id: blockId,
      issues: saved.issues ?? [],
      ...(saved.version != null
        ? { block_version: saved.version, draft_version: saved.version }
        : {}),
      ...(saved.draft_ref != null ? { draft_ref: saved.draft_ref } : {}),
      ...(saved.request_id != null ? { request_id: saved.request_id } : {}),
      ...(saved.replayed != null ? { replayed: saved.replayed } : {}),
      ...(saved.reason != null ? { reason: saved.reason } : {}),
      ...(saved.current_draft_ref != null ? { current_draft_ref: saved.current_draft_ref } : {}),
      ...(saved.current_draft_version != null
        ? { current_draft_version: saved.current_draft_version }
        : {}),
    };
  },
  summarize(input, output) {
    const ref = input.draft_ref ?? input.block_id ?? input.revision_id ?? '?';
    return `compose_presentation ${ref.slice(0, 8)}: ${output.status}${
      output.issues.length > 0 ? ` (${output.issues.map((issue) => issue.code).join(',')})` : ''
    }`;
  },
  mirrorEvent: 'when_causal',
};
