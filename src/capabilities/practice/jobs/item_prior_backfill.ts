// ItemPriorTask cold-start prior backfill (retained pg-boss handler).
//
// Delegates execution to ../server/item-prior-durable-operation.ts; job data
// normalization, yield reporting and retained failure behavior stay here.
// The DBOS candidate consumes only admission reads and cannot dispatch paid work.
//
// 幂等：applyItemPrior 用 onConflictDoNothing（item_calibration_question_unique），
// 已有 row 的题在候选 SELECT 阶段就被 anti-join 排除，双层兜底。出题 + 录入(OCR)
// 两条路径产生的新题都被同一 job 兜住——无需每条创建路径埋 hook。
//
// 失败语义：单题的 LLM/parse 失败只跳过该题（catch + 计数），不炸整个 job——
// 一道坏题不该阻断其余题的标定，下轮 job 再重试它（候选 SELECT 仍命中）。
// 候选 SELECT（pre-LLM DB read）的 throw 照常传播 → pg-boss 重试。

import type { Job } from 'pg-boss';
import type { Db } from '@/db/client';
import { type JobYieldOutput, reportJobYield } from '@/server/boss/job-yield';
import {
  type ItemPriorBackfillResult,
  type ItemPriorMethod,
  normalizeMethod,
  normalizeReps,
  runItemPriorBackfillOperation,
} from '../server/item-prior-durable-operation';

import type { PracticeTaskRunFn } from '../server/task-runtime';

export type {
  ItemPriorBackfillResult,
  ItemPriorMethod,
} from '../server/item-prior-durable-operation';

type DepsOverride = {
  runTaskFn?: PracticeTaskRunFn;
  /** 每轮最多标定多少题（防一次 job 打爆 LLM 预算）。default 25。 */
  maxPerRun?: number;
  /**
   * 先验方法选择。默认 'feature'；'llasa' 走 LLaSA 学生模拟反推 b。
   * 运行时也可经 job data { method: 'llasa' } 触发（pg-boss send 携带）。
   */
  method?: ItemPriorMethod;
  /**
   * feature 路径每题重复采样次数。默认 DEFAULT_REPS=3：median-of-3 把
   * within-question SD 0.361→0.173，≈+$0.0004/题。详见
   * item-prior-durable-operation.ts 的 sampleFeaturePriorDraft。
   */
  reps?: number;
};

/**
 * Backfill cold-start difficulty anchors for questions that have no hard-track
 * `item_calibration` row yet. Picks at most `maxPerRun` candidates per run.
 */
export async function runItemPriorBackfill(
  db: Db,
  deps: DepsOverride = {},
): Promise<ItemPriorBackfillResult> {
  const method = deps.method ?? 'feature';
  const reps = normalizeReps(deps.reps);
  if (method === 'llasa' && reps > 1) {
    // reps 只挂在 feature 路径；llasa+reps 不静默吞掉，warn 留痕。
    console.warn('[item_prior_backfill] reps>1 ignored for method=llasa', { reps });
  }
  return runItemPriorBackfillOperation(db, {
    method,
    reps,
    maxPerRun: deps.maxPerRun,
    runTaskFn: deps.runTaskFn,
  });
}

export function buildItemPriorBackfillHandler(
  db: Db,
): (jobs: Job<{ method?: ItemPriorMethod; reps?: number }>[]) => Promise<JobYieldOutput> {
  return async (jobs) => {
    try {
      // opt-in：pg-boss send('item_prior_backfill', { method: 'llasa' })
      // 触发 LLaSA 学生模拟路径（写 source='llm_prior_llasa'）；缺省/未知值恒回
      // 'feature'，cron 与既有 send 调用零变更。
      const method = normalizeMethod(jobs[0]?.data?.method);
      // { reps: N } 覆盖默认：feature 路径同题 N 次采样 median
      // 聚合；缺省/非法值回退 DEFAULT_REPS=3（nightly cron 不带 job data →
      // 生产默认 median-of-3），显式 { reps: 1 } 为单次调用 opt-out。
      const reps = normalizeReps(jobs[0]?.data?.reps);
      const result = await runItemPriorBackfill(db, { method, reps });
      console.log('[item_prior_backfill] result', result);
      // the counters already existed; nothing acted on them. An empty
      // candidate set early-returns with considered:0 → level `idle`; a 限流风暴
      // fails every question → calibrated:0 → level `stalled` (loud + job output).
      // Invariant holds: considered === calibrated + skipped_failed.
      return reportJobYield('item_prior_backfill', {
        attempted: result.considered,
        succeeded: result.calibrated,
        failed: result.skipped_failed,
      });
    } catch (err) {
      console.error('[item_prior_backfill] failed', err);
      throw err;
    }
  };
}
