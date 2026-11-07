// YUK-876 — knowledge proposal DomainTools. Proposal-only: they write
// inbox-visible events and never apply destructive graph mutations.

import { and, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import {
  checkProposalCooldownGate,
  writeKnowledgeEdgeProposal,
} from '@/capabilities/knowledge/server/edge-proposal-write';
import { findLiveSameNameKnowledgeNodes } from '@/capabilities/knowledge/server/knowledge-name-dedup';
import {
  knowledgeMutationCooldown,
  writeKnowledgeProposeEvent,
} from '@/capabilities/knowledge/server/proposals';
import { normalizeKnowledgeNodeName } from '@/core/knowledge-name';
import { RelationTypeSchema } from '@/core/schema/event/blocks';
// P5.6 / YUK-178 — model-labeled proactive/corrective discriminator.
import { SuggestionKind } from '@/core/schema/event/known';
import { LearnerSummarySchema, type ProposalEvidenceRefT } from '@/core/schema/proposal';
import type { Db, Tx } from '@/db/client';
import { knowledge } from '@/db/schema';
import { proposalAutoApplies } from '@/kernel/proposals/auto-apply-marker';
import { withProposalGateLock } from '@/kernel/proposals/signals';
import { getEffectiveDomain } from '@/kernel/read-models/knowledge-tree';
import { sanitizeProposedNodeDomain } from '@/subjects/profile';
import type { DomainTool, ToolContext } from './types';

type DbLike = Db | Tx;

// Cap model input so a malformed call cannot amplify into unbounded evidence reads.
const EvidenceEventIdsSchema = z.array(z.string().min(1)).max(20);

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

async function getSharedKnowledgeDomain(db: Db, ids: string[]): Promise<string | null> {
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length === 0) return null;
  const domains = await Promise.all(uniqueIds.map((id) => getEffectiveDomain(db, id)));
  const [first] = domains;
  return domains.every((domain) => domain === first) ? first : null;
}

// ADR-0032 D4-E1 — 'create' (default) proposes a new edge; 'archive' soft-deletes
// an existing live edge by id. Flat z.object because the MCP bridge requires a
// ZodObject, so per-op required fields are checked in execute().
const ProposeKnowledgeEdgeInputSchema = z.object({
  // Optional keeps the Input type a clean z.object; absence means 'create' and is
  // applied in execute(). A .default() would break the DomainTool input type.
  op: z.enum(['create', 'archive']).optional(),
  // create-op endpoints; optional on the schema, required by op in execute().
  from_knowledge_id: z.string().min(1).optional(),
  to_knowledge_id: z.string().min(1).optional(),
  relation_type: RelationTypeSchema.optional(),
  weight: z.number().min(0).max(1).optional(),
  // archive-op target: the live knowledge_edge.id to soft-delete.
  edge_id: z.string().min(1).optional(),
  // Learner-facing line; technical evidence stays in reasoning/evidence_event_ids.
  learner_summary: LearnerSummarySchema,
  reasoning: z.string().min(1).max(2000),
  evidence_event_ids: EvidenceEventIdsSchema.optional(),
  // P5.6 / YUK-178 — optional model label: 'corrective' only when this edge
  // repairs an observed failure; omit means proactive. No deterministic coercion.
  suggestion_kind: SuggestionKind.optional(),
});

const ProposeKnowledgeEdgeOutputSchema = z.object({
  status: z.enum([
    'proposed',
    'skipped:self_edge',
    'skipped:unknown_node',
    'skipped:cross_subject',
    'skipped:duplicate_live_edge',
    'skipped:duplicate_pending',
    // YUK-1553 — an active dismiss-cooldown covers this edge key.
    'skipped:cooldown',
    'skipped:parent_semantic_duplicate',
    // P5.4 — rubric-rejected agent edge. The proposal is still written and marked
    // rejected; the verdict returns to the agent as primitive feedback.
    'skipped:rubric_rejected',
    // ADR-0032 — archive target missing/already archived, or a proposal is pending.
    'skipped:edge_not_found',
    // A create with zero evidence refs is skipped so the agent can retry with
    // the supporting attempt/event ids — structural shape, not an evidence floor.
    'skipped:no_evidence',
  ]),
  proposal_id: z.string().optional(),
  cooldown_key: z.string().optional(),
  // YUK-1553 — ISO deadline so the agent knows when a retry could succeed.
  cooldown_until: z.string().optional(),
  // YUK-1553 — live edge id for duplicate/not-found outcomes.
  edge_id: z.string().optional(),
  reason: z.string().optional(),
  // P5.4 — stable gate string from the rubric verdict (YUK-174 Layer-2 signal).
  gate: z.string().optional(),
});

