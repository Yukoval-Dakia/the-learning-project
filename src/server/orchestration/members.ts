// YUK-758 — 从组合根 capabilities 投影出编排 DAG 成员，并建图。
//
// 成员 = manifest JobDecl 上**存在** dependsOn 字段的 job（含 `[]` 根）。裸 cron job
// （无 dependsOn）不入图。纯函数：读 manifest 元数据，无 IO——kernel/job-dag 做拓扑。

import { type JobDag, type JobDagMemberInput, buildJobDag } from '@/kernel/job-dag';
import type { CapabilityManifest } from '@/kernel/manifest';

/** 从 capabilities 抽取图成员输入（name/owner/dependsOn）。 */
export function projectDagMembers(
  capabilities: readonly CapabilityManifest[],
): JobDagMemberInput[] {
  const members: JobDagMemberInput[] = [];
  for (const cap of capabilities) {
    for (const job of cap.jobs?.handlers ?? []) {
      if (job.dependsOn !== undefined) {
        members.push({ name: job.name, owner: cap.name, dependsOn: job.dependsOn });
      }
    }
  }
  return members;
}

/**
 * 建编排 DAG。假定组合根已通过 validateComposition（含 validateJobDag：无缺引用/自环/
 * 成环）——orchestrator 运行在 worker 启动后，组合根校验早已跑过。
 */
export function buildOrchestrationDag(capabilities: readonly CapabilityManifest[]): JobDag {
  return buildJobDag(projectDagMembers(capabilities));
}
