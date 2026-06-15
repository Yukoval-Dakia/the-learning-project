// B1-W1 (ADR-0035 慢热阶段①) — ItemPriorTask 冷启先验 backfill。
//
// 结构上仿 goal_scope_propose_nightly.ts：候选选择（无 item_calibration 硬轨 row
// 的题）→ 逐题跑 ItemPriorTask（单次结构化输出）→ parse → applyItemPrior 写 row。
//
// 幂等：applyItemPrior 用 onConflictDoNothing（item_calibration_question_unique），
// 已有 row 的题在候选 SELECT 阶段就被 anti-join 排除，双层兜底。出题 + 录入(OCR)
// 两条路径产生的新题都被同一 job 兜住——无需每条创建路径埋 hook。
//
// 失败语义：单题的 LLM/parse 失败只跳过该题（catch + 计数），不炸整个 job——
// 一道坏题不该阻断其余题的标定，下轮 job 再重试它（候选 SELECT 仍命中）。
// 候选 SELECT（pre-LLM DB read）的 throw 照常传播 → pg-boss 重试。

import { sql } from 'drizzle-orm';
import type { Job } from 'pg-boss';

import { resolveSubjectProfileForKnowledgeIds } from '@/capabilities/knowledge/server/subject-profile';
import type { Db } from '@/db/client';
import { knowledge, question } from '@/db/schema';
import { parseItemPriorOutput } from '@/server/ai/item-prior';
import type { TaskTextRunFn } from '@/server/ai/provenance';
import { applyItemPrior } from '@/server/mastery/item-calibration';
import { inArray } from 'drizzle-orm';

type DepsOverride = {
  runTaskFn?: TaskTextRunFn;
  /** 每轮最多标定多少题（防一次 job 打爆 LLM 预算）。default 25。 */
  maxPerRun?: number;
};

export interface ItemPriorBackfillResult {
  /** 本轮挑出的待标定题数（capped by maxPerRun）。 */
  considered: number;
  /** 成功写入 calibration row 的题数。 */
  calibrated: number;
  /** 单题 LLM/parse 失败被跳过的题数（不阻断其余题）。 */
  skipped_failed: number;
}

const DEFAULT_MAX_PER_RUN = 25;

/**
 * Backfill cold-start difficulty anchors for questions that have no hard-track
 * `item_calibration` row yet. Picks at most `maxPerRun` candidates per run.
 */
export async function runItemPriorBackfill(
  db: Db,
  deps: DepsOverride = {},
): Promise<ItemPriorBackfillResult> {
  const maxPerRun = deps.maxPerRun ?? DEFAULT_MAX_PER_RUN;
  const result: ItemPriorBackfillResult = { considered: 0, calibrated: 0, skipped_failed: 0 };

  // PRE-LLM read OUTSIDE any per-task swallow: a throw here is a legit retryable
  // DB fault (pg-boss retries). Anti-join: questions with no hard-track
  // item_calibration row. NOT EXISTS keeps it index-friendly + idempotent.
  const candidates = await db
    .select({
      id: question.id,
      kind: question.kind,
      prompt_md: question.prompt_md,
      knowledge_ids: question.knowledge_ids,
    })
    .from(question)
    .where(
      sql`NOT EXISTS (
        SELECT 1 FROM item_calibration ic
        WHERE ic.question_id = ${question.id} AND ic.track = 'hard'
      )`,
    )
    .limit(maxPerRun);

  result.considered = candidates.length;
  if (candidates.length === 0) return result;

  const runTaskFn = deps.runTaskFn ?? defaultRunTaskFn;

  // Resolve knowledge names once for the union of all candidate knowledge ids.
  const allKnowledgeIds = Array.from(new Set(candidates.flatMap((c) => c.knowledge_ids ?? [])));
  const nameById = new Map<string, string>();
  if (allKnowledgeIds.length > 0) {
    const rows = await db
      .select({ id: knowledge.id, name: knowledge.name })
      .from(knowledge)
      .where(inArray(knowledge.id, allKnowledgeIds));
    for (const r of rows) nameById.set(r.id, r.name);
  }

  for (const c of candidates) {
    try {
      const knowledgeContext = (c.knowledge_ids ?? [])
        .map((id) => ({ name: nameById.get(id) }))
        .filter((kc): kc is { name: string } => typeof kc.name === 'string');
      // Resolve the subject profile for the prompt rendering (cause taxonomy /
      // language style). Falls back to default profile when unlabeled.
      const subjectProfile = await resolveSubjectProfileForKnowledgeIds(db, c.knowledge_ids ?? []);
      const input = {
        prompt_md: c.prompt_md,
        kind: c.kind,
        knowledge_context: knowledgeContext,
      };
      const runResult = await runTaskFn('ItemPriorTask', input, { db, subjectProfile });
      const draft = parseItemPriorOutput(runResult.text);
      await applyItemPrior(db, { questionId: c.id, draft });
      result.calibrated++;
    } catch (err) {
      // One bad question must not block the rest. Logged + counted; the next run
      // re-picks it (the candidate SELECT still matches — no row was written).
      console.error('[item_prior_backfill] question calibration failed', { questionId: c.id, err });
      result.skipped_failed++;
    }
  }

  return result;
}

async function defaultRunTaskFn(
  kind: string,
  input: unknown,
  ctx: unknown,
): Promise<Awaited<ReturnType<TaskTextRunFn>>> {
  const { runTask } = await import('@/server/ai/runner');
  return runTask(kind, input, ctx as Parameters<typeof runTask>[2]);
}

export function buildItemPriorBackfillHandler(
  db: Db,
): (jobs: Job<Record<string, never>>[]) => Promise<void> {
  return async () => {
    try {
      const result = await runItemPriorBackfill(db);
      console.log('[item_prior_backfill] result', result);
    } catch (err) {
      console.error('[item_prior_backfill] failed', err);
      throw err;
    }
  };
}
