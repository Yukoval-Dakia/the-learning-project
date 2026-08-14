import {
  addOption,
  setQuestionType,
  splitStem,
  updatePrompt,
} from '@/capabilities/ingestion/server/block-structured-edit';
import { QuestionKind } from '@/core/schema/business';
import { z } from 'zod';
import type { DomainTool, ToolContext } from './types';

const UpdatePromptInputSchema = z.object({
  block_id: z.string().min(1),
  node_id: z.string().min(1),
  prompt_text: z.string(),
});
const UpdatePromptOutputSchema = z.object({
  status: z.enum(['written', 'skipped:not_draft', 'skipped:node_not_found']),
  block_id: z.string(),
  node_id: z.string(),
});
type UpdatePromptInput = z.infer<typeof UpdatePromptInputSchema>;
type UpdatePromptOutput = z.infer<typeof UpdatePromptOutputSchema>;

export const updatePromptTool: DomainTool<UpdatePromptInput, UpdatePromptOutput> = {
  name: 'update_prompt',
  description:
    'Correct the prompt_text of one node in a DRAFT question_block.structured tree (pre-import OCR/VLM correction). No-op skip if the block is not draft or the node is missing.',
  effect: 'write',
  inputSchema: UpdatePromptInputSchema,
  outputSchema: UpdatePromptOutputSchema,
  costClass: 'local',
  async execute(ctx: ToolContext, input) {
    const result = await updatePrompt(ctx.db, {
      blockId: input.block_id,
      nodeId: input.node_id,
      promptText: input.prompt_text,
      actorRef: ctx.callerActor.ref,
    });
    const status =
      result.status === 'written' || result.status === 'skipped:not_draft'
        ? result.status
        : 'skipped:node_not_found';
    return { status, block_id: input.block_id, node_id: input.node_id };
  },
  summarize(input, output) {
    return `update_prompt ${input.node_id.slice(0, 8)}: ${output.status}`;
  },
  mirrorEvent: 'when_causal',
};

const AddOptionInputSchema = z.object({
  block_id: z.string().min(1),
  node_id: z.string().min(1),
  option: z.object({ label: z.string().min(1), text: z.string() }),
});
const AddOptionOutputSchema = z.object({
  status: z.enum(['written', 'skipped:not_draft', 'skipped:node_not_found']),
  block_id: z.string(),
  node_id: z.string(),
});
type AddOptionInput = z.infer<typeof AddOptionInputSchema>;
type AddOptionOutput = z.infer<typeof AddOptionOutputSchema>;

export const addOptionTool: DomainTool<AddOptionInput, AddOptionOutput> = {
  name: 'add_option',
  description:
    'Append a choice option { label, text } to one node in a DRAFT question_block.structured tree. Skips if the block is not draft or the node is missing.',
  effect: 'write',
  inputSchema: AddOptionInputSchema,
  outputSchema: AddOptionOutputSchema,
  costClass: 'local',
  async execute(ctx: ToolContext, input) {
    const result = await addOption(ctx.db, {
      blockId: input.block_id,
      nodeId: input.node_id,
      option: input.option,
      actorRef: ctx.callerActor.ref,
    });
    const status =
      result.status === 'written' || result.status === 'skipped:not_draft'
        ? result.status
        : 'skipped:node_not_found';
    return { status, block_id: input.block_id, node_id: input.node_id };
  },
  summarize(input, output) {
    return `add_option ${input.option.label} → ${input.node_id.slice(0, 8)}: ${output.status}`;
  },
  mirrorEvent: 'when_causal',
};

const SetQuestionTypeInputSchema = z.object({
  block_id: z.string().min(1),
  node_id: z.string().min(1),
  kind: QuestionKind,
});
const SetQuestionTypeOutputSchema = z.object({
  status: z.enum(['written', 'skipped:not_draft', 'skipped:node_not_found']),
  block_id: z.string(),
  node_id: z.string(),
});
type SetQuestionTypeInput = z.infer<typeof SetQuestionTypeInputSchema>;
type SetQuestionTypeOutput = z.infer<typeof SetQuestionTypeOutputSchema>;

export const setQuestionTypeTool: DomainTool<SetQuestionTypeInput, SetQuestionTypeOutput> = {
  name: 'set_question_type',
  description:
    'Set an advisory question-type hint (kind) on one node in a DRAFT question_block.structured tree. This is a non-binding hint for the future review UI; it does NOT change the import path. Skips if not draft / node missing.',
  effect: 'write',
  inputSchema: SetQuestionTypeInputSchema,
  outputSchema: SetQuestionTypeOutputSchema,
  costClass: 'local',
  async execute(ctx: ToolContext, input) {
    const result = await setQuestionType(ctx.db, {
      blockId: input.block_id,
      nodeId: input.node_id,
      kind: input.kind,
      actorRef: ctx.callerActor.ref,
    });
    const status =
      result.status === 'written' || result.status === 'skipped:not_draft'
        ? result.status
        : 'skipped:node_not_found';
    return { status, block_id: input.block_id, node_id: input.node_id };
  },
  summarize(input, output) {
    return `set_question_type ${input.kind} → ${input.node_id.slice(0, 8)}: ${output.status}`;
  },
  mirrorEvent: 'when_causal',
};

const SplitStemInputSchema = z.object({
  block_id: z.string().min(1),
  node_id: z.string().min(1),
});
const SplitStemOutputSchema = z.object({
  status: z.enum([
    'written',
    'skipped:not_draft',
    'skipped:node_not_found',
    'skipped:not_splittable',
  ]),
  block_id: z.string(),
  node_id: z.string(),
});
type SplitStemInput = z.infer<typeof SplitStemInputSchema>;
type SplitStemOutput = z.infer<typeof SplitStemOutputSchema>;

export const splitStemTool: DomainTool<SplitStemInput, SplitStemOutput> = {
  name: 'split_stem',
  description:
    'Un-group a stem node in a DRAFT question_block: promote its sub_questions to standalone, preserving order (within-block only). Skips if not draft / node missing / node is not a stem with sub_questions.',
  effect: 'write',
  inputSchema: SplitStemInputSchema,
  outputSchema: SplitStemOutputSchema,
  costClass: 'local',
  async execute(ctx: ToolContext, input) {
    const result = await splitStem(ctx.db, {
      blockId: input.block_id,
      nodeId: input.node_id,
      actorRef: ctx.callerActor.ref,
    });
    let status: SplitStemOutput['status'];
    if (result.status === 'written' || result.status === 'skipped:not_draft') {
      status = result.status;
    } else if (result.status === 'skipped:not_splittable') {
      status = 'skipped:not_splittable';
    } else {
      status = 'skipped:node_not_found';
    }
    return { status, block_id: input.block_id, node_id: input.node_id };
  },
  summarize(input, output) {
    return `split_stem ${input.node_id.slice(0, 8)}: ${output.status}`;
  },
  mirrorEvent: 'when_causal',
};
