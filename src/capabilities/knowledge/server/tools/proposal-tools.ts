// YUK-876 — knowledge proposal DomainTools. Proposal-only: they write
// inbox-visible events and never apply destructive graph mutations.

import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { z } from 'zod';
// ADR-0032 D4-E1 — archive-op proposals target a live edge by id; edges.ts is
// the read authority.
import { getKnowledgeEdgeById } from '@/capabilities/knowledge/server/edges';
import {
  knowledgeMutationCooldown,
  writeKnowledgeProposeEvent,
} from '@/capabilities/knowledge/server/proposals';
import {
  type RubricVerdict,
  validateProposalQuality,
} from '@/capabilities/knowledge/server/rubric-validator';
import { RelationTypeSchema, isSymmetricKnowledgeRelation } from '@/core/schema/event/blocks';
// P5.6 / YUK-178 — model-labeled proactive/corrective discriminator.
import { SuggestionKind } from '@/core/schema/event/known';
import {
  type AiProposalPayloadInputT,
  type ProposalEvidenceRefT,
  parseAiProposalPayload,
} from '@/core/schema/proposal';
import type { Db, Tx } from '@/db/client';
import { knowledge, knowledge_edge } from '@/db/schema';
// P5.4-L2 / YUK-174 — per-(kind, relation) gate bump passed to the L1 validator;
// cold start is a no-op.
import { resolveEdgeGateBump } from '@/kernel/proposals/adaptive-bias';
import { listProposalInboxRows } from '@/kernel/proposals/inbox';
import { findActiveProposalCooldown, withProposalGateLock } from '@/kernel/proposals/signals';
import { writeAiProposal } from '@/kernel/proposals/writer';
import { getEffectiveDomain } from '@/kernel/read-models/knowledge-tree';
// P5.4-L2 / YUK-174 — adaptive gate-bump budget + bias config.
import { PROPOSAL_FEEDBACK_BUDGET, PROPOSAL_GATE_BIAS_CONFIG } from '@/kernel/tools/budgets';
import { writeToolCallLog } from '@/kernel/tools/call-evidence';
import { sanitizeProposedNodeDomain } from '@/subjects/profile';
import type { DomainTool, ToolContext } from './types';

type DbLike = Db | Tx;

// Cap model input so a malformed call cannot amplify into unbounded evidence reads.
const EvidenceEventIdsSchema = z.array(z.string().min(1)).max(20);

function evidenceRefsFromEventIds(ids: string[]): ProposalEvidenceRefT[] {
  return [...new Set(ids)].map((id) => ({ kind: 'event', id }));
}

// YUK-1553 — propose-side dedup/cooldown gate shared by both proposal tools.
// Runs inside withProposalGateLock so reads and write serialize per (kind, cooldown_key).
interface ProposalCooldownSkip {
  status: 'skipped:duplicate_pending' | 'skipped:cooldown';
  /** Existing proposal row id: the pending twin, or the latest proposal on the key. */
  proposal_id?: string;
  cooldown_key: string;
  cooldown_until?: string;
}

async function checkProposalCooldownGate(
  db: DbLike,
  kind: string,
  cooldownKeys: readonly string[],
): Promise<ProposalCooldownSkip | null> {
  const keys = new Set(cooldownKeys);
  const rows = await listProposalInboxRows(db);
  const onKey = rows.filter(
    (row) =>
      row.kind === kind &&
      row.payload.cooldown_key !== undefined &&
      keys.has(row.payload.cooldown_key),
  );
  const pending = onKey.find((row) => row.status === 'pending');
  if (pending) {
    return {
      status: 'skipped:duplicate_pending',
      proposal_id: pending.id,
      cooldown_key: cooldownKeys[0] ?? (pending.payload.cooldown_key as string),
    };
  }
  const cooling = await findActiveProposalCooldown(db, kind, cooldownKeys);
  if (cooling) {
    // Point at the dismissed proposal that started the cooldown (fallback: latest row).
    const latest = (rows: typeof onKey) =>
      rows.reduce<(typeof onKey)[number] | undefined>(
        (best, row) => (best === undefined || row.proposed_at > best.proposed_at ? row : best),
        undefined,
      );
    const dismissed = onKey.filter((row) => row.status === 'dismissed');
    const source = latest(dismissed) ?? latest(onKey);
    return {
      status: 'skipped:cooldown',
      proposal_id: source?.id,
      cooldown_key: cooling.cooldown_key,
      cooldown_until: cooling.cooldown_until.toISOString(),
    };
  }
  return null;
}

