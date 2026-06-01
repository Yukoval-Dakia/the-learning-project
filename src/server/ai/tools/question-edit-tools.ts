// YUK-195 — six agent-callable question structure-edit DomainTools.
//
// Design note: docs/superpowers/specs/2026-06-01-question-edit-domaintools-design.md
//
// These are thin wrappers over the single-owner service
// `src/server/ingestion/block-structured-edit.ts`. They operate on the
// pre-import correction layer (draft `question_block.structured` + `.figures`)
// so an agent can fix OCR/VLM-extracted structure. Each tool:
//   - effect: 'write', mirrorEvent: 'when_causal' (agent callers → bridge
//     auto-writes the `tool_use` event; matches `attribute_mistake`),
//   - costClass: 'local' (pure DB, no LLM),
//   - returns a valid Output on soft failure (`status: 'skipped:*'`); the
//     service throws on hard/unexpected conditions and the bridge records
//     `error_reason`.
//
// Allowed only on the `ingestion_block_edit` surface (allowlists.ts); the
// copilot / dreaming / coach surfaces do NOT get question-mutation by default.

import { z } from 'zod';

import { QuestionKind } from '@/core/schema/business';
import {
  addOption,
  mergeQuestions,
  reassignFigure,
  setQuestionType,
  splitStem,
  updatePrompt,
} from '@/server/ingestion/block-structured-edit';
import type { DomainTool, ToolContext } from './types';

// ---------------------------------------------------------------------------
// update_prompt (§4.1)
// ---------------------------------------------------------------------------

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
    const res = await updatePrompt(ctx.db, {
      blockId: input.block_id,
      nodeId: input.node_id,
      promptText: input.prompt_text,
      actorRef: ctx.callerActor.ref,
    });
    const status =
      res.status === 'written' || res.status === 'skipped:not_draft'
        ? res.status
        : 'skipped:node_not_found';
    return { status, block_id: input.block_id, node_id: input.node_id };
  },
  summarize(input, output) {
    return `update_prompt ${input.node_id.slice(0, 8)}: ${output.status}`;
  },
  mirrorEvent: 'when_causal',
};

// ---------------------------------------------------------------------------
// add_option (§4.2)
// ---------------------------------------------------------------------------

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
    const res = await addOption(ctx.db, {
      blockId: input.block_id,
      nodeId: input.node_id,
      option: input.option,
      actorRef: ctx.callerActor.ref,
    });
    const status =
      res.status === 'written' || res.status === 'skipped:not_draft'
        ? res.status
        : 'skipped:node_not_found';
    return { status, block_id: input.block_id, node_id: input.node_id };
  },
  summarize(input, output) {
    return `add_option ${input.option.label} → ${input.node_id.slice(0, 8)}: ${output.status}`;
  },
  mirrorEvent: 'when_causal',
};

// ---------------------------------------------------------------------------
// set_question_type (§4.3) — advisory `kind` hint, no import-path effect.
// ---------------------------------------------------------------------------

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
    const res = await setQuestionType(ctx.db, {
      blockId: input.block_id,
      nodeId: input.node_id,
      kind: input.kind,
      actorRef: ctx.callerActor.ref,
    });
    const status =
      res.status === 'written' || res.status === 'skipped:not_draft'
        ? res.status
        : 'skipped:node_not_found';
    return { status, block_id: input.block_id, node_id: input.node_id };
  },
  summarize(input, output) {
    return `set_question_type ${input.kind} → ${input.node_id.slice(0, 8)}: ${output.status}`;
  },
  mirrorEvent: 'when_causal',
};

// ---------------------------------------------------------------------------
// split_stem (§4.4)
// ---------------------------------------------------------------------------

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
    const res = await splitStem(ctx.db, {
      blockId: input.block_id,
      nodeId: input.node_id,
      actorRef: ctx.callerActor.ref,
    });
    let status: SplitStemOutput['status'];
    if (res.status === 'written' || res.status === 'skipped:not_draft') {
      status = res.status;
    } else if (res.status === 'skipped:not_splittable') {
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

// ---------------------------------------------------------------------------
// merge_questions (§4.5)
// ---------------------------------------------------------------------------

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
    const res = await mergeQuestions(ctx.db, {
      primaryBlockId: input.primary_block_id,
      mergeBlockIds: input.merge_block_ids,
      actorRef: ctx.callerActor.ref,
    });
    let status: MergeQuestionsOutput['status'];
    if (
      res.status === 'written' ||
      res.status === 'skipped:not_draft' ||
      res.status === 'skipped:cross_session'
    ) {
      status = res.status;
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

// ---------------------------------------------------------------------------
// reassign_figure (§4.6) — shares the service core with the PATCH route.
// ---------------------------------------------------------------------------

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
    const res = await reassignFigure(ctx.db, {
      blockId: input.block_id,
      assetId: input.asset_id,
      attachedToIndex: input.attached_to_index,
      actorRef: ctx.callerActor.ref,
      // Agent edits are draft-only (the route stays unguarded for the user).
      enforceDraft: true,
    });
    return {
      status: res.status,
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
