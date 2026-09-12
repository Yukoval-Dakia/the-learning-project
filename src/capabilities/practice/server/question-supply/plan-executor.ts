// YUK-988 (Supply-Agent/3) — SupplyPlan 确定性执行核（E3 Slice 3）。
//
// 把 planner 落地的 SupplyPlan items（experimental:supply_planner 事件 + 逐项
// experimental:supply_planner_demand）沿 route_preference 顺序转成真实获取动作：
//
//   - jyeoo_fetch → runJyeooFetchCandidates（预算租约 + 批量吸收）+ 逐候选 commit；
//   - sourcing_web → 注入的 runWebFetchCandidates（web 候选生产线，LLM 相位在工具层）
//     + 逐候选 commit；imageCandidates 经注入的 proposal writer 落 image_candidate；
//   - quiz_gen → enqueueQuizGen（quiz_gen 队列原生 job；异步经自身 verify 链闭环，
//     诚实语义：dispatched ≠ acquired，生成内容保留自身 provenance 族）。
//
// 一切 commit 经 store_sourced_question seam（dedup/活体校验/verify 链权威在那侧）；
// 本模块只做路由决策、归属解析（jyeoo hints → 知识树精确名匹配 / web 锚点前置）与
// 单次完成事件（experimental:supply_executor，#598 canary 单写规则）。
//
// 幂等（YUK-988 Oracle P1-1）：执行前查同 plan_event_id 的 executor 完成事件 →
// already_executed 全量短路；每个 item 完成即写 experimental:supply_executor_item
// 增量事件，崩溃重跑按 demand_id 跳过已完成 item（resume 语义——重跑只补 undone
// item，单 item 内的副作用窗口收敛到该 item）；quiz_gen 派发带 singletonKey
// （plan_event_id + demand_id 派生）封崩溃窗口内的重复入队。store seam 的
// duplicate_exact 仍是数据面兜底。plan_event_id null（scanner/手动）无幂等事件，
// 沿用只靠 store seam 去重的旧语义。
//
// 纯模块纪律（ownership/boundary，镜像 web-candidates.ts）：不 import '@/server/'。
// 外部效果（web LLM 相位、pg-boss enqueue、image proposal 写）全部依赖注入；
// '../tools/store-sourced-question' 是 capability 内兄弟 seam（tools 层持 server 依赖）。

import { createId } from '@paralleldrive/cuid2';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { event, knowledge } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import type { QuizGenJobData } from '@/kernel/quiz-gen-contract';
import { resolveSubjectProfile } from '@/subjects/profile';
import type { SubjectProfile } from '@/subjects/profile-schema';
import {
  type StoreSourcedQuestionDeps,
  executeStoreSourcedQuestion,
} from '../tools/store-sourced-question';
import { SupplyTraceV1, type SupplyTraceV1T } from './evidence-demand';
import { jyeooBudgetRemaining } from './jyeoo-budget';
import {
  type JyeooCandidate,
  type JyeooFetchCandidatesResult,
  type JyeooGrade,
  runJyeooFetchCandidates,
} from './jyeoo-candidates';
import { findSubjectRootKnowledgeId, matchJyeooKnowledgeHints } from './jyeoo-hint-match';
import type { DifficultyBand } from './target-discovery';
import type {
  RunWebFetchCandidatesParams,
  RunWebFetchCandidatesResult,
  WebCandidate,
} from './web-candidates';

/** executor 可执行的获取路由（SupplyPlanV1.route_preference 的可执行子集）。 */
export type SupplyRouteName = 'jyeoo_fetch' | 'sourcing_web' | 'quiz_gen';

export const SUPPLY_EXECUTOR_ROUTES: readonly SupplyRouteName[] = [
  'jyeoo_fetch',
  'sourcing_web',
  'quiz_gen',
];

const DIFFICULTY_BANDS: ReadonlySet<string> = new Set(['below', 'near', 'above', 'stretch']);

/** jyeoo 单次抓取的 sessionMax 上界（spec：min(count*2, 预算余额, 8)）。 */
const JYEOO_SESSION_MAX_CAP = 8;

/** planner → executor 的需求项（SupplyPlanItemV1 的执行投影；kind 'any' = 无题型约束）。 */
export interface SupplyDemandItem {
  demandId: string;
  knowledgeId: string;
  /** canonical QuestionKind 或 'any'（透传为无约束）。 */
  kind: string;
  /** 'below' | 'near' | 'above' | 'stretch'（仅 jyeoo post-filter 消费；null = 不过滤）。 */
  difficultyBand: string | null;
  count: number;
  routePreference: readonly SupplyRouteName[];
  placementClaimId?: string;
  /** 目标题型约束传递（镜像旧 SourcingJobData 的 objective_only/kind_required；scanner 派发面保留行为等价）。 */
  objectiveOnly?: boolean;
  kindRequired?: boolean;
}

