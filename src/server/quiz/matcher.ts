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
import { compareBySourceTierThenWhitelist, deriveSourceTier } from '@/core/schema/provenance';
import type { Db } from '@/db/client';
import { embedText } from '@/server/ai/embed';
import { kindsMatch } from '@/subjects/question-kind';
import { type PoolRow, poolFetch } from './pool-fetch';
import type { SourcingNeed } from './sourcing-sequence';

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
// dispatch (Task 3) / verify (Task 5)；Task 2 只引入 embedFn.
export interface MatcherDeps {
  /** queryText 路 B 的 embedder seam. 默认 embedText (DashScope text-embedding-v4@1024).
   *  铁律: 与池中向量同一 seam，否则 cosine 跨空间无意义 (plan §190). */
  embedFn?: (text: string) => Promise<number[]>;
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

/**
 * caller-agnostic matcher 仲裁器 (Task 1 骨架 + Task 2 cosine 软排序).
 *
 * 召回单 KC 候选池 (hybrid: 标量硬过滤 + 可选 cosine 排序) → rankPool (kind 过滤 + tier 排序
 * + slice) → 三态输出. queryEmbedding/queryText 解析为查询向量透传 poolFetch (NULL embedding
 * 在 vector mode 由 poolFetch 排除，§7 降级)。
 * Task 1/2: poolFetch 不投影 draft_status，故全部候选当 active 填 used；无残余生成.
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

  // Task 1 无残余生成 (Task 3 接入)。satisfiedFromPool = 无残余缺口.
  const residual: SourcingNeed[] = [];
  const satisfiedFromPool = residual.length === 0;

  return { used, residual, satisfiedFromPool };
}
