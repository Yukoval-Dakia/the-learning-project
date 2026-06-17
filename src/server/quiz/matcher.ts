// Phase 1 增量 3 (YUK-399/YUK-396) — caller-agnostic matcher 仲裁器骨架.
//
// matcher(demand) 召回单 KC 候选 (poolFetch, activeOnly:false) → app 层复合保守仲裁
// (kind 垫片过滤 + 合约五 tier 排序 + slice) → 三态输出 (used / residual / satisfiedFromPool).
//
// 与 runSourcingSequence 的判别轴根本不同 (后者 Step 1 写死 activeOnly:true、enqueue-then-
// forget；matcher activeOnly:false 召回 active+draft 当场仲裁)，故是新模块、不改造之 (plan §1).
//
// ── 增量切分 (plan §Tasks) ───────────────────────────────────────────────────
// Task 1: 纯 active 命中骨架 — poolFetch(activeOnly:false) 召回但暂当全 active
//   (poolFetch 当前不投影 draft_status — Task 5 才扩 projection 接 draft 分支)，全填 used；
//   无 cosine 阈值过滤 (Task 5)、无残余生成 (Task 3)、无 draft lazy verify (Task 5).
// Task 2 (本提交): cosine 软排序 (hybrid 检索) + NULL embedding 降级.
//   入参解析 queryEmbedding (路 A) 优先于 queryText (路 B，经可注入 embedFn seam)；都无则
//   不排序 (poolFetch 退 created_at,id)。得到的向量透传 poolFetch.queryEmbedding —— cosine
//   排序由 poolFetch 的 `ORDER BY embedding <=> qvec` 给 (无需 distance projection；阈值过滤
//   推迟到 Task 5 扩 projection 时一起做，plan §185)。NULL embedding 降级: 传 queryEmbedding
//   时 poolFetch isNotNull(embedding) 排除 NULL 行 (不崩，用回来的有向量行)；不传则纯标量集
//   含 NULL 行 (§7).
// 镜像 queryExistingPool (sourcing-sequence.ts:121-145) 的 app 层 kind 过滤 + tier 排序 +
//   slice 链 (同源单一真相)。CRITICAL: 不传 limit 给 poolFetch — 截断在 app 层 (F2 防线).
import { getEffectiveDomain } from '@/capabilities/knowledge/server/domain';
import { newId } from '@/core/ids';
import { compareBySourceTierThenWhitelist, deriveSourceTier } from '@/core/schema/provenance';
import type { Db } from '@/db/client';
import { embedText } from '@/server/ai/embed';
import { type DispatchResult, dispatchSupplyTarget } from '@/server/question-supply/dispatcher';
import {
  type DifficultyBand,
  type QuestionSupplyTarget,
  type SupplyGapKind,
  type SupplyRoute,
  seedGenerationMethod,
  seedRoutePreference,
  targetFingerprint,
} from '@/server/question-supply/target-discovery';
import { resolveSubjectProfile } from '@/subjects/profile';
import { kindsMatch } from '@/subjects/question-kind';
import { type PoolRow, poolFetch } from './pool-fetch';
import type { SourcingNeed, SourcingSequenceStep } from './sourcing-sequence';

// ── §3.1.5 三层 Demand (v1 子集) ──────────────────────────────────────────────
export interface Demand {
  // ① 硬过滤 → poolFetch WHERE
  /** 必填，v1 单 KC. */
  knowledgeId: string;
  /** 难度带下限 (整数 1-5，poolFetch 标量；R3 caller 算好传入). */
  difficultyMin?: number | null;
  /** 难度带上限. */
  difficultyMax?: number | null;
  /** 结构轴 unit==='篇' (poolFetch compositeParentOnly). */
  compositeParentOnly?: boolean;
  /** gated YUK-395 — v1 收下不进 WHERE (留接口；answer_class 新鲜度未解前不硬过滤). */
  answerClass?: string;
  // ② 软排序
  /** matcher 内部 embed (路 B)；Task 2 接入. */
  queryText?: string;
  /** caller 预算 (路 A)；二者都给 Embedding 优先. Task 2 接入. */
  queryEmbedding?: number[];
  /** 源档底线 (R2)，喂残余 target + 排序参考. */
  minSourceTier?: 1 | 2 | 3;
  /** legacy 垫片 (kindsMatch)；随 YUK-386 收口删. */
  kind?: string;
  // ③ 信封 (不进检索)
  /** 错因：embed→召回 + 喂残余 generate prompt (经 target.reason 透传，Task 3). */
  cause?: string;
  /** R1-R4：steer 残余路由 (映射 SupplyGapKind，Task 3). */
  gapType?: string;
  priority?: number;
  /** 必填. */
  limit: number;
}