/**
 * quiz_gen 派发 payload —— 镜像 dispatcher.ts 构建 quiz_gen job data 的字段族
 * （src/capabilities/practice/server/question-supply/dispatcher.ts:328-364）：anchor
 * knowledge（ref_id/knowledge_id）、count/exact_count、kind、placement 字段。
 * generation_method / semantic_goal_revision_id / supply_trace 是可选项，plan item
 * 不携带这些信号，故省略（quiz_gen agent 自由选择生成方法）。
 */
export type QuizGenDispatchPayload = QuizGenJobData;

/** web 候选生产线注入面（LLM 相位整体在工具层装配，见 web-candidates.ts 头注释）。 */
export type RunWebFetchCandidatesFn = (
  params: Omit<RunWebFetchCandidatesParams, 'deps'>,
) => Promise<RunWebFetchCandidatesResult>;

/** jyeoo 抓取注入面（默认 = 兄弟模块真身；db 测试注入 fake）。 */
export type RunJyeooFetchCandidatesFn = (
  params: Parameters<typeof runJyeooFetchCandidates>[0],
) => Promise<JyeooFetchCandidatesResult>;

/**
 * image_candidate proposal 写入注入面 —— 参数镜像旧 sourcing job 的
 * writeAiProposal 调用（jobs/sourcing.ts:631-668）：pending inbox 语义
 * （outcome 'partial'）、ADR-0002（accept 才下载/抽图）、cooldown_key 防重复
 * proposal。db 参数不进 args（db 由 executor 闭包持有者自取）。
 */
export interface ImageCandidateProposalArgs {
  actor_ref: string;
  outcome: 'partial';
  payload: {
    kind: 'image_candidate';
    target: { subject_kind: 'source_asset'; subject_id: null };
    reason_md: string;
    evidence_refs: [];
    proposed_change: {
      source_url: string;
      source_title: string;
      summary_md: string;
      knowledge_ids: string[];
      requested_kind?: string;
    };
    cooldown_key: string;
  };
  task_run_id: string | null;
  created_at: Date;
}

/** quiz_gen 派发的可选 enqueue 选项（P1-1：崩溃窗口幂等键透传到 pg-boss）。 */
export interface EnqueueQuizGenDispatchOptions {
  /** pg-boss 单例键——同 (plan_event_id, demand_id) 重投不重复入队（由 runQuizGenRoute 派生）。 */
  singletonKey?: string;
}

export interface ExecuteSupplyPlanDeps {
  /** web 候选生产线（必填注入——真身在 tools/web-fetch-candidates.ts 装配）。 */
  runWebFetchCandidates: RunWebFetchCandidatesFn;
  /** jyeoo 抓取核（缺省 = 兄弟模块真身）。 */
  runJyeooFetchCandidates?: RunJyeooFetchCandidatesFn;
  /** quiz_gen 队列 enqueue（失败抛出——pg-boss 语义保留，不让 executor 吞掉）。 */
  enqueueQuizGen: (
    payload: QuizGenDispatchPayload,
    opts?: EnqueueQuizGenDispatchOptions,
  ) => Promise<string | undefined>;
  /** image_candidate proposal 写入；提供时 web imageCandidates 落 proposal（旧 sourcing 行为）。 */
  writeImageCandidateProposal?: (args: ImageCandidateProposalArgs) => Promise<unknown>;
  /** store seam 的 verify enqueue 注入口（生产缺省 = seam 自身默认 pg-boss；db 测试注入 fake）。 */
  enqueueSourceVerify?: StoreSourcedQuestionDeps['enqueueSourceVerify'];
  now?: () => Date;
}

/** jyeoo grade 路线抓取配置（producer --grade/--subjects；缺省时 jyeoo 路由确定性跳过）。 */
export interface JyeooFetchConfig {
  grade: JyeooGrade;
  /** producer 学科 id（默认 math2——当前唯一注册 producer 学科，工具默认一致）。 */
  subject?: string;
  /** 发现侧列表页数（免费；默认 2，工具默认一致）。 */
  pages?: number;
  /** 发现侧试卷上限（免费；默认 2，工具默认一致）。 */
  maxPapers?: number;
}

export interface ExecuteSupplyPlanParams {
  db: Db;
  /** planner 事件 id（幂等键；null = 幂等短路不可用，仅用于手动/测试直调）。 */
  planEventId: string | null;
  items: SupplyDemandItem[];
  /** store seam / 事件留痕的运行上下文；taskRunId 缺省生成。 */
  ctx?: { taskRunId?: string; causedByEventId?: string | null };
  /** jyeoo 抓取配置；未提供时 jyeoo_fetch 路由记 skipped:'jyeoo_unconfigured'。 */
  jyeooFetch?: JyeooFetchConfig;
  /** 按有效 domain 注入 subject profile（缓存/覆写）；缺省 resolveSubjectProfile(domain)。 */
  subjectProfileByDomain?: Map<string, SubjectProfile>;
  /** 供应链路（scanner 派发面携带）——透传进 sourced 路由的每个 store commit，保 placement/缺口溯源。 */
  supplyTrace?: SupplyTraceV1T;
}

