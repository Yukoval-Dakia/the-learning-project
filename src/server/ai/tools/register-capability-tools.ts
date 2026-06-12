// M5-T3 (YUK-321) — copilotTools 贡献制的组合根聚合器（registerCapabilityJobs 先例）。
//
// 归属真相源 = 各包 manifest.copilotTools；运行时注册仍落进既有 DomainTool
// registry（MCP 桥接 / AI runner 一律不动）。bootstrap.ts 的 CORE_TOOLS 保持
// 幂等兜底（per-tool getTool 判空后才 registerTool），与本聚合器谁先到达均安全。
// `as DomainTool` 窄化集中在此一处：kernel CopilotToolDecl 的 load 返回最小
// 结构 { name }，避免 kernel 依赖 src/server 类型（JobHandlerFactory 同约）。

import type { CapabilityManifest } from '@/kernel/manifest';

import { getTool, registerTool } from './registry';
import type { DomainTool } from './types';

export async function registerCapabilityCopilotTools(
  capabilities: CapabilityManifest[],
): Promise<void> {
  const decls = capabilities
    .flatMap((cap) => cap.copilotTools?.tools ?? [])
    .filter((decl) => decl.load);
  for (const decl of decls) {
    if (getTool(decl.name)) continue; // CORE_TOOLS 兜底已注册 → 跳过
    const tool = (await decl.load?.()) as DomainTool<unknown, unknown>;
    if (tool.name !== decl.name) {
      throw new Error(
        `registerCapabilityCopilotTools: manifest declares '${decl.name}' but module exports '${tool.name}'`,
      );
    }
    registerTool(tool);
  }
}
