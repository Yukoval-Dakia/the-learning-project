// YUK-474 — 动态供题 refill（池见底补题）。
//
// 角色（owner 2026-06-21 拍定，从 day-one 降级为 act/later）：当学习者**取题**（练习流首次
// lazy-compose）时，其**活跃学习 KC**（learning_item status active/in_progress 引用的
// knowledge_ids）的**活跃池**（non-draft question）< 阈值 → 复用既有供给机器补题。
// **不重写 dispatcher**——走 matcher 的 demandToSupplyTarget（Demand → QuestionSupplyTarget）
// + dispatcher 的 dispatchSupplyTarget（route-plan → enqueue 既有 sourcing/quiz_gen 队列，自带
// 7 天 fingerprint cooldown）。这是 nightly `question_supply_nightly` 全量扫描的**按需补充**
// （取题瞬间触发的 on-demand refill），**不在 day-one 关键路径**（openable 绝不依赖本模块）。
//
// ── fingerprint 共享（关键正确性属性）──────────────────────────────────────────────
// `Demand{knowledgeId, gapType:'frontier_zero', limit:REFILL_POOL_THRESHOLD}` 经
// `demandToSupplyTarget` 产出的 target（kind='any' / difficultyBand='near' /
// gapKind='frontier_zero' / minSourceTier=2 / subjectId=resolveSubjectProfile(
// getEffectiveDomain(kid)).id）的 **fingerprint 与 nightly 扫描器的 R1 frontier_zero 目标**
// （`scanCoverageGaps`，同 KC，同 `targetFingerprint` 同入参）**逐字相同**。故 dispatcher 的 7 天
// fingerprint cooldown 在 refill 与 nightly **之间共享**——refill 不会重发 nightly 刚发过的同一
// KC 缺口，反之亦然。这把「按需 refill」与「夜间基线」收敛到同一把幂等闸，不双付费。
//   （subjectId 解析路径与 target-discovery `loadFrontierKnowledge`:552-556 同款 try/catch；
//    即便边缘场景 subjectId 解析有别，refill 仍有**自身** fingerprint 的 7d cooldown 兜 spam，
//    shared-fingerprint 是收益而非正确性依赖。）
//
// ── open question 1 / 3：cooldown 竞态（并发取题多次触发）─────────────────────────────
//   dispatcher 已有 7d 持久 cooldown（查 `event` 表 action='experimental:question_supply'、
//   payload.status='dispatched'），但它依赖**上次 dispatch 事件已落库**；并发取题在首事件落库前
//   各自 recentDispatchExists 都返 false → 各派一次。补强：**进程内 in-flight Set（按
//   knowledgeId）**——同 KC 的 refill 正在飞时，后到的并发请求跳过（in-process 节流，非持久幂等；
//   持久幂等由 dispatcher 7d cooldown 兜）。两层叠加：进程内挡并发竞态，dispatcher cooldown 挡
//   跨进程/跨日重复。
//
// ── open question 2：热路径同步 dispatch 开销 ─────────────────────────────────────────
//   选 **取题瞬间 best-effort，仅在 compose 真正发生时触发**（getStream 的 `rows.length===0 &&
//   composeIfEmpty` 分支 = 每用户每天首次打开练习流一次，**非 per-question / 非每次读**）。compose
//   本身是秒级 LLM；refill 的几个廉价池计数 + cooldown-gated dispatch 相对可忽略，且只在 thin 池
//   （罕见）才真派。全程 try/catch，refill 失败**绝不**破坏取题。**未选 detached fire-and-forget**
//   （floating promise 易 unhandled-rejection + 测试竞态）：awaited-best-effort 在「每天一次 + 罕见
//   thin 条件」下延迟可忽略，且无悬挂 promise 风险（caller 在 compose 事务**提交后**、用 top-level
//   `db`、await 它——见 stream-store.ts getStream）。
//
// ── flag 门（dark-ship / defer-flip）─────────────────────────────────────────────────
//   `QUESTION_SUPPLY_REFILL_ENABLED`（默认 false）。off → 本模块入口**零 DB 读零 dispatch**，取题
//   路径 byte-identical 现状。act 侧：day-one 不依赖它，collect（上传/seed）先通电。flip 是 owner
//   决策（绑生产验收），本 PR 只把实现 + 接线 + flag 做穿到 live（[defer flip not build]）。
//
// ── n=1 admissibility ────────────────────────────────────────────────────────────────
//   refill **不引入任何新信号**：判据全是 admissible —— 池题计数（计数）、COVERAGE 阈值常数 2、
//   cooldown 7d 常数、in-flight 进程内集合。**无**跨被试 a/slip/guess/φ/discrimination；不读写
//   θ̂/p(L)/选题调度。复用件（demandToSupplyTarget/dispatchSupplyTarget）的内部判据沿用既有
//   GAP_KIND_BASE_PRIORITY 常数，本模块不新增需 population 方差的权重。

