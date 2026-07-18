// M5-T3 / YUK-328 — copilotTools 贡献制的组合根聚合器（registerCapabilityJobs 先例）。
//
// 归属真相源 = 各包 manifest.copilotTools。YUK-328 后该字段覆盖完整 DomainTool
// inventory（名称沿用以避免再造第二套贡献接口）；surface 权限仍由 allowlists.ts
// 控制。运行时注册落进既有 DomainTool registry，MCP bridge 只消费已注册工具。
// `as DomainTool` 窄化集中在此一处：kernel CopilotToolDecl 的 load 返回最小
// 结构 { name }，避免 kernel 依赖 src/server 类型（JobHandlerFactory 同约）。

import type { CapabilityManifest } from '@/kernel/manifest';

import { getTool, registerTool } from './registry';
import type { DomainTool } from './types';

export async function registerCapabilityTools(
  capabilities: readonly CapabilityManifest[],
): Promise<void> {
  const decls = capabilities
    .flatMap((cap) => cap.copilotTools?.tools ?? [])
    .filter((decl) => decl.load);
  for (const decl of decls) {
    // load 在调用点已被过滤非空；这里再守一道（TS 窄化，对齐 mountJob 先例）。
    if (!decl.load) continue;
    if (getTool(decl.name)) continue;
    const tool = (await decl.load()) as DomainTool<unknown, unknown>;
    // M5-T3a 收口：getTool 判空与 registerTool 之间隔 await 挂起点（TOCTOU），
    // 两个并发聚合器或其它启动装配可能在此期间注册同名 tool——await 后复查再注册。
    if (getTool(decl.name)) continue;
    if (tool.name !== decl.name) {
      throw new Error(
        `registerCapabilityTools: manifest declares '${decl.name}' but module exports '${tool.name}'`,
      );
    }
    registerTool(tool);
  }
}
