// 供给目标发现 + 派发的夜间 job。
//
// 结构上仿 item_prior_backfill.ts：纯发现（discoverSupplyTargets 覆盖缺口 +
// discoverConfusableContrastTargets 易混对比缺口，零写零 LLM）→
// 确定性缺口扫描得 QuestionSupplyTarget[] → dispatchSupplyTargets 把每个目标派到
// 既有获取面（supply_execute：jyeoo / web；quiz_gen 队列）或标 manual。出题（quiz_gen / author）+ 录入
// （OCR）两条创建路径产生的「KC 前沿但缺题」缺口都被此夜扫兜住——无需每条创建路径埋
// hook。
//
// ── 红线：成本 ───────────────────────────────────────────────────────────────
// 这个 cron 让付费获取（Tavily web 找题 + LLM 生成/验证）**自动**发生。唯一的防 job-spam
// 闸是 dispatcher 的 7d query-based fingerprint cooldown（recentDispatchExists）：同一未满足
// 缺口在 7 天窗内只真派一次后台 job，其余扫描命中 cooldown → status='skipped'，不再
// boss.send。本 job **依赖** dispatcher 这层 cooldown 作为成本护栏——绝不在此处绕过
// dispatcher 直发队列。本 job 无自身 cron，由夜间 orchestrator 在标定链（item_prior →
// recalibration）之后触发，让缺口判定读到 firm 过的 b_calib（manifest.ts 的 dependsOn
// 硬边即此保证）。
//
// ── 红线：草稿排除 + 只读消费 ────────────────────────────────────────────────
// 候选 KC 的题池由 discoverSupplyTargets → loadQuestionPool 提供，后者已带 draft 过滤。
// 本 job **不**新增任何绕过该过滤的 active-surface 查询。dispatcher 只 enqueue 既有队列 +
// emit 观测事件，永不写题的 b 锚（item difficulty）——纯只读消费 + 派发，不污染标定轴。

import type { Job } from 'pg-boss';
import type { DispatchResult } from '@/capabilities/practice/public';
import {
  SUPPLY_DISPATCH_COOLDOWN_DAYS,
  dispatchPracticeSupplyTarget,
  dispatchPracticeSupplyTargets as dispatchSupplyTargets,
  inFlightSupplyCount,
} from '@/capabilities/practice/public';
import { discoverConfusableContrastTargets } from '@/capabilities/practice/supply/server/confusable-contrast-discovery';
import { runInventoryShadowDualRead } from '@/capabilities/practice/supply/server/inventory-projection';
import { jyeooBudgetRemaining } from '@/capabilities/practice/supply/server/jyeoo-budget';
import {
  type QuestionSupplyTarget,
  computePriority,
  discoverSupplyTargets,
  targetFingerprint,
} from '@/capabilities/practice/supply/server/target-discovery';
import { newId } from '@/core/ids';
import type { Db } from '@/db/client';
import { loadActivityTier } from '@/kernel/read-models/activity-tier';
import { getEffectiveDomain } from '@/kernel/read-models/knowledge-tree';
import { loadReturnStockGaps } from '@/kernel/read-models/return-stock';
import {
  buildCoverageEvidenceDemand,
  evidenceDemandToTargetContext,
} from '@/kernel/supply-contracts';
import { resolveSubjectProfile } from '@/subjects/profile';

type DispatchDeps = Parameters<typeof dispatchSupplyTargets>[2];

type DepsOverride = {
  /** dispatcher 注入（DB 测试可注入 fake enqueue / cooldown / tavilyAvailable）。 */
  dispatchDeps?: DispatchDeps;
  /**
   * 本轮最多派发多少个供给目标（防一次 cron 打爆付费队列）。default 25。
   */
  maxPerRun?: number;
  /**
   * 空闲 / 回来唤醒：按回归库存缺口派题。数量是补到 RETURN_STOCK 还缺的题，
   * 不走发现器的深度阈值，也不用 maxPerRun 截断。
   */
  returnStock?: boolean;
};

// ── 红线：per-run 派发硬顶 ───────────────────────────────────────────────────
// 这是**防事故硬顶**，不是紧限：cron 让付费获取（Tavily web 找题 + LLM 生成/验证）自动发生，
// 而 dispatcher 的 7d fingerprint cooldown 在**首跑**（cooldown 尚未生效前）拦不住——首跑会把
// discoverSupplyTargets 发现的**全部**缺口一次性 boss.send，首部署 / 大缺口积压时可一次性 flood
// 付费队列。本顶把单轮派发数夹在合理上界：discoverSupplyTargets 返回的目标**已按 priority 降序**
// 排好（见 target-discovery.ts），故 slice top-N 即「派最高优先级的 N 个，其余留下次夜跑」。
// 取 25 对齐其它付费夜 job（item_prior_backfill DEFAULT_MAX_PER_RUN=25，同 LLM 付费惯例）——
// 比 recalibration（200，纯本地计算无付费）保守。截掉的目标无 cooldown 副作用（未 dispatch →
// 无 fingerprint 落库），下轮自然按新优先级重新发现 + 派发。
const DEFAULT_MAX_PER_RUN = 25;