import { newId } from '@/core/ids';
import type { Db } from '@/db/client';
import { learning_item } from '@/db/schema';
import {
  type DispatchDeps,
  type DispatchResult,
  dispatchSupplyTarget,
} from '@/server/question-supply/dispatcher';
import type { QuestionSupplyTarget } from '@/server/question-supply/target-discovery';
import { type Demand, demandToSupplyTarget } from '@/server/quiz/matcher';
import { poolFetch } from '@/server/quiz/pool-fetch';
import { inArray } from 'drizzle-orm';

/**
 * 覆盖深度阈值——某 KC 的可用（non-draft）题数 < 此值即「池见底」，触发 refill。**镜像
 * target-discovery.ts 的 R1 `COVERAGE_DEPTH_THRESHOLD = 2`**（module-private 未导出，故此处
 * 本地重声明并对齐——二者必须一致，否则 refill 与 nightly R1 的触发面/desiredCount 会漂移，
 * 也会破坏上面注释的 fingerprint 共享前提）。
 */
export const REFILL_POOL_THRESHOLD = 2;

/**
 * flag reader（运行时读 env，runtime-flippable + 测试可 set/unset；mirror resolveSelectionPolicy
 * 读 process.env.SELECTION_POLICY 的惯例）。默认 false（dark-ship）。`'true'` / `'1'` 为开。
 */
export function refillEnabled(): boolean {
  const raw = process.env.QUESTION_SUPPLY_REFILL_ENABLED;
  return raw === 'true' || raw === '1';
}

/**
 * 进程内 in-flight 节流集合（open question 1/3）。键 = knowledgeId。某 KC 的 refill dispatch
 * 正在飞（其 `experimental:question_supply` 事件可能尚未落库 → dispatcher 7d cooldown 看不到它）
 * 时，并发的后到请求跳过该 KC，避免在首事件落库前各派一次。dispatch 完成（成功/失败）即释放。
 * 进程级单例——同一 Node 进程内的并发取题共享（Hono API 进程；worker 进程的 nightly 走自身路径）。
 */
const inFlightRefills = new Set<string>();

export type RefillAction =
  | 'dispatched' // 真派了一个后台供给 job（dispatcher status='dispatched'）。
  | 'skipped-cooldown' // dispatcher 7d fingerprint cooldown 命中（同缺口近期已派）。
  | 'manual' // 选定路由当前无法自动派（image/ingest/author 或 Tavily 缺失）→ 留人工/UI。
  | 'failed' // dispatch 抛错（enqueue 失败）——已 try/catch 兜住，不破坏取题。
  | 'in-flight' // 同 KC 的 refill 正在本进程内飞，跳过（节流）。
  | 'above-threshold'; // 活跃池 ≥ 阈值，无需补题。

export interface RefillOutcome {
  knowledgeId: string;
  /** 计数到的活跃（non-draft）题数（封顶 REFILL_POOL_THRESHOLD）；in-flight/failed 时 null。 */
  poolCount: number | null;
  action: RefillAction;
  /** dispatch 真跑时的 dispatcher 原始 status（观测用）。 */
  dispatchStatus?: DispatchResult['status'];
}

/** 注入口（测试注 fake 捕获 dispatch、不打真 pg-boss / 真 DB 计数）。 */
export interface RefillDeps {
  /** 某 KC 的活跃（non-draft）题计数 seam。默认 poolFetch(activeOnly, limit=阈值).length。 */
  countActiveQuestions?: (db: Db, knowledgeId: string) => Promise<number>;
  /** Demand → QuestionSupplyTarget seam。默认 demandToSupplyTarget（matcher 现成，不重写）。 */
  buildTarget?: (db: Db, demand: Demand, gap: number) => Promise<QuestionSupplyTarget>;
  /** 派发 seam。默认 dispatchSupplyTarget（route-plan → enqueue 既有队列，自带 7d cooldown）。 */
  dispatch?: (db: Db, target: QuestionSupplyTarget, deps?: DispatchDeps) => Promise<DispatchResult>;
  /** 透传给 dispatch 的 DispatchDeps。默认带 actorRef='question_supply_refill'（观测区分 refill
   *  与 nightly；不影响 cooldown——recentDispatchExists 不按 actorRef 过滤，故 fingerprint 共享）。 */
  dispatchDeps?: DispatchDeps;
  /** id 生成（测试确定化）。默认 newId。 */
  makeId?: () => string;
}

/** 默认活跃池计数：复用 canonical poolFetch（activeOnly → non-draft），limit=阈值封顶（只需知道
 *  是否 < 阈值，封顶保持廉价）。返回 rows.length。 */
async function defaultCountActiveQuestions(db: Db, knowledgeId: string): Promise<number> {
  const rows = await poolFetch(db, {
    knowledgeId,
    activeOnly: true,
    limit: REFILL_POOL_THRESHOLD,
  });
  return rows.length;
}

/**
 * 对一组 knowledgeId 做 refill：逐 KC 计数活跃池，< 阈值则复用既有 dispatcher 补题。
 *
 * flag off → **立即返 []（零 DB 零 dispatch）**，byte-identical no-op。
 * in-request 去重（同 KC 多次引用塌成一次检查）+ in-process in-flight 节流（并发竞态，open Q1/3）。
 * 每 KC 包 try/catch + finally 释放节流——单 KC 失败不影响其余 KC，更不破坏取题（best-effort）。
 */
