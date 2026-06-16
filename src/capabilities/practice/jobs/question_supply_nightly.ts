// YUK-372 L5 (YUK-361 Phase 8 wire-up) — 供给目标发现 + 派发的夜间 job。
//
// 结构上仿 item_prior_backfill.ts：纯发现（discoverSupplyTargets，零写零 LLM）→
// 确定性缺口扫描得 QuestionSupplyTarget[] → dispatchSupplyTargets 把每个目标派到
// 既有获取面（sourcing / quiz_gen 队列）或标 manual。出题（quiz_gen / author）+ 录入
// （OCR）两条创建路径产生的「KC 前沿但缺题」缺口都被此夜扫兜住——无需每条创建路径埋
// hook。
//
// ── 红线：成本（G-COST）─────────────────────────────────────────────────────
// 这个 cron 让付费获取（Tavily web 找题 + LLM 生成/验证）**自动**发生。唯一的防 job-spam
// 闸是 dispatcher 的 7d query-based fingerprint cooldown（recentDispatchExists，commit
// 30784420 review FINDING #1/#2）：同一未满足缺口在 7 天窗内只真派一次后台 job，其余扫描
// 命中 cooldown → status='skipped'，不再 boss.send。本 job **依赖** dispatcher 这层 cooldown
// 作为成本护栏——绝不在此处绕过 dispatcher 直发队列。cron 排在数据预产链之后（item_prior
// 04:20 / mastery 夜链 / compose 05:30 之前的 06:00），让选题信号已新鲜、缺口判定准确。
//
// ── 红线：草稿排除（G5）+ 只读消费（G3）─────────────────────────────────────
// 候选 KC 的题池由 discoverSupplyTargets → loadQuestionPool 提供，后者已带 draft 过滤
// （commit 4cdf0577）。本 job **不**新增任何绕过该过滤的 active-surface 查询。dispatcher
// 只 enqueue 既有队列 + emit 观测事件，永不写题的 b 锚（item difficulty）——纯只读消费 +
// 派发，不污染标定轴。

import type { Db } from '@/db/client';
import type { DispatchResult } from '@/server/question-supply/dispatcher';
import { dispatchSupplyTargets } from '@/server/question-supply/dispatcher';
import { discoverSupplyTargets } from '@/server/question-supply/target-discovery';
import type { Job } from 'pg-boss';

type DispatchDeps = Parameters<typeof dispatchSupplyTargets>[2];

type DepsOverride = {
  /** dispatcher 注入（DB 测试可注入 fake enqueue / cooldown / tavilyAvailable）。 */
  dispatchDeps?: DispatchDeps;
  /**
   * Codex review F3 — 本轮最多派发多少个供给目标（防一次 cron 打爆付费队列）。default 25。
   */
  maxPerRun?: number;
};

// ── 红线：per-run 派发硬顶（G-COST，Codex review F3）──────────────────────────
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
  /** 本轮实际进入派发的目标数（= min(discovered, maxPerRun)，F3 硬顶后）。 */
  considered: number;
  /** per-run cap 截掉、留待下轮的目标数（discovered − considered，F3 观测）。 */
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

/**
 * 端到端夜扫：发现供给目标 → 派发到既有获取面。零写、零新 AI task（dispatcher 只 enqueue
 * 既有队列 + emit 观测事件）。空目标早返回（零派发，不触付费 job）。
 */
export async function runQuestionSupplyNightly(
  db: Db,
  deps: DepsOverride = {},
): Promise<QuestionSupplyNightlyResult> {
  const maxPerRun = deps.maxPerRun ?? DEFAULT_MAX_PER_RUN;
  const targets = await discoverSupplyTargets(db);
  if (targets.length === 0) {
    return {
      discovered: 0,
      considered: 0,
      deferred: 0,
      dispatched: 0,
      manual: 0,
      skipped: 0,
      failed: 0,
    };
  }
  // F3 per-run 硬顶：targets 已按 priority 降序（target-discovery.ts），slice top-N 即派最高
  // 优先级的 N 个，其余留下轮（截掉的目标不 dispatch ⇒ 无 fingerprint 落库 ⇒ 无 cooldown 副作用）。
  const dispatchTargets = targets.slice(0, maxPerRun);
  const results = await dispatchSupplyTargets(db, dispatchTargets, deps.dispatchDeps);
  return tallyByStatus(results, targets.length);
}

export function buildQuestionSupplyNightlyHandler(
  db: Db,
): (jobs: Job<Record<string, never>>[]) => Promise<void> {
  return async () => {
    try {
      const result = await runQuestionSupplyNightly(db);
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