export interface RouteExecutionTally {
  route: string;
  status: 'ok' | 'dispatched' | 'skipped';
  acquired: number;
  committed: number;
  opportunistic: number;
  /** status='skipped' 时的确定性原因（jyeoo_budget / failureClass / llm / spawn / route_not_executable…）。 */
  skipped?: string;
  /** skipped 原因的补充说明（未预期异常 message / supply_trace 丢弃备注）。 */
  detail?: string;
  /** per-candidate store 拒绝计数（reason→count：duplicate_exact / near_dup / dead_knowledge_node / foreign_host）。 */
  rejections: Record<string, number>;
  /** per-candidate store commit 未预期异常计数（软失败，不中断路由）。 */
  errors: number;
  /** jyeoo 候选因 hints 与科目根都解析不出归属而被放弃提交的数量（观测）。 */
  unattributable?: number;
  /** status='dispatched' 时的 pg-boss job id。 */
  job_id?: string;
}

export interface ItemExecutionResult {
  demandId: string;
  knowledgeId: string;
  routes: RouteExecutionTally[];
  acquired: number;
  committed: number;
  opportunistic: number;
  /** item 级确定性跳过（锚点死亡 / 空路由偏好）——routes 为空或未执行任何获取。 */
  skipped?: string;
}

export type ExecuteSupplyPlanResult =
  | {
      status: 'executed';
      eventId: string;
      results: ItemExecutionResult[];
      totals: {
        items: number;
        acquired: number;
        committed: number;
        opportunistic: number;
        dispatched: number;
      };
    }
  | { status: 'already_executed'; priorEventId: string };

export const SUPPLY_EXECUTOR_EVENT_ACTION = 'experimental:supply_executor';

/** P1-1 逐 item 增量完成事件：崩溃重跑的 resume 凭证（demand_id 粒度幂等）。 */
export const SUPPLY_EXECUTOR_ITEM_EVENT_ACTION = 'experimental:supply_executor_item';

// ── 锚点解析（镜像 supply_planner.loadLiveKnowledge 的 parent 链有效 domain 求解） ──

interface LiveKnowledgeRow {
  id: string;
  name: string;
  domain: string | null;
  parentId: string | null;
}

async function loadLiveKnowledgeTree(db: Db): Promise<Map<string, LiveKnowledgeRow>> {
  const rows = await db
    .select({
      id: knowledge.id,
      name: knowledge.name,
      domain: knowledge.domain,
      parentId: knowledge.parent_id,
    })
    .from(knowledge)
    .where(isNull(knowledge.archived_at));
  return new Map(rows.map((row) => [row.id, row]));
}

/** 有效 domain：子节点 domain=null 沿 parent 链上溯（环防御 64 层，planner 同款）。 */
function effectiveDomain(
  tree: Map<string, LiveKnowledgeRow>,
  id: string,
): { domain: string | null; reachable: boolean } {
  let cur = tree.get(id);
  for (let depth = 0; depth < 64 && cur; depth += 1) {
    if (cur.domain !== null) return { domain: cur.domain, reachable: true };
    if (cur.parentId === null) return { domain: null, reachable: true };
    cur = tree.get(cur.parentId);
  }
  return { domain: null, reachable: false };
}

// ── 幂等探针（不新建表：executor 自己的完成事件即凭证，dispatcher cooldown 同款手法） ──

async function priorExecutorEvent(db: Db, planEventId: string): Promise<string | null> {
  const rows = await db
    .select({ id: event.id })
    .from(event)
    .where(
      and(
        eq(event.action, SUPPLY_EXECUTOR_EVENT_ACTION),
        sql`${event.payload}->>'plan_event_id' = ${planEventId}`,
      ),
    )
    .limit(1);
  return rows[0]?.id ?? null;
}

/**
 * P1-1 resume 探针：同 plan_event_id 下已有增量完成事件的 demand_id 集合——崩溃
 * 重跑只补 undone item（上次运行死在完成事件之前时，逐 item 事件仍在）。
 */
async function priorItemDemandIds(db: Db, planEventId: string): Promise<Set<string>> {
  const rows = await db
    .select({ demandId: sql<string | null>`${event.payload}->>'demand_id'` })
    .from(event)
    .where(
      and(
        eq(event.action, SUPPLY_EXECUTOR_ITEM_EVENT_ACTION),
        sql`${event.payload}->>'plan_event_id' = ${planEventId}`,
      ),
    );
  return new Set(rows.map((row) => row.demandId).filter((id): id is string => id !== null));
}

