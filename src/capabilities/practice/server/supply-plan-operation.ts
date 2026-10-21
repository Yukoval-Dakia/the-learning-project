// SupplyPlan 有界规划尝试操作（自 jobs/supply_planner.ts 下沉的完整运行操作）。
// 本模块拥有"一次有界规划尝试"的全部内部决策，caller 只喂快照并收结果：
// - 挂载装配：planner 的只读知识图谱面（SUPPLY_PLANNER_READ_TOOLS）经
// piDomainMount 编译 + allowedTools 折叠；`supply_planner_tool_${createId}`
// 工具归因 taskRunId 创建一次、跨全部重试复用（绝不逐 attempt 新铸）；
// - 运行调用：`runAgentTask('SupplyPlanTask')` 字面量 kind；
// `runAgentTaskFn` 注入 seam 保留（db 测试 fake 原路径有效）；
// - 有界尝试政策：≤ SUPPLY_PLAN_MAX_ATTEMPTS 轮，每轮拒绝原因 flat 回喂
// previous_rejection 驱动有界重生成，仍不过则 fail closed（plan=null）；
// - 解析/机检顺序与拒绝归集：parseSupplyPlanOutput → checkSupplyPlanStructure
// → checkSupplyPlanKnowledgeIds，reasons 逐轮 push 进 rejections（原顺序、
// 原结构，caller 原样写进 run 事件 payload）；
// - 留痕口径：task_run_id 仅在存在时收集、cost_usd 按 `?? 0` 累加、
// attempts 记实际执行轮数。
// caller（jobs/supply_planner.ts）保留：原始信号快照装配（知识树/题数/掌握度/
// pending claims/jyeoo 余量）、plannerInput 构造、PLANNER_HOST_SUBJECT 的
// subjectProfile 解析，以及全部 run/demand/execute/shadow 事件与 DB 写入。
// 本模块自身不写 DB、不写事件——除注入 run 自身的运行留痕（ai_task_runs /
// cost ledger 语义不变）。run 异常原样上抛（pg-boss DLQ 重试语义不变）。

import { createId } from '@paralleldrive/cuid2';
import type { SupplyPlanV1T } from '@/core/schema/supply_plan';
import type { Db } from '@/db/client';
import {
  DOMAIN_TOOL_MCP_SERVER_NAME,
  type DomainToolName,
  toMcpAllowedToolName,
} from '@/kernel/tools/allowlists';
import { runAgentTask } from '@/server/ai/runner';
import { type PiToolMount, piDomainMount } from '@/server/ai/tools/pi-tools';
import type { SubjectProfile } from '@/subjects/profile';
import {
  checkSupplyPlanKnowledgeIds,
  checkSupplyPlanStructure,
  parseSupplyPlanOutput,
} from './question-supply/supply-plan-gate';

// planner 只挂只读知识图谱面（下钻核实节点）；与 QUIZ_GEN_READ_TOOLS 同集但独立
// 声明——共享 allowlist 矩阵扩张需显式决策（quiz_gen.ts 同款注释）。
const SUPPLY_PLANNER_READ_TOOLS = [
  'query_knowledge',
  'get_subject_graph_overview',
  'expand_knowledge_subgraph',
  'find_knowledge_paths',
] as const satisfies readonly DomainToolName[];

// 照 QUIZ_PLAN_MAX_ATTEMPTS（quiz_gen_plan.ts）：规划至多 2 轮，仍不过 fail closed。
const SUPPLY_PLAN_MAX_ATTEMPTS = 2;

// runAgentTask 返回的最小结构面（照 quiz_gen.ts TaskTextResult 注释同款）。
export interface SupplyPlanTaskTextResult {
  text: string;
  task_run_id?: string;
  cost_usd?: number | null;
}

export type SupplyPlanRunAgentFn = (
  kind: string,
  input: unknown,
  opts: {
    db: Db;
    allowedTools?: string[];
    subjectProfile: SubjectProfile;
  },
) => Promise<SupplyPlanTaskTextResult>;

export interface SupplyPlanOperationParams {
  db: Db;
  /** caller 装配好的 SupplyPlanTask 输入（原始信号快照；操作不回读 DB 补信号）。 */
  plannerInput: Record<string, unknown>;
  /** caller 按宿主科目解析的 profile（PLANNER_HOST_SUBJECT 决策留在 caller）。 */
  subjectProfile: SubjectProfile;
  /** 活 knowledge 节点全集（caller 快照产出）——checkSupplyPlanKnowledgeIds 的判定集。 */
  liveKnowledgeIds: ReadonlySet<string>;
  /** 当日 jyeoo 预算余量（caller 快照产出）——checkSupplyPlanStructure 的判定值。 */
  jyeooBudgetRemaining: number;
}

