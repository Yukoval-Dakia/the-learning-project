// YUK-1570 — web sourcing 挂载运行操作（RunWebSourcingAgentFn 真身，自
// tools/web-fetch-candidates.ts 下沉的完整运行操作）。
//
// 本模块拥有"一次 SourcingTask 挂载运行"的全部内部决策，caller 只传
// SourcingTask 输入与运行归因 ctx：
//
//   - Exa 检索后端可用性闸：buildExaMcpServer() 为 null → 返回 null（在挂载
//     domain server 之前短路，caller/核映射为 failureClass
//     'web_search_unavailable'，旧 dispatcher webSearchAvailable 闸同款语义）；
//   - 挂载装配：SOURCING_READ_TOOLS 域只读面（in-process domain read tools，
//     callerActor='sourcing'，taskRunId/causedByEventId 透传调用方 run ctx）
//     + Exa remote 双 mount；
//   - allowedTools 折叠：domain 名 → mcp__loom__* + EXA_MCP_ALLOWED_TOOLS；
//   - 运行调用：runAgentTask('SourcingTask') 字面量 kind（task census 可见），
//     modelBinding 透传，结果收窄为 {text, task_run_id, cost_usd}；
//   - 生产 deps 装配：defaultWebSourcingDeps() 是"哪个 runSourcingAgent 真身 +
//     哪个 parseLoose"的唯一组装点（tool 层与 executor job 层曾各自手装同一对）。
//
// caller 保留：canary 事件单写（web-candidates 核）、anchor/subject 解析、
// 候选 parse/kind 门/活 knowledge 校验与全部后续正确性路径。本模块不写 DB、
// 不写事件——除 runAgentTask 自身的运行留痕（ai_task_runs/cost ledger 不变）。

import { piDomainMount, piRemoteMcpMount, type PiToolMount } from '@/ai/pi-tool-mount';
import { parseJsonObjectLoose } from '@/core/json-extract';
import {
  DOMAIN_TOOL_MCP_SERVER_NAME,
  type DomainToolName,
  toMcpAllowedToolName,
} from '@/kernel/tools/allowlists';
import {
  EXA_MCP_ALLOWED_TOOLS,
  EXA_MCP_SERVER_NAME,
  EXA_SCOPED_TOOL_NAMES,
  buildExaMcpServer,
} from '@/server/ai/mcp/exa';
import { runAgentTask } from '@/server/ai/runner';
import type {
  RunWebFetchCandidatesDeps,
  RunWebSourcingAgentFn,
} from './question-supply/web-candidates';

// SourcingTask 挂载的 read-only domain-tool 面——从 jobs/sourcing.ts SOURCING_READ_TOOLS
// 逐字拷贝（退役 monolith 不许从 tool 层 import）；与 planner 读面同集但独立
// 声明——共享 allowlist 矩阵扩张需显式决策。
const SOURCING_READ_TOOLS = [
  'query_knowledge',
  'get_subject_graph_overview',
  'expand_knowledge_subgraph',
  'find_knowledge_paths',
] as const satisfies readonly DomainToolName[];

/**
 * RunWebSourcingAgentFn 的真身：MCP 挂载（domain read tools + Exa remote）+
 * runAgentTask('SourcingTask')。Exa key 缺失时返回 null——核映射为
 * failureClass 'web_search_unavailable'（旧 dispatcher webSearchAvailable 闸同款语义）。
 */
export const runWebSourcingOperation: RunWebSourcingAgentFn = async (params) => {
  const { db, input, subjectProfile, ctx } = params;

  // web 路由无检索后端即不可执行——先闸，避免无谓挂载 domain server。
  const exaCfg = buildExaMcpServer();
  if (exaCfg === null) return null;

  // MCP mount 镜像旧 sourcing job：in-process domain read tools（ctx 归因到
  // 调用方透传的 run 上下文，callerActor='sourcing'）+ Exa remote。
  const piToolMounts: PiToolMount[] = [
    piDomainMount({
      ctx: {
        db,
        taskRunId: ctx.taskRunId,
        callerActor: { kind: 'agent', ref: 'sourcing' },
        causedByEventId: ctx.causedByEventId,
      },
      serverName: DOMAIN_TOOL_MCP_SERVER_NAME,
      toolNames: SOURCING_READ_TOOLS,
      taskKind: 'SourcingTask',
    }),
    piRemoteMcpMount(EXA_MCP_SERVER_NAME, exaCfg, EXA_SCOPED_TOOL_NAMES, db),
  ];
  const allowedTools = [
    ...SOURCING_READ_TOOLS.map((name) => toMcpAllowedToolName(name)),
    ...EXA_MCP_ALLOWED_TOOLS,
  ];

  const result = await runAgentTask('SourcingTask', input, {
    db,
    piToolMounts,
    allowedTools,
    subjectProfile,
    modelBinding: ctx.modelBinding,
  });
  return { text: result.text, task_run_id: result.task_run_id, cost_usd: result.cost_usd };
};

/**
 * web 候选生产线的生产 deps 唯一组装点：真身 runSourcingAgent + 真身
 * parseLoose。tool 层默认依赖与 executor job deps 装配共用（原两处各自手装
 * 同一对，组装决策重复）；逐字段注入能力不变——caller 仍可覆盖单个字段。
 */
export function defaultWebSourcingDeps(): RunWebFetchCandidatesDeps {
  return { runSourcingAgent: runWebSourcingOperation, parseLoose: parseJsonObjectLoose };
}
