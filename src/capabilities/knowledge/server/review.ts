// KnowledgeReviewTask — Maintenance Agent runtime.
//
// 2026-05-17 migrated from Vercel AI SDK (`streamText` + inline ToolSet) to
// Claude Agent SDK with an in-process MCP server. The tool dispatch logic
// (tree-shape vs mesh-shape) is preserved verbatim; only the agent runtime
// changes.
//
// Flow:
//   1. Build the input payload (tree + recent failure attempts).
//   2. Construct an in-process MCP server with one tool: `write_proposal`.
//      The handler dispatches by `payload.mutation` (or top-level
//      `mutation` arg) into:
//        - propose_knowledge_edge → ProposeKnowledgeEdge event.
//        - anything else → writeKnowledgeProposeEvent (tree mutation).
//   3. Call `streamTask` which routes through the Claude Agent SDK
//      subprocess, exposing the MCP tool as `mcp__loom__write_proposal`.
//   4. Return the streamed Response.
//
// The registry's `allowedTools: ['mcp__loom__write_proposal']` matches the
// SDK-resolved name so the agent runner doesn't strip the tool from the
// catalog before the model sees it.

import { readAgentNotes } from '@/capabilities/agency/server/notes';
import { validateProposalQuality } from '@/capabilities/knowledge/server/rubric-validator';
import { newId } from '@/core/ids';
import type { KnowledgeEdgeProposalChangeT } from '@/core/schema/proposal';
import { parseAiProposalPayload } from '@/core/schema/proposal';
import type { Db, Tx } from '@/db/client';
import { event, knowledge, proposal_signals } from '@/db/schema';
import { streamTask } from '@/server/ai/runner';
import { PROPOSAL_FEEDBACK_BUDGET, PROPOSAL_GATE_BIAS_CONFIG } from '@/server/ai/tools/budgets';
import { effectiveCauseForFailureAttempt } from '@/server/events/cause-policy';
import { getCorrectionStatuses } from '@/server/events/corrections';
import { getFailureAttempts } from '@/server/events/queries';
// P5.4-L2 / YUK-174 (Facet B) — resolve the per-(kind, relation) gate-bump for
// the legacy MCP edge path (always actor 'dreaming' → isAgent: true). Bounded
// digest read; cold-start / below-threshold → no-op bump.
import type { AdaptiveGateInput } from '@/server/proposals/adaptive-bias';
import { resolveEdgeGateBump } from '@/server/proposals/adaptive-bias';
import type { ProposalInboxRow } from '@/server/proposals/inbox';
import { writeAiProposal } from '@/server/proposals/writer';
import { resolveSubjectProfile } from '@/subjects/profile';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { type KnowledgeMutationPayload, writeKnowledgeProposeEvent } from './proposals';

const RECENT_MISTAKES_LIMIT = 100;
type DbLike = Db | Tx;

async function buildReviewInput(db: Db) {
  const tree = await db
    .select({
      id: knowledge.id,
      name: knowledge.name,
      domain: knowledge.domain,
      parent_id: knowledge.parent_id,
      archived_at: knowledge.archived_at,
      version: knowledge.version,
      merged_from: knowledge.merged_from,
    })
    .from(knowledge)
    .orderBy(knowledge.created_at);

  // U8 / AF §4 — un-expired out-of-band hints addressed to 'maintenance'. HINTS,
  // not facts (labelled as such in the input below); additive context only,
  // never mutates durable learning facts (AF §2.4). Empty on the common path.
  const agent_notes = (await readAgentNotes(db, { for_agent: 'maintenance', now: new Date() })).map(
    (n) => ({
      id: n.id,
      signal_kind: n.signal_kind,
      summary_md: n.summary_md,
      refs: n.refs,
      source_task_kind: n.source_task_kind,
      ...(n.confidence !== undefined ? { confidence: n.confidence } : {}),
    }),
  );

  const attempts = await getFailureAttempts(db, { limit: RECENT_MISTAKES_LIMIT });
  const recent_mistakes = attempts.map((fa) => {
    const cause = effectiveCauseForFailureAttempt(fa);
    return {
      id: fa.attempt_event_id,
      // M3 closeout (2026-05-22): canonical LLM payload field name —
      // KnowledgeReviewTask prompt (src/ai/task-prompts.ts buildKnowledgeReviewPrompt)
      // documents `question_id` as the recipe field. NOT ActivityRef legacy.
      question_id: fa.question_id,
      knowledge_ids: fa.referenced_knowledge_ids,
      cause: cause
        ? {
            source: cause.source,
            primary_category: cause.primary_category,
            secondary_categories: cause.secondary_categories,
            analysis_md: cause.analysis_md ?? cause.user_notes,
            confidence: cause.confidence,
          }
        : null,
    };
  });

  return {
    input: {
      tree,
      recent_mistakes,
      // U8 / AF §4 — these are HINTS left by narrow tasks, NOT facts: use them to
      // direct maintenance attention (e.g. a flagged structural gap), never as
      // ground truth, and keep proposing only (AF §2.4). Empty when no fresh
      // notes exist → the task behaves exactly as before.
      agent_notes,
    },
    subjectProfile: resolveSubjectProfile(resolveSingleTreeDomain(tree)),
  };
}

