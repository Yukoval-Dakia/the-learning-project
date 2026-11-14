import { z } from 'zod';
import { writeRelearnProposal } from '@/kernel/proposals/producers';
import { proposeComputedCompletion } from '../learning-item-completion-producer';
import {
  type LearningItemProposalOutput,
  LearningItemProposalOutputSchema,
  evidenceRefsFromEventIds,
  getActiveLearningItem,
  pendingProposalWithCooldown,
} from './proposal-tool-support';
import type { DomainTool, ToolContext } from './types';

const ProposeLearningItemCompletionInputSchema = z.object({
  learning_item_id: z.string().min(1),
});

type ProposeLearningItemCompletionInput = z.infer<typeof ProposeLearningItemCompletionInputSchema>;

async function proposeLearningItemCompletionExecute(
  ctx: ToolContext,
  raw: ProposeLearningItemCompletionInput,
): Promise<LearningItemProposalOutput> {
  const input = ProposeLearningItemCompletionInputSchema.parse(raw);
  const actorRef =
    ctx.callerActor?.kind === 'agent' && ctx.callerActor.ref
      ? ctx.callerActor.ref
      : 'learning_item_maintenance';
  return proposeComputedCompletion(ctx.db, input.learning_item_id, {
    actorRef,
    taskRunId: ctx.taskRunId,
    causedByEventId: ctx.causedByEventId,
  });
}

export const proposeLearningItemCompletionTool: DomainTool<
  ProposeLearningItemCompletionInput,
  LearningItemProposalOutput
> = {
  name: 'propose_learning_item_completion',
  description:
    'Check server-owned native evidence for a learning item and propose completion only when all knowledge points qualify. The learner must accept; model claims are not evidence.',
  effect: 'propose',
  inputSchema: ProposeLearningItemCompletionInputSchema,
  outputSchema: LearningItemProposalOutputSchema,
  costClass: 'local',
  execute: proposeLearningItemCompletionExecute,
  summarize(input, output) {
    return `completion ${input.learning_item_id}: ${output.status}`;
  },
  mirrorEvent: 'when_causal',
};

const ProposeLearningItemRelearnInputSchema = z.object({
  learning_item_id: z.string().min(1),
  current_mastery: z.number().min(0).max(1).nullable(),
  peak_mastery: z.number().min(0).max(1).nullable().optional(),
  days_since_done: z.number().int().nonnegative().optional(),
  evidence_event_ids: z.array(z.string().min(1)).optional(),
  reasoning: z.string().min(1).max(2000),
});

type ProposeLearningItemRelearnInput = z.infer<typeof ProposeLearningItemRelearnInputSchema>;

async function proposeLearningItemRelearnExecute(
  ctx: ToolContext,
  raw: ProposeLearningItemRelearnInput,
): Promise<LearningItemProposalOutput> {
  const input = ProposeLearningItemRelearnInputSchema.parse(raw);
  const item = await getActiveLearningItem(ctx.db, input.learning_item_id);
  if (!item) return { status: 'skipped:not_found', learning_item_id: input.learning_item_id };
  if (item.status !== 'done' && item.status !== 'resting') {
    return {
      status: 'skipped:invalid_state',
      learning_item_id: input.learning_item_id,
      reason: item.status,
    };
  }
  const cooldownKey = `relearn:${input.learning_item_id}`;
  if (await pendingProposalWithCooldown(ctx.db, 'relearn', cooldownKey)) {
    return { status: 'skipped:duplicate_pending', learning_item_id: input.learning_item_id };
  }

  const currentMastery = input.current_mastery ?? 0;
  const peakMastery = input.peak_mastery ?? currentMastery;
  const daysSinceDone =
    input.days_since_done ??
    (item.completed_at
      ? Math.max(0, Math.floor((Date.now() - item.completed_at.getTime()) / 86_400_000))
      : 0);
  const actorRef =
    ctx.callerActor?.kind === 'agent' && ctx.callerActor.ref
      ? ctx.callerActor.ref
      : 'learning_item_maintenance';
  const proposalId = await writeRelearnProposal(ctx.db, {
    actor_ref: actorRef,
    learning_item_id: input.learning_item_id,
    current_mastery: currentMastery,
    peak_mastery: peakMastery,
    days_since_done: daysSinceDone,
    evidence_refs: evidenceRefsFromEventIds(input.evidence_event_ids ?? []),
    reason_md: input.reasoning,
    task_run_id: ctx.taskRunId,
    caused_by_event_id: ctx.causedByEventId ?? null,
  });
  return { status: 'proposed', proposal_id: proposalId, learning_item_id: input.learning_item_id };
}

export const proposeLearningItemRelearnTool: DomainTool<
  ProposeLearningItemRelearnInput,
  LearningItemProposalOutput
> = {
  name: 'propose_learning_item_relearn',
  description:
    'Propose that a done/resting LearningItem should re-enter active learning. Writes a relearn proposal only; accept owner routes own transitions.',
  effect: 'propose',
  inputSchema: ProposeLearningItemRelearnInputSchema,
  outputSchema: LearningItemProposalOutputSchema,
  costClass: 'local',
  execute: proposeLearningItemRelearnExecute,
  summarize(input, output) {
    return `relearn ${input.learning_item_id}: ${output.status}`;
  },
  mirrorEvent: 'when_causal',
};