type ProposeKnowledgeEdgeInput = z.infer<typeof ProposeKnowledgeEdgeInputSchema>;
export type ProposeKnowledgeEdgeOutput = z.infer<typeof ProposeKnowledgeEdgeOutputSchema>;

async function proposeKnowledgeEdgeExecute(
  ctx: ToolContext,
  raw: ProposeKnowledgeEdgeInput,
): Promise<ProposeKnowledgeEdgeOutput> {
  const input = ProposeKnowledgeEdgeInputSchema.parse(raw);
  // ADR-0032 — dispatch by op. Archive shares the writer/inbox/accept path but
  // skips the create-only rubric floor.
  if (input.op === 'archive') {
    return await proposeKnowledgeEdgeArchive(ctx, input);
  }
  return await proposeKnowledgeEdgeCreate(ctx, input);
}

async function proposeKnowledgeEdgeCreate(
  ctx: ToolContext,
  input: ProposeKnowledgeEdgeInput,
): Promise<ProposeKnowledgeEdgeOutput> {
  // create-op required fields are checked here due to the flat-schema MCP constraint.
  if (!input.from_knowledge_id || !input.to_knowledge_id || !input.relation_type) {
    return {
      status: 'skipped:unknown_node',
      reason: "op 'create' requires from_knowledge_id, to_knowledge_id, relation_type",
    };
  }
  const fromKnowledgeId = input.from_knowledge_id;
  const toKnowledgeId = input.to_knowledge_id;
  const relationType = input.relation_type;
  if (fromKnowledgeId === toKnowledgeId) {
    return { status: 'skipped:self_edge', reason: 'from_knowledge_id equals to_knowledge_id' };
  }

  const [fromNode, toNode] = await Promise.all([
    getKnowledgeNode(ctx.db, fromKnowledgeId),
    getKnowledgeNode(ctx.db, toKnowledgeId),
  ]);
  if (!fromNode || !toNode) {
    return {
      status: 'skipped:unknown_node',
      reason: !fromNode ? fromKnowledgeId : toKnowledgeId,
    };
  }

  const sharedDomain = await getSharedKnowledgeDomain(ctx.db, [fromNode.id, toNode.id]);
  if (sharedDomain === null) {
    return {
      status: 'skipped:cross_subject',
      reason: 'knowledge nodes resolve to different domains',
    };
  }

  const repeatsTreeParent = fromNode.parent_id === toNode.id || toNode.parent_id === fromNode.id;
  if (repeatsTreeParent) {
    return {
      status: 'skipped:parent_semantic_duplicate',
      reason: `${relationType} would repeat the tree parent relationship`,
    };
  }

  return await writeKnowledgeEdgeProposal(ctx.db, {
    validate: 'rubric',
    change: {
      edge_op: 'create',
      from_knowledge_id: fromKnowledgeId,
      to_knowledge_id: toKnowledgeId,
      relation_type: relationType,
      weight: input.weight ?? 1,
    },
    learner_summary: input.learner_summary,
    reason_md: input.reasoning,
    evidence_refs: evidenceRefsFromEventIds(input.evidence_event_ids ?? []),
    // P5.6 — explicit model label; survives parseAiProposalPayload into the rubric.
    suggestion_kind: input.suggestion_kind ?? 'proactive',
    actor_ref: ctx.callerActor.ref,
    task_run_id: ctx.taskRunId,
    caused_by_event_id: ctx.causedByEventId ?? null,
  });
}

// ADR-0032 — archive executor: proposes soft-deleting a live edge through the
// same proposal→accept loop. Archive carries no evidence by design; the ≥1-ref
// shape rule applies to create only.
async function proposeKnowledgeEdgeArchive(
  ctx: ToolContext,
  input: ProposeKnowledgeEdgeInput,
): Promise<ProposeKnowledgeEdgeOutput> {
  if (!input.edge_id) {
    return { status: 'skipped:edge_not_found', reason: "op 'archive' requires edge_id" };
  }
  return await writeKnowledgeEdgeProposal(ctx.db, {
    validate: 'rubric',
    change: { edge_op: 'archive', edge_id: input.edge_id },
    learner_summary: input.learner_summary,
    reason_md: input.reasoning,
    evidence_refs: evidenceRefsFromEventIds(input.evidence_event_ids ?? []),
    suggestion_kind: input.suggestion_kind ?? 'proactive',
    actor_ref: ctx.callerActor.ref,
    task_run_id: ctx.taskRunId,
    caused_by_event_id: ctx.causedByEventId ?? null,
  });
}