export interface QuestionSupplyNightlyResult {
  /** discoverSupplyTargets 发现的供给目标**总数**（缺口数，per-run cap 之前）。 */
  discovered: number;
  /** 本轮实际进入派发的目标数（= min(discovered, maxPerRun)，硬顶后）。 */
  considered: number;
  /** per-run cap 截掉、留待下轮的目标数（discovered − considered）。 */
  deferred: number;
  /** 真派到后台队列的目标数（status='dispatched'）。 */
  dispatched: number;
  /** 无后台队列、留给人工/UI 的目标数（status='manual'）。 */
  manual: number;
  /** cooldown / 无锚等被跳过的目标数（status='skipped'）。 */
  skipped: number;
  /** 派发抛错的目标数（status='failed'）。 */
  failed: number;
}

function tallyByStatus(results: DispatchResult[], discovered: number): QuestionSupplyNightlyResult {
  const out: QuestionSupplyNightlyResult = {
    discovered,
    considered: results.length,
    deferred: Math.max(0, discovered - results.length),
    dispatched: 0,
    manual: 0,
    skipped: 0,
    failed: 0,
  };
  for (const r of results) {
    switch (r.status) {
      case 'dispatched':
        out.dispatched++;
        break;
      case 'manual':
        out.manual++;
        break;
      case 'skipped':
        out.skipped++;
        break;
      case 'failed':
        out.failed++;
        break;
    }
  }
  return out;
}

function emptyTally(discovered = 0): QuestionSupplyNightlyResult {
  return {
    discovered,
    considered: 0,
    deferred: discovered,
    dispatched: 0,
    manual: 0,
    skipped: 0,
    failed: 0,
  };
}

function returnStockTarget(
  subjectId: string,
  knowledgeId: string,
  missing: number,
): QuestionSupplyTarget {
  // 与普通覆盖补题共用指纹：在途的那次派发算承诺；死掉的冷却不占缺口，改派下一个知识点。
  const fingerprint = targetFingerprint({
    subjectId,
    knowledgeIds: [knowledgeId],
    kind: 'any',
    difficultyBand: 'near',
    gapKind: 'frontier_zero',
    minSourceTier: 2,
  });
  const demand = buildCoverageEvidenceDemand({
    subjectId,
    knowledgeIds: [knowledgeId],
    statement: `return stock for knowledge ${knowledgeId} is short by ${missing}`,
    eligibleCount: missing,
  });
  return {
    id: newId(),
    fingerprint,
    gapKind: 'frontier_zero',
    subjectId,
    knowledgeIds: [knowledgeId],
    kind: 'any',
    difficultyBand: 'near',
    desiredCount: missing,
    minSourceTier: 2,
    routePreference: [],
    priority: computePriority('frontier_zero', 0),
    reason: `return stock for knowledge ${knowledgeId} is short by ${missing}`,
    constraints: {},
    context: evidenceDemandToTargetContext(demand),
  };
}

async function subjectForReturnStock(
  db: Db,
  gapSubjectId: string | null,
  knowledgeId: string,
): Promise<string | null> {
  if (gapSubjectId) return gapSubjectId;
  try {
    return resolveSubjectProfile(await getEffectiveDomain(db, knowledgeId)).id;
  } catch (err) {
    console.warn(
      `[question_supply_nightly] return stock has no subject for knowledge ${knowledgeId}`,
      err,
    );
    return null;
  }
}

function failedReturnStockDispatch(target: QuestionSupplyTarget, err: unknown): DispatchResult {
  const message = err instanceof Error ? err.message : String(err);
  return {
    targetId: target.id,
    fingerprint: target.fingerprint,
    routePlan: [],
    chosenRoute: null,
    status: 'failed',
    jobId: null,
    stopCondition: `dispatchSupplyTarget threw: ${message}`,
    reason: target.reason,
  };
}

async function returnStockCovered(
  db: Db,
  result: DispatchResult,
  requested: number,
  cooldownDays: number,
): Promise<number> {
  if (result.status === 'dispatched') return requested;
  if (result.status !== 'skipped' || !result.stopCondition.startsWith('cooldown:')) return 0;
  const live = await inFlightSupplyCount(db, result.fingerprint, cooldownDays);
  return Math.min(requested, live);
}

