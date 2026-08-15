// YUK-892 (F4.0) — Ingestion-owned record proposal tools, moved verbatim from
// the central src/server/ai/tools/proposal-tools.ts.
//
// These tools expose owner-service paths to agent tool loops. They do not
// apply destructive record mutations directly: they write inbox-visible
// proposal events only; the accept path owns record updates. Shared proposal
// inbox/writer machinery lives in @/kernel/proposals.

import { SuggestionKind } from '@/core/schema/event/known';
import type { ProposalEvidenceRefT } from '@/core/schema/proposal';
import type { Db } from '@/db/client';
import { artifact, knowledge, learning_item, learning_record, question } from '@/db/schema';
import { pendingProposalWithCooldown } from '@/kernel/proposals/inbox';
import { writeAiProposal } from '@/kernel/proposals/writer';
import { getActiveLearningRecord } from '@/kernel/records/queries';
import type { DomainTool, ToolContext } from '@/kernel/tools/types';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';

function evidenceRefsFromEventIds(ids: string[]): ProposalEvidenceRefT[] {
  return [...new Set(ids)].map((id) => ({ kind: 'event', id }));
}

async function getKnowledgeNode(
  db: Db,
  id: string,
): Promise<{
  id: string;
  domain: string | null;
  parent_id: string | null;
  version: number;
} | null> {
  const row = (
    await db
      .select({
        id: knowledge.id,
        domain: knowledge.domain,
        parent_id: knowledge.parent_id,
        version: knowledge.version,
      })
      .from(knowledge)
      .where(and(eq(knowledge.id, id), isNull(knowledge.archived_at)))
      .limit(1)
  )[0];
  return row ?? null;
}

async function targetExists(
  db: Db,
  targetKind: 'knowledge' | 'question' | 'learning_item' | 'artifact',
  targetId: string,
): Promise<boolean> {
  switch (targetKind) {
    case 'knowledge': {
      return (await getKnowledgeNode(db, targetId)) !== null;
    }
    case 'question': {
      const row = (
        await db
          .select({ id: question.id })
          .from(question)
          .where(eq(question.id, targetId))
          .limit(1)
      )[0];
      return Boolean(row);
    }
    case 'learning_item': {
      const row = (
        await db
          .select({ id: learning_item.id })
          .from(learning_item)
          .where(and(eq(learning_item.id, targetId), isNull(learning_item.archived_at)))
          .limit(1)
      )[0];
      return Boolean(row);
    }
    case 'artifact': {
      const row = (
        await db
          .select({ id: artifact.id })
          .from(artifact)
          .where(and(eq(artifact.id, targetId), isNull(artifact.archived_at)))
          .limit(1)
      )[0];
      return Boolean(row);
    }
  }
}

// ---------------------------------------------------------------------------
// LearningRecord proposal tools
// ---------------------------------------------------------------------------

const RecordLinkTargetKindSchema = z.enum(['knowledge', 'question', 'learning_item', 'artifact']);
const RecordLinkRelationSchema = z.enum(['about', 'evidence_for', 'follow_up', 'source_for']);

const ProposeRecordLinksInputSchema = z.object({
  record_id: z.string().min(1),
  proposed_links: z
    .array(
      z.object({
        target_kind: RecordLinkTargetKindSchema,
        target_id: z.string().min(1),
        relation: RecordLinkRelationSchema,
        confidence: z.number().min(0).max(1),
        reasoning: z.string().min(1).max(1000),
      }),
    )
    .min(1)
    .max(12),
  evidence_event_ids: z.array(z.string().min(1)).optional(),
  // P5.6 / YUK-178 (§4.2, SK-5) — OPTIONAL model-labeled discriminator; omit
  // (→ proactive) unless this repairs a model-observed failure.
  suggestion_kind: SuggestionKind.optional(),
});

const RecordProposalOutputSchema = z.object({
  status: z.enum([
    'proposed',
    'skipped:not_found',
    'skipped:unknown_target',
    'skipped:duplicate_pending',
  ]),
  proposal_id: z.string().optional(),
  record_id: z.string().optional(),
  reason: z.string().optional(),
});

type ProposeRecordLinksInput = z.infer<typeof ProposeRecordLinksInputSchema>;
type RecordProposalOutput = z.infer<typeof RecordProposalOutputSchema>;

