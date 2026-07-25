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
// 作为成本护栏——绝不在此处绕过 dispatcher 直发队列。YUK-758 起本 job 无自身 cron，由夜间
// orchestrator 在标定链（item_prior → recalibration）之后触发，让缺口判定读到 firm 过的
// b_calib（manifest.ts 的 dependsOn 硬边即此保证）。（旧注「mastery 夜链」已删——该 job
// 从不存在，mastery_state 在线写入；YUK-377 复审 §6.4。）
//
// ── 红线：草稿排除（G5）+ 只读消费（G3）─────────────────────────────────────
// 候选 KC 的题池由 discoverSupplyTargets → loadQuestionPool 提供，后者已带 draft 过滤
// （commit 4cdf0577）。本 job **不**新增任何绕过该过滤的 active-surface 查询。dispatcher
// 只 enqueue 既有队列 + emit 观测事件，永不写题的 b 锚（item difficulty）——纯只读消费 +
// 派发，不污染标定轴。

import type { Db } from '@/db/client';
import type { DispatchResult } from '@/server/question-supply/dispatcher';
import { dispatchSupplyTargets } from '@/server/question-supply/dispatcher';
import { runInventoryShadowDualRead } from '@/server/question-supply/inventory-projection';
import { discoverSupplyTargets } from '@/server/question-supply/target-discovery';
import type { Job } from 'pg-boss';
import type {
  PlacementStarterRecoveryDeps,
  PlacementStarterRecoveryResult,
} from '../server/placement-starter-recovery';
import {
  emptyPlacementStarterRecoveryResult,
  sweepStalePlacementStarterClaims,
} from '../server/placement-starter-recovery';

type DispatchDeps = Parameters<typeof dispatchSupplyTargets>[2];

type DepsOverride = {
  /** dispatcher 注入（DB 测试可注入 fake enqueue / cooldown / tavilyAvailable）。 */
  dispatchDeps?: DispatchDeps;
  /**
   * Codex review F3 — 本轮最多派发多少个供给目标（防一次 cron 打爆付费队列）。default 25。
   */
  maxPerRun?: number;
  /** YUK-761 — 尾部 placement starter 恢复清扫器的注入（DB 测试可注入 fake dispatch / now）。 */
  placementRecovery?: PlacementStarterRecoveryDeps;
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
  /**
   * YUK-761 — 尾部 placement starter claim 恢复清扫结果（重驱 stranded pending_dispatch +
   * 收割 zombie retry_scheduled）。见 server/placement-starter-recovery.ts。
   */
  placementStarterRecovery: PlacementStarterRecoveryResult;
}

type SupplyTally = Omit<QuestionSupplyNightlyResult, 'placementStarterRecovery'>;

