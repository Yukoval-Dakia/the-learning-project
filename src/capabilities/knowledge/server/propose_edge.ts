// Phase 2 Dreaming — knowledge_edge propose pipeline.
//
// 和 propose.ts (节点提议) 对应：propose.ts 让 AI 提议**新节点**，本模块让 AI
// 提议**新边**。两者都走"提议事件 → 用户 rate → accept 落库"的两步流程，区别只
// 是落库目标 (knowledge vs knowledge_edge) 和 mutation 语义。
//
// 不复用 KnowledgeReviewTask 的 streaming + tool-calling 路径 —— ReviewTask 是
// 交互式 12 iter 设计，nightly cron 用单次结构化输出更便宜可控。

import { validateProposalQuality } from '@/capabilities/knowledge/server/rubric-validator';
import type { ActivityRefT } from '@/core/schema/activity';
import { RelationTypeSchema } from '@/core/schema/event/blocks';
import { parseAiProposalPayload } from '@/core/schema/proposal';
import type { Db } from '@/db/client';
import { event, knowledge_edge } from '@/db/schema';
import { writeCostLedger } from '@/server/ai/log';
import { glmChatCostCny } from '@/server/ai/pricing';
import type { TaskTextRunFn } from '@/server/ai/provenance';
import { effectiveCauseForFailureAttempt } from '@/server/events/cause-policy';
import type { FailureAttempt } from '@/server/events/queries';
import { writeEvent } from '@/server/events/queries';
import type { Env } from '@/server/memory/client';
import { writeAiProposal } from '@/server/proposals/writer';
import type { SubjectProfile } from '@/subjects/profile';
import { createId } from '@paralleldrive/cuid2';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { writeRetryableAiFailureLedger } from './ai_failure_log';
import {
  type EdgeCandidate,
  type EdgeNeighbor,
  type EdgeReconcileDecision,
  applyConfidenceThreshold,
  judgeEdgeReconcile,
  resolveGlmConfig,
} from './edge-reconcile';
import {
  insertEdgePlannedRows,
  makeEdgePlannedRow,
  markEdgeReconcileApplied,
} from './edge-reconcile-store';
import { archiveKnowledgeEdge, createKnowledgeEdge } from './edges';
import { type TopologyEdge, checkEdgeTopology } from './topology-gate';
import { loadTreeSnapshot } from './tree';

const EdgeProposalSchema = z.object({
  from_knowledge_id: z.string().min(1),
  to_knowledge_id: z.string().min(1),
  relation_type: RelationTypeSchema,
  weight: z.number().min(0).max(1).default(0.5),
  reasoning: z.string().min(1).max(500),
});

type EdgeProposalSchemaT = z.infer<typeof EdgeProposalSchema>;

const EdgeOutputSchema = z.object({
  proposals: z.array(EdgeProposalSchema).max(5),
});

export type EdgeProposeOutput = z.infer<typeof EdgeOutputSchema>;

export type RunTaskFn = TaskTextRunFn;

// ADR-0034 §3 / YUK-344 增量 2 — the reconcile decision function. Defaults to the
// live GLM `judgeEdgeReconcile`; tests inject a deterministic stub so the wiring
// (archive + log + correction + new edge) can be exercised without a GLM call.
// Signature mirrors judgeEdgeReconcile's (candidate, neighbors) → decision.
export type JudgeEdgeReconcileFn = (
  candidate: EdgeCandidate,
  neighbors: EdgeNeighbor[],
) => Promise<EdgeReconcileDecision>;

export interface RunEdgeProposeAndWriteParams {
  db: Db;
  recentFailures: FailureAttempt[];
  runTaskFn: RunTaskFn;
  env?: unknown;
  subjectProfile?: SubjectProfile;
  // Override for tests. Production omits it → the live GLM judge is used with
  // `env` threaded through (so the ZHIPU key resolves via mem0 config).
  judgeReconcileFn?: JudgeEdgeReconcileFn;
}

export interface RunEdgeProposeAndWriteResult {
  proposed: number;
  skipped_self_loop: number;
  skipped_unknown_node: number;
  skipped_duplicate_edge: number;
  skipped_duplicate_pending: number;
  // P5.4 §5-Q5 / YUK-175 — batch edge proposals that FAILED the L1 rubric floor
  // (validateProposalQuality) and were FOLDED (a rubric-rejected propose event is
  // still written, marked, but no live pending proposal is created).
  folded_rubric_rejected: number;
  // ADR-0034 §2 / YUK-344 — TOPOLOGY gate hard-rejects (cycle / direction
  // contradiction on the prerequisite graph). Folded like rubric rejects: a
  // marked propose event is written for audit, no live pending proposal.
  folded_topology_rejected: number;
  // ADR-0034 §2 / YUK-344 — TOPOLOGY transitive-redundancy WARNINGS. The edge is
  // still proposed live (warning, not hard-reject per §2), but the propose event
  // carries a topology_verdict marker so the inbox / downstream can downweight.
  warned_transitive_redundancy: number;
  // ADR-0034 §3 / YUK-344 增量 2 — RECONCILE SUPERSEDE applied: a candidate that
  // passed topology + rubric semantically CORRECTED a live neighbor edge. The old
  // edge is soft-archived (archived_at, load-bearing removal), a CorrectionKind
  // supersede event records the epistemic provenance, the new edge is written
  // live, and a write-ahead log row is marked applied. Distinct from `proposed`
  // (which counts KEEP_BOTH propose events).
  reconcile_superseded: number;
}