// ── commit seam 适配（JyeooCandidate / WebCandidate → store Input 的 snake_case） ──

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * P1-2：supply_trace 的路由级克隆——顶层 trace 的 producer_route 覆写为实际执行的
 * 路由（fallback 路由不得继承 planner 标注的 producer_route）。caller 侧 trace 是
 * job payload z.unknown() 的未校验透传，覆写后必须 safeParse 复验：失败返回 null
 * （caller 丢弃 trace 并在 tally.detail 留痕，绝不盲 cast）；无 trace 返回 undefined。
 */
function cloneSupplyTraceForRoute(
  trace: SupplyTraceV1T | undefined,
  producerRoute: 'jyeoo_fetch' | 'sourcing_web',
): SupplyTraceV1T | null | undefined {
  if (trace === undefined) return undefined;
  const parsed = SupplyTraceV1.safeParse({ ...trace, producer_route: producerRoute });
  return parsed.success ? parsed.data : null;
}

type StoreCandidateInput = Parameters<typeof executeStoreSourcedQuestion>[1]['candidate'];

function jyeooCandidateToStoreInput(candidate: JyeooCandidate): StoreCandidateInput {
  return {
    candidate_id: candidate.candidateId,
    question: candidate.question,
    extraction_hash: candidate.extractionHash,
    knowledge_hints: candidate.knowledgeHints,
    source_id: candidate.sourceId,
    figures: candidate.figures,
    image_refs: candidate.imageRefs,
    structured: candidate.structured,
    staged_asset_ids: candidate.stagedAssetIds,
  };
}

function webCandidateToStoreInput(candidate: WebCandidate): StoreCandidateInput {
  return {
    candidate_id: candidate.candidateId,
    question: candidate.question,
    extraction_hash: candidate.extractionHash,
    knowledge_hints: candidate.knowledgeHints,
    source_id: candidate.sourceId,
    figures: null,
    image_refs: null,
    structured: null,
    staged_asset_ids: candidate.stagedAssetIds,
  };
}

/** commit 单候选的判别结果（P1-5：per-candidate 轨迹不再坍缩为 null）。 */
export type CommitCandidateResult =
  | { status: 'inserted'; questionId: string }
  | {
      status: 'rejected';
      /** store seam 的拒绝 reason 原样透传（outputSchema 的四值枚举）。 */
      reason: 'dead_knowledge_node' | 'duplicate_exact' | 'near_dup' | 'foreign_host';
    }
  | { status: 'threw'; detail: string };

/**
 * 单候选 commit。软拒绝返回 rejected（store seam 的 reason 透传）；未预期异常捕获为
 * threw（per-candidate 失败不上抛——路由失败与单候选失败都不得中断其余 item；store
 * 抛错时 staged 资产由其自身 cleanup + reaper 兜底）。成功返回 inserted + questionId。
 */
async function commitCandidate(
  db: Db,
  ctx: { taskRunId: string; causedByEventId: string | null },
  input: Parameters<typeof executeStoreSourcedQuestion>[1],
  storeDeps: StoreSourcedQuestionDeps = {},
): Promise<CommitCandidateResult> {
  try {
    const output = await executeStoreSourcedQuestion(
      {
        db,
        taskRunId: ctx.taskRunId,
        ...(ctx.causedByEventId !== null ? { causedByEventId: ctx.causedByEventId } : {}),
      },
      input,
      storeDeps,
    );
    return output.status === 'inserted'
      ? { status: 'inserted', questionId: output.question_id }
      : { status: 'rejected', reason: output.reason };
  } catch (err) {
    console.error('[supply_executor] store commit threw; candidate dropped:', err);
    return { status: 'threw', detail: errorMessage(err) };
  }
}

/** P1-5：路由 tally 的 per-candidate 拒绝计数（reason→count）。 */
function recordRejection(tally: RouteExecutionTally, reason: string): void {
  tally.rejections[reason] = (tally.rejections[reason] ?? 0) + 1;
}

// ── 路由执行 ─────────────────────────────────────────────────────────────────

interface RouteRunContext {
  db: Db;
  item: SupplyDemandItem;
  /** 锚点有效 domain（jyeoo hint 匹配作用域 + subject 解析键）。 */
  domain: string | null;
  subjectProfile: SubjectProfile;
  taskRunId: string;
  causedByEventId: string | null;
  /** planner 事件 id（P1-1：quiz_gen singletonKey 派生键；null = scanner/手动）。 */
  planEventId: string | null;
  now: Date;
  /** 供应链路（可选）——透传进 sourced 路由 store commit（P1-2：路由级克隆后使用）。 */
  supplyTrace?: SupplyTraceV1T;
  /** 还需获取的数量（执行中递减）。 */
  remaining: number;
}