function proposeKnowledgeEdgeSummary(
  input: ProposeKnowledgeEdgeInput,
  output: ProposeKnowledgeEdgeOutput,
): string {
  if (input.op === 'archive') {
    return `edge archive proposal ${input.edge_id ?? '?'}: ${output.status}`;
  }
  return `edge proposal ${input.from_knowledge_id ?? '?'}->${input.to_knowledge_id ?? '?'} ${input.relation_type ?? '?'}: ${output.status}`;
}

export const proposeKnowledgeEdgeTool: DomainTool<
  ProposeKnowledgeEdgeInput,
  ProposeKnowledgeEdgeOutput
> = {
  name: 'propose_knowledge_edge',
  description:
    'Propose one knowledge mesh edge change. op="create" (default) proposes a NEW edge from {from_knowledge_id, to_knowledge_id, relation_type, weight?} — validates active same-subject nodes, self loops, duplicate live/pending edges, and parent-only related_to redundancy. A create must name at least one supporting attempt/event id in evidence_event_ids (else skipped:no_evidence — fix and retry); evidence sufficiency is decided by the user at accept, not by a write-time gate. op="archive" proposes soft-deleting an EXISTING live edge named by edge_id (no failure evidence required — archiving is the inverse of proposing). Both ops are proposal-only: the user accepts in the inbox; archive sets archived_at, never a hard delete. Results starting with skipped: mean the proposal was NOT written — do not retry the same change. Every call also requires learner_summary: one plain Chinese sentence (max 80 chars) for the learner — state WHAT this proposal will do and WHY. Never put knowledge/edge ids, tool names, or English field names (for example propose_knowledge_edge, evidence_event_ids, children=0) in learner_summary; technical evidence belongs in reasoning/evidence_event_ids. A hard failure beginning with learner_summary_rejected means only that sentence must be rewritten before retrying.',
  effect: 'propose',
  inputSchema: ProposeKnowledgeEdgeInputSchema,
  outputSchema: ProposeKnowledgeEdgeOutputSchema,
  costClass: 'local',
  execute: proposeKnowledgeEdgeExecute,
  summarize: proposeKnowledgeEdgeSummary,
  mirrorEvent: 'when_causal',
};

// YUK-1553 — the model-visible input exposes the real five-branch change. The pi
// bridge needs a top-level z.object, so the union lives in `change`; one schema
// serves both the wire contract and the execute-side parse.
const KnowledgeMutationChangeSchema = z.discriminatedUnion('mutation', [
  z.object({
    mutation: z.literal('propose_new'),
    name: z.string().min(1).max(120),
    // null = new domain ROOT and requires `domain` (validated in execute);
    // a string parent_id proposes a child node.
    parent_id: z.string().min(1).nullable(),
    domain: z.string().min(1).optional(),
  }),
  z.object({
    mutation: z.literal('reparent'),
    node_id: z.string().min(1),
    new_parent_id: z.string().min(1),
    // CAS token: the node's current `version`.
    expected_version: z.number().int().min(0),
  }),
  z.object({
    mutation: z.literal('merge'),
    from_ids: z.array(z.string().min(1)).min(1),
    into_id: z.string().min(1),
    // CAS tokens for every absorbed node; accept rejects a drifted base version.
    expected_versions: z.record(z.string(), z.number().int().min(0)),
  }),
  z.object({
    mutation: z.literal('split'),
    from_id: z.string().min(1),
    into: z
      .array(z.object({ name: z.string().min(1).max(120), parent_id: z.string().min(1) }))
      .min(1),
    expected_version: z.number().int().min(0),
  }),
  z.object({
    mutation: z.literal('archive'),
    node_id: z.string().min(1),
    expected_version: z.number().int().min(0),
  }),
]);

const KnowledgeMutationInputSchema = z.object({
  change: KnowledgeMutationChangeSchema,
  // Learner-facing line; technical evidence stays in reasoning/evidence_event_ids.
  learner_summary: LearnerSummarySchema,
  reasoning: z.string().min(1).max(2000),
  evidence_event_ids: EvidenceEventIdsSchema.optional(),
  // P5.6 — optional model label; omit unless this mutation repairs an observed failure.
  suggestion_kind: SuggestionKind.optional(),
});