function resolveSingleTreeDomain(tree: Array<{ domain: string | null }>): string | null {
  const domains = new Set(
    tree.map((row) => row.domain).filter((domain): domain is string => Boolean(domain)),
  );
  return domains.size === 1 ? ([...domains][0] ?? null) : null;
}

// ---------- Pure dispatcher (testable without the SDK) ----------
//
// Exposed so tests can drive the dispatch logic on different payload shapes
// without spawning the Claude CLI subprocess.

export interface WriteProposalArgs {
  mutation?: string;
  payload: unknown;
  reasoning: string;
}

export type WriteProposalResult =
  | {
      proposal_id?: string;
      event_id?: string;
      kind: 'tree_mutation' | 'knowledge_edge_propose';
    }
  | {
      proposal_id: string;
      kind: 'skipped_duplicate';
      cooldown_key: string;
    }
  | {
      proposal_id: string;
      kind: 'skipped_cooldown';
      cooldown_key: string;
      cooldown_until: string;
    }
  // P5.4 / YUK-143 (RB-6) — rubric-rejected agent edge. The propose event is
  // still written (folded, marked rubric-rejected); the verdict is surfaced to
  // the agent so it gets structured feedback instead of a silent drop.
  | {
      event_id: string;
      kind: 'rubric_rejected';
      gate: string;
      reason: string;
    };

interface ProposalGateCandidate {
  kind: ProposalInboxRow['kind'];
  cooldown_key: string;
}

function proposalGateCandidate(args: WriteProposalArgs): ProposalGateCandidate | null {
  const edgePayload =
    args.mutation === 'propose_knowledge_edge' || isKnowledgeEdgeMutation(args.payload)
      ? extractEdgePayload(args.payload)
      : null;
  if (edgePayload) {
    return {
      kind: 'knowledge_edge',
      cooldown_key: `knowledge_edge:${edgePayload.from_knowledge_id}|${edgePayload.to_knowledge_id}|${edgePayload.relation_type}`,
    };
  }

  if (typeof args.payload !== 'object' || args.payload === null) return null;
  const p = args.payload as Record<string, unknown>;
  if (
    p.mutation === 'propose_new' &&
    typeof p.parent_id === 'string' &&
    typeof p.name === 'string'
  ) {
    return {
      kind: 'knowledge_node',
      cooldown_key: `knowledge_node:${p.parent_id}:${p.name}`,
    };
  }
  if (p.mutation === 'archive' && typeof p.node_id === 'string') {
    return {
      kind: 'archive',
      cooldown_key: `archive:knowledge:${p.node_id}`,
    };
  }
  return null;
}

async function checkProposalGate(
  db: DbLike,
  candidate: ProposalGateCandidate,
): Promise<Extract<
  WriteProposalResult,
  { kind: 'skipped_duplicate' | 'skipped_cooldown' }
> | null> {
  const now = new Date();
  const signal = await lockProposalSignal(db, candidate);
  const duplicate = await findPendingProposalForGate(db, candidate);
  if (duplicate) {
    return {
      proposal_id: duplicate.id,
      kind: 'skipped_duplicate',
      cooldown_key: candidate.cooldown_key,
    };
  }
  if (signal.cooldown_until && signal.cooldown_until > now) {
    const sourceProposal = await findLatestProposalForGate(db, candidate);
    return {
      proposal_id: sourceProposal?.id ?? signal.id,
      kind: 'skipped_cooldown',
      cooldown_key: candidate.cooldown_key,
      cooldown_until: signal.cooldown_until.toISOString(),
    };
  }
  return null;
}