async function proposeRecordLinksExecute(
  ctx: ToolContext,
  raw: ProposeRecordLinksInput,
): Promise<RecordProposalOutput> {
  const input = ProposeRecordLinksInputSchema.parse(raw);
  if (!(await getActiveLearningRecord(ctx.db, input.record_id))) {
    return { status: 'skipped:not_found', record_id: input.record_id };
  }

  for (const link of input.proposed_links) {
    if (!(await targetExists(ctx.db, link.target_kind, link.target_id))) {
      return {
        status: 'skipped:unknown_target',
        record_id: input.record_id,
        reason: `${link.target_kind}:${link.target_id}`,
      };
    }
  }

  const linkFingerprint = input.proposed_links
    .map((link) => `${link.target_kind}:${link.target_id}:${link.relation}`)
    .sort()
    .join('|');
  const cooldownKey = `record_links:${input.record_id}:${linkFingerprint}`;
  if (await pendingProposalWithCooldown(ctx.db, 'record_links', cooldownKey)) {
    return { status: 'skipped:duplicate_pending', record_id: input.record_id };
  }

  const proposalId = await writeAiProposal(ctx.db, {
    actor_ref: ctx.callerActor.ref,
    payload: {
      kind: 'record_links',
      target: { subject_kind: 'record', subject_id: input.record_id },
      reason_md: input.proposed_links.map((link) => link.reasoning).join('\n\n'),
      evidence_refs: [
        { kind: 'record', id: input.record_id },
        ...evidenceRefsFromEventIds(input.evidence_event_ids ?? []),
      ],
      proposed_change: {
        record_id: input.record_id,
        links: input.proposed_links,
      },
      rollback_plan: { action: 'dismiss proposal; record links stay unchanged' },
      cooldown_key: cooldownKey,
      // P5.6 / YUK-178 — explicit model label, default proactive.
      suggestion_kind: input.suggestion_kind ?? 'proactive',
    },
    task_run_id: ctx.taskRunId,
    caused_by_event_id: ctx.causedByEventId ?? null,
  });

  return { status: 'proposed', proposal_id: proposalId, record_id: input.record_id };
}

export const proposeRecordLinksTool: DomainTool<ProposeRecordLinksInput, RecordProposalOutput> = {
  name: 'propose_record_links',
  description:
    'Propose bounded links from one LearningRecord to knowledge, question, learning_item, or artifact targets. Writes proposal only; accept path owns record updates.',
  effect: 'propose',
  inputSchema: ProposeRecordLinksInputSchema,
  outputSchema: RecordProposalOutputSchema,
  costClass: 'local',
  execute: proposeRecordLinksExecute,
  summarize(input, output) {
    return `record links ${input.record_id}: ${output.status} (${input.proposed_links.length})`;
  },
  mirrorEvent: 'when_causal',
};

const ProposeRecordPromotionInputSchema = z.object({
  record_id: z.string().min(1),
  target: z.enum(['question', 'learning_item', 'artifact']),
  reasoning: z.string().min(1).max(2000),
  draft: z.unknown().optional(),
  // P5.6 / YUK-178 (§4.2, SK-5) — OPTIONAL model-labeled discriminator; omit
  // (→ proactive) unless this repairs a model-observed failure.
  suggestion_kind: SuggestionKind.optional(),
});

type ProposeRecordPromotionInput = z.infer<typeof ProposeRecordPromotionInputSchema>;

async function proposeRecordPromotionExecute(
  ctx: ToolContext,
  raw: ProposeRecordPromotionInput,
): Promise<RecordProposalOutput> {
  const input = ProposeRecordPromotionInputSchema.parse(raw);
  if (!(await getActiveLearningRecord(ctx.db, input.record_id))) {
    return { status: 'skipped:not_found', record_id: input.record_id };
  }

  const cooldownKey = `record_promotion:${input.record_id}:${input.target}`;
  if (await pendingProposalWithCooldown(ctx.db, 'record_promotion', cooldownKey)) {
    return { status: 'skipped:duplicate_pending', record_id: input.record_id };
  }

  const proposalId = await writeAiProposal(ctx.db, {
    actor_ref: ctx.callerActor.ref,
    payload: {
      kind: 'record_promotion',
      target: { subject_kind: 'record', subject_id: input.record_id },
      reason_md: input.reasoning,
      evidence_refs: [{ kind: 'record', id: input.record_id }],
      proposed_change: {
        record_id: input.record_id,
        target: input.target,
        ...(input.draft !== undefined ? { draft: input.draft } : {}),
      },
      rollback_plan: { action: 'dismiss proposal; no stronger learning object is created' },
      cooldown_key: cooldownKey,
      // P5.6 / YUK-178 — explicit model label, default proactive.
      suggestion_kind: input.suggestion_kind ?? 'proactive',
    },
    task_run_id: ctx.taskRunId,
    caused_by_event_id: ctx.causedByEventId ?? null,
  });

  return { status: 'proposed', proposal_id: proposalId, record_id: input.record_id };
}

export const proposeRecordPromotionTool: DomainTool<
  ProposeRecordPromotionInput,
  RecordProposalOutput
> = {
  name: 'propose_record_promotion',
  description:
    'Propose promoting one LearningRecord into a question, LearningItem, or artifact draft. Writes proposal only; accept path owns materialization.',
  effect: 'propose',
  inputSchema: ProposeRecordPromotionInputSchema,
  outputSchema: RecordProposalOutputSchema,
  costClass: 'local',
  execute: proposeRecordPromotionExecute,
  summarize(input, output) {
    return `record promotion ${input.record_id}->${input.target}: ${output.status}`;
  },
  mirrorEvent: 'when_causal',
};
