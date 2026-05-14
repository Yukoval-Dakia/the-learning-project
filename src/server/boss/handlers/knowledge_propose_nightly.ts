import { eq, gte, sql } from 'drizzle-orm';
import type { Job } from 'pg-boss';

import type { Db } from '@/db/client';
import { mistake, question } from '@/db/schema';
import { runProposeAndWrite, type RunTaskFn } from '@/server/knowledge/propose';

type DepsOverride = {
  runTaskFn?: RunTaskFn;
};

/**
 * Nightly cron handler —— 扫最近 24h 创建的 mistakes，对每条调 runProposeAndWrite
 * 触发 KnowledgeProposeTask 产生 dreaming_proposal。
 *
 * per-mistake try-catch：一条失败不影响后续。
 *
 * 默认 runTaskFn 走 @/server/ai/runner（生产路径）；测试传 mock 注入。
 */
export async function runKnowledgeProposeNightly(
  db: Db,
  deps: DepsOverride = {},
): Promise<{ processed: number; failed: number }> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const recent = await db
    .select({
      m_id: mistake.id,
      wrong_answer_md: mistake.wrong_answer_md,
      knowledge_ids: mistake.knowledge_ids,
      q_prompt_md: question.prompt_md,
      q_reference_md: question.reference_md,
    })
    .from(mistake)
    .innerJoin(question, eq(mistake.question_id, question.id))
    .where(gte(mistake.created_at, cutoff));

  const runTaskFn: RunTaskFn = deps.runTaskFn ?? defaultRunTaskFn;

  let processed = 0;
  let failed = 0;
  for (const row of recent) {
    try {
      await runProposeAndWrite({
        db,
        mistakeContent: {
          prompt_md: row.q_prompt_md,
          reference_md: row.q_reference_md,
          wrong_answer_md: row.wrong_answer_md ?? '',
          knowledge_ids_picked: row.knowledge_ids ?? [],
        },
        runTaskFn,
      });
      processed += 1;
    } catch (err) {
      console.error(`[knowledge_propose_nightly] mistake ${row.m_id} failed`, err);
      failed += 1;
    }
  }
  return { processed, failed };
}

// 避免 sql 模板未使用的告警（type 推导需要）
const _sqlMarker = sql;
void _sqlMarker;

async function defaultRunTaskFn(
  kind: string,
  input: unknown,
  ctx: unknown,
): Promise<{ text: string }> {
  const { runTask } = await import('@/server/ai/runner');
  const result = await runTask(kind, input, ctx as Parameters<typeof runTask>[2]);
  return { text: result.text };
}

/**
 * pg-boss handler adapter —— scheduler 触发时调；本身不带参数。
 */
export function buildKnowledgePropoNightlyHandler(
  db: Db,
): (jobs: Job<Record<string, never>>[]) => Promise<void> {
  return async () => {
    const result = await runKnowledgeProposeNightly(db);
    console.log('[knowledge_propose_nightly] result', result);
  };
}
