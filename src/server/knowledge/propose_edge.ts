// Phase 2 Dreaming — knowledge_edge propose pipeline.
//
// 和 propose.ts (节点提议) 对应：propose.ts 让 AI 提议**新节点**，本模块让 AI
// 提议**新边**。两者都走"提议事件 → 用户 rate → accept 落库"的两步流程，区别只
// 是落库目标 (knowledge vs knowledge_edge) 和 mutation 语义。
//
// 不复用 KnowledgeReviewTask 的 streaming + tool-calling 路径 —— ReviewTask 是
// 交互式 12 iter 设计，nightly cron 用单次结构化输出更便宜可控。

import { RelationTypeSchema } from '@/core/schema/event/blocks';
import type { Db } from '@/db/client';
import { event, knowledge_edge } from '@/db/schema';
import type { TaskTextRunFn } from '@/server/ai/provenance';
import { effectiveCauseForFailureAttempt } from '@/server/events/cause-policy';
import type { FailureAttempt } from '@/server/events/queries';
import { writeAiProposal } from '@/server/proposals/writer';
import type { SubjectProfile } from '@/subjects/profile';
import { and, desc, eq, inArray } from 'drizzle-orm';
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
}

const EMPTY_RESULT: RunEdgeProposeAndWriteResult = {
  proposed: 0,
  skipped_self_loop: 0,
  skipped_unknown_node: 0,
  skipped_duplicate_edge: 0,
  skipped_duplicate_pending: 0,
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
      await writeAiProposal(params.db, {
        actor_ref: 'dreaming',
        outcome: 'success',
        payload: {
          kind: 'knowledge_edge',
          target: { subject_kind: 'knowledge_edge', subject_id: null },
          reason_md: p.reasoning,
          evidence_refs: params.recentFailures.map((failure) => ({
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
        },
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
    .where(and(eq(event.action, 'propose'), eq(event.subject_kind, 'knowledge_edge')))
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