function edgeCooldownKeys(fromId: string, toId: string, relationType: string): string[] {
  const directional = `knowledge_edge:${fromId}|${toId}|${relationType}`;
  if (!isSymmetricKnowledgeRelation(relationType)) return [directional];
  const normalized = [fromId, toId].sort().join('|');
  return [
    `knowledge_edge:${normalized}|${relationType}`,
    directional,
    `knowledge_edge:${toId}|${fromId}|${relationType}`,
  ];
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

  const cooldownKeys = edgeCooldownKeys(fromKnowledgeId, toKnowledgeId, relationType);
  const cooldownKey = cooldownKeys[0];

  // YUK-1553 — duplicate/pending/cooldown reads and the write share one
  // advisory-locked txn; rubric/adaptive stay inside so both see the serialized world.
  return await withProposalGateLock(ctx.db, 'knowledge_edge', cooldownKeys, async (tx) => {
    const duplicateLiveEdge = (
      await tx
        .select({ id: knowledge_edge.id })
        .from(knowledge_edge)
        .where(
          and(
            isSymmetricKnowledgeRelation(relationType)
              ? or(
                  and(
                    eq(knowledge_edge.from_knowledge_id, fromKnowledgeId),
                    eq(knowledge_edge.to_knowledge_id, toKnowledgeId),
                  ),
                  and(
                    eq(knowledge_edge.from_knowledge_id, toKnowledgeId),
                    eq(knowledge_edge.to_knowledge_id, fromKnowledgeId),
                  ),
                )
              : and(
                  eq(knowledge_edge.from_knowledge_id, fromKnowledgeId),
                  eq(knowledge_edge.to_knowledge_id, toKnowledgeId),
                ),
            eq(knowledge_edge.relation_type, relationType),
            isNull(knowledge_edge.archived_at),
          ),
        )
        .limit(1)
    )[0];
    if (duplicateLiveEdge) {
      return {
        status: 'skipped:duplicate_live_edge',
        edge_id: duplicateLiveEdge.id,
        reason: duplicateLiveEdge.id,
      };
    }

    const skip = await checkProposalCooldownGate(tx, 'knowledge_edge', cooldownKeys);
    if (skip) {
      return {
        status: skip.status,
        proposal_id: skip.proposal_id,
        cooldown_key: skip.cooldown_key,
        cooldown_until: skip.cooldown_until,
      };
    }

    const proposalPayload = {
      kind: 'knowledge_edge' as const,
      target: { subject_kind: 'knowledge_edge' as const, subject_id: null },
      reason_md: input.reasoning,
      evidence_refs: evidenceRefsFromEventIds(input.evidence_event_ids ?? []),
      proposed_change: {
        // Explicit create marker keeps the payload self-describing.
        edge_op: 'create' as const,
        from_knowledge_id: fromKnowledgeId,
        to_knowledge_id: toKnowledgeId,
        relation_type: relationType,
        weight: input.weight ?? 1,
      },
      cooldown_key: cooldownKey,
      // P5.6 — explicit model label; survives parseAiProposalPayload into the rubric.
      suggestion_kind: input.suggestion_kind ?? 'proactive',
    };

    // P5.4-L2 — resolve the adaptive bump for this (knowledge_edge, relation).
    // Only agents use it. A digest error must not block pure L1, so downgrade to
    // undefined (same as cold start).
    let adaptive: Awaited<ReturnType<typeof resolveEdgeGateBump>> | undefined;
    if (ctx.callerActor.kind === 'agent') {
      try {
        adaptive = await resolveEdgeGateBump(
          tx,
          relationType,
          PROPOSAL_FEEDBACK_BUDGET,
          PROPOSAL_GATE_BIAS_CONFIG,
        );
      } catch (bumpErr) {
        adaptive = undefined;
        // Evidence-first: log the soft-layer downgrade via ctx.db (an independent
        // side-record that survives a gate rollback). Logging must never break the
        // tool path; fall back to console.
        const errorReason = bumpErr instanceof Error ? bumpErr.message : String(bumpErr);
        try {
          await writeToolCallLog(ctx.db, {
            task_run_id: ctx.taskRunId,
            task_kind: ctx.callerActor.ref,
            tool_name: 'propose_knowledge_edge:resolveEdgeGateBump',
            effect: 'read',
            input_json: { relation_type: relationType },
            output_json: { adaptive_downgraded: true },
            error_reason: errorReason,
            iteration: 0,
            latency_ms: 0,
            cost: 0,
          });
        } catch (logErr) {
          console.error('[propose_knowledge_edge] adaptive-bump downgrade log failed', {
            task_run_id: ctx.taskRunId,
            bump_error: errorReason,
            err: logErr,
          });
        }
      }
    }

    // P5.4 — shared rubric floor before the write; agents strict, users structural-only.
    const verdict = await validateProposalQuality(
      parseAiProposalPayload(proposalPayload),
      tx,
      {
        isAgent: ctx.callerActor.kind === 'agent',
        actorRef: ctx.callerActor.ref,
      },
      adaptive,
    );
    if (!verdict.ok) {
      return await foldRubricRejectedEdge(ctx, tx, proposalPayload, cooldownKey, verdict, {
        from_knowledge_id: fromKnowledgeId,
        to_knowledge_id: toKnowledgeId,
        relation_type: relationType,
        weight: input.weight ?? 1,
        reasoning: input.reasoning,
      });
    }

    const proposalId = await writeAiProposal(tx, {
      actor_ref: ctx.callerActor.ref,
      outcome: 'success',
      payload: proposalPayload,
      task_run_id: ctx.taskRunId,
      caused_by_event_id: ctx.causedByEventId ?? null,
    });

    return { status: 'proposed', proposal_id: proposalId, cooldown_key: cooldownKey };
  });
}