export interface SupplyPlanOperationDeps {
  /** 运行注入 seam（缺省 = runAgentTask 真身；db 测试 fake 断言 input/attempts）。 */
  runAgentTaskFn?: SupplyPlanRunAgentFn;
}

export interface SupplyPlanOperationResult {
  /** 过机检的 SupplyPlan；≤MAX 轮仍不过为 null（fail closed）。 */
  plan: SupplyPlanV1T | null;
  /** 逐轮拒绝原因（parse reasons 与机检 reasons 按原顺序逐轮 push）。 */
  rejections: string[][];
  /** 各轮实际返回的 task_run_id（仅存在时收集，顺序=轮序）。 */
  taskRunIds: string[];
  /** 各轮 cost_usd 按 `?? 0` 累加的原始总额（>0 换算与 null 规则由 caller 决定）。 */
  costUsdTotal: number;
  /** 实际执行轮数（最后一轮的 attempt 序号；run 上抛时不返回）。 */
  attempts: number;
}

/**
 * 跑一次有界 SupplyPlan 规划尝试：挂载（一次）→ ≤MAX 轮
 * run → parse → 机检，拒绝回喂。返回 plan 与全部留痕口径；
 * 事件/DB 写入全部在 caller。
 */
export async function runSupplyPlanOperation(
  params: SupplyPlanOperationParams,
  deps: SupplyPlanOperationDeps = {},
): Promise<SupplyPlanOperationResult> {
  const { db, plannerInput, subjectProfile, liveKnowledgeIds, jyeooBudgetRemaining } = params;
  const run = deps.runAgentTaskFn ?? runAgentTask;

  // 工具归因 taskRunId + 挂载只创建一次，跨 ≤MAX 轮重试复用（tool_call_log
  // 归因键；逐 attempt 新铸会切碎工具调用归属）。
  const toolContextTaskRunId = `supply_planner_tool_${createId()}`;
  // piDomainMount compiles the DomainTools into AgentTools.
  const piToolMounts: PiToolMount[] = [
    piDomainMount({
      ctx: {
        db,
        taskRunId: toolContextTaskRunId,
        callerActor: { kind: 'agent', ref: 'supply_planner' },
      },
      serverName: DOMAIN_TOOL_MCP_SERVER_NAME,
      toolNames: SUPPLY_PLANNER_READ_TOOLS,
      taskKind: 'SupplyPlanTask',
    }),
  ];
  const allowedTools = SUPPLY_PLANNER_READ_TOOLS.map((name) => toMcpAllowedToolName(name));

  let plan: SupplyPlanV1T | null = null;
  const planRejections: string[][] = [];
  const taskRunIds: string[] = [];
  let costUsdTotal = 0;
  let attempts = 0;
  for (let attempt = 1; attempt <= SUPPLY_PLAN_MAX_ATTEMPTS; attempt += 1) {
    const previousRejection = planRejections.flat().join('; ') || undefined;
    const attemptInput = previousRejection
      ? { ...plannerInput, previous_rejection: previousRejection }
      : plannerInput;
    attempts = attempt;
    const runResult = await run('SupplyPlanTask', attemptInput, {
      db,
      piToolMounts,
      allowedTools,
      subjectProfile,
    });
    if (runResult.task_run_id) taskRunIds.push(runResult.task_run_id);
    costUsdTotal += runResult.cost_usd ?? 0;

    const parsed = parseSupplyPlanOutput(runResult.text);
    if (!parsed.ok) {
      planRejections.push(parsed.reasons);
      continue;
    }
    const reasons = [
      ...checkSupplyPlanStructure(parsed.plan, { jyeooBudgetRemaining }),
      ...checkSupplyPlanKnowledgeIds(parsed.plan, liveKnowledgeIds),
    ];
    if (reasons.length === 0) {
      plan = parsed.plan;
      break;
    }
    planRejections.push(reasons);
  }

  return {
    plan,
    rejections: planRejections,
    taskRunIds,
    costUsdTotal,
    attempts,
  };
}