export async function refillThinPools(
  db: Db,
  knowledgeIds: string[],
  deps: RefillDeps = {},
): Promise<RefillOutcome[]> {
  if (!refillEnabled()) return []; // flag-off → byte-identical no-op（无 DB、无 dispatch）。

  const countActive = deps.countActiveQuestions ?? defaultCountActiveQuestions;
  const buildTarget = deps.buildTarget ?? demandToSupplyTarget;
  const dispatch = deps.dispatch ?? dispatchSupplyTarget;
  const dispatchDeps: DispatchDeps = deps.dispatchDeps ?? { actorRef: 'question_supply_refill' };
  const makeId = deps.makeId ?? newId;

  // open Q3 — in-request 去重：同 KC 被多个待做项引用 → 塌成一次池检查。
  const unique = [...new Set(knowledgeIds.filter(Boolean))];
  const outcomes: RefillOutcome[] = [];

  for (const kid of unique) {
    // open Q1/3 — in-process 节流：同 KC 的 refill 已在本进程内飞（其 dispatch 事件可能尚未落库，
    // dispatcher 7d cooldown 看不到）→ 跳过，避免并发各派一次。在飞的那次会负责 dispatch（或 cooldown-skip）。
    if (inFlightRefills.has(kid)) {
      outcomes.push({ knowledgeId: kid, poolCount: null, action: 'in-flight' });
      continue;
    }
    inFlightRefills.add(kid);
    try {
      const poolCount = await countActive(db, kid);
      if (poolCount >= REFILL_POOL_THRESHOLD) {
        outcomes.push({ knowledgeId: kid, poolCount, action: 'above-threshold' });
        continue;
      }
      // gapType='frontier_zero' → gapKind='frontier_zero' → fingerprint 与 nightly R1 共享（见模块头）。
      const demand: Demand = {
        knowledgeId: kid,
        gapType: 'frontier_zero',
        limit: REFILL_POOL_THRESHOLD,
      };
      // desiredCount = 补齐到阈值（零题 → 2，1 题 → 1），与 target-discovery R1 的
      // `COVERAGE_DEPTH_THRESHOLD - pool.length` 同款。
      const gap = REFILL_POOL_THRESHOLD - poolCount;
      // makeId DI：用默认 buildTarget（demandToSupplyTarget）时透传 makeId（确定化 target.id，
      // 测试可断言）；注入了自定义 buildTarget 时由它自管 id。target 只建一次。
      const target =
        buildTarget === demandToSupplyTarget
          ? await demandToSupplyTarget(db, demand, gap, makeId)
          : await buildTarget(db, demand, gap);
      const result = await dispatch(db, target, dispatchDeps);
      const action: RefillAction =
        result.status === 'dispatched'
          ? 'dispatched'
          : result.status === 'skipped'
            ? 'skipped-cooldown'
            : result.status === 'manual'
              ? 'manual'
              : 'failed';
      outcomes.push({ knowledgeId: kid, poolCount, action, dispatchStatus: result.status });
    } catch (err) {
      // best-effort：refill 失败绝不破坏取题（open Q2）。
      console.error('[question-supply/refill] refill failed for KC', kid, err);
      outcomes.push({ knowledgeId: kid, poolCount: null, action: 'failed' });
    } finally {
      inFlightRefills.delete(kid); // 释放 in-process 节流。
    }
  }
  return outcomes;
}

/**
 * 加载活跃学习 KC：active learning item（status IN ['active','in_progress']）引用的全部
 * knowledge_ids。**与 target-discovery `loadFrontierKnowledge`:537-541 + stream-store
 * `collectComposerInputs` step 3 同款 learning_item 扫描**（约定式重复，三处一致；本扫描轻量、
 * 只读 knowledge_ids，不解析 mastery）。
 */
export async function activeLearningKnowledgeIds(db: Db): Promise<string[]> {
  const items = await db
    .select({ knowledge_ids: learning_item.knowledge_ids })
    .from(learning_item)
    .where(inArray(learning_item.status, ['active', 'in_progress']));
  return [...new Set(items.flatMap((i) => i.knowledge_ids ?? []).filter(Boolean))];
}

/**
 * 取题瞬间 refill 入口：派生活跃学习 KC → 对池见底者补题。getStream 的 compose 分支调本函数
 * （compose 事务**提交后**、top-level db、best-effort）。
 *
 * flag off → 在 learning_item 扫描**之前**短路返 []（零 DB），保证取题路径 byte-identical 现状。
 */
export async function refillActiveLearningPools(
  db: Db,
  deps: RefillDeps = {},
): Promise<RefillOutcome[]> {
  if (!refillEnabled()) return []; // flag-off → 连 learning_item 扫描都不做（byte-identical）。
  const kids = await activeLearningKnowledgeIds(db);
  if (kids.length === 0) return [];
  return refillThinPools(db, kids, deps);
}
