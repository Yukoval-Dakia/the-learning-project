// 从组合根 capabilities 投影出编排 DAG 成员并建图。
//
// 成员判据（JobDecl 上**存在** dependsOn 字段，含 `[]` 根；裸 cron job 不入图）归 kernel 的
// projectDagMembers 独家所有，此处不得内联投影——否则「校验过的图」与「运行期建的图」
// 会静默分叉。

import { type JobDag, buildJobDag } from '@/kernel/job-dag';
import { type CapabilityManifest, projectDagMembers } from '@/kernel/manifest';

/**
 * 建编排 DAG。假定组合根已通过 validateComposition（含 validateJobDag：无重复成员/缺引用/
 * 自环/成环）——orchestrator 运行在 worker 启动后，组合根校验早已跑过。
 */
export function buildOrchestrationDag(capabilities: readonly CapabilityManifest[]): JobDag {
  return buildJobDag(projectDagMembers(capabilities));
}
