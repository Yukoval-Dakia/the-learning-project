// YUK-988 (Supply-Agent/3) — `web_fetch_candidates` DomainTool（effect:'read'）。
//
// 供给 agent 化的 web 搜寻面：runWebFetchCandidates 核（question-supply/
// web-candidates.ts，从退役 jobs/sourcing.ts 提取的"找 + 判"部分）跑一次
// SourcingTask（Exa 检索 → 抽取 → 结构化），返回【候选】——不写 question、不写
// verify intent、不写 proposal（图片型候选原样返回，由调用方决定 propose）；提交入库
// 走 `store_sourced_question`（dedup/verify 链权威判定在那侧）。
//
// effect 判 'read' 的理由（jyeoo_fetch_candidates 同款论证）：唯一的持久写是 canary
// 事件（观测面，非 learner/domain 数据）；question 写入只发生在 store_sourced_question
// （effect:'write'）。costClass 'expensive_llm'：本工具承载完整 SourcingTask agent 循环
// （多轮 tool-call + Exa 检索/抽取），真实 LLM + 检索开销。
//
// Canary：每次运行（含失败）写 action='experimental:web_fetch_candidates' 事件一次——
// 漏斗观测面（anchor → 候选 → 下游 commit/verify）；绝不双写（预算账本按 canary 事件
// 求和的契约与 jyeoo 面一致）。subject 由锚点 KC 的 domain 服务端解析（resolveSubjectProfile），
// 不信任调用方声明。

import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { SourcedQuestion, SourcingImageCandidate } from '@/core/schema/sourcing';
import { knowledge } from '@/db/schema';
import type { DomainTool, ToolContext } from '@/kernel/tools/types';
import { resolveSubjectProfile } from '@/subjects/profile';
import {
  type ParseLooseFn,
  type RunWebFetchCandidatesResult,
  type RunWebSourcingAgentFn,
  runWebFetchCandidates,
} from '../question-supply/web-candidates';
import { defaultWebSourcingDeps, runWebSourcingOperation } from '../web-sourcing-operation';

/**
 * 兼容导出（YUK-1570）：RunWebSourcingAgentFn 的真身已下沉到
 * ../web-sourcing-operation.ts（Exa 闸 + domain/Exa 双 mount + SourcingTask
 * 运行 + 结果收窄的完整操作）；本别名保持旧 import 路径可用。
 */
export const runWebSourcingAgentDefault: RunWebSourcingAgentFn = runWebSourcingOperation;

const inputSchema = z.object({
  /** 需求锚点 KC（executor 的 plan item / dispatcher 的 target anchor）；subject 由其 domain 服务端解析。 */
  anchor_knowledge_id: z.string().trim().min(1),
  /** 参与判题上下文的附加 KC（默认仅锚点）。 */
  knowledge_ids: z.array(z.string().trim().min(1)).optional(),
  /** 本次候选数量（SourcingTask count 同界 1..10）。 */
  count: z.number().int().min(1).max(10),
  /** 可选 kind pin（自由文本题面标签，YUK-386；作为 kinds 单元素列表下传，同旧 sourcing job）。 */
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
      'web_search_unavailable',
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
  // 生产默认依赖来自 defaultWebSourcingDeps() 唯一组装点；逐字段注入 seam 不变。
  const productionDeps = defaultWebSourcingDeps();
  const runSourcingAgent = deps.runSourcingAgent ?? productionDeps.runSourcingAgent;
  const parseLoose: ParseLooseFn = deps.parseLoose ?? productionDeps.parseLoose;

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
    // Canary 由核单写（见模块头）——本层透传归因 ctx，保证 agent 调用与 executor 直调核
    // 产生同一条 canary（含 session/task/causal 归因）。
    ctx: {
      taskRunId: ctx.taskRunId,
      ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
      ...(ctx.causedByEventId ? { causedByEventId: ctx.causedByEventId } : {}),
    },
    deps: { runSourcingAgent, parseLoose },
  });

  return toOutput(result);
}

export const webFetchCandidatesTool: DomainTool<Input, Output> = {
  name: 'web_fetch_candidates',
  description:
    '经 Exa web 检索 + SourcingTask 抽取，围绕锚点知识点产出真实考题候选（不写库）。' +
    '返回候选（含 dedup hash）与图片型候选；提交入库须调 submit_question。' +
    'web_search_unavailable 表示 web 路由未配置检索后端；failed 按 failure_class 决定是否重试。',
  effect: 'read',
  inputSchema,
  outputSchema,
  costClass: 'expensive_llm',
  // 无 safeHandoff：核内 canary 事件是 db 写，registry 只允许 idempotent read 远程 handoff——
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