const EMPTY_RESULT: RunEdgeProposeAndWriteResult = {
  proposed: 0,
  skipped_self_loop: 0,
  skipped_unknown_node: 0,
  skipped_duplicate_edge: 0,
  skipped_duplicate_pending: 0,
  folded_rubric_rejected: 0,
  folded_topology_rejected: 0,
  warned_transitive_redundancy: 0,
  reconcile_superseded: 0,
};

/**
 * Build input + call KnowledgeEdgeProposeTask + validate + write propose events.
 *
 * 任何步骤抛错都 swallow（log）—— nightly cron 不应因 LLM 故障停摆。返回
 * stats，便于 cron handler 写入日志。
 */
export async function runEdgeProposeAndWrite(
  params: RunEdgeProposeAndWriteParams,
): Promise<RunEdgeProposeAndWriteResult> {
  try {
    const tree = await loadTreeSnapshot(params.db);
    if (tree.length === 0) return { ...EMPTY_RESULT };

    const existingEdges = await params.db
      .select({
        id: knowledge_edge.id,
        from_knowledge_id: knowledge_edge.from_knowledge_id,
        to_knowledge_id: knowledge_edge.to_knowledge_id,
        relation_type: knowledge_edge.relation_type,
        archived_at: knowledge_edge.archived_at,
      })
      .from(knowledge_edge);

    const existingEdgeKey = new Set(
      existingEdges.map((e) => edgeKey(e.from_knowledge_id, e.to_knowledge_id, e.relation_type)),
    );

    // ADR-0034 §3 / YUK-344 增量 2 — node-name map for the reconcile prompt's
    // human-readable neighbor descriptions (ids are NEVER exposed to the LLM, but
    // names are; see edge-reconcile.ts describeEdge).
    const nodeNameById = new Map(tree.map((n) => [n.id, n.name]));

    // ADR-0034 §2 / YUK-344 — the topology gate operates on the LIVE mesh only
    // (archived_at IS NULL is the live-mesh reader's sole filter, ADR-0034 §4).
    // An archived edge is not part of the learning-order graph, so it cannot
    // form a cycle / contradiction / transitive path with a new live proposal.
    // The dedup `existingEdgeKey` above intentionally still uses the FULL set
    // (an archived row keeps its UNIQUE(from,to,type) slot), so these are kept
    // separate.
    const liveTopologyEdges: TopologyEdge[] = existingEdges
      .filter((e) => e.archived_at === null)
      .map((e) => ({
        from_knowledge_id: e.from_knowledge_id,
        to_knowledge_id: e.to_knowledge_id,
        relation_type: e.relation_type,
      }));

    // ADR-0034 §3 / YUK-344 增量 2 — live edges carrying their REAL edge id, for
    // the reconcile ring's neighbor lookup. Like `liveTopologyEdges`, this starts
    // from the live (archived_at IS NULL) mesh and is mutated as the batch
    // proceeds: a SUPERSEDE removes the archived old edge and adds the new one, a
    // KEEP_BOTH adds the new edge — so a LATER candidate in the same batch
    // reconciles against the batch-evolved live mesh (the DB is not yet
    // persisted for the in-flight rows).
    type LiveEdge = {
      edge_id: string;
      from_knowledge_id: string;
      to_knowledge_id: string;
      relation_type: string;
    };
    const liveNeighborEdges: LiveEdge[] = existingEdges
      .filter((e) => e.archived_at === null)
      .map((e) => ({
        edge_id: e.id,
        from_knowledge_id: e.from_knowledge_id,
        to_knowledge_id: e.to_knowledge_id,
        relation_type: e.relation_type,
      }));

    const pendingEdgeKey = await loadPendingEdgeProposalKeys(params.db);

    const input = {
      tree_snapshot: tree.map((n) => ({
        id: n.id,
        name: n.name,
        parent_id: n.parent_id,
        effective_domain: n.effective_domain,
      })),
      // Keep the LLM input shape stable (from/to/relation_type only) — the
      // archived_at column added for the topology gate must not leak into the
      // prompt input.
      existing_edges: existingEdges.map((e) => ({
        from_knowledge_id: e.from_knowledge_id,
        to_knowledge_id: e.to_knowledge_id,
        relation_type: e.relation_type,
      })),
      recent_failures: params.recentFailures.map((fa) => {
        const cause = effectiveCauseForFailureAttempt(fa);
        return {
          attempt_event_id: fa.attempt_event_id,
          referenced_knowledge_ids: fa.referenced_knowledge_ids,
          cause: cause?.primary_category ?? null,
          cause_source: cause?.source ?? null,
          analysis_md: cause?.analysis_md ?? cause?.user_notes ?? null,
        };
      }),
    };

    const result = await params.runTaskFn('KnowledgeEdgeProposeTask', input, {
      db: params.db,
      env: params.env,
      subjectProfile: params.subjectProfile,
    });
    const parsed = parseEdgeProposeOutput(result.text);

    const validNodeIds = new Set(tree.map((n) => n.id));
    const stats = { ...EMPTY_RESULT };

    for (const p of parsed.proposals) {
      if (p.from_knowledge_id === p.to_knowledge_id) {
        stats.skipped_self_loop += 1;
        continue;
      }
      if (!validNodeIds.has(p.from_knowledge_id) || !validNodeIds.has(p.to_knowledge_id)) {
        stats.skipped_unknown_node += 1;
        continue;
      }
      const key = edgeKey(p.from_knowledge_id, p.to_knowledge_id, p.relation_type);
      if (existingEdgeKey.has(key)) {
        stats.skipped_duplicate_edge += 1;
        continue;
      }
      if (pendingEdgeKey.has(key)) {
        stats.skipped_duplicate_pending += 1;
        continue;
      }

      // P5.4-L2 / YUK-174 NOTE: this batch path's L1 rubric floor is now wired in
      // (YUK-175): every proposal runs `validateProposalQuality` BELOW before the
      // live write, mirroring the DomainTool / legacy-MCP call sites. Facet A
      // (reason-digest) is still deferred — the `KnowledgeEdgeProposeTask` input
      // built above carries only { tree_snapshot, existing_edges, recent_failures },
      // NOT a `proposal_feedback` digest; threading it here needs the registry
      // input schema + prompt extended first (out of scope here). Facet B (the
      // adaptive gate-bump 4th arg) is INTENTIONALLY NOT passed: L2/Facet A is
      // out-of-scope for this slice (§5-Q5), so the validator runs as pure L1.
      // codex r? P2 (propose_edge.ts:163) — per-edge evidence scoping. Attaching
      // EVERY batch recentFailure to EVERY edge's evidence_refs let edge B borrow
      // edge A's same-pattern failures and clear the strong floor (live instead of
      // fold). Scope each edge's evidence to the failures whose EFFECTIVE
      // referenced ids touch THIS edge's own endpoints, where "effective" is the
      // attempt ∪ judge union — identical to rubric-validator.ts
      // `effectiveReferencedKnowledgeIds` (attempt.referenced_knowledge_ids ∪
      // attempt.judge?.referenced_knowledge_ids). A failure references an endpoint
      // when its effective id set contains p.from_knowledge_id or p.to_knowledge_id.
      // When the scoped set is empty the validator takes the evidence_missing path
      // → fold (correct, matches the existing no-endpoint-evidence behaviour).
      //
      // Built BEFORE the topology check so the topology-reject branch can reuse it
      // (overriding only evidence_refs → []) instead of hand-rebuilding the same
      // proposal payload object.
      const endpointTouchingFailures = params.recentFailures.filter((failure) => {
        const effectiveRefs = new Set([
          ...failure.referenced_knowledge_ids,
          ...(failure.judge?.referenced_knowledge_ids ?? []),
        ]);
        return effectiveRefs.has(p.from_knowledge_id) || effectiveRefs.has(p.to_knowledge_id);
      });
      const proposalPayload = {
        kind: 'knowledge_edge' as const,
        target: { subject_kind: 'knowledge_edge' as const, subject_id: null },
        reason_md: p.reasoning,
        evidence_refs: endpointTouchingFailures.map((failure) => ({
          kind: 'event' as const,
          id: failure.attempt_event_id,
        })),
        proposed_change: {
          from_knowledge_id: p.from_knowledge_id,
          to_knowledge_id: p.to_knowledge_id,
          relation_type: p.relation_type,
          weight: p.weight,
        },
        cooldown_key: `knowledge_edge:${key}`,
      };

      // Base fields shared by every writeAiProposal call below (reject / warn /
      // normal). Each branch spreads this and adds its own payload + event_override.
      const proposalWriteBase = {
        actor_ref: 'dreaming' as const,
        outcome: 'success' as const,
        task_run_id: result.task_run_id ?? null,
        cost_usd: result.cost_usd,
        created_at: new Date(),
      };

      // Base event_override.payload fields shared by the topology reject AND warn
      // branches below. Both branches emit the identical edge fields and differ
      // ONLY in the `topology_verdict` marker they append, so we build the common
      // base once here (before the topology check) and spread it with the
      // per-branch verdict. Behaviour is byte-identical to inlining the fields.
      const eventPayloadBase = {
        from_knowledge_id: p.from_knowledge_id,
        to_knowledge_id: p.to_knowledge_id,
        relation_type: p.relation_type,
        weight: p.weight,
        reasoning: p.reasoning,
      };

      // ADR-0034 §2 / YUK-344 — write-time STRUCTURAL CONSISTENCY gate (topology
      // layer). Pure graph checks (cycle / direction contradiction / transitive
      // redundancy) on the prerequisite graph, orthogonal to the semantic rubric
      // gate below. `liveTopologyEdges` accumulates edges accepted EARLIER in this
      // same batch so two proposals that TOGETHER form a cycle are caught (the
      // batch is not yet persisted, so a fresh DB read would miss them).
      const topology = checkEdgeTopology(
        {
          from_knowledge_id: p.from_knowledge_id,
          to_knowledge_id: p.to_knowledge_id,
          relation_type: p.relation_type,
        },
        liveTopologyEdges,
      );

      if (topology.status === 'reject') {
        // Cycle / direction contradiction = HARD reject. Fold like a rubric
        // reject (RB-6 / §3.4): write a MARKED propose event for audit, no live
        // pending proposal, and exclude it from cross-batch dedup so a later
        // batch can re-evaluate against an evolved graph. The marker is a
        // `topology_verdict` sibling of ai_proposal on the event payload. Reuse
        // `proposalPayload` but drop evidence_refs — a folded reject carries no
        // evidence (its endpoints' failures are not "supporting" a live edge).
        await writeAiProposal(params.db, {
          ...proposalWriteBase,
          payload: { ...proposalPayload, evidence_refs: [] },
          event_override: {
            action: 'propose',
            subject_kind: 'knowledge_edge',
            payload: {
              ...eventPayloadBase,
              topology_verdict: {
                status: 'reject',
                gate: topology.gate,
                reason: topology.reason,
              },
            },
          },
        });
        pendingEdgeKey.add(key);
        stats.folded_topology_rejected += 1;
        continue;
      }

      // Write ProposeKnowledgeEdge event (Lane B).
      const verdict = await validateProposalQuality(
        parseAiProposalPayload(proposalPayload),
        params.db,
        { isAgent: true, actorRef: 'dreaming' },
      );

      if (!verdict.ok) {
        // RB-6 / §3.4 — write the propose event ANYWAY, MARKED rubric-rejected
        // (carrying { rubric_verdict } as a sibling of ai_proposal in the event
        // payload). Folded, not dropped: an audit trail + a Layer-2 signal, and
        // excluded from live-pending dedup (RB-7) so a later batch can re-propose
        // and re-fold rather than permanently lock the edge out. Mirrors
        // foldRubricRejectedEdge in proposal-tools.ts.
        await writeAiProposal(params.db, {
          ...proposalWriteBase,
          payload: proposalPayload,
          event_override: {
            action: 'propose',
            subject_kind: 'knowledge_edge',
            payload: {
              from_knowledge_id: p.from_knowledge_id,
              to_knowledge_id: p.to_knowledge_id,
              relation_type: p.relation_type,
              weight: p.weight,
              reasoning: p.reasoning,
              rubric_verdict: { ok: false, gate: verdict.gate, reason: verdict.reason },
            },
          },
        });
        // Mark this key so the SAME batch does not re-emit it (the folded row is
        // excluded from the CROSS-batch pending set in loadPendingEdgeProposalKeys,
        // but within one batch we still suppress an immediate duplicate).
        pendingEdgeKey.add(key);
        stats.folded_rubric_rejected += 1;
        continue;
      }

      // ADR-0034 §3 / YUK-344 增量 2 — WRITE-TIME RECONCILIATION RING. Runs ONLY
      // for a candidate that has already passed BOTH the topology gate (above —
      // a topology-rejected edge `continue`d before ever reaching here, so the
      // ring NEVER sees a topology-rejected edge) AND the semantic rubric floor
      // (just above). Retrieve the live neighbor edges touching either endpoint
      // and ask the ring whether the candidate semantically CORRECTS a live
      // neighbor (SUPERSEDE) or coexists with all of them (KEEP_BOTH, the
      // default-in-doubt). On ReconcileParseError / network / low confidence the
      // ring (or this wiring) degrades to KEEP_BOTH — never a destructive
      // supersede on an uncertain judgment.
      const neighbors: EdgeNeighbor[] = liveNeighborEdges
        .filter(
          (e) =>
            e.from_knowledge_id === p.from_knowledge_id ||
            e.to_knowledge_id === p.from_knowledge_id ||
            e.from_knowledge_id === p.to_knowledge_id ||
            e.to_knowledge_id === p.to_knowledge_id,
        )
        .map((e, index) => ({
          index,
          edge_id: e.edge_id,
          from_knowledge_id: e.from_knowledge_id,
          to_knowledge_id: e.to_knowledge_id,
          relation_type: e.relation_type as EdgeNeighbor['relation_type'],
          from_name: nodeNameById.get(e.from_knowledge_id),
          to_name: nodeNameById.get(e.to_knowledge_id),
        }));

      const candidateForReconcile: EdgeCandidate = {
        from_knowledge_id: p.from_knowledge_id,
        to_knowledge_id: p.to_knowledge_id,
        relation_type: p.relation_type as EdgeCandidate['relation_type'],
        from_name: nodeNameById.get(p.from_knowledge_id),
        to_name: nodeNameById.get(p.to_knowledge_id),
        reasoning: p.reasoning,
      };

      // The ring only covers the 5 CORE homogeneous relation types (ADR-0010 /
      // edge-reconcile.ts). An `experimental:*` candidate has no ring framing —
      // treat it as KEEP_BOTH (skip the ring entirely), preserving today's behavior.
      const isCoreRelation = CORE_RELATION_TYPES.has(p.relation_type);

      let decision: EdgeReconcileDecision | null = null;
      if (isCoreRelation && neighbors.length > 0) {
        try {
          const judge =
            params.judgeReconcileFn ??
            ((cand: EdgeCandidate, nbrs: EdgeNeighbor[]) =>
              judgeEdgeReconcile(cand, nbrs, {
                env: params.env as never,
                // YUK-344: ledger live reconcile GLM tokens to cost_ledger, mirroring
                // the memory reconcile path (triggers.ts onUsage / YUK-359). Best-effort
                // — a ledger write failure must never fail reconcile, so swallow + log.
                // Only the LIVE judge bills; the injected test fn (judgeReconcileFn) has
                // no GLM call, so it correctly never reaches this onUsage.
                onUsage: (usage) => {
                  // CodeRabbit/PR-Agent Finding 3 — thread the ACTUAL resolved GLM
                  // model (the same resolveGlmConfig the judge uses) instead of
                  // hardcoding 'glm-5.2', which drifts when MEM0_LLM_MODEL overrides
                  // the model. Single source of truth: resolveGlmConfig(env).
                  const model = resolveGlmConfig(params.env as Env).model;
                  void writeCostLedger(params.db, {
                    task_kind: 'edge_reconcile',
                    provider: 'glm',
                    model,
                    cost: glmChatCostCny(usage.promptTokens, usage.completionTokens),
                    currency: 'CNY',
                    tokens_in: usage.promptTokens,
                    tokens_out: usage.completionTokens,
                  }).catch((err) => console.error('[edge_reconcile] writeCostLedger failed', err));
                },
              }));
          // Defensive re-apply of the confidence threshold: the live
          // judgeEdgeReconcile already applies it, so this is an idempotent no-op
          // there; for an INJECTED fn it guarantees a low-confidence SUPERSEDE is
          // still degraded to KEEP_BOTH (the "no destructive supersede on low
          // confidence" invariant holds regardless of the decision source).
          decision = applyConfidenceThreshold(await judge(candidateForReconcile, neighbors));
        } catch (err) {
          // ReconcileParseError / Retryable / Permanent — safe-degrade to
          // KEEP_BOTH (no destructive supersede on an unparseable / failed judge).
          // Log ONLY the safe message: a ReconcileParseError carries `raw` = the
          // full raw LLM provider response, and serializing the whole error object
          // would leak that sensitive AI payload into log output. Mirror the memory
          // side's KEEP_BOTH degrade log (triggers.ts: `err.message` only); `raw`
          // belongs in the audit-log row, never the console.
          console.warn(
            'runEdgeProposeAndWrite: reconcile judge failed, KEEP_BOTH degrade',
            err instanceof Error ? err.message : String(err),
          );
          decision = null;
        }
      }

      if (decision?.action === 'SUPERSEDE' && decision.superseded_edge_id) {
        // Resolve the superseded neighbor (its endpoints/type for the new-edge
        // provenance + intra-batch live-mesh bookkeeping). Guard against a stale
        // id that no longer matches a tracked live edge → degrade to KEEP_BOTH.
        const supersededId = decision.superseded_edge_id;
        const supersededEdge = liveNeighborEdges.find((e) => e.edge_id === supersededId);
        // affected_refs must be ≥1 ActivityRef (CorrectEvent schema). The candidate
        // reached the LIVE path, so the rubric floor passed via endpoint-touching
        // judge-backed failures → endpointTouchingFailures is non-empty in practice.
        // If it is somehow empty we cannot form a valid correction event → degrade.
        const affectedRefs: ActivityRefT[] = endpointTouchingFailures.map((failure) => ({
          kind: 'question',
          id: failure.question_id,
        }));

        if (supersededEdge && affectedRefs.length > 0) {
          const newEdgeId = await applyEdgeSupersede(params.db, {
            candidate: p,
            supersededEdgeId: supersededId,
            // CodeRabbit/Bugbot Finding 1 — pass the SUPERSEDED OLD edge endpoints so
            // the step-4 archive-provenance event describes the edge actually being
            // archived. The reconcile neighbor filter only requires sharing ONE
            // endpoint, so the old edge endpoints can differ from the candidate's;
            // using p.* there would misdescribe which edge was archived.
            supersededEdge: {
              from_knowledge_id: supersededEdge.from_knowledge_id,
              to_knowledge_id: supersededEdge.to_knowledge_id,
              relation_type: supersededEdge.relation_type,
            },
            decision,
            affectedRefs,
          });

          // Intra-batch live-mesh bookkeeping: the old edge is now archived (drop
          // it from BOTH accumulators), the new edge is now live (add it). This
          // keeps a LATER same-batch candidate's topology + reconcile checks
          // consistent with the eventual DB state (mirrors FINDING A).
          for (let i = liveNeighborEdges.length - 1; i >= 0; i -= 1) {
            if (liveNeighborEdges[i].edge_id === supersededId) liveNeighborEdges.splice(i, 1);
          }
          const removeIdx = liveTopologyEdges.findIndex(
            (e) =>
              e.from_knowledge_id === supersededEdge.from_knowledge_id &&
              e.to_knowledge_id === supersededEdge.to_knowledge_id &&
              e.relation_type === supersededEdge.relation_type,
          );
          if (removeIdx >= 0) liveTopologyEdges.splice(removeIdx, 1);

          pendingEdgeKey.add(key);
          liveTopologyEdges.push({
            from_knowledge_id: p.from_knowledge_id,
            to_knowledge_id: p.to_knowledge_id,
            relation_type: p.relation_type,
          });
          liveNeighborEdges.push({
            edge_id: newEdgeId,
            from_knowledge_id: p.from_knowledge_id,
            to_knowledge_id: p.to_knowledge_id,
            relation_type: p.relation_type,
          });
          stats.reconcile_superseded += 1;
          continue;
        }
        // supersededEdge missing / no affected_refs → fall through to KEEP_BOTH.
      }

      // ADR-0034 §2 — transitive-redundancy WARNING (topology.status === 'warn').
      // Not a hard reject: the edge is still proposed live, but the propose event
      // carries a `topology_verdict` marker so the inbox / downstream can
      // downweight the redundant direct edge. When there is no warning we keep
      // the original write shape (no marker), so the non-warning path is
      // byte-identical to before this gate.
      if (topology.status === 'warn') {
        await writeAiProposal(params.db, {
          ...proposalWriteBase,
          payload: proposalPayload,
          event_override: {
            action: 'propose',
            subject_kind: 'knowledge_edge',
            payload: {
              ...eventPayloadBase,
              topology_verdict: {
                status: 'warn',
                gate: topology.gate,
                reason: topology.reason,
              },
            },
          },
        });
        stats.warned_transitive_redundancy += 1;
      } else {
        await writeAiProposal(params.db, {
          ...proposalWriteBase,
          payload: proposalPayload,
        });
      }
      // 同一 batch 内防同向同型重复
      pendingEdgeKey.add(key);
      // ADR-0034 §2 — record the now-live edge so a LATER proposal in this same
      // batch is checked against it (intra-batch cycle / contradiction).
      //
      // FINDING A (YUK-344) — this push is reached ONLY on the live (non-folded)
      // path: every fold branch above (topology reject, rubric reject) `continue`s
      // BEFORE here, so a folded edge is intentionally NEVER added to
      // `liveTopologyEdges`. This is correct, not a bug: a folded edge (rubric OR
      // topology) is never persisted as a live edge, so it is not part of the live
      // prerequisite graph. The accumulator must mirror the live graph — if a
      // folded edge were added, a LATER same-batch edge that would only close a
      // cycle THROUGH the folded edge would be falsely topology-rejected, even
      // though that cycle does not exist in the live mesh. Excluding folded edges
      // keeps the intra-batch check consistent with the eventual DB state.
      //
      // ADR-0034 §3 / YUK-344 增量 2 — a KEEP_BOTH edge is written as a PENDING
      // PROPOSAL (writeAiProposal → a propose event), NOT a live knowledge_edge
      // row, so it is intentionally NOT added to `liveNeighborEdges`: the
      // reconcile ring's neighbors are LIVE edges (archivable rows with real
      // ids), and a pending proposal has neither. Only a SUPERSEDE (which writes
      // a real live edge) feeds `liveNeighborEdges` above.
      liveTopologyEdges.push({
        from_knowledge_id: p.from_knowledge_id,
        to_knowledge_id: p.to_knowledge_id,
        relation_type: p.relation_type,
      });
      stats.proposed += 1;
    }

    return stats;
  } catch (err) {
    // Log ONLY the safe message: this catch-all in the edge-reconcile write path
    // could in principle receive an error carrying a raw LLM payload (e.g. a
    // ReconcileParseError), and serializing the whole error object would leak that
    // sensitive AI response into log output. Message-only, matching the judge
    // degrade site above.
    console.error(
      'runEdgeProposeAndWrite: failed (no proposals written)',
      err instanceof Error ? err.message : String(err),
    );
    await writeRetryableAiFailureLedger(params.db, 'KnowledgeEdgeProposeTask');
    return { ...EMPTY_RESULT };
  }
}