// superset ExistingPoolHit ({question_id, source, tier} + 2 字段).
export interface MatchedQuestion {
  question_id: string;
  source: string;
  tier: number;
  /** false=本来 active；true=本次 gate promote (Task 5 才会 true). */
  promotedFromDraft: boolean;
  /** promote 留痕引用 (evidence-first，Task 5). */
  verifyEventId?: string;
}

export interface MatcherResult {
  /** active 直接用 + 已 promote 的 draft (同列，返回时 draft_status 永远 active). */
  used: MatchedQuestion[];
  /** 复用 sourcing-sequence.ts 的 SourcingNeed (import，别重定义). Task 1 永远 []. */
  residual: SourcingNeed[];
  /** 全部 limit 由池满足、无残余. */
  satisfiedFromPool: boolean;
}

// Injectable seams (db 测试注 vi.fn() 不打真 DashScope/真派发). 后续 Task 在此扩
// verify (Task 5)；Task 2 引入 embedFn，Task 3 引入 dispatch.
export interface MatcherDeps {
  /** queryText 路 B 的 embedder seam. 默认 embedText (DashScope text-embedding-v4@1024).
   *  铁律: 与池中向量同一 seam，否则 cosine 跨空间无意义 (plan §190). */
  embedFn?: (text: string) => Promise<number[]>;
  /** 残余生成派发 seam (Task 3). 默认 dispatchSupplyTarget (route-plan → enqueue 既有队列，
   *  带 7 天 fingerprint cooldown 防无界 re-dispatch). db 测试注 vi.fn() 捕获 target、不打
   *  真 pg-boss / 真 Tavily. */
  dispatch?: (db: Db, target: QuestionSupplyTarget) => Promise<DispatchResult>;
}

/**
 * Resolve the query vector for hybrid retrieval. queryEmbedding (路 A，caller 预算) 优先于
 * queryText (路 B，matcher 内部 embed)；二者都给 Embedding 优先 (spec §9 开放问题 3)。都无 →
 * null (poolFetch 退 created_at,id 标量序)。queryText 经可注入 embedFn (默认 embedText)，
 * 保证与池向量同一 embedding seam (plan §190 铁律).
 */
async function resolveQueryEmbedding(demand: Demand, deps: MatcherDeps): Promise<number[] | null> {
  if (demand.queryEmbedding != null && demand.queryEmbedding.length > 0) {
    return demand.queryEmbedding;
  }
  if (demand.queryText != null && demand.queryText.length > 0) {
    const embed = deps.embedFn ?? embedText;
    return embed(demand.queryText);
  }
  return null;
}

// OF-2 — read metadata.web_sourced.whitelist_match for the within-tier-2 demotion
// comparator. Mirrors queryExistingPool's readWhitelistMatch verbatim (single truth:
// the sort semantics live in compareBySourceTierThenWhitelist, 合约五).
function readWhitelistMatch(metadata: Record<string, unknown> | null): boolean | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const webSourced = (metadata as Record<string, unknown>).web_sourced;
  if (!webSourced || typeof webSourced !== 'object') return null;
  const match = (webSourced as Record<string, unknown>).whitelist_match;
  return typeof match === 'boolean' ? match : null;
}

/**
 * Pure ranking of a fetched candidate pool: ① A2 kind filter (canonical space, no-op
 * when demand.kind is undefined) ② 合约五 tier/whitelist sort (authentic-first,
 * off-whitelist demoted) ③ slice to limit. Mirrors queryExistingPool's app-layer chain
 * (sourcing-sequence.ts:121-145) verbatim so selection stays single-truth. poolFetch must
 * NOT receive limit — slicing happens here, AFTER the in-memory tier sort (F2 防线).
 */