/**
 * jyeoo_fetch：预算 pre-flight → 一次有界抓取 → 全候选逐个 commit。anchor 命中
 * （解析出的 knowledge_ids 含 item.knowledgeId）计入 acquired；其余是 opportunistic
 * （仍 commit——批量库存吸收，预算最大化）。归属：hints 精确名匹配（matched）→
 * 科目根兜底（coarse）→ 都失败则放弃该候选（unattributable）。
 */
async function runJyeooRoute(
  run: RouteRunContext,
  deps: ExecuteSupplyPlanDeps,
  config: JyeooFetchConfig | undefined,
): Promise<RouteExecutionTally> {
  const tally: RouteExecutionTally = {
    route: 'jyeoo_fetch',
    status: 'skipped',
    acquired: 0,
    committed: 0,
    opportunistic: 0,
    rejections: {},
    errors: 0,
  };
  if (!config) {
    tally.skipped = 'jyeoo_unconfigured';
    return tally;
  }

  const budgetRemaining = await jyeooBudgetRemaining(run.db, run.now);
  if (budgetRemaining <= 0) {
    tally.skipped = 'jyeoo_budget';
    return tally;
  }

  const sessionMax = Math.min(run.remaining * 2, budgetRemaining, JYEOO_SESSION_MAX_CAP);
  const band: DifficultyBand | undefined =
    run.item.difficultyBand && DIFFICULTY_BANDS.has(run.item.difficultyBand)
      ? (run.item.difficultyBand as DifficultyBand)
      : undefined;
  const fetchFn = deps.runJyeooFetchCandidates ?? runJyeooFetchCandidates;
  let result: JyeooFetchCandidatesResult;
  try {
    result = await fetchFn({
      db: run.db,
      input: {
        grade: config.grade,
        subject: config.subject ?? 'math2',
        pages: config.pages ?? 2,
        maxPapers: config.maxPapers ?? 2,
        sessionMax,
        ...(run.item.kind !== 'any' ? { kind: run.item.kind } : {}),
        ...(band ? { difficultyBand: band } : {}),
      },
      now: run.now,
    });
  } catch (err) {
    // P1-4：抓取核未预期异常（子进程崩溃/网络栈炸等）确定性降级为 skipped:'spawn'，
    // 路由回落继续，不把整个 job 送 retry/DLQ。预算查询等 DB 错误在 catch 之外，仍上抛。
    tally.skipped = 'spawn';
    tally.detail = errorMessage(err);
    return tally;
  }

  if (result.status === 'budget_exhausted') {
    tally.skipped = 'jyeoo_budget';
    return tally;
  }
  if (result.status === 'failed') {
    tally.skipped = result.failureClass;
    return tally;
  }

  tally.status = 'ok';
  // P1-2：trace 路由级克隆（producer_route 覆写）；复验失败丢弃并留痕 detail。
  const routeTrace = cloneSupplyTraceForRoute(run.supplyTrace, 'jyeoo_fetch');
  if (routeTrace === null) {
    tally.detail =
      'supply_trace dropped: failed SupplyTraceV1 revalidation after producer_route override';
  }
  for (const candidate of result.candidates) {
    // 归属解析延后到 commit（fetch 核只透传 hints）——确定性精确名匹配，不做模糊匹配。
    const matched =
      run.domain !== null
        ? await matchJyeooKnowledgeHints(run.db, run.domain, candidate.knowledgeHints)
        : null;
    let knowledgeIds: string[];
    let attributionState: 'matched' | 'coarse';
    if (matched && matched.matched.length > 0) {
      knowledgeIds = matched.matched.map((hit) => hit.knowledgeId);
      attributionState = 'matched';
    } else {
      const rootId =
        run.domain !== null ? await findSubjectRootKnowledgeId(run.db, run.domain) : null;
      if (rootId === null) {
        tally.unattributable = (tally.unattributable ?? 0) + 1;
        continue;
      }
      knowledgeIds = [rootId];
      attributionState = 'coarse';
    }

    const commit = await commitCandidate(
      run.db,
      run,
      {
        source_route: 'jyeoo_fetch',
        candidate: jyeooCandidateToStoreInput(candidate),
        knowledge_ids: knowledgeIds,
        attribution_state: attributionState,
        subject_id: run.subjectProfile.id,
        ...(run.item.demandId ? { demand_id: run.item.demandId } : {}),
        ...(routeTrace ? { supply_trace: routeTrace } : {}),
      },
      deps.enqueueSourceVerify ? { enqueueSourceVerify: deps.enqueueSourceVerify } : {},
    );
    if (commit.status === 'rejected') {
      recordRejection(tally, commit.reason);
      continue; // 拒绝不入 committed，继续批内后续候选
    }
    if (commit.status === 'threw') {
      tally.errors += 1;
      continue;
    }
    tally.committed += 1;
    if (knowledgeIds.includes(run.item.knowledgeId)) {
      tally.acquired += 1;
      run.remaining -= 1;
    } else {
      tally.opportunistic += 1;
    }
  }
  return tally;
}