export function parseEdgeProposeOutput(text: string): EdgeProposeOutput {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('parseEdgeProposeOutput: no JSON object found in text');
  }
  const slice = text.slice(start, end + 1);
  let json: unknown;
  try {
    json = JSON.parse(slice);
  } catch (e) {
    throw new Error(`parseEdgeProposeOutput: JSON.parse failed: ${(e as Error).message}`);
  }
  return EdgeOutputSchema.parse(json);
}

function edgeKey(fromId: string, toId: string, relationType: string): string {
  return `${fromId}|${toId}|${relationType}`;
}

// ADR-0034 §3 / YUK-344 增量 2 — the 5 CORE homogeneous relation types the
// reconcile ring covers (ADR-0010 / edge-reconcile.ts EdgeRelationType). An
// `experimental:*` candidate has no ring framing → KEEP_BOTH (skip the ring),
// preserving today's behavior for experimental edges.
const CORE_RELATION_TYPES = new Set<string>([
  'prerequisite',
  'related_to',
  'contrasts_with',
  'applied_in',
  'derived_from',
]);

/**
 * ADR-0034 §3 / YUK-344 增量 2 — apply a reconcile SUPERSEDE decision.
 *
 * Atomic single-transaction sequence (all inside ONE `db.transaction`, so a crash
 * rolls back EVERYTHING — including the `edge_reconciliation_log` row — and there is
 * nothing to replay). The log row is an AUDIT / PROVENANCE record of the supersede,
 * not a write-ahead replay cursor: it captures the decision (action, confidence,
 * superseded_edge_id, llm_raw) for observability. The no-double-apply guard is the
 * `knowledge_edge` UNIQUE(from,to,relation_type) constraint (a re-proposed duplicate
 * candidate is `skipped_duplicate_edge` upstream before ever reaching this apply),
 * NOT deterministic ids — every id below is a fresh `createId()`.
 *   1. audit-log the SUPERSEDE plan (planned_at set; applied_at stamped in step 6);
 *   2. write the NEW edge: a `generate` knowledge_edge event (its id is the
 *      correction's `replacement_event_id`) + the real live `knowledge_edge` row
 *      (createKnowledgeEdge — single-owner INSERT);
 *   3. archive the OLD edge: `archiveKnowledgeEdge` (NULL→now soft-delete — the
 *      ADR-0034 §4 LOAD-BEARING removal from the live mesh);
 *   4. write the OLD edge's archive-provenance `generate` event (mirrors the
 *      proposals/actions.ts archive path) so the correction has a stable event to
 *      target — a CorrectEvent can only target subject_kind='event', NOT an edge
 *      row (ADR-0034 §4);
 *   5. write the `correct` event: correction_kind='supersede', subject targeting
 *      the OLD edge's archive-provenance event, replacement_event_id = the NEW
 *      edge's generate event (epistemic PROVENANCE only — the archive in step 3 is
 *      what actually removes the edge). Attributed to the dreaming AGENT
 *      (actor_kind='agent', actor_ref='dreaming') — this is an autonomous supersede,
 *      NOT a user correction (YUK-344);
 *   6. mark the write-ahead log row applied.
 *
 * Returns the new edge's id (for intra-batch live-mesh bookkeeping).
 */
