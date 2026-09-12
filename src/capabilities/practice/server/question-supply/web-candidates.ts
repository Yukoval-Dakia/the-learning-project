// YUK-988 (Supply-Agent/3) — web 候选生产线：从退役 jobs/sourcing.ts 提取的"找 + 判"
// 部分，candidate-only 形态（镜像 jyeoo-candidates.ts）。LLM 判断（SourcingTask：
// 搜索 → 抽取 → 结构化）留在本模块内部；正确性路径（持久化/dedup/verify）全部在上游
// store_sourced_question commit seam。本模块不写 question / verify intent / proposal /
// canary 事件——db 只读（anchor 解析 + 活 knowledge 校验）。
//
// 纯模块纪律（ownership/boundary）：不 import '@/server/'。MCP 挂载 + runAgentTask
// 整个压进单个依赖注入函数 RunWebSourcingAgentFn；真实实现住在 DomainTool
// （server/tools/web-fetch-candidates.ts），executor job 层共享同一实现。SourcingTask
// prompt 契约（trigger/ref/knowledge_context/kinds/objective_only/kind_required）
// 与旧 sourcing.ts 完全一致——SourcingTask TaskSpec 不变。

import { and, eq, inArray, isNull } from 'drizzle-orm';
import type {
  SourcedQuestionT,
  SourcingImageCandidateT,
  SourcingTaskOutputT,
} from '@/core/schema/sourcing';
import { SourcingTaskOutput } from '@/core/schema/sourcing';
import type { Db } from '@/db/client';
import { knowledge } from '@/db/schema';
import type { SubjectProfile } from '@/subjects/profile-schema';
import { kindsMatch } from '@/subjects/question-kind';
import { canonicalQuestionContentHash } from '../quiz/content-fingerprint';

// 旧 sourcing.ts:109 同款常量；source_route / difficulty_evidence 的路由身份。
export const SOURCING_WEB_ROUTE = 'sourcing_web' as const;

// ── 候选形状（与 JyeooCandidate 对齐，web 无 producer 内部 id / 无 hint 通道 / 不暂存资产）──
export interface WebCandidate {
  candidateId: string;
  question: SourcedQuestionT;
  /** `sha256:<canonicalQuestionContentHash(text)>`——与 commit seam 重算值 canonical-相等（dedup key）。 */
  extractionHash: string;
  /** web 无 producer 内部 id（source_url 即身份）→ 恒 null。 */
  sourceId: null;
  knowledgeHints: string[];
  /** web 候选不暂存资产：图片题走 image_candidate proposal 通道（ADR-0002），不入 draft。 */
  stagedAssetIds: string[];
}

export type WebFetchFailureClass =
  | 'anchor_not_found'
  | 'tavily_unavailable'
  | 'llm'
  | 'parse'
  | 'kind_gate'
  | 'knowledge_unresolvable';

export type RunWebFetchCandidatesResult =
  | {
      status: 'ok';
      candidates: WebCandidate[];
      /** 图片型候选——调用方（executor/job）决定写 proposal；本模块只返回。 */
      imageCandidates: SourcingImageCandidateT[];
      queryPlan: SourcingTaskOutputT['query_plan'];
      fetchedAt: string;
      taskRunId: string | null;
      costUsd: number | null;
    }
  | { status: 'failed'; failureClass: WebFetchFailureClass; detail: string };

// ── SourcingTask 输入契约（与旧 sourcing.ts:365-382 逐字段一致） ──────────────
export interface WebSourcingAgentInput {
  subject: string;
  trigger: 'knowledge';
  ref: {
    id: string;
    name: string | null;
    knowledge_node: { id: string; name: string; domain: string | null } | null;
  };
  knowledge_context: Array<{ id: string; name: string; domain: string | null }>;
  count: number;
  whitelist: string[];
  kinds?: string[];
  objective_only?: boolean;
  kind_required?: boolean;
}

/**
 * LLM 相位整体依赖注入：MCP 挂载（domain read tools + Tavily remote）+ runAgentTask
 * 由调用方装配。返回 null 表示 Tavily 不可用（调用方映射为 deterministic skip，
 * 旧 dispatcher 的 tavilyAvailable 闸同款语义——web 路由无 Tavily 即不可执行）。
 */
export type RunWebSourcingAgentFn = (params: {
  db: Db;
  input: WebSourcingAgentInput;
  subjectProfile: SubjectProfile;
  ctx: { taskRunId: string; causedByEventId: string };
}) => Promise<{ text: string; task_run_id?: string | null; cost_usd?: number | null } | null>;

