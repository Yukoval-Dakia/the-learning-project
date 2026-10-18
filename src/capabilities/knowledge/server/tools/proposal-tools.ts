// YUK-876 / FULL F3.7b — Knowledge proposal DomainTools, owned by the knowledge
// capability and loaded through its manifest. These expose owner-service paths to
// agent tool loops; they do not apply destructive graph mutations directly:
// proposal tools write inbox-visible proposal events (propose-only invariant).
// Moved byte-identical from src/server/ai/tools/proposal-tools.ts.

import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { z } from 'zod';
// ADR-0032 D4-E1 (YUK-203) — archive-op edge proposal targets a live edge by id;
// the single-owner edges module is the read authority.
import { getKnowledgeEdgeById } from '@/capabilities/knowledge/server/edges';
import {
  knowledgeNodeCooldownKey,
  writeKnowledgeProposeEvent,
} from '@/capabilities/knowledge/server/proposals';
import {
  type RubricVerdict,
  validateProposalQuality,
} from '@/capabilities/knowledge/server/rubric-validator';
import { RelationTypeSchema, isSymmetricKnowledgeRelation } from '@/core/schema/event/blocks';
// P5.6 / YUK-178 — the proactive/corrective discriminator the model can label
// explicitly via the propose-tool input arg (§4.1/§4.2).
import { SuggestionKind } from '@/core/schema/event/known';
import {
  type AiProposalPayloadInputT,
  type ProposalEvidenceRefT,
  parseAiProposalPayload,
} from '@/core/schema/proposal';
import type { Db, Tx } from '@/db/client';
import { knowledge, knowledge_edge } from '@/db/schema';
// P5.4-L2 / YUK-174 (Facet B) — resolve the per-(kind, relation) gate-bump for
// this edge and pass it as the OPTIONAL adaptive input to the L1 validator. The
// digest read is bounded; cold-start / below-threshold returns a no-op bump.
import { resolveEdgeGateBump } from '@/kernel/proposals/adaptive-bias';
import { listProposalInboxRows } from '@/kernel/proposals/inbox';
import { findActiveProposalCooldown, withProposalGateLock } from '@/kernel/proposals/signals';
import { writeAiProposal } from '@/kernel/proposals/writer';
import { getEffectiveDomain } from '@/kernel/read-models/knowledge-tree';
// P5.4-L2 / YUK-174 — the adaptive gate-bump budget + bias config single source.
import { PROPOSAL_FEEDBACK_BUDGET, PROPOSAL_GATE_BIAS_CONFIG } from '@/kernel/tools/budgets';
import { writeToolCallLog } from '@/server/ai/log';
import { sanitizeProposedNodeDomain } from '@/subjects/profile';
import type { DomainTool, ToolContext } from './types';

type DbLike = Db | Tx;

function evidenceRefsFromEventIds(ids: string[]): ProposalEvidenceRefT[] {
  return [...new Set(ids)].map((id) => ({ kind: 'event', id }));
}

// YUK-1553 — the propose-side dedup/cooldown gate shared by both knowledge
// proposal tools, run INSIDE {@link withProposalGateLock} so the pending +
// dismiss-cooldown reads and the subsequent proposal write are serialized per
// (kind, cooldown_key). This is the check the retired KR `runWriteProposal`
// gate enforced (`checkProposalGate`); the canonical home is here so every
// caller of the shared tools gets it, not just the maintenance task.
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
    // Point the caller at the cooldown's origin: the latest DISMISSED proposal
    // on the key (cooldowns only exist after a dismiss), falling back to the
    // latest row at all if the dismiss predates this projection window.
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

// ---------------------------------------------------------------------------
// propose_knowledge_edge
// ---------------------------------------------------------------------------

