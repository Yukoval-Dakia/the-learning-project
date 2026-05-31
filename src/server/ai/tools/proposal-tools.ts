// Wave 3 / T-D4 proposal and bounded-write DomainTools.
//
// These tools expose existing owner-service paths to agent tool loops. They do
// not apply destructive graph, record, or LearningItem mutations directly:
// proposal tools write inbox-visible proposal events, while attribute_mistake
// delegates to the AttributionTask writer that appends a judge event.

import { RelationTypeSchema } from '@/core/schema/event/blocks';
import {
  type AiProposalPayloadInputT,
  type ProposalEvidenceRefT,
  parseAiProposalPayload,
} from '@/core/schema/proposal';
import type { Db } from '@/db/client';
import {
  artifact,
  knowledge,
  knowledge_edge,
  learning_item,
  learning_record,
  question,
} from '@/db/schema';
import { writeToolCallLog } from '@/server/ai/log';
import type { TaskTextRunFn } from '@/server/ai/provenance';
import { runVariantGen } from '@/server/boss/handlers/variant_gen';
import { getFailureAttemptById, getJudgeForAttempt } from '@/server/events/queries';
import { runAttributionAndWriteJudgeEvent } from '@/server/knowledge/attribute';
import { getEffectiveDomain } from '@/server/knowledge/domain';
import {
  type KnowledgeMutationPayload,
  writeKnowledgeProposeEvent,
} from '@/server/knowledge/proposals';
import { type RubricVerdict, validateProposalQuality } from '@/server/knowledge/rubric-validator';
import { listProposalInboxRows } from '@/server/proposals/inbox';
import {
  writeArchiveProposal,
  writeCompletionProposal,
  writeDeferProposal,
  writeRelearnProposal,
} from '@/server/proposals/producers';
import { writeAiProposal } from '@/server/proposals/writer';
import { resolveSubjectProfile } from '@/subjects/profile';
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { z } from 'zod';
import type { DomainTool, ToolContext } from './types';

const TEXT_EXCERPT_MAX = 180;