export interface RunWebFetchCandidatesParams {
  db: Db;
  input: {
    /** 需求锚点 KC（executor 的 plan item / dispatcher 的 target anchor）。 */
    anchorKnowledgeId: string;
    /** 参与判题上下文的附加 KC（默认仅锚点）。 */
    knowledgeIds?: string[];
    count: number;
    /** canonical QuestionKind；'any' 由调用方展开为 undefined（自由找题）。 */
    kind?: string;
    objectiveOnly?: boolean;
    kindRequired?: boolean;
    subjectProfile: SubjectProfile;
  };
  ctx?: { taskRunId?: string; causedByEventId?: string };
  deps: RunWebFetchCandidatesDeps;
  now?: Date;
}

// 与旧 sourcing.ts parseOutput（:183-205）同款严格度：宽松提取 + riskyRepair:'reject' +
// schema 校验。sourcing 解析结果直接落库为题面，web 素材 ASCII 标点密度高（jsonrepair
// 静默重划字符串边界的高危形态）——只许内容保真的确定性修复级。
function parseSourcingOutput(text: string, parseLoose: ParseLooseFn): SourcingTaskOutputT {
  let extracted: ReturnType<ParseLooseFn>;
  try {
    extracted = parseLoose(text, 'web-candidates parseOutput', { riskyRepair: 'reject' });
  } catch (e) {
    throw new Error(`web-candidates parseOutput: JSON.parse failed: ${(e as Error).message}`);
  }
  if (extracted === null) {
    throw new Error('web-candidates parseOutput: no JSON object found in text');
  }
  const parsed = SourcingTaskOutput.safeParse(extracted.json);
  if (!parsed.success) {
    throw new Error(
      `web-candidates parseOutput: schema invalid: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    );
  }
  return parsed.data;
}

// parseJsonObjectLoose 的结构化替身（避免 question-supply → @/server/ai 边；工具层注入真身）。
export type ParseLooseFn = (
  text: string,
  label: string,
  opts: { riskyRepair: 'reject' },
) => { json: unknown } | null;

export interface RunWebFetchCandidatesDeps {
  runSourcingAgent: RunWebSourcingAgentFn;
  parseLoose: ParseLooseFn;
}

// 旧 sourcing.ts:174-177 同款白名单读取：profile 字段宽容读取（absent → [] →
// whitelist_match=false 默认，OF-2 语义不变），不做 schema 级强转。
function profileSourceWhitelist(profile: SubjectProfile): string[] {
  const raw = (profile as { sourceWhitelist?: unknown }).sourceWhitelist;
  return Array.isArray(raw) ? raw.filter((d): d is string => typeof d === 'string') : [];
}

export async function runWebFetchCandidates(
  params: RunWebFetchCandidatesParams,
): Promise<RunWebFetchCandidatesResult> {
  const { db, deps } = params;
  const now = params.now ?? new Date();

  // ── 1. anchor 解析（活节点；archived/查无 → deterministic skip，旧 resolveTrigger 同款）──
  const anchorRows = await db
    .select({ id: knowledge.id, name: knowledge.name, domain: knowledge.domain })
    .from(knowledge)
    .where(and(eq(knowledge.id, params.input.anchorKnowledgeId), isNull(knowledge.archived_at)));
  const anchor = anchorRows[0] ?? null;
  if (!anchor) {
    return {
      status: 'failed',
      failureClass: 'anchor_not_found',
      detail: `锚点 knowledge 不存在或已归档: ${params.input.anchorKnowledgeId}`,
    };
  }
  const contextIds = params.input.knowledgeIds ?? [anchor.id];

  // ── 2. SourcingTask 输入（契约与旧 sourcing.ts:365-382 逐字段一致） ────────────
  const whitelist = profileSourceWhitelist(params.input.subjectProfile);
  const input: WebSourcingAgentInput = {
    subject: params.input.subjectProfile.id,
    trigger: 'knowledge',
    ref: { id: anchor.id, name: anchor.name, knowledge_node: anchor },
    knowledge_context: [anchor],
    count: params.input.count,
    whitelist,
    ...(params.input.kind ? { kinds: [params.input.kind] } : {}),
    ...(params.input.objectiveOnly ? { objective_only: true } : {}),
    ...(params.input.kindRequired ? { kind_required: true } : {}),
  };

  // ── 3. LLM 相位（deps；null = Tavily 不可用 → deterministic skip） ──────────────
  const runCtx = {
    taskRunId: params.ctx?.taskRunId ?? `web_fetch_${anchor.id}`,
    causedByEventId: params.ctx?.causedByEventId ?? `web_fetch_trigger_${anchor.id}`,
  };
  const taskResult = await deps.runSourcingAgent({
    db,
    input,
    subjectProfile: params.input.subjectProfile,
    ctx: runCtx,
  });
  if (taskResult === null) {
    return {
      status: 'failed',
      failureClass: 'tavily_unavailable',
      detail: 'Tavily API key 未配置——web 路由不可执行（旧 dispatcher tavilyAvailable 闸同款）',
    };
  }

  // ── 4. parse + kind 门（旧 sourcing.ts:394-405 同款语义） ───────────────────────
  let parsed: SourcingTaskOutputT;
  try {
    parsed = parseSourcingOutput(taskResult.text, deps.parseLoose);
  } catch (e) {
    return { status: 'failed', failureClass: 'parse', detail: (e as Error).message };
  }
  if ((params.input.objectiveOnly || params.input.kindRequired) && params.input.kind) {
    for (const q of parsed.questions) {
      if (!kindsMatch(q.kind, params.input.kind)) {
        return {
          status: 'failed',
          failureClass: 'kind_gate',
          detail: `kind 约束 '${params.input.kind}' 但产出 '${q.kind}'`,
        };
      }
    }
  }

  // ── 5. 活 knowledge 校验（旧 sourcing.ts:411-456 同款：幻觉 id 交集 + 锚点回退） ──
  const referencedIds = [...new Set(parsed.questions.flatMap((q) => q.knowledge_ids))];
  const liveRows = referencedIds.length
    ? await db
        .select({ id: knowledge.id })
        .from(knowledge)
        .where(and(inArray(knowledge.id, referencedIds), isNull(knowledge.archived_at)))
    : [];
  const liveIds = new Set(liveRows.map((r) => r.id));
  const resolvedIds = [anchor.id, ...contextIds.filter((id) => id !== anchor.id)];
  const resolvedLiveRows = resolvedIds.length
    ? await db
        .select({ id: knowledge.id })
        .from(knowledge)
        .where(and(inArray(knowledge.id, resolvedIds), isNull(knowledge.archived_at)))
    : [];
  const liveResolved = new Set(resolvedLiveRows.map((r) => r.id));
  // SQL IN 不保序：knowledge_ids[0] 是主归属锚点，显式恢复 resolver 语义序。
  const fallbackIds = [...new Set(resolvedIds.filter((id) => liveResolved.has(id)))];
  const resolveQuestionKnowledgeIds = (q: SourcedQuestionT): string[] => {
    const valid = q.knowledge_ids.filter((kid) => liveIds.has(kid));
    if (valid.length > 0) return valid;
    if (fallbackIds.length > 0) return fallbackIds;
    throw new Error(
      `question '${q.prompt_md}' references no known knowledge_id (got [${q.knowledge_ids.join(', ')}]) and anchor resolved none`,
    );
  };

  // ── 6. 候选成形（不写库；归属 id 已活校验，commit seam 的 dedup/verify 接管正确性） ──
  const candidates: WebCandidate[] = [];
  for (const q of parsed.questions) {
    let knowledgeIds: string[];
    try {
      knowledgeIds = resolveQuestionKnowledgeIds(q);
    } catch (e) {
      return {
        status: 'failed',
        failureClass: 'knowledge_unresolvable',
        detail: (e as Error).message,
      };
    }
    candidates.push({
      candidateId: `webcand_${anchor.id}_${candidates.length + 1}`,
      question: { ...q, knowledge_ids: knowledgeIds },
      extractionHash: `sha256:${canonicalQuestionContentHash({
        promptMd: q.prompt_md,
        referenceMd: q.reference_md,
        choicesMd: q.choices_md,
        rubricJson: q.rubric_json,
      })}`,
      sourceId: null,
      knowledgeHints: [],
      stagedAssetIds: [],
    });
  }

  return {
    status: 'ok',
    candidates,
    imageCandidates: parsed.image_candidates ?? [],
    queryPlan: parsed.query_plan,
    fetchedAt: now.toISOString(),
    taskRunId: taskResult.task_run_id ?? null,
    costUsd: taskResult.cost_usd ?? null,
  };
}