async function applyEdgeSupersede(
  db: Db,
  opts: {
    candidate: EdgeProposalSchemaT;
    supersededEdgeId: string;
    // CodeRabbit/Bugbot Finding 1 — the SUPERSEDED OLD edge endpoints (resolved at
    // the call site from the chosen neighbor). The step-4 archive-provenance event
    // MUST describe THESE, not the candidate's (the neighbor filter only requires a
    // single shared endpoint, so they can legitimately differ).
    supersededEdge: {
      from_knowledge_id: string;
      to_knowledge_id: string;
      relation_type: string;
    };
    decision: EdgeReconcileDecision;
    affectedRefs: ActivityRefT[];
  },
): Promise<string> {
  const { candidate: p, supersededEdgeId, supersededEdge, decision, affectedRefs } = opts;
  const now = new Date();

  const logRow = makeEdgePlannedRow({
    candidate_from_knowledge_id: p.from_knowledge_id,
    candidate_to_knowledge_id: p.to_knowledge_id,
    candidate_relation_type: p.relation_type,
    action: 'SUPERSEDE',
    superseded_edge_id: supersededEdgeId,
    confidence: decision.confidence,
    reason: decision.reason,
    llm_raw: { action: decision.action, neighbor_index: decision.neighbor_index },
  });

  const newGenerateEventId = createId();
  const oldArchiveGenerateEventId = createId();
  const correctionEventId = createId();
  let newEdgeId = '';

  await db.transaction(async (tx) => {
    // 1) audit-log the SUPERSEDE plan (applied_at stamped in step 6, same tx).
    await insertEdgePlannedRows(tx, [logRow]);

    // 2) NEW live edge row first (assigns its id), then its `generate` provenance
    //    event subject-anchored to that id. The candidate's key is guaranteed
    //    unique here (a key matching ANY existing edge — including the archived
    //    superseded one, which keeps its UNIQUE(from,to,type) slot — was already
    //    `skipped_duplicate_edge` upstream), so this INSERT cannot 23505-conflict.
    newEdgeId = await createKnowledgeEdge(tx, {
      from_knowledge_id: p.from_knowledge_id,
      to_knowledge_id: p.to_knowledge_id,
      relation_type: p.relation_type,
      weight: p.weight,
      reasoning: p.reasoning,
      // YUK-471 — fold-consistent created_by + created_at aligned to the `generate` event below
      // (same `now`, same actor) so this reconcile edge folds == its row.
      actor_kind: 'agent',
      actor_ref: 'dreaming',
      created_at: now,
    });
    await writeEvent(tx, {
      id: newGenerateEventId,
      actor_kind: 'agent',
      actor_ref: 'dreaming',
      action: 'generate',
      subject_kind: 'knowledge_edge',
      subject_id: newEdgeId,
      outcome: 'success',
      payload: {
        from_knowledge_id: p.from_knowledge_id,
        to_knowledge_id: p.to_knowledge_id,
        relation_type: p.relation_type,
        weight: p.weight,
        reasoning: p.reasoning,
      },
      created_at: now,
    });

    // 3) Archive the OLD edge (the load-bearing removal; idempotent NULL→now).
    await archiveKnowledgeEdge(tx, supersededEdgeId);

    // 4) OLD edge archive-provenance event — a stable subject the correction can
    //    target (a CorrectEvent cannot target an edge row, only an event).
    await writeEvent(tx, {
      id: oldArchiveGenerateEventId,
      actor_kind: 'agent',
      actor_ref: 'dreaming',
      action: 'generate',
      subject_kind: 'knowledge_edge',
      subject_id: supersededEdgeId,
      outcome: 'success',
      payload: {
        edge_op: 'archive',
        archive_edge_id: supersededEdgeId,
        // CodeRabbit/Bugbot Finding 1 — the OLD (superseded) edge endpoints, NOT the
        // candidate's. Step-2's NEW-edge generate event correctly keeps p.* (the new
        // edge); this archive-provenance event describes the edge being ARCHIVED.
        from_knowledge_id: supersededEdge.from_knowledge_id,
        to_knowledge_id: supersededEdge.to_knowledge_id,
        relation_type: supersededEdge.relation_type,
        reasoning: `reconcile SUPERSEDE: ${decision.reason}`,
      },
      created_at: now,
    });

    // 5) CorrectionKind supersede event — epistemic PROVENANCE only (ADR-0034 §4).
    // YUK-344 attribution fix: this is an AUTONOMOUS nightly supersede (no human in
    // the loop), so it is attributed to the dreaming AGENT, NOT user/self. The
    // CorrectEvent schema now accepts the agent lane (actor_kind='agent', a non-'self'
    // ref); the user-correction lane (UI rejudge/correct/revert) still writes
    // user/self. Consumers (getCorrectionStatuses, deriveProposalStatus, inbox /
    // proposal-status projections) read only correction_kind + replacement_event_id,
    // so this attribution change does not alter the projected correction state.
    await writeEvent(tx, {
      id: correctionEventId,
      actor_kind: 'agent',
      actor_ref: 'dreaming',
      action: 'correct',
      subject_kind: 'event',
      subject_id: oldArchiveGenerateEventId,
      outcome: 'success',
      payload: {
        correction_kind: 'supersede',
        replacement_event_id: newGenerateEventId,
        reason_md: `reconcile ring superseded a contradicting live edge: ${decision.reason}`,
        affected_refs: affectedRefs,
      },
      caused_by_event_id: oldArchiveGenerateEventId,
      created_at: now,
    });

    // 6) Stamp the audit-log row applied_at (same tx — atomic with the apply, so
    //    a committed log row always reflects a fully-applied supersede).
    await markEdgeReconcileApplied(tx, logRow.id);
  });

  return newEdgeId;
}