async function dispatchReturnStock(
  db: Db,
  deps: DepsOverride,
): Promise<QuestionSupplyNightlyResult> {
  const gaps = await loadReturnStockGaps(db);
  if (gaps.length === 0) return emptyTally();
  const cooldownDays = deps.dispatchDeps?.cooldownDays ?? SUPPLY_DISPATCH_COOLDOWN_DAYS;
  const results: DispatchResult[] = [];
  for (const gap of gaps) {
    let remaining = gap.missing;
    for (const knowledgeId of [...new Set(gap.knowledgeIds)].sort()) {
      if (remaining <= 0) break;
      const subjectId = await subjectForReturnStock(db, gap.subjectId, knowledgeId);
      if (!subjectId) continue;
      const target = returnStockTarget(subjectId, knowledgeId, remaining);
      let result: DispatchResult;
      try {
        result = await dispatchPracticeSupplyTarget(db, target, deps.dispatchDeps);
      } catch (err) {
        console.error(
          `[question_supply_nightly] return stock dispatch threw for ${target.fingerprint}`,
          err,
        );
        result = failedReturnStockDispatch(target, err);
      }
      results.push(result);
      remaining -= await returnStockCovered(db, result, remaining, cooldownDays);
    }
  }
  if (results.length === 0) {
    console.warn(
      '[question_supply_nightly] return stock is short but no knowledge id could be dispatched',
    );
  }
  return tallyByStatus(results, results.length);
}

// 对比缺口是附加来源：读取失败只丢这一路，覆盖缺口照常派发。
async function discoverContrastTargetsIsolated(db: Db): Promise<QuestionSupplyTarget[]> {
  try {
    return await discoverConfusableContrastTargets(db);
  } catch (err) {
    console.error(
      '[question_supply_nightly] confusable contrast discovery failed; dispatching coverage gaps only',
      err,
    );
    return [];
  }
}

async function runSupplyDiscoveryAndDispatch(
  db: Db,
  deps: DepsOverride,
): Promise<QuestionSupplyNightlyResult> {
  if (deps.returnStock) return dispatchReturnStock(db, deps);
  const coverageTargets = await discoverSupplyTargets(db, undefined, {
    observeInventory: async (input, currentTargets) => {
      await runInventoryShadowDualRead(db, input, currentTargets);
    },
  });
  // 易混对比缺口与覆盖缺口同表排序，共用 per-run 硬顶与 dispatcher cooldown。
  // 稳定排序：同优先级保持覆盖缺口在前。
  const targets = [...coverageTargets, ...(await discoverContrastTargetsIsolated(db))].sort(
    (a, b) => b.priority - a.priority,
  );
  if (targets.length === 0) return emptyTally();
  // per-run 硬顶：targets 已按 priority 降序，slice top-N 即派最高
  // 优先级的 N 个，其余留下轮（截掉的目标不 dispatch ⇒ 无 fingerprint 落库 ⇒ 无 cooldown 副作用）。
  const dispatchTargets = targets.slice(0, deps.maxPerRun ?? DEFAULT_MAX_PER_RUN);
  if (dispatchTargets.length === 0) return emptyTally(targets.length);
  // jyeoo 付费抓取只经这里：路由规则读当日余额，派发数仍是上面的 per-run 硬顶。
  const results = await dispatchSupplyTargets(db, dispatchTargets, {
    ...deps.dispatchDeps,
    jyeooBudgetRemaining:
      deps.dispatchDeps?.jyeooBudgetRemaining ?? (await jyeooBudgetRemaining(db)),
  });
  return tallyByStatus(results, targets.length);
}

/**
 * 端到端夜扫：发现供给目标 → 写 observe-only inventory dual-read → 派发到既有获取面。
 * 不新增 AI task；shadow 写入失败由 discovery seam 隔离，不改变 targets 或派发。空目标时
 * 供给腿零派发早返回（不触付费 job）。placement starter claim 的到期清扫自 YUK-1664 起
 * 由独立的 placement_starter_recovery job 负责，不再挂在本 job 尾部。
 */
export async function runQuestionSupplyNightly(
  db: Db,
  deps: DepsOverride = {},
): Promise<QuestionSupplyNightlyResult> {
  return runSupplyDiscoveryAndDispatch(db, deps);
}

export function buildQuestionSupplyNightlyHandler(
  db: Db,
  deps: DepsOverride = {},
): (jobs: Job<Record<string, never>>[]) => Promise<void> {
  return async () => {
    try {
      const returnStock =
        deps.returnStock === true ||
        (deps.maxPerRun === undefined && (await loadActivityTier(db, new Date())) === 'idle');
      const result = await runQuestionSupplyNightly(
        db,
        returnStock ? { dispatchDeps: deps.dispatchDeps, returnStock: true } : deps,
      );
      console.log('[question_supply_nightly] result', result);
    } catch (err) {
      // PRE-discovery / dispatch 阶段的意外 throw（如 DB read 故障）冒泡 → pg-boss DLQ 重试。
      // 单个 target 的 dispatch 错已被 dispatchSupplyTargets 内部 per-target try/catch 兜住
      // （合成 failed 结果计入返回），不会到这里。
      console.error('[question_supply_nightly] failed', err);
      throw err;
    }
  };
}
