import { z } from 'zod';
import { writeArchiveProposal, writeDeferProposal } from '@/kernel/proposals/producers';
import {
  type LearningItemProposalOutput,
  LearningItemProposalOutputSchema,
  evidenceRefsFromEventIds,
  getActiveLearningItem,
  pendingProposalWithCooldown,
} from './proposal-tool-support';
import type { DomainTool, ToolContext } from './types';

const ProposeLearningItemDeferInputSchema = z.object({
  learning_item_id: z.string().min(1),
  defer_until: z.string().datetime().optional(),
  reason: z.string().min(1).max(280).optional(),
  evidence_event_ids: z.array(z.string().min(1)).optional(),
  reasoning: z.string().min(1).max(2000),
});

type ProposeLearningItemDeferInput = z.infer<typeof ProposeLearningItemDeferInputSchema>;

async function proposeLearningItemDeferExecute(
  ctx: ToolContext,
  raw: ProposeLearningItemDeferInput,
): Promise<LearningItemProposalOutput> {
  const input = ProposeLearningItemDeferInputSchema.parse(raw);
  const item = await getActiveLearningItem(ctx.db, input.learning_item_id);
  if (!item) return { status: 'skipped:not_found', learning_item_id: input.learning_item_id };
  if (item.status !== 'pending' && item.status !== 'in_progress') {
    return {
      status: 'skipped:invalid_state',
      learning_item_id: input.learning_item_id,
      reason: item.status,
    };
  }
  const cooldownKey = `defer:${input.learning_item_id}`;
  if (await pendingProposalWithCooldown(ctx.db, 'defer', cooldownKey)) {
    return { status: 'skipped:duplicate_pending', learning_item_id: input.learning_item_id };
  }

  const actorRef =
    ctx.callerActor?.kind === 'agent' && ctx.callerActor.ref ? ctx.callerActor.ref : 'coach';
  const proposalId = await writeDeferProposal(ctx.db, {
    actor_ref: actorRef,
    learning_item_id: input.learning_item_id,
    defer_until: input.defer_until,
    reason: input.reason,
    evidence_refs: evidenceRefsFromEventIds(input.evidence_event_ids ?? []),
    reason_md: input.reasoning,
    task_run_id: ctx.taskRunId,
    caused_by_event_id: ctx.causedByEventId ?? null,
  });
  return { status: 'proposed', proposal_id: proposalId, learning_item_id: input.learning_item_id };
}

export const proposeLearningItemDeferTool: DomainTool<
  ProposeLearningItemDeferInput,
  LearningItemProposalOutput
> = {
  name: 'propose_learning_item_defer',
  description:
    'Propose deferring (postponing) an active LearningItem. Writes a defer proposal only; status transition stays in accept owner routes. Use sparingly — defer signals low-energy weeks rather than permanent removal (use archive for that).',
  effect: 'propose',
  inputSchema: ProposeLearningItemDeferInputSchema,
  outputSchema: LearningItemProposalOutputSchema,
  costClass: 'local',
  execute: proposeLearningItemDeferExecute,
  summarize(input, output) {
    return `defer ${input.learning_item_id}: ${output.status}`;
  },
  mirrorEvent: 'when_causal',
};

const ProposeLearningItemArchiveInputSchema = z.object({
  learning_item_id: z.string().min(1),
  reason: z.string().min(1).max(280).optional(),
  evidence_event_ids: z.array(z.string().min(1)).optional(),
  reasoning: z.string().min(1).max(2000),
});

type ProposeLearningItemArchiveInput = z.infer<typeof ProposeLearningItemArchiveInputSchema>;

async function proposeLearningItemArchiveExecute(
  ctx: ToolContext,
  raw: ProposeLearningItemArchiveInput,
): Promise<LearningItemProposalOutput> {
  const input = ProposeLearningItemArchiveInputSchema.parse(raw);
  const item = await getActiveLearningItem(ctx.db, input.learning_item_id);
  if (!item) return { status: 'skipped:not_found', learning_item_id: input.learning_item_id };
  const cooldownKey = `archive:learning_item:${input.learning_item_id}`;
  if (await pendingProposalWithCooldown(ctx.db, 'archive', cooldownKey)) {
    return { status: 'skipped:duplicate_pending', learning_item_id: input.learning_item_id };
  }

  const actorRef =
    ctx.callerActor?.kind === 'agent' && ctx.callerActor.ref ? ctx.callerActor.ref : 'coach';
  const proposalId = await writeArchiveProposal(ctx.db, {
    actor_ref: actorRef,
    target_subject_kind: 'learning_item',
    target_subject_id: input.learning_item_id,
    evidence_refs: evidenceRefsFromEventIds(input.evidence_event_ids ?? []),
    reason_md: input.reasoning,
    proposed_change: {
      learning_item_id: input.learning_item_id,
      ...(input.reason ? { reason: input.reason } : {}),
    },
    task_run_id: ctx.taskRunId,
    caused_by_event_id: ctx.causedByEventId ?? null,
  });
  return { status: 'proposed', proposal_id: proposalId, learning_item_id: input.learning_item_id };
}

export const proposeLearningItemArchiveTool: DomainTool<
  ProposeLearningItemArchiveInput,
  LearningItemProposalOutput
> = {
  name: 'propose_learning_item_archive',
  description:
    'Propose archiving a LearningItem the user no longer wants active. Writes an archive proposal only; the actual archived_at write stays in accept owner routes.',
  effect: 'propose',
  inputSchema: ProposeLearningItemArchiveInputSchema,
  outputSchema: LearningItemProposalOutputSchema,
  costClass: 'local',
  execute: proposeLearningItemArchiveExecute,
  summarize(input, output) {
    return `archive ${input.learning_item_id}: ${output.status}`;
  },
  mirrorEvent: 'when_causal',
};