// ADR-0032 D4-E1 (YUK-203) — `op` discriminator: 'create' (default / absence)
// proposes a NEW mesh edge from {from,to,relation_type}; 'archive' soft-deletes an
// EXISTING live edge named by `edge_id`. FLAT z.object (the MCP bridge requires a
// ZodObject — see mcp-bridge.ts:145; a .refine would break it), so the per-op
// required-field check ('archive' requires edge_id; 'create' requires the edge
// endpoints) runs in execute(), not on the schema. Mirrors the node omnibus
// (propose_knowledge_mutation) discriminator and author_question's flat-schema +
// in-execute validation pattern.
const ProposeKnowledgeEdgeInputSchema = z.object({
  // OPTIONAL on the schema (absence === 'create') so the tool's Input type stays a
  // clean z.object the MCP bridge + DomainTool generic accept; the default is
  // applied in execute() (mirrors suggestion_kind's absence→proactive). A schema
  // .default() would diverge z.input (optional) from z.infer (required) and break
  // the DomainTool<Input> inputSchema constraint.
  op: z.enum(['create', 'archive']).optional(),
  // create-op endpoints (also describe the archive target's edge for the card;
  // optional on the schema, required-by-op in execute()).
  from_knowledge_id: z.string().min(1).optional(),
  to_knowledge_id: z.string().min(1).optional(),
  relation_type: RelationTypeSchema.optional(),
  weight: z.number().min(0).max(1).optional(),
  // archive-op target: the live knowledge_edge.id to soft-delete.
  edge_id: z.string().min(1).optional(),
  reasoning: z.string().min(1).max(2000),
  evidence_event_ids: z.array(z.string().min(1)).optional(),
  // P5.6 / YUK-178 (§4.1/§4.2, SK-5) — OPTIONAL model-labeled discriminator. Set
  // 'corrective' ONLY when this edge repairs a failure the model itself observed;
  // omit (→ 'proactive') for a next-step suggestion. There is NO deterministic
  // coercion — absence defaults to proactive in execute().
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
    // YUK-1553 — an active dismiss-cooldown covers this edge key; same-args
    // retries inside the window are suppressed (was the retired KR gate's
    // `skipped_cooldown`).
    'skipped:cooldown',
    'skipped:parent_semantic_duplicate',
    // P5.4 / YUK-143 (RB-6) — rubric-rejected agent edge. The propose event is
    // still written, MARKED rubric-rejected (folded, not dropped); the verdict
    // is returned to the agent as primitive feedback.
    'skipped:rubric_rejected',
    // ADR-0032 D4-E1 (YUK-203) — archive-op outcomes. The target edge id does not
    // resolve to a live (non-archived) edge, or an archive proposal for the same
    // edge is already pending.
    'skipped:edge_not_found',
  ]),
  proposal_id: z.string().optional(),
  cooldown_key: z.string().optional(),
  // YUK-1553 — ISO deadline for skipped:cooldown so the agent knows when a
  // retry could succeed.
  cooldown_until: z.string().optional(),
  // YUK-1553 — the live edge id for skipped:duplicate_live_edge /
  // skipped:edge_not_found (was smuggled through `reason`).
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
  // ADR-0032 D4-E1 (YUK-203) — dispatch by op (absence === 'create', backward
  // compatible). Archive is the inverse of create: it soft-deletes a live edge
  // through the proposal→accept loop, so it shares the proposal writer + inbox +
  // accept dispatch but skips the create-only rubric evidence floor (the validator
  // short-circuits {ok:true} for edge_op:'archive').
  if (input.op === 'archive') {
    return await proposeKnowledgeEdgeArchive(ctx, input);
  }
  return await proposeKnowledgeEdgeCreate(ctx, input);
}

async function proposeKnowledgeEdgeCreate(
  ctx: ToolContext,
  input: ProposeKnowledgeEdgeInput,
): Promise<ProposeKnowledgeEdgeOutput> {
  // create-op required fields (optional on the flat schema — enforced here per the
  // MCP-bridge ZodObject constraint, mirroring author_question).
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

  // YUK-1553 — live-duplicate + pending + dismiss-cooldown reads and the
  // proposal write run inside ONE (kind, cooldown_key) advisory-locked txn
  // (the gate the retired KR path enforced); rubric/adaptive stay inside the
  // same txn so a verdict-fold and a skip both see the serialized world.
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
        // ADR-0032 D4-E1 — explicit create marker (the schema defaults to it, but
        // setting it makes the create branch's payload self-describing alongside
        // the archive branch).
        edge_op: 'create' as const,
        from_knowledge_id: fromKnowledgeId,
        to_knowledge_id: toKnowledgeId,
        relation_type: relationType,
        weight: input.weight ?? 1,
      },
      cooldown_key: cooldownKey,
      // P5.6 / YUK-178 — explicit model label, default proactive. This payload flows
      // through parseAiProposalPayload → validateProposalQuality (the rubric) BELOW
      // before writeAiProposal, so the marker must survive that round-trip (§12 PIN
      // 10); it does because suggestion_kind is on BaseProposal.
      suggestion_kind: input.suggestion_kind ?? 'proactive',
    };

    // P5.4-L2 / YUK-174 (Facet B) — resolve the adaptive gate-bump for this edge's
    // `(knowledge_edge, relation_type)` cell. Only meaningful for agents (the L1
    // evidence floor + rescue is agent-only); for the user path the bump is inert
    // because the rescue branch never runs. Cold-start / below-threshold → no-op.
    //
    // ND-5 (additive-only): the L2 bump is an OPTIONAL soft layer. A digest/query
    // error here MUST NOT become a hard failure that blocks the pure-L1
    // validateProposalQuality below — that would suppress L1's signal-driven
    // proposals. Guard the call so any error downgrades `adaptive` to undefined
    // (no-op, identical to cold start) and the L1 floor + downstream still run.
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
        // Evidence-first (CLAUDE.md): the soft-layer downgrade is traceable. Log
        // via the AI action logger; the log write itself must never break the
        // tool path, so swallow log errors with a console fallback (mirrors the
        // mcp-bridge writeToolCallLog guard). The log deliberately goes through
        // ctx.db (not tx): it is an independent side-record that must survive a
        // later gate-txn rollback.
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

    // P5.4 / YUK-143 (RB-1) — shared rubric floor before the write. Agents are
    // strict; user-edited proposals (kind !== 'agent') run structural-only.
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

