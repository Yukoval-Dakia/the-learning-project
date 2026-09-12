// YUK-988 (Supply-Agent/3) — `web_fetch_candidates` DomainTool（effect:'read'）。
//
// 供给 agent 化的 web 搜寻面：runWebFetchCandidates 核（question-supply/
// web-candidates.ts，从退役 jobs/sourcing.ts 提取的"找 + 判"部分）跑一次
// SourcingTask（Tavily 检索 → 抽取 → 结构化），返回【候选】——不写 question、不写
// verify intent、不写 proposal（图片型候选原样返回，由调用方决定 propose）；提交入库
// 走 `store_sourced_question`（dedup/verify 链权威判定在那侧）。
//
// effect 判 'read' 的理由（jyeoo_fetch_candidates 同款论证）：唯一的持久写是 canary
// 事件（观测面，非 learner/domain 数据）；question 写入只发生在 store_sourced_question
// （effect:'write'）。costClass 'expensive_llm'：本工具承载完整 SourcingTask agent 循环
// （多轮 tool-call + Tavily 检索/抽取），真实 LLM + 检索开销。
//
// Canary：每次运行（含失败）写 action='experimental:web_fetch_candidates' 事件一次——
// 漏斗观测面（anchor → 候选 → 下游 commit/verify）；绝不双写（预算账本按 canary 事件
// 求和的契约与 jyeoo 面一致）。subject 由锚点 KC 的 domain 服务端解析（resolveSubjectProfile），
// 不信任调用方声明。

import { createId } from '@paralleldrive/cuid2';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { SourcedQuestion, SourcingImageCandidate } from '@/core/schema/sourcing';
import { knowledge } from '@/db/schema';
import { costUsdToMicroUsd } from '@/kernel/cost';
import { writeEvent } from '@/kernel/events';
import {
  DOMAIN_TOOL_MCP_SERVER_NAME,
  type DomainToolName,
  toMcpAllowedToolName,
} from '@/kernel/tools/allowlists';
import type { DomainTool, ToolContext } from '@/kernel/tools/types';
import { parseJsonObjectLoose } from '@/server/ai/json-extract';
import {
  TAVILY_MCP_ALLOWED_TOOLS,
  TAVILY_MCP_SERVER_NAME,
  buildTavilyMcpServer,
} from '@/server/ai/mcp/tavily';
import { runAgentTask } from '@/server/ai/runner';
import { buildMcpServerFromRegistry } from '@/server/ai/tools/mcp-bridge';
import { resolveSubjectProfile } from '@/subjects/profile';
import {
  type ParseLooseFn,
  type RunWebFetchCandidatesResult,
  type RunWebSourcingAgentFn,
  runWebFetchCandidates,
} from '../question-supply/web-candidates';

// SourcingTask 挂载的 read-only domain-tool 面——从 jobs/sourcing.ts SOURCING_READ_TOOLS
// 逐字拷贝（退役 monolith 不许从 tool 层 import；两边保持同步直至该 job 退役）。
const SOURCING_READ_TOOLS = [
  'query_knowledge',
  'get_subject_graph_overview',
  'expand_knowledge_subgraph',
  'find_knowledge_paths',
] as const satisfies readonly DomainToolName[];

// Canary action = 漏斗观测面（单写/次，含失败）。
const WEB_FETCH_CANARY_ACTION = 'experimental:web_fetch_candidates' as const;

/**
 * RunWebSourcingAgentFn 的真身：MCP 挂载（domain read tools + Tavily remote）+
 * runAgentTask('SourcingTask')。Tavily key 缺失时返回 null——核映射为
 * failureClass 'tavily_unavailable'（旧 dispatcher tavilyAvailable 闸同款语义）。
 * executor job 层共享同一实现。
 */