/**
 * sourcing_web：注入的 web 生产线一次取 remaining 个候选 → 逐个 commit（锚点强制
 * 首位——SourcingTask 以锚点发起，归属诚实）。count cap：只 commit 还需要的数量，
 * 多余候选丢弃（web 无批量吸收语义，超额是 LLM 超发）。imageCandidates 经
 * writeImageCandidateProposal 落 pending proposal（best-effort，不翻转路由结果）。
 */
async function runWebRoute(
  run: RouteRunContext,
  deps: ExecuteSupplyPlanDeps,
): Promise<RouteExecutionTally> {
  const tally: RouteExecutionTally = {
    route: 'sourcing_web',
    status: 'skipped',
    acquired: 0,
    committed: 0,
    opportunistic: 0,
    rejections: {},
    errors: 0,
  };

  let result: RunWebFetchCandidatesResult;
  try {
    result = await deps.runWebFetchCandidates({
      db: run.db,
      input: {
        anchorKnowledgeId: run.item.knowledgeId,
        count: run.remaining,
        ...(run.item.kind !== 'any' ? { kind: run.item.kind } : {}),
        ...(run.item.objectiveOnly ? { objectiveOnly: true } : {}),
        ...(run.item.kindRequired ? { kindRequired: true } : {}),
        subjectProfile: run.subjectProfile,
      },
      ctx: {
        taskRunId: run.taskRunId,
        ...(run.causedByEventId ? { causedByEventId: run.causedByEventId } : {}),
      },
      now: run.now,
    });
  } catch (err) {
    // P1-4：注入的 web 生产线（含 LLM 相位）未预期异常确定性降级为 skipped:'llm'，
    // 路由回落（如 quiz_gen），不把整个 job 送 retry/DLQ；生产线自身的 failed
    // 返回仍走 failureClass 路径（下方），两类都 deterministic。
    tally.skipped = 'llm';
    tally.detail = errorMessage(err);
    return tally;
  }

  if (result.status === 'failed') {
    tally.skipped = result.failureClass;
    return tally;
  }

  tally.status = 'ok';
  // P1-2：trace 路由级克隆（producer_route 覆写）；复验失败丢弃并留痕 detail。
  const routeTrace = cloneSupplyTraceForRoute(run.supplyTrace, 'sourcing_web');
  if (routeTrace === null) {
    tally.detail =
      'supply_trace dropped: failed SupplyTraceV1 revalidation after producer_route override';
  }

  // imageCandidates → proposal（旧 sourcing 同款：pending inbox + ADR-0002；URL 同时
  // 出现在文本题里的候选跳过——文本题已入库，accept 再抽会堆重复）。
  if (deps.writeImageCandidateProposal && result.imageCandidates.length > 0) {
    const questionSourceUrls = new Set(result.candidates.map((c) => c.question.source_url));
    const seenCooldownKeys = new Set<string>();
    for (const imageCandidate of result.imageCandidates) {
      const cooldownKey = `image_candidate:${imageCandidate.source_url}`;
      if (questionSourceUrls.has(imageCandidate.source_url) || seenCooldownKeys.has(cooldownKey)) {
        continue;
      }
      seenCooldownKeys.add(cooldownKey);
      try {
        await deps.writeImageCandidateProposal({
          actor_ref: 'supply_executor',
          outcome: 'partial',
          payload: {
            kind: 'image_candidate',
            target: { subject_kind: 'source_asset', subject_id: null },
            reason_md: imageCandidate.summary_md,
            evidence_refs: [],
            proposed_change: {
              source_url: imageCandidate.source_url,
              source_title: imageCandidate.source_title,
              summary_md: imageCandidate.summary_md,
              knowledge_ids: [run.item.knowledgeId],
              ...(run.item.kind !== 'any' ? { requested_kind: run.item.kind } : {}),
            },
            cooldown_key: cooldownKey,
          },
          task_run_id: run.taskRunId,
          created_at: run.now,
        });
      } catch (proposalErr) {
        console.error(
          '[supply_executor] image_candidate proposal write failed (best-effort, route stands):',
          proposalErr,
        );
      }
    }
  }

  for (const candidate of result.candidates) {
    if (run.remaining <= 0) break; // count cap：只要还需要的
    const candidateIds = candidate.question.knowledge_ids;
    const knowledgeIds = [
      run.item.knowledgeId,
      ...candidateIds.filter((id) => id !== run.item.knowledgeId),
    ];
    const commit = await commitCandidate(
      run.db,
      run,
      {
        source_route: 'sourcing_web',
        candidate: webCandidateToStoreInput(candidate),
        knowledge_ids: knowledgeIds,
        attribution_state: 'matched', // 上游 live 校验 + 锚点发起，归属诚实
        subject_id: run.subjectProfile.id,
        ...(run.item.demandId ? { demand_id: run.item.demandId } : {}),
        ...(routeTrace ? { supply_trace: routeTrace } : {}),
      },
      deps.enqueueSourceVerify ? { enqueueSourceVerify: deps.enqueueSourceVerify } : {},
    );
    if (commit.status === 'rejected') {
      recordRejection(tally, commit.reason);
      continue; // 拒绝不入 committed，继续下一候选
    }
    if (commit.status === 'threw') {
      tally.errors += 1;
      continue;
    }
    tally.committed += 1;
    tally.acquired += 1;
    run.remaining -= 1;
  }
  return tally;
}