// P5.4 — on rejection, write the propose event anyway, marked rubric-rejected.
// Folded as an audit/L2 signal and excluded from live-pending dedup because the
// inbox derives a terminal status.
//
// Do not log here: the mcp-bridge DomainTool wrapper already logs exactly one
// tool_call_log from the return value; a second log would double-count and
// mis-flag a soft reject as a hard failure.
async function foldRubricRejectedEdge(
  ctx: ToolContext,
  db: DbLike,
  proposalPayload: AiProposalPayloadInputT,
  cooldownKey: string,
  verdict: Extract<RubricVerdict, { ok: false }>,
  // Narrowed create-edge fields (fold is only reachable from create).
  edge: {
    from_knowledge_id: string;
    to_knowledge_id: string;
    relation_type: string;
    weight: number;
    reasoning: string;
  },
): Promise<ProposeKnowledgeEdgeOutput> {
  const proposalId = await writeAiProposal(db, {
    actor_ref: ctx.callerActor.ref,
    outcome: 'success',
    payload: proposalPayload,
    event_override: {
      action: 'propose',
      subject_kind: 'knowledge_edge',
      payload: {
        // Folded rejection is always create-op; archive never reaches the rubric.
        edge_op: 'create',
        from_knowledge_id: edge.from_knowledge_id,
        to_knowledge_id: edge.to_knowledge_id,
        relation_type: edge.relation_type,
        weight: edge.weight,
        reasoning: edge.reasoning,
        rubric_verdict: { ok: false, gate: verdict.gate, reason: verdict.reason },
      },
    },
    task_run_id: ctx.taskRunId,
    caused_by_event_id: ctx.causedByEventId ?? null,
  });

  return {
    status: 'skipped:rubric_rejected',
    proposal_id: proposalId,
    cooldown_key: cooldownKey,
    gate: verdict.gate,
    reason: verdict.reason,
  };
}

// ADR-0032 — one pending archive per edge id; a second call dedups instead of
// stacking inbox rows.
function edgeArchiveCooldownKey(edgeId: string): string {
  return `knowledge_edge_archive:${edgeId}`;
}