export const runWebSourcingAgentDefault: RunWebSourcingAgentFn = async (params) => {
  const { db, input, subjectProfile, ctx } = params;

  // web 路由无 Tavily 即不可执行——先闸，避免无谓挂载 domain server。
  const tavilyCfg = buildTavilyMcpServer();
  if (tavilyCfg === null) return null;

  // MCP mount 镜像 jobs/sourcing.ts:342-363：in-process domain read tools（ctx 归因到
  // 调用方透传的 run 上下文，callerActor='sourcing' 与旧 job 一致）+ Tavily remote。
  const domainMcpServer = buildMcpServerFromRegistry({
    ctx: {
      db,
      taskRunId: ctx.taskRunId,
      callerActor: { kind: 'agent', ref: 'sourcing' },
      causedByEventId: ctx.causedByEventId,
    },
    serverName: DOMAIN_TOOL_MCP_SERVER_NAME,
    toolNames: SOURCING_READ_TOOLS,
    taskKind: 'SourcingTask',
  });

  const mcpServers = {
    [DOMAIN_TOOL_MCP_SERVER_NAME]: domainMcpServer,
    [TAVILY_MCP_SERVER_NAME]: tavilyCfg,
  };
  const allowedTools = [
    ...SOURCING_READ_TOOLS.map((name) => toMcpAllowedToolName(name)),
    ...TAVILY_MCP_ALLOWED_TOOLS,
  ];

  const result = await runAgentTask('SourcingTask', input, {
    db,
    mcpServers,
    allowedTools,
    subjectProfile,
  });
  return { text: result.text, task_run_id: result.task_run_id, cost_usd: result.cost_usd };
};

const inputSchema = z.object({
  /** 需求锚点 KC（executor 的 plan item / dispatcher 的 target anchor）；subject 由其 domain 服务端解析。 */
  anchor_knowledge_id: z.string().trim().min(1),
  /** 参与判题上下文的附加 KC（默认仅锚点）。 */
  knowledge_ids: z.array(z.string().trim().min(1)).optional(),
  /** 本次候选数量（SourcingTask count 同界 1..10）。 */
  count: z.number().int().min(1).max(10),
  /** 可选 kind pin（canonical QuestionKind；作为 kinds 单元素列表下传，同旧 sourcing job）。 */
  kind: z.string().trim().min(1).optional(),
  objective_only: z.boolean().optional(),
  kind_required: z.boolean().optional(),
});

const candidateSchema = z.object({
  candidate_id: z.string(),
  question: SourcedQuestion,
  extraction_hash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  source_id: z.string().nullable(),
  knowledge_hints: z.array(z.string()),
  staged_asset_ids: z.array(z.string()),
});

const outputSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    candidates: z.array(candidateSchema),
    image_candidates: z.array(SourcingImageCandidate),
    query_plan: z.array(z.string()),
    fetched_at: z.string(),
    task_run_id: z.string().nullable(),
    cost_usd: z.number().nullable(),
  }),
  z.object({
    status: z.literal('failed'),
    failure_class: z.enum([
      'anchor_not_found',
      'tavily_unavailable',
      'llm',
      'parse',
      'kind_gate',
      'knowledge_unresolvable',
    ]),
    detail: z.string(),
  }),
]);

type Input = z.infer<typeof inputSchema>;
type Output = z.infer<typeof outputSchema>;

function toOutput(result: RunWebFetchCandidatesResult): Output {
  if (result.status === 'failed') {
    return { status: 'failed', failure_class: result.failureClass, detail: result.detail };
  }
  return {
    status: 'ok',
    candidates: result.candidates.map((candidate) => ({
      candidate_id: candidate.candidateId,
      question: candidate.question,
      extraction_hash: candidate.extractionHash,
      source_id: candidate.sourceId,
      knowledge_hints: candidate.knowledgeHints,
      staged_asset_ids: candidate.stagedAssetIds,
    })),
    image_candidates: result.imageCandidates,
    query_plan: result.queryPlan,
    fetched_at: result.fetchedAt,
    task_run_id: result.taskRunId,
    cost_usd: result.costUsd,
  };
}

export interface WebFetchCandidatesDeps {
  runSourcingAgent?: RunWebSourcingAgentFn;
  parseLoose?: ParseLooseFn;
}

/**
 * Tool 执行核（依赖可注入——db 测试直接调它；DomainTool.execute 走默认依赖）。
 * 软失败（failed:*）返回有效 Output；未预期异常抛出（MCP bridge 按硬失败处理）。
 */