async function lockProposalSignal(
  db: DbLike,
  candidate: ProposalGateCandidate,
): Promise<{ id: string; cooldown_until: Date | null }> {
  await db.execute(sql`
    INSERT INTO proposal_signals (
      id,
      kind,
      cooldown_key,
      accept_count,
      dismiss_count,
      acceptance_rate,
      created_at,
      updated_at
    )
    VALUES (
      ${newId()},
      ${candidate.kind},
      ${candidate.cooldown_key},
      0,
      0,
      0.5,
      NOW(),
      NOW()
    )
    ON CONFLICT (kind, cooldown_key) DO NOTHING
  `);
  await db.execute(sql`
    SELECT id
    FROM proposal_signals
    WHERE kind = ${candidate.kind}
      AND cooldown_key = ${candidate.cooldown_key}
    FOR UPDATE
  `);

  const row = (
    await db
      .select({
        id: proposal_signals.id,
        cooldown_until: proposal_signals.cooldown_until,
      })
      .from(proposal_signals)
      .where(
        and(
          eq(proposal_signals.kind, candidate.kind),
          eq(proposal_signals.cooldown_key, candidate.cooldown_key),
        ),
      )
      .limit(1)
  )[0];
  if (!row) throw new Error(`proposal signal lock row missing: ${candidate.cooldown_key}`);
  return row;
}

async function findLatestProposalForGate(
  db: DbLike,
  candidate: ProposalGateCandidate,
): Promise<{ id: string } | null> {
  const rows = await findProposalRowsForGate(db, candidate);
  return rows[0] ?? null;
}

async function findPendingProposalForGate(
  db: DbLike,
  candidate: ProposalGateCandidate,
): Promise<{ id: string } | null> {
  const proposalRows = await findProposalRowsForGate(db, candidate);
  if (proposalRows.length === 0) return null;

  const proposalIds = proposalRows.map((row) => row.id);
  const latestRateByProposal = new Map<string, typeof event.$inferSelect>();
  const rateRows = await db
    .select()
    .from(event)
    .where(
      and(
        eq(event.action, 'rate'),
        inArray(event.caused_by_event_id, proposalIds),
        isNotNull(event.caused_by_event_id),
      ),
    )
    .orderBy(desc(event.created_at), desc(event.id));
  for (const row of rateRows) {
    const proposalId = row.caused_by_event_id;
    if (proposalId && !latestRateByProposal.has(proposalId)) {
      latestRateByProposal.set(proposalId, row);
    }
  }

  const correctionStatuses = await getCorrectionStatuses(db, proposalIds);
  for (const row of proposalRows) {
    const correctionStatus = correctionStatuses.get(row.id);
    if (correctionStatus && correctionStatus.state !== 'active') continue;
    if (!latestRateByProposal.has(row.id)) return row;
  }
  return null;
}

async function findProposalRowsForGate(
  db: DbLike,
  candidate: ProposalGateCandidate,
): Promise<Array<{ id: string }>> {
  return await db
    .select({ id: event.id })
    .from(event)
    .where(
      and(
        sql`${event.payload}->'ai_proposal'->>'kind' = ${candidate.kind}`,
        sql`${event.payload}->'ai_proposal'->>'cooldown_key' = ${candidate.cooldown_key}`,
        // P5.4 / YUK-143 (RB-7) — exclude rubric-rejected (folded) propose
        // events. They are terminal, NOT live-pending; counting them would lock
        // out the very edge the rubric rejected and block a later valid
        // proposal on the same (kind, cooldown_key). The marker is a
        // `rubric_verdict: { ok:false }` sibling of ai_proposal on the payload.
        sql`(${event.payload}->'rubric_verdict'->>'ok') IS DISTINCT FROM 'false'`,
        // ADR-0034 §2 / YUK-344 — exclude TOPOLOGY-rejected (folded) propose
        // events too. A topology reject fold carries a `topology_verdict` marker
        // with status 'reject' and NO rubric_verdict key, so the rubric filter
        // above misses it. Counting one here would lock out the same
        // (kind, cooldown_key) and block a later valid proposal — the same
        // terminal-but-treated-as-pending bug RB-7 forbids. Mirrors the
        // rubric_verdict predicate; the marker is a
        // `topology_verdict: { status:'reject' }` sibling of ai_proposal.
        sql`(${event.payload}->'topology_verdict'->>'status') IS DISTINCT FROM 'reject'`,
      ),
    )
    .orderBy(desc(event.created_at), desc(event.id))
    .limit(20);
}