// ADR-0032 — archive executor: proposes soft-deleting a live edge through the
// same proposal→accept loop. No rubric evidence floor; archive carries none by design.
async function proposeKnowledgeEdgeArchive(
  ctx: ToolContext,
  input: ProposeKnowledgeEdgeInput,
): Promise<ProposeKnowledgeEdgeOutput> {
  if (!input.edge_id) {
    return { status: 'skipped:edge_not_found', reason: "op 'archive' requires edge_id" };
  }
  const edgeId = input.edge_id;
  const cooldownKey = edgeArchiveCooldownKey(edgeId);
  // YUK-1553 — dedup + write inside one (kind, cooldown_key) advisory-locked txn.
  return await withProposalGateLock(ctx.db, 'knowledge_edge', [cooldownKey], async (tx) => {
    const edge = await getKnowledgeEdgeById(tx, edgeId);
    // Target must be a live edge; missing/already-archived is a no-op.
    if (!edge || edge.archived_at !== null) {
      return { status: 'skipped:edge_not_found', edge_id: edgeId, reason: edgeId };
    }

    const skip = await checkProposalCooldownGate(tx, 'knowledge_edge', [cooldownKey]);
    if (skip) {
      return {
        status: skip.status,
        proposal_id: skip.proposal_id,
        cooldown_key: skip.cooldown_key,
        cooldown_until: skip.cooldown_until,
      };
    }

    const proposalPayload = {
      kind: 'knowledge_edge' as const,
      target: { subject_kind: 'knowledge_edge' as const, subject_id: edgeId },
      reason_md: input.reasoning,
      evidence_refs: evidenceRefsFromEventIds(input.evidence_event_ids ?? []),
      proposed_change: {
        edge_op: 'archive' as const,
        // Endpoints/relation describe the archived edge; archive_edge_id is the
        // authoritative target the accept applier flips.
        from_knowledge_id: edge.from_knowledge_id,
        to_knowledge_id: edge.to_knowledge_id,
        relation_type: edge.relation_type,
        weight: edge.weight,
        archive_edge_id: edgeId,
      },
      cooldown_key: cooldownKey,
      suggestion_kind: input.suggestion_kind ?? 'proactive',
    };

    // Shape uniformity only; archive short-circuits {ok:true} and is never folded.
    const verdict = await validateProposalQuality(parseAiProposalPayload(proposalPayload), tx, {
      isAgent: ctx.callerActor.kind === 'agent',
      actorRef: ctx.callerActor.ref,
    });
    if (!verdict.ok) {
      // Defensive: a future structural gate could reject an archive. Surface it,
      // but do not fold a create-shaped event for an archive.
      return {
        status: 'skipped:rubric_rejected',
        cooldown_key: cooldownKey,
        gate: verdict.gate,
        reason: verdict.reason,
      };
    }

    const proposalId = await writeAiProposal(tx, {
      actor_ref: ctx.callerActor.ref,
      outcome: 'success',
      payload: proposalPayload,
      task_run_id: ctx.taskRunId,
      caused_by_event_id: ctx.causedByEventId ?? null,
    });

    return { status: 'proposed', proposal_id: proposalId, cooldown_key: cooldownKey };
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
    'Propose one knowledge mesh edge change. op="create" (default) proposes a NEW edge from {from_knowledge_id, to_knowledge_id, relation_type, weight?} — validates active same-subject nodes, self loops, duplicate live/pending edges, and parent-only related_to redundancy. Agent-proposed creates are rubric-gated: put the supporting attempt/event ids in evidence_event_ids, not just in reasoning. op="archive" proposes soft-deleting an EXISTING live edge named by edge_id (no failure evidence required — archiving is the inverse of proposing). Both ops are proposal-only: the user accepts in the inbox; archive sets archived_at, never a hard delete. Results starting with skipped: mean the proposal was NOT written — do not retry the same change.',
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
  ]),
  proposal_id: z.string().optional(),
  cooldown_key: z.string().optional(),
  cooldown_until: z.string().optional(),
  reason: z.string().optional(),
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
    const skip = await checkProposalCooldownGate(tx, gate.kind, gate.cooldownKeys);
    if (skip) {
      return {
        status: skip.status,
        proposal_id: skip.proposal_id,
        cooldown_key: skip.cooldown_key,
        cooldown_until: skip.cooldown_until,
      };
    }
    const proposalId = await writeProposal(tx);
    return { status: 'proposed', proposal_id: proposalId };
  });
}

export const proposeKnowledgeMutationTool: DomainTool<
  KnowledgeMutationInput,
  KnowledgeMutationOutput
> = {
  name: 'propose_knowledge_mutation',
  description:
    "Propose one knowledge tree mutation (proposal-only; the user accepts in the inbox — never a direct write). Input: {change, reasoning, evidence_event_ids?}. change.mutation picks the branch: propose_new {name, parent_id} — parent_id=null + domain proposes a NEW subject root; a child uses an existing node id and omits domain. reparent {node_id, new_parent_id, expected_version}. merge {from_ids, into_id, expected_versions:{id:version} for every from_id}. split {from_id, into:[{name,parent_id}], expected_version}. archive {node_id, expected_version}. expected_version(s) are CAS tokens — copy the node's current `version` from query_knowledge / the tree input. Results starting with skipped: mean the proposal was NOT written — do not retry the same change.",
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
