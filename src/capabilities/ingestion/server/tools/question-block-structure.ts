import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { AddressableStructureSchema } from '@/core/schema/addressable-structure';
import {
  type AddressableStructure,
  projectAddressableStructure,
} from '@/core/schema/structured_question';
import { question_block } from '@/db/schema';
import type { DomainTool, ToolContext } from './types';

const GetQuestionBlockStructureInputSchema = z.object({
  blockId: z.string().min(1),
});

const GetQuestionBlockStructureOutputSchema = z.object({
  structure: AddressableStructureSchema.nullable(),
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
    'Read the addressable StructuredQuestion tree of one ingestion draft question_block (pre-import draft layer), clipped to id/role/sub_questions + figure addressing. Pairs with the question-edit write tools so the agent reads the block by node-id the same way it edits it.',
  effect: 'read',
  inputSchema: GetQuestionBlockStructureInputSchema,
  outputSchema: GetQuestionBlockStructureOutputSchema,
  costClass: 'local',
  execute: executeGetQuestionBlockStructure,
  summarize(input, output) {
    const nodes = output.structure ? countAddressableNodes(output.structure.tree) : 0;
    return `block structure · ${input.blockId} · ${nodes} nodes`;
  },
  mirrorEvent: 'when_user_visible',
};