export function rankPool(rows: PoolRow[], demand: Demand): PoolRow[] {
  const ranked = rows
    // A2 — kind filter in canonical space (no-op when demand.kind is undefined). A row
    // whose persisted kind doesn't normalize-match the requested kind is excluded.
    .filter((r) => demand.kind === undefined || kindsMatch(r.kind, demand.kind))
    .map((r) => ({
      row: r,
      tier: deriveSourceTier({ source: r.source, metadata: r.metadata ?? null }).tier,
      whitelistMatch: readWhitelistMatch((r.metadata ?? null) as Record<string, unknown> | null),
    }));
  // 合约五: high tier first (1 authentic → 4 generated), then OF-2 within-tier demotion.
  // The created_at/cosine base order from poolFetch stays stable within equal keys.
  ranked.sort(compareBySourceTierThenWhitelist);
  return ranked.slice(0, demand.limit).map((x) => x.row);
}

// ── Task 3: 残余生成分支 (demandToSupplyTarget + dispatchSupplyTarget) ──────────

// 类型阻抗 (plan §196, critic 已证): dispatchSupplyTarget 返 DispatchResult.chosenRoute:
// SupplyRoute (词表 author_question/sourcing_web/ingest_existing/image_candidate/quiz_gen)，
// 而 MatcherResult.residual: SourcingNeed[] 需要 SourcingSequenceStep (词表 external_sourcing/
// material_grounded/closed_book) —— 两者不同构。用显式映射表把 chosenRoute 翻成 SourcingNeed.source，
// 不硬塞 SupplyRoute 进 SourcingNeed 类型。
//   sourcing_web   → external_sourcing  (tier 2 在线检索线，sourcing 队列)
//   quiz_gen       → material_grounded | closed_book (据 result.preferredGenerationMethod；缺省 closed_book)
//   author_question / image_candidate / ingest_existing → closed_book
//     (这三条无对应 SourcingSequenceStep；它们是 manual 出口 = owner gate，inc-4 闭环。
//      落 closed_book 是「最重兜底」语义占位，残余 SourcingNeed 只是「池缺、有后台生产在路上」标记，
//      实际派路由 + manual 决策都在 DispatchResult.routePlan/chosenRoute 里如实留痕，这里只折出一个步。)
const SUPPLY_ROUTE_TO_SOURCING_STEP: Record<
  Exclude<SupplyRoute, 'quiz_gen'>,
  SourcingSequenceStep
> = {
  sourcing_web: 'external_sourcing',
  author_question: 'closed_book',
  image_candidate: 'closed_book',
  ingest_existing: 'closed_book',
};

/**
 * Translate a DispatchResult (+ the dispatched target) into the SourcingSequenceStep that
 * goes on the residual SourcingNeed.source. quiz_gen splits on the target's
 * preferredGenerationMethod (material_grounded vs closed_book — the field lives on
 * QuestionSupplyTarget, NOT DispatchResult; dispatcher's generationMethodFor reads it the
 * same way); the other routes map via SUPPLY_ROUTE_TO_SOURCING_STEP. chosenRoute === null
 * (manual: dispatch found no auto-dispatchable route, owner gate is the loop exit, inc-4) →
 * closed_book 兜底 step (the heaviest fallback; the real manual disposition lives in the
 * DispatchResult.routePlan/stopCondition, this only picks a step for the residual marker).
 */
function supplyRouteToSourcingStep(
  result: DispatchResult,
  target: QuestionSupplyTarget,
): SourcingSequenceStep {
  const route = result.chosenRoute;
  // manual 出口 (chosenRoute === null) = owner gate, inc-4 闭环 → closed_book 兜底 step.
  if (route === null) return 'closed_book';
  if (route === 'quiz_gen') {
    return target.preferredGenerationMethod === 'material_grounded'
      ? 'material_grounded'
      : 'closed_book';
  }
  return SUPPLY_ROUTE_TO_SOURCING_STEP[route];
}

// difficultyMin/Max → DifficultyBand 反推 (plan Step 4). inc-3 简化: 无 θ̂ / mastery 依赖，
// 缺省 'near' (gap 目标默认建近-θ̂ 脚手架，与 target-discovery R1 frontier 目标的 band=near 同款)。
function difficultyBandFor(_demand: Demand): DifficultyBand {
  // inc-3 不引 mastery 依赖 — difficultyMin/Max 是标量带不映射到 logit band。缺省 near。
  return 'near';
}

// demand.gapType (R1-R4 信封) → SupplyGapKind (机器可读缺口类别，steer 派发/观测分流)。
// 词表对齐 target-discovery SupplyGapKind；未知/缺省 → frontier_zero (补深度是最常见的残余缺口)。
const GAP_TYPE_TO_SUPPLY_GAP_KIND: Record<string, SupplyGapKind> = {
  frontier_zero: 'frontier_zero',
  source_quality: 'source_quality',
  diagnostic: 'diagnostic',
  format_diversity: 'format_diversity',
};