const KnowledgeMutationOutputSchema = z.object({
  status: z.enum([
    'proposed',
    'skipped:unknown_node',
    'skipped:cross_subject',
    'skipped:invalid_payload',
    'skipped:duplicate_pending',
    // YUK-1553 — an active dismiss-cooldown covers this key.
    'skipped:cooldown',
    // A live node already exists under this parent with the same normalized
    // name; reuse the returned node_id instead of proposing a duplicate.
    'skipped:already_exists',
  ]),
  proposal_id: z.string().optional(),
  // skipped:already_exists — the existing live node's id, attachable directly.
  node_id: z.string().optional(),
  // Present only when the written proposal carries the auto-apply marker —
  // the automated lane applies it shortly, so the caller must not ask the
  // learner to confirm. Absent means ordinary human review.
  auto_apply: z.literal(true).optional(),
  cooldown_key: z.string().optional(),
  cooldown_until: z.string().optional(),
  reason: z.string().optional(),
  // skipped:duplicate_pending / skipped:already_exists — the deterministic next
  // step the result already enables, so the model can continue without re-reading.
  next_step: z.string().optional(),
});

type KnowledgeMutationInput = z.infer<typeof KnowledgeMutationInputSchema>;
type KnowledgeMutationChange = z.infer<typeof KnowledgeMutationChangeSchema>;
export type KnowledgeMutationOutput = z.infer<typeof KnowledgeMutationOutputSchema>;

async function activeKnowledgeIds(db: DbLike, ids: string[]): Promise<Set<string>> {
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length === 0) return new Set();
  const rows = await db
    .select({ id: knowledge.id })
    .from(knowledge)
    .where(and(inArray(knowledge.id, uniqueIds), isNull(knowledge.archived_at)));
  return new Set(rows.map((row) => row.id));
}

function knowledgeIdsForMutation(change: KnowledgeMutationChange): string[] {
  switch (change.mutation) {
    case 'propose_new':
      return change.parent_id === null ? [] : [change.parent_id];
    case 'reparent':
      return [change.node_id, change.new_parent_id];
    case 'merge':
      return [...change.from_ids, change.into_id];
    case 'split':
      return [change.from_id, ...change.into.map((entry) => entry.parent_id)];
    case 'archive':
      return [change.node_id];
  }
}

async function proposeKnowledgeMutationExecute(
  ctx: ToolContext,
  raw: KnowledgeMutationInput,
): Promise<KnowledgeMutationOutput> {
  const input = KnowledgeMutationInputSchema.parse(raw);
  const change = input.change;
  if (change.mutation === 'merge' && change.from_ids.includes(change.into_id)) {
    return { status: 'skipped:invalid_payload', reason: 'merge into_id cannot appear in from_ids' };
  }
  if (change.mutation === 'merge') {
    const missingExpectedVersions = change.from_ids.filter(
      (fromId) => !(fromId in change.expected_versions),
    );
    if (missingExpectedVersions.length > 0) {
      return {
        status: 'skipped:invalid_payload',
        reason: `expected_versions missing entry for ${missingExpectedVersions.join(',')}`,
      };
    }
  }

  // Root proposals need a real domain; children inherit the parent's effective
  // domain and must omit it. 'general'/blank is never a node domain.
  if (change.mutation === 'propose_new') {
    if (change.parent_id === null && !sanitizeProposedNodeDomain(change.domain)) {
      return {
        status: 'skipped:invalid_payload',
        reason:
          "root proposal (parent_id=null) requires a selectable change.domain — 'general'/blank is a fallback identity, not a node domain",
      };
    }
    if (change.parent_id !== null && change.domain !== undefined) {
      return {
        status: 'skipped:invalid_payload',
        reason: 'child nodes inherit the parent domain — omit change.domain when parent_id is set',
      };
    }
  }

  const ids = knowledgeIdsForMutation(change);
  const activeIds = await activeKnowledgeIds(ctx.db, ids);
  const missing = [...new Set(ids)].filter((id) => !activeIds.has(id));
  if (missing.length > 0) {
    return { status: 'skipped:unknown_node', reason: missing.join(',') };
  }

  // Root proposals reference no existing nodes; the domain is reviewed at accept.
  const sharedDomain = ids.length === 0 ? 'root' : await getSharedKnowledgeDomain(ctx.db, ids);
  if (sharedDomain === null) {
    return { status: 'skipped:cross_subject', reason: 'mutation spans multiple domains' };
  }

  const writeProposal = (db: DbLike) =>
    writeKnowledgeProposeEvent(db, {
      payload: change,
      learner_summary: input.learner_summary,
      reasoning: input.reasoning,
      evidence_refs: evidenceRefsFromEventIds(input.evidence_event_ids ?? []),
      actor_ref: ctx.callerActor.ref,
      caused_by_event_id: ctx.causedByEventId ?? null,
      task_run_id: ctx.taskRunId,
      // P5.6 — model-labeled discriminator, default proactive.
      suggestion_kind: input.suggestion_kind ?? 'proactive',
    });

  // Every branch shares the writer's `(kind, cooldown_key)` identity; change-scoped
  // mutations now dedup too.
  const gate = knowledgeMutationCooldown(change);
  // YUK-1553 — dedup reads + write in one advisory-locked txn so retries skip
  // instead of stacking inbox rows.
  return await withProposalGateLock(ctx.db, gate.kind, gate.cooldownKeys, async (tx) => {
    // A live same-named node beats any pending/cooldown state: reuse its id so
    // the caller can attach content this turn instead of waiting for an apply.
    if (change.mutation === 'propose_new') {
      const [existing] = await findLiveSameNameKnowledgeNodes(tx, {
        name: change.name,
        parentId: change.parent_id,
        role: 'kc',
        ...(change.parent_id === null
          ? { domain: sanitizeProposedNodeDomain(change.domain) ?? undefined }
          : {}),
      });
      if (existing) {
        return {
          status: 'skipped:already_exists',
          node_id: existing.id,
          reason: `a live node already exists here with the normalized name '${normalizeKnowledgeNodeName(change.name)}'`,
          next_step:
            'attach content directly to the returned node_id (e.g. author_question knowledge_ids=[node_id]); do not wait for any apply',
        };
      }
    }
    const skip = await checkProposalCooldownGate(tx, gate.kind, gate.cooldownKeys);
    if (skip) {
      return {
        status: skip.status,
        proposal_id: skip.proposal_id,
        cooldown_key: skip.cooldown_key,
        cooldown_until: skip.cooldown_until,
        ...(skip.status === 'skipped:duplicate_pending'
          ? {
              next_step:
                change.mutation === 'propose_new'
                  ? 'an identical node proposal is already pending — do not propose it again; author_question needs no node id, submit under the subject root with knowledge_ids=[], subject_id, and the learner wording as learner_topic; report its placement only as placement_note says'
                  : 'the identical change is already pending — do not retry it; continue with the rest of the plan',
            }
          : {}),
      };
    }
    const proposalId = await writeProposal(tx);
    return {
      status: 'proposed',
      proposal_id: proposalId,
      ...(change.mutation === 'propose_new' && proposalAutoApplies('knowledge_node')
        ? { auto_apply: true as const }
        : {}),
    };
  });
}