export async function runWriteProposal(
  db: Db,
  args: WriteProposalArgs,
): Promise<WriteProposalResult> {
  const candidate = proposalGateCandidate(args);
  if (candidate) {
    return await db.transaction(async (tx) => {
      const gate = await checkProposalGate(tx, candidate);
      if (gate) return gate;
      return await writeProposalAfterGate(tx, args);
    });
  }

  return await writeProposalAfterGate(db, args);
}

async function writeProposalAfterGate(
  db: DbLike,
  args: WriteProposalArgs,
): Promise<WriteProposalResult> {
  const { mutation, payload, reasoning } = args;
  const isEdgeProposal = mutation === 'propose_knowledge_edge' || isKnowledgeEdgeMutation(payload);
  if (isEdgeProposal) {
    const edgePayload = extractEdgePayload(payload);
    if (!edgePayload) {
      // Malformed edge proposal — fall through to dreaming path so we
      // don't silently swallow it.
      const id = await writeKnowledgeProposeEvent(db, {
        payload: payload as KnowledgeMutationPayload,
        reasoning,
      });
      return { proposal_id: id, kind: 'tree_mutation' };
    }
    const cooldownKey = `knowledge_edge:${edgePayload.from_knowledge_id}|${edgePayload.to_knowledge_id}|${edgePayload.relation_type}`;
    const edgeProposalPayload = {
      kind: 'knowledge_edge' as const,
      target: { subject_kind: 'knowledge_edge' as const, subject_id: null },
      reason_md: reasoning,
      // Legacy MCP path attaches no evidence_event_ids today — the RB-4 floor
      // will reject evidence-free agent edges and fold them (RB-6).
      evidence_refs: [],
      proposed_change: {
        from_knowledge_id: edgePayload.from_knowledge_id,
        to_knowledge_id: edgePayload.to_knowledge_id,
        relation_type: edgePayload.relation_type as KnowledgeEdgeProposalChangeT['relation_type'],
        weight: 1,
      },
      cooldown_key: cooldownKey,
    };

    // P5.4-L2 / YUK-174 (Facet B) — resolve the adaptive gate-bump for this
    // edge's relation before the floor. Bounded digest read on the same tx
    // handle; cold-start / below-threshold → no-op.
    //
    // ND-5 (additive only): the L2 read must NEVER block L1. A throw from the
    // digest read degrades to `adaptive = undefined` so `validateProposalQuality`
    // runs the pure-L1 floor unchanged (the optional `adaptive` param omitted →
    // pure L1, rubric-validator.ts:426). No task_run_id exists on this legacy
    // dispatcher path (see the RB-6 note below, :401–:407), so the downgrade is
    // surfaced via console.error like the sibling L2 feedback-read degradation
    // (copilot/chat.ts:264), not the task-run-scoped log.ts helpers.
    let adaptive: AdaptiveGateInput | undefined;
    try {
      adaptive = await resolveEdgeGateBump(
        db,
        edgePayload.relation_type,
        PROPOSAL_FEEDBACK_BUDGET,
        PROPOSAL_GATE_BIAS_CONFIG,
      );
    } catch (err) {
      adaptive = undefined;
      console.error('[writeProposalAfterGate] resolveEdgeGateBump failed; degrading to pure-L1', {
        relation_type: edgePayload.relation_type,
        err,
      });
    }

    // P5.4 / YUK-143 (RB-1) — shared rubric floor. Legacy MCP path always runs
    // as actor_ref 'dreaming' → isAgent: true (§3.5). On reject the event is
    // still written, marked rubric-rejected (RB-6), and excluded from
    // live-pending dedup (RB-7).
    const verdict = await validateProposalQuality(
      parseAiProposalPayload(edgeProposalPayload),
      db as Db,
      { isAgent: true, actorRef: 'dreaming' },
      adaptive,
    );
    if (!verdict.ok) {
      // RB-6 step 7 (evidence-first logging): the DomainTool path's reject is
      // logged once by the mcp-bridge wrapper (per tool call, from the return
      // value), but this legacy MCP path has no such wrapper and intentionally
      // does NOT log here. tool_call_log.task_run_id is NOT NULL (schema.ts:424) and
      // WriteProposalArgs carries no task_run_id — the value lives only in the
      // SDK runner above this in-process MCP tool, not in this pure dispatcher.
      // Threading a real task_run_id down through the MCP boundary is out of
      // scope for P5.4 (§5 Q2); the fold itself (the rubric_verdict marker on
      // the event below) is the durable, queryable audit trail. If a nullable
      // task_run_id or a threaded value lands later, add the reject log here.
      const eventId = await writeAiProposal(db, {
        actor_ref: 'dreaming',
        outcome: 'success',
        payload: edgeProposalPayload,
        event_override: {
          action: 'propose',
          subject_kind: 'knowledge_edge',
          payload: {
            from_knowledge_id: edgePayload.from_knowledge_id,
            to_knowledge_id: edgePayload.to_knowledge_id,
            relation_type: edgePayload.relation_type,
            weight: 1,
            reasoning,
            rubric_verdict: { ok: false, gate: verdict.gate, reason: verdict.reason },
          },
        },
      });
      return {
        event_id: eventId,
        kind: 'rubric_rejected',
        gate: verdict.gate,
        reason: verdict.reason,
      };
    }

    const eventId = await writeAiProposal(db, {
      actor_ref: 'dreaming',
      outcome: 'success',
      payload: edgeProposalPayload,
    });
    return { event_id: eventId, kind: 'knowledge_edge_propose' };
  }
  const id = await writeKnowledgeProposeEvent(db, {
    payload: payload as KnowledgeMutationPayload,
    reasoning,
  });
  return { proposal_id: id, kind: 'tree_mutation' };
}