function supplyGapKindFor(demand: Demand): SupplyGapKind {
  if (demand.gapType && GAP_TYPE_TO_SUPPLY_GAP_KIND[demand.gapType]) {
    return GAP_TYPE_TO_SUPPLY_GAP_KIND[demand.gapType];
  }
  return 'frontier_zero';
}

/**
 * Adapt a Demand + computed gap into a QuestionSupplyTarget the existing dispatcher can
 * route (plan Step 4 — 13 必填字段，对 target-discovery.ts QuestionSupplyTarget 核实). async:
 * subjectId resolution walks the KC's effective domain via DB (mirror target-discovery.ts:541).
 *
 * fingerprint 调 import 的 targetFingerprint (绝不复刻算法 — 复刻=cooldown 失效=无界付费
 * re-dispatch，critic 已证). subjectId resolution: getEffectiveDomain → resolveSubjectProfile.id；
 * 节点缺失/未建 (matcher 可在零库 / 错题 caller 上跑) → 退 resolveSubjectProfile(null).id
 * (mirror target-discovery loadFrontierKnowledge try/catch 兜底)，绝不留空/硬编码。
 *
 * cause→prompt 透传缺口: QuizGenJobData/SourcingJobData payload 当前不带 cause/answer_class/
 * 难度带——spec §3.1.5 要 demand.cause 喂残余 generate prompt，但 inc-3 不扩 JobData (避免动两个
 * handler 契约)；把 cause 塞进 target.reason (人读字符串，dispatcher 已留痕)。扩 JobData 是后续
 * 增量，见 spec §3.1.5 + Linear follow-up.
 */
export async function demandToSupplyTarget(
  db: Db,
  demand: Demand,
  gap: number,
  makeId: () => string = newId,
): Promise<QuestionSupplyTarget> {
  // subjectId: 科目是派生轴 (effective_domain → resolveSubjectProfile.id)，不给 KC 加 subject 列。
  let subjectId: string;
  try {
    subjectId = resolveSubjectProfile(await getEffectiveDomain(db, demand.knowledgeId)).id;
  } catch {
    // 节点缺失 / domain 未解 (零库 / 自由 caller) → 默认 subject (mirror target-discovery:542).
    subjectId = resolveSubjectProfile(null).id;
  }
  const profile = resolveSubjectProfile(subjectId);

  const kind = demand.kind ?? 'any';
  const difficultyBand = difficultyBandFor(demand);
  const gapKind = supplyGapKindFor(demand);
  const minSourceTier: 1 | 2 | 3 = (demand.minSourceTier ?? 2) as 1 | 2 | 3;
  const knowledgeIds = [demand.knowledgeId];

  // fingerprint: import targetFingerprint，与 target-discovery 同算法 → 同 demand 产同 fingerprint
  // (7 天 cooldown 前提，plan §218). 绝不复刻算法.
  const fingerprint = targetFingerprint({
    subjectId,
    knowledgeIds,
    kind,
    difficultyBand,
    gapKind,
    minSourceTier,
  });

  return {
    id: makeId(),
    fingerprint,
    gapKind,
    subjectId,
    knowledgeIds,
    kind,
    difficultyBand,
    desiredCount: gap,
    minSourceTier,
    // import seedRoutePreference (不硬编码空数组)；空 profile 退 [] → dispatcher 落 manual.
    routePreference: seedRoutePreference(profile),
    // FINDING #3 — quiz_gen 的 material vs closed_book 区分 (与 target-discovery seedGenerationMethod
    // 同款，单一真相)；undefined → dispatcher 退 minSourceTier 推导。residual step 折叠也读它.
    preferredGenerationMethod: seedGenerationMethod(profile),
    priority: demand.priority ?? GAP_KIND_BASE_PRIORITY[gapKind],
    // cause→prompt 透传缺口: 把 demand.cause 塞进 reason (人读字符串，dispatcher 留痕)。
    // 扩 JobData 是后续增量，见 spec §3.1.5.
    reason: residualReason(demand, gap),
    constraints: {},
  };
}

// 缺省 priority base，词表对齐 target-discovery GAP_BASE_PRIORITY (单一真相在那边；这里只是
// matcher 残余 demand 未显式给 priority 时的兜底基准，与扫描器同尺度便于观测对齐)。
const GAP_KIND_BASE_PRIORITY: Record<SupplyGapKind, number> = {
  frontier_zero: 1.0,
  diagnostic: 0.7,
  source_quality: 0.5,
  format_diversity: 0.4,
};