export const proposeKnowledgeMutationTool: DomainTool<
  KnowledgeMutationInput,
  KnowledgeMutationOutput
> = {
  name: 'propose_knowledge_mutation',
  description:
    "Propose one knowledge tree mutation. Creating a new node (propose_new) is auto-applied by the automated lane shortly after this call returns — no user confirmation step; the node is still reversible from the inbox undo window. reparent/merge/split/archive remain human-reviewed. Input: {change, learner_summary, reasoning, evidence_event_ids?}. change.mutation picks the branch: propose_new {name, parent_id} — parent_id=null + domain proposes a NEW subject root; a child uses an existing node id and omits domain. reparent {node_id, new_parent_id, expected_version}. merge {from_ids, into_id, expected_versions:{id:version} for every from_id}. split {from_id, into:[{name,parent_id}], expected_version}. archive {node_id, expected_version}. expected_version(s) are CAS tokens — copy the node's current `version` from query_knowledge / the tree input. Results starting with skipped: mean the proposal was NOT written — do not retry the same change. For propose_new, 'skipped:already_exists' returns node_id of a live same-name node — attach content directly to it (e.g. author_question knowledge_ids) instead of waiting for an apply. When you propose a node because the topic has none, name it with the learner's own topic wording verbatim (whitespace aside): author_question records that wording as learner_topic; the root-placement refile, when enabled, matches the node by exact name equality, so a renamed node can leave the question at the subject root. learner_summary is one plain Chinese sentence (max 80 chars) for the learner — state WHAT this proposal will do and WHY. Never put node ids, tool names, or English field names (for example propose_knowledge_mutation, expected_version, children=0) in learner_summary; technical evidence belongs in reasoning/evidence_event_ids. A hard failure beginning with learner_summary_rejected means only that sentence must be rewritten before retrying.",
  effect: 'propose',
  inputSchema: KnowledgeMutationInputSchema,
  outputSchema: KnowledgeMutationOutputSchema,
  costClass: 'local',
  execute: proposeKnowledgeMutationExecute,
  summarize(input, output) {
    return `knowledge ${input.change.mutation}: ${output.status}`;
  },
  mirrorEvent: 'when_causal',
};
