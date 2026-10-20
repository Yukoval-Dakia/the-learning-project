// YUK-1560 — 夜间任务入队前的确定性资格判定（ADR-0075 D6 / §3）。
//
// 阈值在这里，调用方不能改。判断不调模型。kernel 无 IO：信号由
// src/server/orchestration/nightly-signals.ts 读表后传入。

export const ACTIVITY_ACTIVE_MS = 24 * 60 * 60 * 1000;
export const ACTIVITY_IDLE_MS = 3 * 24 * 60 * 60 * 1000;
export const ACTIVITY_DORMANT_MS = 14 * 24 * 60 * 60 * 1000;

/** 正反馈生产者 pending 提议上限。与 frontier 每夜写入上限是同一个数。 */
export const FRONTIER_PENDING_CAP = 5;

/** 空闲档「回来练两次」：两次练习 × 前沿每次 5 题。 */
export const RETURN_STOCK_QUESTIONS = 10;

export const LEARNING_EVENT_ACTIONS = [
  'attempt',
  'review',
  'experimental:assessment_attempt',
  'experimental:record_capture',
] as const;

export const MEMORY_BRIEF_SWEEP_JOB = 'memory_brief_sweep';

export const REFLECTION_BRIEF_SCOPE_KEYS = ['global', 'meta:orchestrator_self'] as const;

export type ActivityTier = 'active' | 'recent' | 'idle' | 'dormant';

export type NightlyJobClass =
  | 'reflection'
  | 'supply'
  | 'structure'
  | 'deterministic'
  | 'hygiene_dedup'
  | 'hygiene_embed';

export interface NightlySignals {
  job: string;
  tier: ActivityTier;
  /** ISO 时间；从未有过允许推导的学习事件则为 null。 */
  lastLearnerEventAt: string | null;
  /** goal 无日期列，读不到考试窗口时调用方传 false。 */
  examWindow: boolean;
  newLearnerEvidence: boolean;
  treeChanged: boolean;
  embedPending: boolean;
  findingsOpen: number;
  pendingEdgeProposals: number;
  returnStockShort: boolean;
  /** 该 job 最近终态里、从最新一夜往前连续 degraded 的夜数。 */
  degradedNights: number;
}

export type EligibilityDecision =
  | { run: true }
  | { run: false; reason: string; defect?: 'consecutive_degraded' };

export interface EligibilityOptions {
  /** 确定性批处理里会调模型的那一支。空闲/休眠不跑。 */
  usesModel?: boolean;
  /** frontier：自己名下 pending 达到上限则不跑。 */
  respectPendingCap?: boolean;
}

export type NightlyEligibilityFn = (signals: NightlySignals) => EligibilityDecision;

export function classifyActivityTier(input: {
  now: Date;
  lastLearnerEventAt: Date | null;
  examWindow: boolean;
}): ActivityTier {
  if (input.examWindow) return 'active';
  if (!input.lastLearnerEventAt) return 'dormant';
  const age = input.now.getTime() - input.lastLearnerEventAt.getTime();
  if (age < ACTIVITY_ACTIVE_MS) return 'active';
  if (age < ACTIVITY_IDLE_MS) return 'recent';
  if (age < ACTIVITY_DORMANT_MS) return 'idle';
  return 'dormant';
}

function skip(signals: NightlySignals, why: string): EligibilityDecision {
  const when = signals.lastLearnerEventAt ?? 'never';
  return { run: false, reason: `${signals.tier}: ${why} (last learner event ${when})` };
}

function reflectionDecision(signals: NightlySignals): EligibilityDecision {
  if (signals.tier === 'idle' || signals.tier === 'dormant') {
    return skip(signals, 'reflection agents stay off');
  }
  if (signals.tier === 'recent') {
    return signals.newLearnerEvidence
      ? { run: true }
      : skip(signals, 'no new learner evidence since last success');
  }
  if (signals.newLearnerEvidence || signals.findingsOpen > 0) return { run: true };
  return skip(signals, 'no new learner evidence and no open findings');
}

function supplyDecision(signals: NightlySignals): EligibilityDecision {
  if (signals.tier === 'dormant') return skip(signals, 'supply stays off');
  if (signals.tier === 'idle') {
    return signals.returnStockShort
      ? { run: true }
      : skip(signals, 'return stock already covers two sessions');
  }
  return { run: true };
}

function structureDecision(
  signals: NightlySignals,
  respectPendingCap: boolean,
): EligibilityDecision {
  if (respectPendingCap && signals.pendingEdgeProposals >= FRONTIER_PENDING_CAP) {
    return skip(
      signals,
      `pending edge proposals ${signals.pendingEdgeProposals} reached cap ${FRONTIER_PENDING_CAP}`,
    );
  }
  if (signals.tier === 'dormant') return skip(signals, 'structure maintenance stays off');
  if (signals.tier === 'idle') {
    return signals.findingsOpen > 0 ? { run: true } : skip(signals, 'no open findings');
  }
  if (signals.treeChanged || signals.findingsOpen > 0) return { run: true };
  return skip(signals, 'tree unchanged and no open findings');
}

function deterministicDecision(signals: NightlySignals, usesModel: boolean): EligibilityDecision {
  if (signals.tier === 'dormant') return skip(signals, 'only housekeeping runs');
  if (signals.tier === 'idle' && usesModel) return skip(signals, 'model batch stays off');
  return { run: true };
}

export function eligibilityFor(
  jobClass: NightlyJobClass,
  signals: NightlySignals,
  opts: EligibilityOptions = {},
): EligibilityDecision {
  if (signals.degradedNights >= 2) {
    const when = signals.lastLearnerEventAt ?? 'never';
    return {
      run: false,
      defect: 'consecutive_degraded',
      reason: `${signals.tier}: two consecutive degraded nights (last learner event ${when})`,
    };
  }
  switch (jobClass) {
    case 'hygiene_dedup':
      return { run: true };
    case 'hygiene_embed':
      return signals.embedPending ? { run: true } : skip(signals, 'no null embeddings');
    case 'reflection':
      return reflectionDecision(signals);
    case 'supply':
      return supplyDecision(signals);
    case 'structure':
      return structureDecision(signals, opts.respectPendingCap ?? false);
    case 'deterministic':
      return deterministicDecision(signals, opts.usesModel ?? false);
  }
}

export function nightlyEligibility(
  jobClass: NightlyJobClass,
  opts?: EligibilityOptions,
): NightlyEligibilityFn {
  return (signals) => eligibilityFor(jobClass, signals, opts);
}
