import { canonicalHash } from './canonical';
import type { MigrationCapture } from './types';

// ====================================================================
// YUK-1048 review P1-1 — checkpoint 内容身份
// ====================================================================
//
// 工件文件名不能只派生自 raw_fact_hash：队列态、订阅 checkpoint/delivery、
// ai_task_runs 计数、可变运维字段（event.ingest_at 等）与 provenance 都属于
// 观测的一部分 —— 它们变了就是另一个 checkpoint，不能被旧文件名吞掉。
//
// checkpoint_hash 覆盖完整观测 + provenance，唯独排除【随运行变化的墙上时钟】：
//   - environment.snapshot_at（各次快照事务的 now()，同状态重跑必不同）
//   - manifest.source.captured_at（构建时刻，不在 capture 内）
// 排除它们是「重跑不产生重复捕获」的前提；其余全部进入身份。

export interface CheckpointProvenance {
  tool_version: string;
  git_sha: string | null;
  app_image: string | null;
  worker_image: string | null;
  migration_files: number | null;
  redaction: { applied: boolean; fields: string[] };
}

/** 从 manifest 选项重建 provenance（manifest 内已有同形字段）。 */
export function checkpointHashOf(
  capture: MigrationCapture,
  provenance: CheckpointProvenance,
): string {
  const { snapshot_at: _excluded, ...environment } = capture.environment;
  return canonicalHash({
    capture_schema_version: capture.capture_schema_version,
    environment,
    rawFacts: capture.rawFacts,
    ops: capture.ops,
    queues: capture.queues,
    subscription_checkpoints: capture.subscription_checkpoints,
    subscription_deliveries: capture.subscription_deliveries,
    ai_task_runs: capture.ai_task_runs,
    provenance,
  });
}
