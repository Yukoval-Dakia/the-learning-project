// Phase 2 Dreaming — nightly knowledge_edge propose handler.
//
// 和 knowledge_propose_nightly 配对：node propose 每条 attempt 单独跑（per-attempt
// 局部判断），edge propose 是 batch 一次跑（跨 attempt 找模式）。每天 BJT 02:30 触发
// （offset 30min 跟 node propose 错峰）。

import type { Job } from 'pg-boss';

import type { Db } from '@/db/client';
import { getFailureAttempts } from '@/server/events/queries';
import { type RunTaskFn, runEdgeProposeAndWrite } from '@/server/knowledge/propose_edge';

type DepsOverride = {
  runTaskFn?: RunTaskFn;
};

export interface NightlyResult {
  proposed: number;
  attempts_considered: number;
  skipped_self_loop: number;
  skipped_unknown_node: number;
  skipped_duplicate_edge: number;
  skipped_duplicate_pending: number;
}

/**
 * Scan the last 24h of failure attempts and run KnowledgeEdgeProposeTask once
 * with the batch. 0 attempts → no-op (cheaper than calling LLM with empty input).
 */
export async function runKnowledgeEdgeProposeNightly(
  db: Db,
  deps: DepsOverride = {},
): Promise<NightlyResult> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const attempts = await getFailureAttempts(db, { since: cutoff, limit: 200 });
  if (attempts.length === 0) {
    return {
      proposed: 0,
      attempts_considered: 0,
      skipped_self_loop: 0,
      skipped_unknown_node: 0,
      skipped_duplicate_edge: 0,
      skipped_duplicate_pending: 0,
    };
  }

  const runTaskFn: RunTaskFn = deps.runTaskFn ?? defaultRunTaskFn;
  const stats = await runEdgeProposeAndWrite({
    db,
    recentFailures: attempts,
    runTaskFn,
  });

  return { ...stats, attempts_considered: attempts.length };
}

async function defaultRunTaskFn(
  kind: string,
  input: unknown,
  ctx: unknown,
): Promise<{ text: string }> {
  const { runTask } = await import('@/server/ai/runner');
  const result = await runTask(kind, input, ctx as Parameters<typeof runTask>[2]);
  return { text: result.text };
}

export function buildKnowledgeEdgeProposeNightlyHandler(
  db: Db,
): (jobs: Job<Record<string, never>>[]) => Promise<void> {
  return async () => {
    const result = await runKnowledgeEdgeProposeNightly(db);
    console.log('[knowledge_edge_propose_nightly] result', result);
  };
}