// P5.4 / YUK-143 (RB-6 / §3.4) — on an agent rubric rejection, write the
// propose event ANYWAY, MARKED rubric-rejected (carrying { rubric_verdict } as a
// sibling of ai_proposal in the event payload). Folded, not dropped: the row is
// an audit trail + a Layer-2 (YUK-174) signal, and is excluded from live-pending
// dedup/cooldown (RB-7) because the inbox derive maps the marker to a terminal
// 'rubric_rejected' status.
//
// NOTE (PR #219 review fix): we do NOT write a tool_call_log row here. The
// mcp-bridge DomainTool wrapper (mcp-bridge.ts) already logs exactly ONE
// tool_call_log per DomainTool call from this function's RETURN value, capturing
// the verdict in `output_json` ({status:'skipped:rubric_rejected', gate, reason}).
// An explicit log here double-counted the call (distorting call-volume/
// failure-rate) and mis-flagged a SOFT reject as a hard failure by writing the
// verdict into `error_reason`. Traceability is preserved via (1) the bridge's
// output_json log and (2) the folded `rubric_rejected` propose event above.
async function foldRubricRejectedEdge(
  ctx: ToolContext,
  db: DbLike,
  proposalPayload: AiProposalPayloadInputT,
  cooldownKey: string,
  verdict: Extract<RubricVerdict, { ok: false }>,
  // Narrowed create-edge fields (the create path resolves these before calling
  // fold; fold is only reachable from create — archive bypasses the rubric).
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
        // ADR-0032 D4-E1 — folded rejection is a create-op edge (archive never
        // reaches the rubric); mark it so the inbox derive reads a stable shape.
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

// ADR-0032 D4-E1 (YUK-203) — archive-op cooldown key. One pending archive proposal
// per live edge id; a second archive call for the same edge dedups to
// skipped:duplicate_pending instead of stacking inbox rows.
function edgeArchiveCooldownKey(edgeId: string): string {
  return `knowledge_edge_archive:${edgeId}`;
}

// ADR-0032 D4-E1 (YUK-203) — archive-op executor. Proposes soft-deleting a LIVE
// edge through the same proposal→accept loop as create (守 propose-only invariant:
// never a direct write). Skips the create-only rubric evidence floor (the
// validator short-circuits {ok:true} for edge_op:'archive') — an archive is the
// inverse of proposing, so it carries no failure evidence by design.
async function proposeKnowledgeEdgeArchive(
  ctx: ToolContext,
  input: ProposeKnowledgeEdgeInput,
): Promise<ProposeKnowledgeEdgeOutput> {
  if (!input.edge_id) {
    return { status: 'skipped:edge_not_found', reason: "op 'archive' requires edge_id" };
  }
  const edgeId = input.edge_id;
  const cooldownKey = edgeArchiveCooldownKey(edgeId);
  // YUK-1553 — the pending/dismiss-cooldown dedup + proposal write run inside
  // ONE (kind, cooldown_key) advisory-locked txn (same gate as create).
  return await withProposalGateLock(ctx.db, 'knowledge_edge', [cooldownKey], async (tx) => {
    const edge = await getKnowledgeEdgeById(tx, edgeId);
    // Target must be a LIVE (non-archived) edge. A missing id or an
    // already-archived edge is a no-op — nothing to propose archiving.
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
        // The endpoints + relation describe the edge being archived (inbox card +
        // structural shape); archive_edge_id is the authoritative target the accept
        // applier flips.
        from_knowledge_id: edge.from_knowledge_id,
        to_knowledge_id: edge.to_knowledge_id,
        relation_type: edge.relation_type,
        weight: edge.weight,
        archive_edge_id: edgeId,
      },
      cooldown_key: cooldownKey,
      suggestion_kind: input.suggestion_kind ?? 'proactive',
    };

    // The validator runs for shape uniformity but short-circuits {ok:true} on
    // edge_op:'archive' (no evidence floor) — archive proposals are never folded.
    const verdict = await validateProposalQuality(parseAiProposalPayload(proposalPayload), tx, {
      isAgent: ctx.callerActor.kind === 'agent',
      actorRef: ctx.callerActor.ref,
    });
    if (!verdict.ok) {
      // Defensive: archive should never fail the rubric (the validator bypasses the
      // evidence floor for it). If a future structural gate does reject it, surface
      // it as rubric_rejected rather than silently swallow — but do NOT fold a
      // create-shaped event_override (this is an archive). Reuse the create fold's
      // marker shape minimally.
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

// ---------------------------------------------------------------------------
// propose_knowledge_mutation
// ---------------------------------------------------------------------------

// YUK-1553 — model-visible input exposes the real five-branch change
// structure. The pi bridge requires a top-level z.object (pi-tools.ts:130), so
// the discriminated union lives inside the `change` field; `change` IS the
// KnowledgeMutationPayload written by the proposal writer — ONE schema serves
// both the wire contract and the execute-side parse (no hidden second parser).
const KnowledgeMutationChangeSchema = z.discriminatedUnion('mutation', [
  z.object({
    mutation: z.literal('propose_new'),
    name: z.string().min(1).max(120),
    // null = propose a NEW domain ROOT; then `domain` is required (validated in
    // execute — flat z.object, no .refine, per the MCP-bridge ZodObject
    // constraint). A string parent_id proposes a child node.
    parent_id: z.string().min(1).nullable(),
    domain: z.string().min(1).optional(),
  }),
  z.object({
    mutation: z.literal('reparent'),
    node_id: z.string().min(1),
    new_parent_id: z.string().min(1),
    // CAS token: the node's current `version` (see query_knowledge / tree input).
    expected_version: z.number().int().min(0),
  }),
  z.object({
    mutation: z.literal('merge'),
    from_ids: z.array(z.string().min(1)).min(1),
    into_id: z.string().min(1),
    // CAS tokens for every absorbed node: {from_id: current version}. Accept
    // rejects a merge whose recorded base version has drifted.
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
  evidence_event_ids: z.array(z.string().min(1)).optional(),
  // P5.6 / YUK-178 (§4.1/§4.2, SK-5) — OPTIONAL model-labeled discriminator;
  // omit (→ 'proactive') unless this mutation repairs a model-observed failure.
  suggestion_kind: SuggestionKind.optional(),
});

const KnowledgeMutationOutputSchema = z.object({
  status: z.enum([
    'proposed',
    'skipped:unknown_node',
    'skipped:cross_subject',
    'skipped:invalid_payload',
    'skipped:duplicate_pending',
    // YUK-1553 — an active dismiss-cooldown covers this key; same-args retries
    // inside the window are suppressed (was the retired KR gate's
    // `skipped_cooldown`).
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

// The cooldown-gated mutations (the same set the retired KR gate covered):
// propose_new and archive. reparent / merge / split keep their ungated write —
// key-completion for those is tracked separately, not silently expanded here.
function mutationCooldownGate(
  change: KnowledgeMutationChange,
): { kind: string; cooldownKey: string } | null {
  if (change.mutation === 'propose_new') {
    return { kind: 'knowledge_node', cooldownKey: knowledgeNodeCooldownKey(change) };
  }
  if (change.mutation === 'archive') {
    return { kind: 'archive', cooldownKey: `archive:knowledge:${change.node_id}` };
  }
  return null;
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

  // Root-creation guard (propose_new with parent_id=null): the payload must
  // declare a real domain for the root to anchor; a child proposal must NOT
  // carry one — children inherit the parent's effective domain and an explicit
  // value would silently diverge from it. 'general'/blank is the fallback
  // subject identity and can never be a node domain (node-creation contract).
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

  // Root proposals reference no existing nodes — nothing to domain-check
  // against; the declared domain is reviewed at accept time like any proposal.
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
      // P5.6 / YUK-178 — model-labeled discriminator threaded into the proposal
      // payload writeKnowledgeProposeEvent builds; default proactive.
      suggestion_kind: input.suggestion_kind ?? 'proactive',
    });

  const gate = mutationCooldownGate(change);
  if (gate === null) {
    const proposalId = await writeProposal(ctx.db);
    return { status: 'proposed', proposal_id: proposalId };
  }

  // YUK-1553 — pending/dismiss-cooldown dedup reads and the proposal write in
  // ONE advisory-locked txn; same-args retries inside the window skip instead
  // of stacking inbox rows (the retired KR gate's serialized check-then-write).
  return await withProposalGateLock(ctx.db, gate.kind, [gate.cooldownKey], async (tx) => {
    const skip = await checkProposalCooldownGate(tx, gate.kind, [gate.cooldownKey]);
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
