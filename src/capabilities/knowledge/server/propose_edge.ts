// Phase 2 Dreaming — knowledge_edge propose pipeline.
//
// 和 propose.ts (节点提议) 对应：propose.ts 让 AI 提议**新节点**，本模块让 AI
// 提议**新边**。两者都走"提议事件 → 用户 rate → accept 落库"的两步流程，区别只
// 是落库目标 (knowledge vs knowledge_edge) 和 mutation 语义。
//
// 不复用 KnowledgeReviewTask 的 streaming + tool-calling 路径 —— ReviewTask 是
// 交互式 12 iter 设计，nightly cron 用单次结构化输出更便宜可控。

import { validateProposalQuality } from '@/capabilities/knowledge/server/rubric-validator';
import { RelationTypeSchema } from '@/core/schema/event/blocks';
import { parseAiProposalPayload } from '@/core/schema/proposal';
import type { Db } from '@/db/client';
import { event, knowledge_edge } from '@/db/schema';
import type { TaskTextRunFn } from '@/server/ai/provenance';
import { effectiveCauseForFailureAttempt } from '@/server/events/cause-policy';
import type { FailureAttempt } from '@/server/events/queries';
import { writeAiProposal } from '@/server/proposals/writer';
import type { SubjectProfile } from '@/subjects/profile';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { writeRetryableAiFailureLedger } from './ai_failure_log';
import { loadTreeSnapshot } from './tree';

const EdgeProposalSchema = z.object({
  from_knowledge_id: z.string().min(1),
  to_knowledge_id: z.string().min(1),
  relation_type: RelationTypeSchema,
  weight: z.number().min(0).max(1).default(0.5),
  reasoning: z.string().min(1).max(500),
});

const EdgeOutputSchema = z.object({
  proposals: z.array(EdgeProposalSchema).max(5),
});

export type EdgeProposeOutput = z.infer<typeof EdgeOutputSchema>;

export type RunTaskFn = TaskTextRunFn;

export interface RunEdgeProposeAndWriteParams {
  db: Db;
  recentFailures: FailureAttempt[];
  runTaskFn: RunTaskFn;
  env?: unknown;
  subjectProfile?: SubjectProfile;
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
}

const EMPTY_RESULT: RunEdgeProposeAndWriteResult = {
  proposed: 0,
  skipped_self_loop: 0,
  skipped_unknown_node: 0,
  skipped_duplicate_edge: 0,
  skipped_duplicate_pending: 0,
  folded_rubric_rejected: 0,
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
        from_knowledge_id: knowledge_edge.from_knowledge_id,
        to_knowledge_id: knowledge_edge.to_knowledge_id,
        relation_type: knowledge_edge.relation_type,
      })
      .from(knowledge_edge);

    const existingEdgeKey = new Set(
      existingEdges.map((e) => edgeKey(e.from_knowledge_id, e.to_knowledge_id, e.relation_type)),
    );
    const pendingEdgeKey = await loadPendingEdgeProposalKeys(params.db);

    const input = {
      tree_snapshot: tree.map((n) => ({
        id: n.id,
        name: n.name,
        parent_id: n.parent_id,
        effective_domain: n.effective_domain,
      })),
      existing_edges: existingEdges,
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

      // Write ProposeKnowledgeEdge event (Lane B).
      //
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
          actor_ref: 'dreaming',
          outcome: 'success',
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
          task_run_id: result.task_run_id ?? null,
          cost_usd: result.cost_usd,
          created_at: new Date(),
        });
        // Mark this key so the SAME batch does not re-emit it (the folded row is
        // excluded from the CROSS-batch pending set in loadPendingEdgeProposalKeys,
        // but within one batch we still suppress an immediate duplicate).
        pendingEdgeKey.add(key);
        stats.folded_rubric_rejected += 1;
        continue;
      }

      await writeAiProposal(params.db, {
        actor_ref: 'dreaming',
        outcome: 'success',
        payload: proposalPayload,
        task_run_id: result.task_run_id ?? null,
        cost_usd: result.cost_usd,
        created_at: new Date(),
      });
      // 同一 batch 内防同向同型重复
      pendingEdgeKey.add(key);
      stats.proposed += 1;
    }

    return stats;
  } catch (err) {
    console.error('runEdgeProposeAndWrite: failed (no proposals written)', err);
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
