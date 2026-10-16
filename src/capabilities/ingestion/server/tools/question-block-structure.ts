import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { AddressableStructureSchema } from '@/core/schema/addressable-structure';
import {
  DRAFT_DOCUMENT_SCHEMA_VERSION,
  QuestionDraftDocument,
  isDraftDocumentV2,
} from '@/core/schema/question-draft';
import {
  type AddressableStructure,
  projectAddressableStructure,
} from '@/core/schema/structured_question';
import { question_block } from '@/db/schema';
import type { DomainTool, ToolContext } from './types';

const GetQuestionBlockStructureInputSchema = z.object({
  blockId: z.string().min(1),
});

// YUK-1468 — v2 草稿文档的轻量结构投影：与 edit_question ops 同一 id 坐标系
//（part/unit/item/material/criterion 稳定 id），不是完整文档回显。
const V2DocumentOverviewSchema = z.object({
  schema_version: z.literal(DRAFT_DOCUMENT_SCHEMA_VERSION),
  parts: z.array(
    z.object({
      part_id: z.string(),
      prompt_md: z.string(),
      question_no: z.string().optional(),
      material_ids: z.array(z.string()),
      unit_ids: z.array(z.string()),
      units: z.array(
        z.object({
          unit_id: z.string(),
          slot_id: z.string(),
          response_class: z.enum(['select', 'blank', 'free']),
          item_ids: z.array(z.string()),
          criterion_ids: z.array(z.string()),
        }),
      ),
    }),
  ),
  material_ids: z.array(z.string()),
  knowledge_ids: z.array(z.string()),
});

const GetQuestionBlockStructureOutputSchema = z.object({
  structure: AddressableStructureSchema.nullable(),
  document: V2DocumentOverviewSchema.nullable().optional(),
});

type GetQuestionBlockStructureInput = z.infer<typeof GetQuestionBlockStructureInputSchema>;
type GetQuestionBlockStructureOutput = z.infer<typeof GetQuestionBlockStructureOutputSchema>;

async function executeGetQuestionBlockStructure(
  ctx: ToolContext,
  raw: GetQuestionBlockStructureInput,
): Promise<GetQuestionBlockStructureOutput> {
  const input = GetQuestionBlockStructureInputSchema.parse(raw);
  const [block] = await ctx.db
    .select()
    .from(question_block)
    .where(eq(question_block.id, input.blockId))
    .limit(1);
  if (!block?.structured) {
    return GetQuestionBlockStructureOutputSchema.parse({ structure: null });
  }
  // v2 草稿文档：返回 id 导航投影（与 edit_question 的 ops target 同坐标）。
  if (isDraftDocumentV2(block.structured)) {
    const doc = QuestionDraftDocument.parse(block.structured);
    return GetQuestionBlockStructureOutputSchema.parse({
      structure: null,
      document: {
        schema_version: doc.schema_version,
        parts: doc.parts.map((part) => ({
          part_id: part.part_id,
          prompt_md: part.prompt_md,
          ...(part.question_no != null ? { question_no: part.question_no } : {}),
          material_ids: part.material_ids,
          unit_ids: part.units.map((u) => u.unit_id),
          units: part.units.map((u) => ({
            unit_id: u.unit_id,
            slot_id: u.slot_id,
            response_class: u.response_class,
            item_ids:
              u.response_spec.kind === 'select' ? u.response_spec.items.map((i) => i.item_id) : [],
            criterion_ids: (u.rubric?.criteria ?? []).map((cr) => cr.criterion_id),
          })),
        })),
        material_ids: doc.materials.map((m) => m.material_id),
        knowledge_ids: doc.knowledge_ids,
      },
    });
  }
  return GetQuestionBlockStructureOutputSchema.parse({
    structure: projectAddressableStructure(block.structured, block.figures ?? []),
  });
}

function countAddressableNodes(node: AddressableStructure['tree']): number {
  return (
    1 + (node.sub_questions?.reduce((sum, child) => sum + countAddressableNodes(child), 0) ?? 0)
  );
}

export const getQuestionBlockStructureTool: DomainTool<
  GetQuestionBlockStructureInput,
  GetQuestionBlockStructureOutput
> = {
  name: 'get_question_block_structure',
  description:
    'Read one question_block draft: legacy StructuredQuestion blocks return the addressable id/role tree; schema_version-2 draft documents return a stable-id overview (parts/units/items/materials — the same id coordinate edit_question ops target). Draft layer only; does not read the published bank.',
  effect: 'read',
  inputSchema: GetQuestionBlockStructureInputSchema,
  outputSchema: GetQuestionBlockStructureOutputSchema,
  costClass: 'local',
  execute: executeGetQuestionBlockStructure,
  summarize(input, output) {
    if (output.document != null) {
      return `block v2 doc · ${input.blockId} · ${output.document.parts.length} parts`;
    }
    const nodes = output.structure ? countAddressableNodes(output.structure.tree) : 0;
    return `block structure · ${input.blockId} · ${nodes} nodes`;
  },
  mirrorEvent: 'when_user_visible',
};