// ---------- MCP server factory (built per-call, captures db) ----------

const WriteProposalSchema = {
  mutation: z.string().optional(),
  payload: z.unknown(),
  reasoning: z.string(),
} as const;

function buildKnowledgeReviewMcpServer(db: Db) {
  return createSdkMcpServer({
    name: 'loom',
    tools: [
      tool(
        'write_proposal',
        'Propose one knowledge graph mutation. Call once per mutation. payload.mutation distinguishes the kind: tree-shape (propose_new / reparent / merge / split / archive) writes a ProposeKnowledge / experimental:knowledge_<mutation> event; mesh-shape (propose_knowledge_edge) writes a ProposeKnowledgeEdge event with {from_knowledge_id, to_knowledge_id, relation_type, reasoning}. reasoning must be concrete. If the result kind is skipped_duplicate or skipped_cooldown, do not retry the same mutation in this run.',
        WriteProposalSchema,
        async (args) => {
          const result = await runWriteProposal(db, args as WriteProposalArgs);
          return {
            content: [{ type: 'text', text: JSON.stringify(result) }],
          };
        },
      ),
    ],
  });
}

// ---------- Public entrypoint ----------

export interface StreamReviewTaskCtx {
  db: Db;
}

/**
 * Stream KnowledgeReviewTask. The Claude Agent SDK runs the tool-call loop
 * against an in-process MCP server; each `write_proposal` call lands as a
 * knowledge / knowledge_edge propose event in the DB. Returns a Response
 * with streamed assistant text deltas.
 */
export async function streamReviewTask(ctx: StreamReviewTaskCtx): Promise<Response> {
  const { input, subjectProfile } = await buildReviewInput(ctx.db);
  const mcpServer = buildKnowledgeReviewMcpServer(ctx.db);

  return streamTask('KnowledgeReviewTask', input, {
    db: ctx.db,
    subjectProfile,
    mcpServers: { loom: mcpServer },
  });
}

// ---------- mutation discriminator ----------

interface KnowledgeEdgeMutationShape {
  mutation: 'propose_knowledge_edge';
  from_knowledge_id: string;
  to_knowledge_id: string;
  relation_type: string;
}

function isKnowledgeEdgeMutation(payload: unknown): payload is KnowledgeEdgeMutationShape {
  if (typeof payload !== 'object' || payload === null) return false;
  const p = payload as Record<string, unknown>;
  return (
    p.mutation === 'propose_knowledge_edge' &&
    typeof p.from_knowledge_id === 'string' &&
    typeof p.to_knowledge_id === 'string' &&
    typeof p.relation_type === 'string'
  );
}

function extractEdgePayload(
  payload: unknown,
): { from_knowledge_id: string; to_knowledge_id: string; relation_type: string } | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (
    typeof p.from_knowledge_id === 'string' &&
    typeof p.to_knowledge_id === 'string' &&
    typeof p.relation_type === 'string'
  ) {
    return {
      from_knowledge_id: p.from_knowledge_id,
      to_knowledge_id: p.to_knowledge_id,
      relation_type: p.relation_type,
    };
  }
  return null;
}