/**
 * quiz_gen：镜像 dispatcher 的 quiz_gen job data（anchor knowledge / count /
 * exact_count / kind / placement 字段）。dispatched ≠ acquired——生成走自身 job +
 * verify 链异步闭环，保留原生 provenance 族。enqueue 失败上抛（pg-boss 语义）。
 */
async function runQuizGenRoute(
  run: RouteRunContext,
  deps: ExecuteSupplyPlanDeps,
): Promise<RouteExecutionTally> {
  const payload: QuizGenDispatchPayload = {
    trigger: 'knowledge',
    ref_id: run.item.knowledgeId,
    knowledge_id: run.item.knowledgeId,
    count: run.remaining,
    exact_count: run.remaining,
    ...(run.item.kind !== 'any' ? { kind: run.item.kind } : {}),
    ...(run.item.objectiveOnly ? { objective_only: true } : {}),
    ...(run.item.kindRequired ? { kind_required: true } : {}),
    ...(run.item.placementClaimId ? { placement_starter_claim_id: run.item.placementClaimId } : {}),
  };
  // P1-1：enqueue 与逐 item 完成事件之间的崩溃窗口用 pg-boss 单例键封——同
  // (plan_event_id, demand_id) 重投不重复入队。scanner/手动（planEventId null）
  // 无键，沿用裸 enqueue 语义。
  const singletonKey =
    run.planEventId !== null && run.item.demandId
      ? `supply_exec_${run.planEventId}_${run.item.demandId}`
      : undefined;
  const jobId = await deps.enqueueQuizGen(payload, singletonKey ? { singletonKey } : undefined);
  return {
    route: 'quiz_gen',
    status: 'dispatched',
    acquired: 0,
    committed: 0,
    opportunistic: 0,
    rejections: {},
    errors: 0,
    ...(typeof jobId === 'string' ? { job_id: jobId } : {}),
  };
}

// ── 主流程 ───────────────────────────────────────────────────────────────────

/**
 * 执行一份 SupplyPlan 的需求项集合。逐 item 顺序沿 routePreference 走到 acquired ≥
 * count 或路由耗尽；任何路由失败只记录、不中断其余 item（quiz_gen enqueue 失败除外
 * ——那是调用方契约错误，上抛）。结尾单写一个 experimental:supply_executor 完成事件。
 */