function tallyByStatus(results: DispatchResult[], discovered: number): SupplyTally {
  const out: SupplyTally = {
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

async function runSupplyDiscoveryAndDispatch(db: Db, deps: DepsOverride): Promise<SupplyTally> {
  const maxPerRun = deps.maxPerRun ?? DEFAULT_MAX_PER_RUN;
  const targets = await discoverSupplyTargets(db, undefined, {
    observeInventory: async (input, currentTargets) => {
      await runInventoryShadowDualRead(db, input, currentTargets);
    },
  });
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

/**
 * 端到端夜扫：发现供给目标 → 写 observe-only inventory dual-read → 派发到既有获取面 →
 * **收尾**跑 placement starter claim 恢复清扫（YUK-761）。不新增 AI task；shadow 写入失败由
 * discovery seam 隔离，不改变 targets 或派发。空目标时供给腿零派发早返回（不触付费 job），
 * 但收尾清扫**照跑**——stranded claim 的存在与今夜有无供给缺口无关。
 */
export async function runQuestionSupplyNightly(
  db: Db,
  deps: DepsOverride = {},
): Promise<QuestionSupplyNightlyResult> {
  // 供给腿的失败**不得**吞掉收尾清扫。stranded claim 的存在与供给腿今夜是否成功完全无关——
  // 若把清扫挂在供给腿的成功路径上，一个与 placement 毫不相干的持续故障（供给发现 DB 读失败
  // 之类）就会让本清扫器**永远不运行**，而它要修的恰恰是「学习者不回来就没人重驱」的场景。
  // 故：供给腿的错先接住，清扫照跑，最后再把原错抛出去（保住宿主的 DLQ 重试语义不变）。
  let supply: SupplyTally | undefined;
  let supplyError: unknown;
  try {
    supply = await runSupplyDiscoveryAndDispatch(db, deps);
  } catch (err) {
    supplyError = err;
  }

  // YUK-761 收尾步：消费 placement_starter_claim_recovery_idx / next_reconcile_at（YUK-452
  // Phase B 建好但一直无消费者的基建）。挂在这只既有 nightly job 尾部而非新开 cron 面——它与
  // 供给腿同属「缺题自愈」职责，且共享同一 DLQ 重试语义。清扫器自身分 leg / claim / 内层三环
  // 隔离失败，并对每个 claim 做条件 UPDATE 领取（幂等、不双发）。
  //
  // **宿主隔离（必须）**：整轮清扫的 top-level 抛错在此就地吞掉 + loud log，绝不冒泡。理由有
  // 二：① 供给腿此刻**可能已经派出付费 job**，让 job 失败 → pg-boss 重投 → 整轮供给发现 + 派发
  // 重跑（只有 dispatcher 的 7d fingerprint cooldown 挡着，不是白挡但也不该主动去撞）；
  // ② YUK-758 起 question_supply_nightly 是编排 DAG 成员，节点 failed 会让其**硬下游按
  // skipped 语义整片跳过**——爆炸半径从「一只 job」变成「一条子树」。恢复清扫是尽力而为的
  // 后台卫生工作，没有任何资格拿走那条子树。失败留在 errored 标里由日志/结果面暴露。
  //
  // 仍存在的、**故意不修**的缺口：本 job 作为 DAG 成员若被硬上游 failed/skipped 连带跳过，
  // 整个节点（含本清扫）今夜不跑。这对清扫器无害——claim 持久、游标已过期，下一轮自然接上；
  // 为它另开一条 cron 面就是「新开 cron 面」的反面教材，且与本票范围相悖。
  let placementStarterRecovery: PlacementStarterRecoveryResult;
  try {
    placementStarterRecovery = await sweepStalePlacementStarterClaims(db, deps.placementRecovery);
  } catch (err) {
    console.error(
      '[question_supply_nightly] placement starter recovery sweep failed; host job unaffected',
      err,
    );
    placementStarterRecovery = emptyPlacementStarterRecoveryResult({ errored: true });
  }

  // 供给腿的原错在清扫跑完后照常冒泡 → pg-boss DLQ 重试语义与 YUK-761 之前逐字一致。**但先把
  // 清扫状态喊出来**：一旦从这里 throw，下面的 return 不会发生，handler 的消费检查也就永远看不到
  // 这一轮的 placementStarterRecovery——恰恰在「供给腿也炸了」这种最该看清全貌的时刻信号最哑。
  if (supplyError !== undefined) {
    surfacePlacementStarterRecovery(placementStarterRecovery, 'supply leg also failed');
    throw supplyError;
  }
  if (!supply) throw new Error('unreachable: supply tally missing without an error');
  return { ...supply, placementStarterRecovery };
}

/**
 * YUK-761 — emit the recovery sweep's failure/degradation signal at the job boundary.
 *
 * Isolating the sweep keeps it from taking the host (and, since YUK-758, the host's whole
 * hard-downstream DAG subtree) down. But a flag nobody reads is the same as no signal at all: the
 * job would report success with its recovery step silently dead — precisely the 建成不通电 shape
 * this ticket exists to close, one level up. Hence explicit, greppable lines. Deliberately never
 * throws: staying green on a sweep failure is the entire point of the isolation.
 *
 * Called from BOTH exits — the normal one and the supply-error one — so the signal does not
 * disappear exactly when the run is worst.
 */
function surfacePlacementStarterRecovery(
  recovery: PlacementStarterRecoveryResult,
  context: string,
): void {
  if (recovery.errored) {
    console.error(
      `[question_supply_nightly] placement starter recovery sweep did not complete this run (${context}); claims stay overdue for the next run`,
    );
  }
  // Per-claim / per-leg failures are contained inside the sweeper and never set `errored`; surface
  // them too, or a fully-degraded sweep (every claim failing individually) still looks healthy.
  const { claimErrors, legErrors } = recovery;
  if (claimErrors > 0 || legErrors > 0) {
    console.error(
      `[question_supply_nightly] placement starter recovery sweep degraded (${context}): ${claimErrors} claim failure(s), ${legErrors} leg failure(s)`,
    );
  }
}

export function buildQuestionSupplyNightlyHandler(
  db: Db,
  deps: DepsOverride = {},
): (jobs: Job<Record<string, never>>[]) => Promise<void> {
  return async () => {
    try {
      const result = await runQuestionSupplyNightly(db, deps);
      console.log('[question_supply_nightly] result', result);
      surfacePlacementStarterRecovery(result.placementStarterRecovery, 'supply leg succeeded');
    } catch (err) {
      // PRE-discovery / dispatch 阶段的意外 throw（如 DB read 故障）冒泡 → pg-boss DLQ 重试。
      // 单个 target 的 dispatch 错已被 dispatchSupplyTargets 内部 per-target try/catch 兜住
      // （合成 failed 结果计入返回），不会到这里。
      console.error('[question_supply_nightly] failed', err);
      throw err;
    }
  };
}
