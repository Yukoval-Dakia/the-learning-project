// YUK-758 — 从组合根 capabilities 投影出编排 DAG 成员，并建图。
//
// 成员判据（JobDecl 上**存在** dependsOn 字段，含 `[]` 根；裸 cron job 不入图）**不在此
// 定义**：投影是 kernel 的 projectDagMembers 独家职责（review ToTau）。本文件曾内联一份
// 同样的投影循环，与 validateComposition 里的那份构成双写——判据一侧改动即让「校验过的
// 图」与「运行期建的图」静默分叉。现在两侧共用 kernel 那一份，分叉不可能发生。

import { type JobDag, buildJobDag } from '@/kernel/job-dag';
import { type CapabilityManifest, projectDagMembers } from '@/kernel/manifest';

/**
 * 建编排 DAG。假定组合根已通过 validateComposition（含 validateJobDag：无重复成员/缺引用/
 * 自环/成环）——orchestrator 运行在 worker 启动后，组合根校验早已跑过。
 */
export function buildOrchestrationDag(capabilities: readonly CapabilityManifest[]): JobDag {
  return buildJobDag(projectDagMembers(capabilities));
}