export async function executeSupplyPlan(
  params: ExecuteSupplyPlanParams,
  deps: ExecuteSupplyPlanDeps,
): Promise<ExecuteSupplyPlanResult> {
  const { db } = params;
  const now = deps.now?.() ?? new Date();
  const taskRunId = params.ctx?.taskRunId ?? `supply_executor_${createId()}`;
  const causedByEventId = params.ctx?.causedByEventId ?? null;

  // ── 幂等：同 plan_event_id 已执行过 → 短路（无新写） ─────────────────────
  if (params.planEventId !== null) {
    const priorEventId = await priorExecutorEvent(db, params.planEventId);
    if (priorEventId !== null) {
      return { status: 'already_executed', priorEventId };
    }
  }

  // P1-1 resume 探针：完成事件缺失（崩溃）时，已完成 item 的增量事件仍在——按
  // demand_id 跳过，只补 undone item。
  const doneDemandIds =
    params.planEventId !== null ? await priorItemDemandIds(db, params.planEventId) : null;

  const tree = await loadLiveKnowledgeTree(db);
  const results: ItemExecutionResult[] = [];
  let dispatchedItems = 0;

  /**
   * P1-1：item 完成（含确定性跳过）即写增量事件（resume 凭证），再进 aggregate。
   * plan_event_id null（scanner/手动直调）无幂等事件——沿用旧语义，重投去重由
   * store seam 的 canonical hash 承担。
   */
  const completeItem = async (
    item: SupplyDemandItem,
    result: ItemExecutionResult,
  ): Promise<void> => {
    results.push(result);
    if (params.planEventId === null) return;
    await writeEvent(db, {
      id: `supply_executor_item_${createId()}`,
      session_id: null,
      actor_kind: 'agent',
      actor_ref: 'supply_executor',
      action: SUPPLY_EXECUTOR_ITEM_EVENT_ACTION,
      subject_kind: 'query',
      subject_id: params.planEventId,
      outcome: 'success',
      payload: {
        plan_event_id: params.planEventId,
        demand_id: item.demandId,
        knowledge_id: item.knowledgeId,
        routes: result.routes,
        acquired: result.acquired,
        committed: result.committed,
        opportunistic: result.opportunistic,
        ...(result.skipped ? { skipped: result.skipped } : {}),
      },
      caused_by_event_id: params.planEventId,
      task_run_id: taskRunId,
      cost_micro_usd: null,
      created_at: now,
    });
  };

  for (const item of params.items) {
    const result: ItemExecutionResult = {
      demandId: item.demandId,
      knowledgeId: item.knowledgeId,
      routes: [],
      acquired: 0,
      committed: 0,
      opportunistic: 0,
    };

    // P1-1 resume：该 demand 已有增量完成事件（上次崩溃前的完成凭证）→ 跳过重执行。
    if (doneDemandIds?.has(item.demandId)) {
      result.skipped = 'already_executed_item';
      results.push(result);
      continue;
    }

    const anchor = tree.get(item.knowledgeId);
    if (!anchor) {
      result.skipped = 'anchor_not_found';
      await completeItem(item, result);
      continue;
    }
    const { domain } = effectiveDomain(tree, item.knowledgeId);
    const subjectProfile =
      (domain !== null ? params.subjectProfileByDomain?.get(domain) : undefined) ??
      resolveSubjectProfile(domain);

    const run: RouteRunContext = {
      db,
      item,
      domain,
      subjectProfile,
      ...(params.supplyTrace ? { supplyTrace: params.supplyTrace } : {}),
      taskRunId,
      causedByEventId,
      planEventId: params.planEventId,
      now,
      remaining: item.count,
    };

    if (item.routePreference.length === 0) {
      result.skipped = 'no_route_preference';
      await completeItem(item, result);
      continue;
    }

    for (const route of item.routePreference as readonly string[]) {
      if (run.remaining <= 0) break;
      let tally: RouteExecutionTally;
      if (route === 'jyeoo_fetch') {
        tally = await runJyeooRoute(run, deps, params.jyeooFetch);
      } else if (route === 'sourcing_web') {
        tally = await runWebRoute(run, deps);
      } else if (route === 'quiz_gen') {
        tally = await runQuizGenRoute(run, deps);
      } else {
        // SupplyPlanV1 词表含 author_question / ingest_existing / image_candidate 等
        // 无自动执行面的路由（dispatcher 同款：emit + manual，不盲发）。
        tally = {
          route,
          status: 'skipped',
          acquired: 0,
          committed: 0,
          opportunistic: 0,
          rejections: {},
          errors: 0,
          skipped: 'route_not_executable',
        };
      }
      result.routes.push(tally);
      result.acquired += tally.acquired;
      result.committed += tally.committed;
      result.opportunistic += tally.opportunistic;
      if (tally.status === 'dispatched') {
        dispatchedItems += 1;
        break; // 已异步派发：生成经自身 job + verify 链闭环，不再走后续路由
      }
    }
    await completeItem(item, result);
  }

  const totals = {
    items: results.length,
    acquired: results.reduce((sum, r) => sum + r.acquired, 0),
    committed: results.reduce((sum, r) => sum + r.committed, 0),
    opportunistic: results.reduce((sum, r) => sum + r.opportunistic, 0),
    dispatched: dispatchedItems,
  };

  // ── 单次完成事件（#598 canary 单写规则）：整份计划的执行台账一处落盘 ─────────
  const eventId = `supply_executor_${createId()}`;
  await writeEvent(db, {
    id: eventId,
    session_id: null,
    actor_kind: 'agent',
    actor_ref: 'supply_executor',
    action: SUPPLY_EXECUTOR_EVENT_ACTION,
    subject_kind: 'query',
    subject_id: params.planEventId ?? eventId,
    outcome: 'success',
    payload: {
      plan_event_id: params.planEventId,
      executed_at: now.toISOString(),
      per_item: results.map((r) => ({
        demand_id: r.demandId,
        knowledge_id: r.knowledgeId,
        routes: r.routes,
        acquired: r.acquired,
        committed: r.committed,
        opportunistic: r.opportunistic,
        ...(r.skipped ? { skipped: r.skipped } : {}),
      })),
      totals,
    },
    caused_by_event_id: params.planEventId ?? causedByEventId,
    task_run_id: taskRunId,
    cost_micro_usd: null,
    created_at: now,
  });

  return { status: 'executed', eventId, results, totals };
}