function excerpt(value: string | null | undefined, max = TEXT_EXCERPT_MAX): string {
  const text = (value ?? '').replace(/\s+/g, ' ').trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function evidenceRefsFromEventIds(ids: string[]): ProposalEvidenceRefT[] {
  return [...new Set(ids)].map((id) => ({ kind: 'event', id }));
}

async function pendingProposalWithCooldown(
  db: Db,
  kind: string,
  cooldownKey: string,
): Promise<boolean> {
  const rows = await listProposalInboxRows(db, { status: 'pending' });
  return rows.some((row) => row.kind === kind && row.payload.cooldown_key === cooldownKey);
}

async function pendingProposalWithAnyCooldown(
  db: Db,
  kind: string,
  cooldownKeys: string[],
): Promise<boolean> {
  const keys = new Set(cooldownKeys);
  const rows = await listProposalInboxRows(db, { status: 'pending' });
  return rows.some(
    (row) => row.kind === kind && row.payload.cooldown_key && keys.has(row.payload.cooldown_key),
  );
}

function isSymmetricRelation(relationType: string): boolean {
  return relationType === 'related_to' || relationType === 'contrasts_with';
}

function edgeCooldownKeys(fromId: string, toId: string, relationType: string): string[] {
  const directional = `knowledge_edge:${fromId}|${toId}|${relationType}`;
  if (!isSymmetricRelation(relationType)) return [directional];
  const normalized = [fromId, toId].sort().join('|');
  return [
    `knowledge_edge:${normalized}|${relationType}`,
    directional,
    `knowledge_edge:${toId}|${fromId}|${relationType}`,
  ];
}

async function defaultRunTaskFn(
  kind: string,
  input: unknown,
  ctx: unknown,
): Promise<Awaited<ReturnType<TaskTextRunFn>>> {
  const { runTask } = await import('@/server/ai/runner');
  return await runTask(kind as never, input, ctx as never);
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

async function getSharedKnowledgeDomain(db: Db, ids: string[]): Promise<string | null> {
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length === 0) return null;
  const domains = await Promise.all(uniqueIds.map((id) => getEffectiveDomain(db, id)));
  const [first] = domains;
  return domains.every((domain) => domain === first) ? first : null;
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

async function getActiveLearningRecord(
  db: Db,
  recordId: string,
): Promise<typeof learning_record.$inferSelect | null> {
  const row = (
    await db
      .select()
      .from(learning_record)
      .where(and(eq(learning_record.id, recordId), isNull(learning_record.archived_at)))
      .limit(1)
  )[0];
  return row ?? null;
}

async function getActiveLearningItem(
  db: Db,
  itemId: string,
): Promise<typeof learning_item.$inferSelect | null> {
  const row = (
    await db
      .select()
      .from(learning_item)
      .where(and(eq(learning_item.id, itemId), isNull(learning_item.archived_at)))
      .limit(1)
  )[0];
  return row ?? null;
}

// ---------------------------------------------------------------------------
// propose_knowledge_edge
// ---------------------------------------------------------------------------

const ProposeKnowledgeEdgeInputSchema = z.object({
  from_knowledge_id: z.string().min(1),
  to_knowledge_id: z.string().min(1),
  relation_type: RelationTypeSchema,
  weight: z.number().min(0).max(1).optional(),
  reasoning: z.string().min(1).max(2000),
  evidence_event_ids: z.array(z.string().min(1)).optional(),
});

const ProposeKnowledgeEdgeOutputSchema = z.object({
  status: z.enum([
    'proposed',
    'skipped:self_edge',
    'skipped:unknown_node',
    'skipped:cross_subject',
    'skipped:duplicate_live_edge',
    'skipped:duplicate_pending',
    'skipped:parent_semantic_duplicate',
    // P5.4 / YUK-143 (RB-6) — rubric-rejected agent edge. The propose event is
    // still written, MARKED rubric-rejected (folded, not dropped); the verdict
    // is returned to the agent as primitive feedback.
    'skipped:rubric_rejected',
  ]),
  proposal_id: z.string().optional(),
  cooldown_key: z.string().optional(),
  reason: z.string().optional(),
  // P5.4 — stable gate string from the rubric verdict (YUK-174 Layer-2 signal).
  gate: z.string().optional(),
});

type ProposeKnowledgeEdgeInput = z.infer<typeof ProposeKnowledgeEdgeInputSchema>;
type ProposeKnowledgeEdgeOutput = z.infer<typeof ProposeKnowledgeEdgeOutputSchema>;

async function proposeKnowledgeEdgeExecute(
  ctx: ToolContext,
  raw: ProposeKnowledgeEdgeInput,
): Promise<ProposeKnowledgeEdgeOutput> {
  const input = ProposeKnowledgeEdgeInputSchema.parse(raw);
  if (input.from_knowledge_id === input.to_knowledge_id) {
    return { status: 'skipped:self_edge', reason: 'from_knowledge_id equals to_knowledge_id' };
  }

  const [fromNode, toNode] = await Promise.all([
    getKnowledgeNode(ctx.db, input.from_knowledge_id),
    getKnowledgeNode(ctx.db, input.to_knowledge_id),
  ]);
  if (!fromNode || !toNode) {
    return {
      status: 'skipped:unknown_node',
      reason: !fromNode ? input.from_knowledge_id : input.to_knowledge_id,
    };
  }

  const sharedDomain = await getSharedKnowledgeDomain(ctx.db, [fromNode.id, toNode.id]);
  if (sharedDomain === null) {
    return {
      status: 'skipped:cross_subject',
      reason: 'knowledge nodes resolve to different domains',
    };
  }

  const repeatsTreeParent =
    input.relation_type === 'related_to' &&
    (fromNode.parent_id === toNode.id || toNode.parent_id === fromNode.id);
  if (repeatsTreeParent) {
    return {
      status: 'skipped:parent_semantic_duplicate',
      reason: 'related_to would only repeat the tree parent relationship',
    };
  }

  const duplicateLiveEdge = (
    await ctx.db
      .select({ id: knowledge_edge.id })
      .from(knowledge_edge)
      .where(
        and(
          isSymmetricRelation(input.relation_type)
            ? or(
                and(
                  eq(knowledge_edge.from_knowledge_id, input.from_knowledge_id),
                  eq(knowledge_edge.to_knowledge_id, input.to_knowledge_id),
                ),
                and(
                  eq(knowledge_edge.from_knowledge_id, input.to_knowledge_id),
                  eq(knowledge_edge.to_knowledge_id, input.from_knowledge_id),
                ),
              )
            : and(
                eq(knowledge_edge.from_knowledge_id, input.from_knowledge_id),
                eq(knowledge_edge.to_knowledge_id, input.to_knowledge_id),
              ),
          eq(knowledge_edge.relation_type, input.relation_type),
          isNull(knowledge_edge.archived_at),
        ),
      )
      .limit(1)
  )[0];
  if (duplicateLiveEdge) {
    return { status: 'skipped:duplicate_live_edge', reason: duplicateLiveEdge.id };
  }

  const cooldownKeys = edgeCooldownKeys(
    input.from_knowledge_id,
    input.to_knowledge_id,
    input.relation_type,
  );
  const cooldownKey = cooldownKeys[0];
  if (await pendingProposalWithAnyCooldown(ctx.db, 'knowledge_edge', cooldownKeys)) {
    return { status: 'skipped:duplicate_pending', cooldown_key: cooldownKey };
  }

  const proposalPayload = {
    kind: 'knowledge_edge' as const,
    target: { subject_kind: 'knowledge_edge' as const, subject_id: null },
    reason_md: input.reasoning,
    evidence_refs: evidenceRefsFromEventIds(input.evidence_event_ids ?? []),
    proposed_change: {
      from_knowledge_id: input.from_knowledge_id,
      to_knowledge_id: input.to_knowledge_id,
      relation_type: input.relation_type,
      weight: input.weight ?? 1,
    },
    cooldown_key: cooldownKey,
  };

  // P5.4 / YUK-143 (RB-1) — shared rubric floor before the write. Agents are
  // strict; user-edited proposals (kind !== 'agent') run structural-only.
  const verdict = await validateProposalQuality(parseAiProposalPayload(proposalPayload), ctx.db, {
    isAgent: ctx.callerActor.kind === 'agent',
    actorRef: ctx.callerActor.ref,
  });
  if (!verdict.ok) {
    return await foldRubricRejectedEdge(ctx, proposalPayload, cooldownKey, verdict, input);
  }

  const proposalId = await writeAiProposal(ctx.db, {
    actor_ref: ctx.callerActor.ref,
    outcome: 'success',
    payload: proposalPayload,
    task_run_id: ctx.taskRunId,
    caused_by_event_id: ctx.causedByEventId ?? null,
  });

  return { status: 'proposed', proposal_id: proposalId, cooldown_key: cooldownKey };
}

// P5.4 / YUK-143 (RB-6 / §3.4) — on an agent rubric rejection, write the
// propose event ANYWAY, MARKED rubric-rejected (carrying { rubric_verdict } as a
// sibling of ai_proposal in the event payload). Folded, not dropped: the row is
// an audit trail + a Layer-2 (YUK-174) signal, and is excluded from live-pending
// dedup/cooldown (RB-7) because the inbox derive maps the marker to a terminal
// 'rubric_rejected' status. Logs the verdict via writeToolCallLog (evidence-first).
async function foldRubricRejectedEdge(
  ctx: ToolContext,
  proposalPayload: AiProposalPayloadInputT,
  cooldownKey: string,
  verdict: Extract<RubricVerdict, { ok: false }>,
  input: ProposeKnowledgeEdgeInput,
): Promise<ProposeKnowledgeEdgeOutput> {
  const proposalId = await writeAiProposal(ctx.db, {
    actor_ref: ctx.callerActor.ref,
    outcome: 'success',
    payload: proposalPayload,
    event_override: {
      action: 'propose',
      subject_kind: 'knowledge_edge',
      payload: {
        from_knowledge_id: input.from_knowledge_id,
        to_knowledge_id: input.to_knowledge_id,
        relation_type: input.relation_type,
        weight: input.weight ?? 1,
        reasoning: input.reasoning,
        rubric_verdict: { ok: false, gate: verdict.gate, reason: verdict.reason },
      },
    },
    task_run_id: ctx.taskRunId,
    caused_by_event_id: ctx.causedByEventId ?? null,
  });

  await writeToolCallLog(ctx.db, {
    task_run_id: ctx.taskRunId,
    task_kind: 'DomainTool',
    tool_name: 'propose_knowledge_edge',
    effect: 'propose',
    input_json: input,
    output_json: { status: 'skipped:rubric_rejected', gate: verdict.gate, reason: verdict.reason },
    error_reason: `rubric:${verdict.gate}`,
    iteration: 0,
    latency_ms: 0,
    cost: 0,
    mirrored_event_id: proposalId,
  });

  return {
    status: 'skipped:rubric_rejected',
    proposal_id: proposalId,
    cooldown_key: cooldownKey,
    gate: verdict.gate,
    reason: verdict.reason,
  };
}

function proposeKnowledgeEdgeSummary(
  input: ProposeKnowledgeEdgeInput,
  output: ProposeKnowledgeEdgeOutput,
): string {
  return `edge proposal ${input.from_knowledge_id}->${input.to_knowledge_id} ${input.relation_type}: ${output.status}`;
}

export const proposeKnowledgeEdgeTool: DomainTool<
  ProposeKnowledgeEdgeInput,
  ProposeKnowledgeEdgeOutput
> = {
  name: 'propose_knowledge_edge',
  description:
    'Propose one knowledge mesh edge. Validates active same-subject nodes, self loops, duplicate live/pending edges, and parent-only related_to redundancy.',
  effect: 'propose',
  inputSchema: ProposeKnowledgeEdgeInputSchema,
  outputSchema: ProposeKnowledgeEdgeOutputSchema,
  costClass: 'local',
  execute: proposeKnowledgeEdgeExecute,
  summarize: proposeKnowledgeEdgeSummary,
  mirrorEvent: 'when_causal',
};

// ---------------------------------------------------------------------------
// propose_knowledge_mutation
// ---------------------------------------------------------------------------

const KnowledgeMutationInputSchema = z.object({
  mutation: z.enum(['propose_new', 'reparent', 'merge', 'split', 'archive']),
  payload: z.record(z.string(), z.unknown()),
  reasoning: z.string().min(1).max(2000),
  evidence_event_ids: z.array(z.string().min(1)).optional(),
});

const KnowledgeMutationParsedSchema = z.discriminatedUnion('mutation', [
  z.object({
    mutation: z.literal('propose_new'),
    payload: z.object({ name: z.string().min(1).max(120), parent_id: z.string().min(1) }),
    reasoning: z.string().min(1).max(2000),
    evidence_event_ids: z.array(z.string().min(1)).default([]),
  }),
  z.object({
    mutation: z.literal('reparent'),
    payload: z.object({
      node_id: z.string().min(1),
      new_parent_id: z.string().min(1),
      expected_version: z.number().int().min(0),
    }),
    reasoning: z.string().min(1).max(2000),
    evidence_event_ids: z.array(z.string().min(1)).default([]),
  }),
  z.object({
    mutation: z.literal('merge'),
    payload: z.object({
      from_ids: z.array(z.string().min(1)).min(1),
      into_id: z.string().min(1),
      expected_versions: z.record(z.string(), z.number().int().min(0)),
    }),
    reasoning: z.string().min(1).max(2000),
    evidence_event_ids: z.array(z.string().min(1)).default([]),
  }),
  z.object({
    mutation: z.literal('split'),
    payload: z.object({
      from_id: z.string().min(1),
      into: z
        .array(z.object({ name: z.string().min(1).max(120), parent_id: z.string().min(1) }))
        .min(1),
      expected_version: z.number().int().min(0),
    }),
    reasoning: z.string().min(1).max(2000),
    evidence_event_ids: z.array(z.string().min(1)).default([]),
  }),
  z.object({
    mutation: z.literal('archive'),
    payload: z.object({
      node_id: z.string().min(1),
      expected_version: z.number().int().min(0),
    }),
    reasoning: z.string().min(1).max(2000),
    evidence_event_ids: z.array(z.string().min(1)).default([]),
  }),
]);

const KnowledgeMutationOutputSchema = z.object({
  status: z.enum([
    'proposed',
    'skipped:unknown_node',
    'skipped:cross_subject',
    'skipped:invalid_payload',
    'skipped:duplicate_pending',
  ]),
  proposal_id: z.string().optional(),
  reason: z.string().optional(),
});

type KnowledgeMutationInput = z.infer<typeof KnowledgeMutationInputSchema>;
type KnowledgeMutationParsedInput = z.infer<typeof KnowledgeMutationParsedSchema>;
type KnowledgeMutationOutput = z.infer<typeof KnowledgeMutationOutputSchema>;

async function activeKnowledgeIds(db: Db, ids: string[]): Promise<Set<string>> {
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length === 0) return new Set();
  const rows = await db
    .select({ id: knowledge.id })
    .from(knowledge)
    .where(and(inArray(knowledge.id, uniqueIds), isNull(knowledge.archived_at)));
  return new Set(rows.map((row) => row.id));
}

function parseKnowledgeMutationInput(input: KnowledgeMutationInput): KnowledgeMutationParsedInput {
  return KnowledgeMutationParsedSchema.parse(input);
}

function knowledgeIdsForMutation(input: KnowledgeMutationParsedInput): string[] {
  switch (input.mutation) {
    case 'propose_new':
      return [input.payload.parent_id];
    case 'reparent':
      return [input.payload.node_id, input.payload.new_parent_id];
    case 'merge':
      return [...input.payload.from_ids, input.payload.into_id];
    case 'split':
      return [input.payload.from_id, ...input.payload.into.map((entry) => entry.parent_id)];
    case 'archive':
      return [input.payload.node_id];
  }
}

function mutationPayload(input: KnowledgeMutationParsedInput): KnowledgeMutationPayload {
  return {
    mutation: input.mutation,
    ...input.payload,
  } as KnowledgeMutationPayload;
}

async function proposeKnowledgeMutationExecute(
  ctx: ToolContext,
  raw: KnowledgeMutationInput,
): Promise<KnowledgeMutationOutput> {
  const input = parseKnowledgeMutationInput(KnowledgeMutationInputSchema.parse(raw));
  if (input.mutation === 'merge' && input.payload.from_ids.includes(input.payload.into_id)) {
    return { status: 'skipped:invalid_payload', reason: 'merge into_id cannot appear in from_ids' };
  }
  if (input.mutation === 'merge') {
    const missingExpectedVersions = input.payload.from_ids.filter(
      (fromId) => !(fromId in input.payload.expected_versions),
    );
    if (missingExpectedVersions.length > 0) {
      return {
        status: 'skipped:invalid_payload',
        reason: `expected_versions missing entry for ${missingExpectedVersions.join(',')}`,
      };
    }
  }

  const ids = knowledgeIdsForMutation(input);
  const activeIds = await activeKnowledgeIds(ctx.db, ids);
  const missing = [...new Set(ids)].filter((id) => !activeIds.has(id));
  if (missing.length > 0) {
    return { status: 'skipped:unknown_node', reason: missing.join(',') };
  }

  const sharedDomain = await getSharedKnowledgeDomain(ctx.db, ids);
  if (sharedDomain === null) {
    return { status: 'skipped:cross_subject', reason: 'mutation spans multiple domains' };
  }

  const duplicateCooldown =
    input.mutation === 'propose_new'
      ? `knowledge_node:${input.payload.parent_id}:${input.payload.name}`
      : input.mutation === 'archive'
        ? `archive:knowledge:${input.payload.node_id}`
        : null;
  if (
    duplicateCooldown &&
    (await pendingProposalWithCooldown(
      ctx.db,
      input.mutation === 'propose_new' ? 'knowledge_node' : 'archive',
      duplicateCooldown,
    ))
  ) {
    return { status: 'skipped:duplicate_pending', reason: duplicateCooldown };
  }

  const proposalId = await writeKnowledgeProposeEvent(ctx.db, {
    payload: mutationPayload(input),
    reasoning: input.reasoning,
    evidence_refs: evidenceRefsFromEventIds(input.evidence_event_ids ?? []),
    actor_ref: ctx.callerActor.ref,
    caused_by_event_id: ctx.causedByEventId ?? null,
    task_run_id: ctx.taskRunId,
  });

  return { status: 'proposed', proposal_id: proposalId };
}

export const proposeKnowledgeMutationTool: DomainTool<
  KnowledgeMutationInput,
  KnowledgeMutationOutput
> = {
  name: 'propose_knowledge_mutation',
  description:
    'Propose a knowledge tree mutation: propose_new, reparent, merge, split, or archive. Writes proposal-only events; accept handlers own the real mutation.',
  effect: 'propose',
  inputSchema: KnowledgeMutationInputSchema,
  outputSchema: KnowledgeMutationOutputSchema,
  costClass: 'local',
  execute: proposeKnowledgeMutationExecute,
  summarize(input, output) {
    return `knowledge ${input.mutation}: ${output.status}`;
  },
  mirrorEvent: 'when_causal',
};

// ---------------------------------------------------------------------------
// attribute_mistake
// ---------------------------------------------------------------------------

const AttributeMistakeInputSchema = z.object({
  attempt_event_id: z.string().min(1),
});

const AttributeMistakeOutputSchema = z.object({
  status: z.enum(['written', 'skipped:existing_judge', 'skipped:not_failure_attempt', 'failed']),
  judge_event_id: z.string().optional(),
  cause: z
    .object({
      primary_category: z.string(),
      secondary_categories: z.array(z.string()),
      confidence: z.number().nullable(),
      analysis_excerpt: z.string(),
    })
    .optional(),
  reason: z.string().optional(),
});

type AttributeMistakeInput = z.infer<typeof AttributeMistakeInputSchema>;
type AttributeMistakeOutput = z.infer<typeof AttributeMistakeOutputSchema>;

function judgeOutput(
  status: 'written' | 'skipped:existing_judge',
  judge: NonNullable<Awaited<ReturnType<typeof getJudgeForAttempt>>>,
): AttributeMistakeOutput {
  return {
    status,
    judge_event_id: judge.judge_event_id,
    cause: {
      primary_category: judge.cause.primary_category,
      secondary_categories: judge.cause.secondary_categories ?? [],
      confidence: judge.cause.confidence ?? null,
      analysis_excerpt: excerpt(judge.cause.analysis_md),
    },
  };
}

async function attributeMistakeExecute(
  ctx: ToolContext,
  raw: AttributeMistakeInput,
): Promise<AttributeMistakeOutput> {
  const input = AttributeMistakeInputSchema.parse(raw);
  const failure = await getFailureAttemptById(ctx.db, input.attempt_event_id);
  if (!failure) {
    return { status: 'skipped:not_failure_attempt' };
  }

  const existingJudge = await getJudgeForAttempt(ctx.db, input.attempt_event_id);
  if (existingJudge) {
    return judgeOutput('skipped:existing_judge', existingJudge);
  }

  const questionRow = (
    await ctx.db
      .select({
        id: question.id,
        prompt_md: question.prompt_md,
        reference_md: question.reference_md,
        knowledge_ids: question.knowledge_ids,
      })
      .from(question)
      .where(eq(question.id, failure.question_id))
      .limit(1)
  )[0];
  if (!questionRow) {
    return { status: 'failed', reason: `question not found: ${failure.question_id}` };
  }

  const knowledgeRows =
    failure.referenced_knowledge_ids.length === 0
      ? []
      : await ctx.db
          .select({ id: knowledge.id, name: knowledge.name, domain: knowledge.domain })
          .from(knowledge)
          .where(inArray(knowledge.id, failure.referenced_knowledge_ids));
  const effectiveDomains = await Promise.all(
    knowledgeRows.map(async (row) => ({
      id: row.id,
      effective_domain: await getEffectiveDomain(ctx.db, row.id).catch(() => row.domain),
    })),
  );
  const domainByKnowledgeId = new Map(
    effectiveDomains.map((row) => [row.id, row.effective_domain ?? null]),
  );
  const subjectProfile = resolveSubjectProfile(
    domainByKnowledgeId.get(knowledgeRows[0]?.id) ?? null,
  );

  let attributionTaskRan = false;
  await runAttributionAndWriteJudgeEvent({
    db: ctx.db,
    attemptEventId: input.attempt_event_id,
    input: {
      prompt_md: questionRow.prompt_md,
      reference_md: questionRow.reference_md ?? null,
      wrong_answer_md: failure.answer_md ?? '',
      knowledge_context: knowledgeRows.map((row) => ({
        id: row.id,
        name: row.name,
        effective_domain: domainByKnowledgeId.get(row.id) ?? null,
      })),
    },
    runTaskFn: (kind, taskInput, taskCtx) => {
      attributionTaskRan = true;
      return defaultRunTaskFn(kind, taskInput, { ...(taskCtx as object), db: ctx.db });
    },
    subjectProfile,
    referencedKnowledgeIds: failure.referenced_knowledge_ids,
  });

  const writtenJudge = await getJudgeForAttempt(ctx.db, input.attempt_event_id);
  if (!writtenJudge) {
    return { status: 'failed', reason: 'AttributionTask completed without writing a judge event' };
  }
  if (!attributionTaskRan) {
    return judgeOutput('skipped:existing_judge', writtenJudge);
  }
  return judgeOutput('written', writtenJudge);
}

export const attributeMistakeTool: DomainTool<AttributeMistakeInput, AttributeMistakeOutput> = {
  name: 'attribute_mistake',
  description:
    'Run the existing AttributionTask path for one failure attempt and append a judge event if no active judge exists. The caller cannot provide a cause.',
  effect: 'write',
  inputSchema: AttributeMistakeInputSchema,
  outputSchema: AttributeMistakeOutputSchema,
  costClass: 'cheap_llm',
  execute: attributeMistakeExecute,
  summarize(input, output) {
    return `attribute ${input.attempt_event_id.slice(0, 8)}: ${output.status}${output.cause ? ` (${output.cause.primary_category})` : ''}`;
  },
  mirrorEvent: 'when_causal',
};

// ---------------------------------------------------------------------------
// propose_variant
// ---------------------------------------------------------------------------

const ProposeVariantInputSchema = z.object({
  attempt_event_id: z.string().min(1),
  count: z.literal(1).optional(),
});

const ProposeVariantOutputSchema = z.object({
  status: z.enum([
    'generated',
    'skipped:attempt_not_found',
    'skipped:not_failure_attempt',
    'skipped:attempt_not_active',
    'skipped:no_judge_yet',
    'skipped:question_not_found',
    'skipped:max_depth',
    'skipped:variant_chain_terminus',
    'skipped:cause_not_targetable',
    'skipped:already_has_variant',
    'skipped:variants_max_reached',
    'failed',
  ]),
  proposal_ids: z.array(z.string()),
  mistake_variant_ids: z.array(z.string()),
  variant_question_ids: z.array(z.string()),
  reasoning_summary: z.string().optional(),
});

type ProposeVariantInput = z.infer<typeof ProposeVariantInputSchema>;
type ProposeVariantOutput = z.infer<typeof ProposeVariantOutputSchema>;

async function proposeVariantExecute(
  ctx: ToolContext,
  raw: ProposeVariantInput,
): Promise<ProposeVariantOutput> {
  const input = ProposeVariantInputSchema.parse(raw);
  try {
    const result = await runVariantGen({
      db: ctx.db,
      attemptEventId: input.attempt_event_id,
      runTaskFn: defaultRunTaskFn,
    });
    if (result.status !== 'proposed') {
      return {
        status:
          result.status === 'skipped:not_a_failure_attempt'
            ? 'skipped:not_failure_attempt'
            : result.status,
        proposal_ids: [],
        mistake_variant_ids: [],
        variant_question_ids: [],
      };
    }
    return {
      status: 'generated',
      proposal_ids: result.proposal_id ? [result.proposal_id] : [],
      mistake_variant_ids: result.mistake_variant_id ? [result.mistake_variant_id] : [],
      variant_question_ids: [],
      reasoning_summary: result.proposal_id ? `proposal ${result.proposal_id}` : undefined,
    };
  } catch (err) {
    return {
      status: 'failed',
      proposal_ids: [],
      mistake_variant_ids: [],
      variant_question_ids: [],
      reasoning_summary: err instanceof Error ? err.message : String(err),
    };
  }
}

export const proposeVariantTool: DomainTool<ProposeVariantInput, ProposeVariantOutput> = {
  name: 'propose_variant',
  description:
    'Generate one targeted variant-question proposal for a failure attempt by reusing runVariantGen guards: active failure, judge required, targetable cause, depth cap, and variant caps.',
  effect: 'propose',
  inputSchema: ProposeVariantInputSchema,
  outputSchema: ProposeVariantOutputSchema,
  costClass: 'cheap_llm',
  execute: proposeVariantExecute,
  summarize(input, output) {
    return `variant ${input.attempt_event_id.slice(0, 8)}: ${output.status}`;
  },
  mirrorEvent: 'when_causal',
};

// ---------------------------------------------------------------------------
// LearningItem proposal tools
// ---------------------------------------------------------------------------

const CompletionSignalSchema = z.enum([
  'mastery_high_persisted',
  'check_all_passed',
  'no_recent_mistake',
  'user_stated_understanding',
]);

const ProposeLearningItemCompletionInputSchema = z.object({
  learning_item_id: z.string().min(1),
  triggering_signals: z.array(CompletionSignalSchema).min(1),
  evidence_event_ids: z.array(z.string().min(1)).optional(),
  reasoning: z.string().min(1).max(2000),
});

const LearningItemProposalOutputSchema = z.object({
  status: z.enum([
    'proposed',
    'skipped:not_found',
    'skipped:invalid_state',
    'skipped:duplicate_pending',
  ]),
  proposal_id: z.string().optional(),
  learning_item_id: z.string().optional(),
  reason: z.string().optional(),
});

type ProposeLearningItemCompletionInput = z.infer<typeof ProposeLearningItemCompletionInputSchema>;
type LearningItemProposalOutput = z.infer<typeof LearningItemProposalOutputSchema>;

async function proposeLearningItemCompletionExecute(
  ctx: ToolContext,
  raw: ProposeLearningItemCompletionInput,
): Promise<LearningItemProposalOutput> {
  const input = ProposeLearningItemCompletionInputSchema.parse(raw);
  const item = await getActiveLearningItem(ctx.db, input.learning_item_id);
  if (!item) return { status: 'skipped:not_found', learning_item_id: input.learning_item_id };
  if (item.status !== 'pending' && item.status !== 'in_progress') {
    return {
      status: 'skipped:invalid_state',
      learning_item_id: input.learning_item_id,
      reason: item.status,
    };
  }
  const cooldownKey = `completion:${input.learning_item_id}`;
  if (await pendingProposalWithCooldown(ctx.db, 'completion', cooldownKey)) {
    return { status: 'skipped:duplicate_pending', learning_item_id: input.learning_item_id };
  }

  const proposalId = await writeCompletionProposal(ctx.db, {
    learning_item_id: input.learning_item_id,
    triggering_signals: input.triggering_signals,
    evidence_refs: evidenceRefsFromEventIds(input.evidence_event_ids ?? []),
    evidence_json: { evidence_event_ids: input.evidence_event_ids ?? [] },
    reason_md: input.reasoning,
    task_run_id: ctx.taskRunId,
  });
  return { status: 'proposed', proposal_id: proposalId, learning_item_id: input.learning_item_id };
}

export const proposeLearningItemCompletionTool: DomainTool<
  ProposeLearningItemCompletionInput,
  LearningItemProposalOutput
> = {
  name: 'propose_learning_item_completion',
  description:
    'Propose that a pending/in_progress LearningItem is ready for completion. Writes a completion proposal only; status transition and ai_propose evidence stay in accept owner routes.',
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
  const proposalId = await writeRelearnProposal(ctx.db, {
    learning_item_id: input.learning_item_id,
    current_mastery: currentMastery,
    peak_mastery: peakMastery,
    days_since_done: daysSinceDone,
    evidence_refs: evidenceRefsFromEventIds(input.evidence_event_ids ?? []),
    reason_md: input.reasoning,
    task_run_id: ctx.taskRunId,
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

// ---------------------------------------------------------------------------
// propose_learning_item_defer  (Wave 5 / T-D6/C / YUK-120)
// ---------------------------------------------------------------------------
//
// Coach-suggested postponement of an active LearningItem (status pending or
// in_progress). Writes a `defer` proposal so the user can review and apply,
// or dismiss. No direct status mutation — accept owner routes apply the
// transition.

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

// ---------------------------------------------------------------------------
// propose_learning_item_archive  (Wave 5 / T-D6/C / YUK-120)
// ---------------------------------------------------------------------------
//
// Coach-suggested archival of a LearningItem that the user no longer wants
// to keep active. Writes an `archive` proposal — the existing
// `writeArchiveProposal` producer is generic over subject_kind so we wrap
// it for the LearningItem target shape.

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
