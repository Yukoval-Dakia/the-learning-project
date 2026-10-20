// YUK-439 (ADR-0043 2026-10-19 Amendment A2/A3) — 联合标定批的夜间触发器。
//
// 历史：本 job 原是 active-PPI 机器（recalibrateQuestion 的 AIPW firm-up + 12 标签硬
// 门控）的触发器（YUK-372 L1）。YUK-439 起改喂 src/server/mastery/joint-calibration.ts
// 的**连续后验批**：每题从证据账本（difficulty_calibration_evidence，含模型判分与
// 非 softmax 来源）以先验 N(μ_j, τ_j²) 全量重算后验 b_post——证据从第一条起连续收缩，
// 无 12 标签跳变、无「首写不可逆」（A3）。旧 AIPW 机器转为离线审计/对照工具（其函数
// 与测试保留；重放对照脚本 scripts/replay-joint-calibration.ts 以它复刻现行方案）。
//
// 批边界后跑 A5 KB 漂移审计（越界归一回锚尺度 + 先验质量调查 flag），结果（含 A6
// 可观测性指标）随 `[recalibration_nightly] result` 日志出口。
//
// ── 红线 ────────────────────────────────────────────────────────────────────
// G1：批函数在 job 顶层调（非 attempt tx 内）→ per-item try/catch 隔离，不加 SAVEPOINT。
// G3：只写 item_calibration 后验列族（+ 归一时的 θ̂/θ 快照/family delta 随动）——
//     never item b / stream / due / 判分。
// G5：候选 JOIN question 排 draft（notDraftPredicate）。
//
// DAG 位置不变（item_prior 之后、compose/supply 之前）：今晨收敛的 b_post 被当天的
// 选题与缺口扫描读到；YUK-758 起次序由 dependsOn 硬边保证。queue=llm 同旧。

import type { Job } from 'pg-boss';
import type { Db } from '@/db/client';
import { type JobYieldOutput, reportJobYield } from '@/server/boss/job-yield';
import { runJointCalibrationBatch } from '@/server/mastery/joint-calibration';

/**
 * 夜跑联合标定批。零新写（除 joint-calibration 内部的后验写）。
 */
export async function runRecalibrationNightly(
  db: Db,
): Promise<import('@/server/mastery/joint-calibration').JointCalibrationBatchResult> {
  return runJointCalibrationBatch(db);
}

export function buildRecalibrationNightlyHandler(
  db: Db,
): (jobs: Job<Record<string, never>>[]) => Promise<JobYieldOutput> {
  return async () => {
    try {
      const result = await runRecalibrationNightly(db);
      console.log('[recalibration_nightly] result', result);
      // YUK-779 — this job has TWO hard downstreams (practice_stream_compose_nightly,
      // question_supply_nightly), so a silent zero-yield here poisons a whole subtree.
      //
      // NOTE the deliberate split: `skipped_no_anchor` counts as SUCCEEDED, not
      // failed — the batch returned a legitimate data conclusion (a question with
      // evidence but no anchor simply has no posterior to write). Only
      // `skipped_failed` (the per-question catch) is a swallowed throw.
      // Invariant: considered === recalibrated + skipped_no_anchor + skipped_failed.
      return reportJobYield('recalibration_nightly', {
        attempted: result.considered,
        succeeded: result.recalibrated + result.skipped_no_anchor,
        failed: result.skipped_failed,
      });
    } catch (err) {
      console.error('[recalibration_nightly] failed', err);
      throw err;
    }
  };
}
