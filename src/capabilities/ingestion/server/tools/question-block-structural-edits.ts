import {
  mergeQuestions,
  reassignFigure,
} from '@/capabilities/ingestion/server/block-structured-edit';
import { z } from 'zod';
import type { DomainTool, ToolContext } from './types';

const MergeQuestionsInputSchema = z.object({
  primary_block_id: z.string().min(1),
  merge_block_ids: z.array(z.string().min(1)).min(1),
});
const MergeQuestionsOutputSchema = z.object({
  status: z.enum([
    'written',
    'skipped:not_draft',
    'skipped:cross_session',
    'skipped:block_not_found',
    'skipped:null_structured',
  ]),
  primary_block_id: z.string(),
  merge_block_ids: z.array(z.string()),
});
type MergeQuestionsInput = z.infer<typeof MergeQuestionsInputSchema>;
type MergeQuestionsOutput = z.infer<typeof MergeQuestionsOutputSchema>;

export const mergeQuestionsTool: DomainTool<MergeQuestionsInput, MergeQuestionsOutput> = {
  name: 'merge_questions',
  description:
    'Merge sibling DRAFT question_blocks into a primary DRAFT block (all must share the same ingestion_session_id). Absorbs each merge-block top-level node into the primary and marks the merge-blocks ignored. Does NOT create a new block. Skips if not draft / cross-session / a block is missing.',
  effect: 'write',
  inputSchema: MergeQuestionsInputSchema,
  outputSchema: MergeQuestionsOutputSchema,
  costClass: 'local',
  async execute(ctx: ToolContext, input) {
    const result = await mergeQuestions(ctx.db, {
      primaryBlockId: input.primary_block_id,
      mergeBlockIds: input.merge_block_ids,
      actorRef: ctx.callerActor.ref,
    });
    let status: MergeQuestionsOutput['status'];
    if (
      result.status === 'written' ||
      result.status === 'skipped:not_draft' ||
      result.status === 'skipped:cross_session' ||
      result.status === 'skipped:null_structured'
    ) {
      status = result.status;
    } else {
      status = 'skipped:block_not_found';
    }
    return {
      status,
      primary_block_id: input.primary_block_id,
      merge_block_ids: input.merge_block_ids,
    };
  },
  summarize(input, output) {
    return `merge_questions ←${input.merge_block_ids.length}: ${output.status}`;
  },
  mirrorEvent: 'when_causal',
};

const ReassignFigureInputSchema = z.object({
  block_id: z.string().min(1),
  asset_id: z.string().min(1),
  attached_to_index: z.string().min(1),
});
const ReassignFigureOutputSchema = z.object({
  status: z.enum([
    'written',
    'skipped:not_draft',
    'skipped:block_not_found',
    'skipped:figure_not_found',
    'skipped:target_not_found',
  ]),
  block_id: z.string(),
  asset_id: z.string(),
  attached_to_index: z.string(),
});
type ReassignFigureInput = z.infer<typeof ReassignFigureInputSchema>;
type ReassignFigureOutput = z.infer<typeof ReassignFigureOutputSchema>;

export const reassignFigureTool: DomainTool<ReassignFigureInput, ReassignFigureOutput> = {
  name: 'reassign_figure',
  description:
    'Reassign a figure to a different node in a DRAFT question_block.structured tree (sets attach_confidence=manual). Validates the target node exists. Skips if not draft / block / figure / target missing.',
  effect: 'write',
  inputSchema: ReassignFigureInputSchema,
  outputSchema: ReassignFigureOutputSchema,
  costClass: 'local',
  async execute(ctx: ToolContext, input) {
    const result = await reassignFigure(ctx.db, {
      blockId: input.block_id,
      assetId: input.asset_id,
      attachedToIndex: input.attached_to_index,
      actorRef: ctx.callerActor.ref,
      enforceDraft: true,
    });
    return {
      status: result.status,
      block_id: input.block_id,
      asset_id: input.asset_id,
      attached_to_index: input.attached_to_index,
    };
  },
  summarize(input, output) {
    return `reassign_figure ${input.asset_id.slice(0, 8)} → ${input.attached_to_index.slice(0, 8)}: ${output.status}`;
  },
  mirrorEvent: 'when_causal',
};