/**
 * Load (from, to, relation_type) keys of pending edge proposals — i.e. propose
 * events for knowledge_edge that have no rate event chained. Used for dedupe so
 * dreaming doesn't re-propose the same edge nightly.
 */
async function loadPendingEdgeProposalKeys(db: Db): Promise<Set<string>> {
  const proposeRows = await db
    .select({ id: event.id, payload: event.payload })
    .from(event)
    .where(
      and(
        eq(event.action, 'propose'),
        eq(event.subject_kind, 'knowledge_edge'),
        // P5.4 / YUK-143 (RB-7) — exclude rubric-rejected (folded) propose
        // events. They are TERMINAL, not live-pending; counting one in the
        // dedup set would make the next nightly batch hit
        // `skipped_duplicate_pending` and permanently refuse to re-propose the
        // very edge the rubric rejected. This is the 4th "pending propose with
        // no chained rate" query and must filter the marker like
        // findProposalRowsForGate (review.ts) does. The marker is a
        // `rubric_verdict: { ok:false }` sibling of ai_proposal on the payload.
        sql`(${event.payload}->'rubric_verdict'->>'ok') IS DISTINCT FROM 'false'`,
        // ADR-0034 §2 / YUK-344 — exclude TOPOLOGY-rejected (folded) propose
        // events too. A topology reject fold writes a `topology_verdict` marker
        // with status 'reject' (and NO rubric_verdict key), so the rubric filter
        // above does NOT catch it. Without this twin filter a topology-rejected
        // edge would be counted as live-pending here → the next batch hits
        // `skipped_duplicate_pending` and permanently refuses to re-propose the
        // very edge topology rejected (the cross-batch lockout RB-7 forbids).
        // Mirrors the rubric_verdict predicate exactly; the marker is a
        // `topology_verdict: { status:'reject' }` sibling of ai_proposal.
        sql`(${event.payload}->'topology_verdict'->>'status') IS DISTINCT FROM 'reject'`,
      ),
    )
    .orderBy(desc(event.created_at));

  if (proposeRows.length === 0) return new Set();

  const proposeIds = proposeRows.map((r) => r.id);
  const rateRows = await db
    .select({ caused_by_event_id: event.caused_by_event_id })
    .from(event)
    .where(
      and(
        eq(event.action, 'rate'),
        eq(event.subject_kind, 'knowledge_edge'),
        inArray(event.caused_by_event_id, proposeIds),
      ),
    );
  const ratedProposeIds = new Set(
    rateRows.map((r) => r.caused_by_event_id).filter((id): id is string => id !== null),
  );

  const out = new Set<string>();
  for (const row of proposeRows) {
    if (ratedProposeIds.has(row.id)) continue;
    const p = row.payload as {
      from_knowledge_id?: unknown;
      to_knowledge_id?: unknown;
      relation_type?: unknown;
    };
    if (
      typeof p.from_knowledge_id === 'string' &&
      typeof p.to_knowledge_id === 'string' &&
      typeof p.relation_type === 'string'
    ) {
      out.add(edgeKey(p.from_knowledge_id, p.to_knowledge_id, p.relation_type));
    }
  }
  return out;
}