function residualReason(demand: Demand, gap: number): string {
  const causeSuffix = demand.cause ? ` (cause: ${demand.cause})` : '';
  return `matcher residual: KC ${demand.knowledgeId} short by ${gap} (limit ${demand.limit})${causeSuffix}`;
}

/**
 * caller-agnostic matcher 仲裁器 (Task 1 骨架 + Task 2 cosine 软排序).
 *
 * 召回单 KC 候选池 (hybrid: 标量硬过滤 + 可选 cosine 排序) → rankPool (kind 过滤 + tier 排序
 * + slice) → 三态输出. queryEmbedding/queryText 解析为查询向量透传 poolFetch (NULL embedding
 * 在 vector mode 由 poolFetch 排除，§7 降级)。
 * Task 1/2: poolFetch 不投影 draft_status，故全部候选当 active 填 used.
 * Task 3 (本提交): 池满足不了 limit → 残余生成分支. gap = limit - used.length → demandToSupplyTarget
 *   适配成 QuestionSupplyTarget → deps.dispatch (默认 dispatchSupplyTarget, 带 7 天 fingerprint
 *   cooldown 防无界 re-dispatch) → DispatchResult 经 supplyRouteToSourcingStep 折成一个
 *   SourcingNeed 填 residual. satisfiedFromPool = 无缺口 (gap <= 0).
 */
export async function matcher(
  db: Db,
  demand: Demand,
  deps: MatcherDeps = {},
): Promise<MatcherResult> {
  // 解析查询向量 (路 A queryEmbedding 优先于路 B queryText)；都无 → null → 标量序.
  const queryEmbedding = await resolveQueryEmbedding(demand, deps);

  // 召回全量候选 (activeOnly:false 为接 draft 分支铺路；Task 1/2 暂当全 active).
  // 不传 limit — 截断在 app 层 rankPool 的 slice (F2 回归防线).
  // queryEmbedding 非空 → poolFetch ORDER BY embedding <=> qvec (cosine 软排序) 且
  // isNotNull(embedding) 排除 NULL 行；null → 退 created_at,id 标量序含 NULL 行 (§7 降级).
  const rows = await poolFetch(db, {
    knowledgeId: demand.knowledgeId,
    activeOnly: false,
    difficultyMin: demand.difficultyMin,
    difficultyMax: demand.difficultyMax,
    compositeParentOnly: demand.compositeParentOnly,
    queryEmbedding,
  });

  const ranked = rankPool(rows, demand);

  // Task 1: 所有候选当 active 直接用 (poolFetch 不投影 draft_status — Task 5 接 draft 分支).
  const used: MatchedQuestion[] = ranked.map((r) => ({
    question_id: r.id,
    source: r.source,
    tier: deriveSourceTier({ source: r.source, metadata: r.metadata ?? null }).tier,
    promotedFromDraft: false,
  }));

  // Task 3 — 残余生成分支. 池满足不了 limit (gap > 0) → 派一个供给目标补差.
  // gap = limit - used.length (Task 1/2: used 全是 active 命中；Task 5 接 draft promote 后
  // gap 仍是 limit - used.length，promote 的 draft 进 used 也算满足).
  const gap = demand.limit - used.length;
  const residual: SourcingNeed[] = [];
  if (gap > 0) {
    const target = await demandToSupplyTarget(db, demand, gap);
    const dispatch = deps.dispatch ?? dispatchSupplyTarget;
    // dispatchSupplyTarget: route-plan → enqueue 既有队列 (sourcing/quiz_gen)，带 7 天 fingerprint
    // cooldown 防无界 re-dispatch (前提=fingerprint 稳定且与 target-discovery 同算法 — 上面用 import
    // 的 targetFingerprint 保证)。manual / cooldown skip / failed 路径 dispatch 也如实返 DispatchResult，
    // 折进 residual (owner manual gate 是闭环出口，inc-4).
    const result = await dispatch(db, target);
    residual.push({
      kind: 'question_generation',
      knowledge_id: demand.knowledgeId,
      source: supplyRouteToSourcingStep(result, target),
      reason: result.reason,
    });
  }

  // satisfiedFromPool = 池独立满足了整个 limit (无残余缺口).
  const satisfiedFromPool = residual.length === 0;

  return { used, residual, satisfiedFromPool };
}