export async function executeWebFetchCandidates(
  ctx: Pick<ToolContext, 'db' | 'sessionId' | 'taskRunId' | 'causedByEventId'>,
  input: Input,
  deps: WebFetchCandidatesDeps = {},
): Promise<Output> {
  const runSourcingAgent = deps.runSourcingAgent ?? runWebSourcingAgentDefault;
  const parseLoose: ParseLooseFn = deps.parseLoose ?? parseJsonObjectLoose;

  // subject 服务端解析：读锚点 knowledge 节点（与核相同谓词——活节点）→ domain →
  // profile（驱动 SourcingTask prompt 声部与 whitelist）。查无/归档不在此短路——
  // 核的 anchor_not_found 是唯一失败真相源。
  const anchorRows = await ctx.db
    .select({ id: knowledge.id, name: knowledge.name, domain: knowledge.domain })
    .from(knowledge)
    .where(and(eq(knowledge.id, input.anchor_knowledge_id), isNull(knowledge.archived_at)));
  const subjectProfile = resolveSubjectProfile(anchorRows[0]?.domain ?? null);

  const result = await runWebFetchCandidates({
    db: ctx.db,
    input: {
      anchorKnowledgeId: input.anchor_knowledge_id,
      ...(input.knowledge_ids ? { knowledgeIds: input.knowledge_ids } : {}),
      count: input.count,
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.objective_only ? { objectiveOnly: true } : {}),
      ...(input.kind_required ? { kindRequired: true } : {}),
      subjectProfile,
    },
    ctx: {
      taskRunId: ctx.taskRunId,
      ...(ctx.causedByEventId ? { causedByEventId: ctx.causedByEventId } : {}),
    },
    deps: { runSourcingAgent, parseLoose },
  });

  // Canary 事件 = 漏斗观测面（单写/次，含失败）。事件写失败不得翻转工具结果
  // （jyeoo_fetch_candidates 同款 try/catch）。
  try {
    await writeEvent(ctx.db, {
      id: createId(),
      session_id: ctx.sessionId ?? null,
      actor_kind: 'agent',
      actor_ref: 'sourcing',
      action: WEB_FETCH_CANARY_ACTION,
      subject_kind: 'query',
      subject_id:
        result.status === 'ok'
          ? (result.taskRunId ?? `web_fetch_${createId()}`)
          : `web_fetch_candidates_${createId()}`,
      outcome: result.status === 'failed' ? 'failure' : 'success',
      payload: {
        ...input,
        tool: 'web_fetch_candidates',
        task_run_id: ctx.taskRunId,
        ...(result.status === 'ok'
          ? {
              candidate_ids: result.candidates.map((candidate) => candidate.candidateId),
              image_candidate_count: result.imageCandidates.length,
              query_plan: result.queryPlan,
              cost_usd: result.costUsd,
            }
          : {
              failure_class: result.failureClass,
              failure_detail: result.detail,
            }),
      },
      caused_by_event_id: ctx.causedByEventId ?? null,
      task_run_id: ctx.taskRunId,
      cost_micro_usd: costUsdToMicroUsd(result.status === 'ok' ? result.costUsd : null),
      created_at: new Date(),
    });
  } catch (eventErr) {
    console.error('[web_fetch_candidates] canary event write failed; result stands:', eventErr);
  }

  return toOutput(result);
}

export const webFetchCandidatesTool: DomainTool<Input, Output> = {
  name: 'web_fetch_candidates',
  description:
    '经 Tavily web 检索 + SourcingTask 抽取，围绕锚点知识点产出真实考题候选（不写库）。' +
    '返回候选（含 dedup hash）与图片型候选；提交入库须调 store_sourced_question。' +
    'tavily_unavailable 表示 web 路由未配置检索后端；failed 按 failure_class 决定是否重试。',
  effect: 'read',
  inputSchema,
  outputSchema,
  costClass: 'expensive_llm',
  // 无 safeHandoff：canary 事件是 db 写，registry 只允许 idempotent read 远程 handoff——
  // 本工具固定 in-process 执行（与 jyeoo_fetch_candidates 同款约束）。
  mirrorEvent: 'when_causal',
  async execute(ctx, input) {
    return executeWebFetchCandidates(ctx, input);
  },
  summarize(input, output) {
    if (output.status === 'failed') {
      return `web 候选失败 · ${output.failure_class}`;
    }
    return `web 候选 ${output.candidates.length}/${input.count} · 图候选 ${output.image_candidates.length}`;
  },
};
