// YUK-361 Phase 1 (观测先行) — selection-signals 纯策略数学。
//
// Cross-subject 信号数学，归 core/（不依赖 IO，不读 DB）。本 lane **零选题行为
// 变更**：只定义信号类型 + 评分/概率 helper + 持久化结构，**不接进
// composeDailyStream / 不改可见选题顺序**。行为变更（候选收集 + 随机化选题 +
// active-PPI 重标定）是 Phase 3（roadmap Task 7-11）。
//
// MFI（Maximum Fisher Information）= p(1−p)，IRT 2PL 在 a=1 时的 item information。
// theta_precision（chain base YUK-361 Phase 2 产物）给高不确定 θ̂ 降权——不确定性
// 越高（precision 越低）的诊断价值越低，避免在噪声大的能力估计上浪费选题预算。
// 权威 spec：docs/superpowers/plans/2026-06-15-personalized-calibration-roadmap.md §Task4。

import { fisherInformation } from '@/core/theta';

/**
 * 选题候选信号。一条候选（题或卷）一行；选题策略据此打分 + 抽样。
 *
 * thetaHat/thetaPrecision/b 三个 IRT 量在 logit 尺度同度量（B1 foundation）。
 * 缺失时由候选收集层（Phase 3）兜底（theta_hat=0 / theta_precision=1 /
 * difficultyToLogitB 弱锚），本 lane 不收集、不兜底——仅定义形状。
 */
export interface SelectionCandidateSignal {
  refKind: 'question' | 'paper';
  refId: string;
  role: 'due' | 'frontier' | 'diagnostic' | 'new_check' | 'paper';
  /** 个体能力估计 θ̂，logit 尺度。缺失（冷启）由 Phase 3 兜底 0。 */
  thetaHat?: number;
  /** θ̂ 的累积 Fisher information（precision）。缺失由 Phase 3 兜底 1（弱先验）。 */
  thetaPrecision?: number;
  /** IRT 难度 b，logit 尺度（item_calibration.b 或 difficulty 弱锚）。 */
  b?: number;
  /** due 槽内的到期排名（FSRS 决定，越小越早到期）。 */
  dueRank?: number;
  /** recall-locked 变体（原题重背，不进 MFI 评分；Phase 3 标 mfi_eligible:false）。 */
  recallLocked?: boolean;

  // ───────────────────────────────────────────────────────────────────────────
  // #52 / ADR-0042 编排档2 amendment（GPT 研究稿 §9.2）——选题不止 MFI 中心。
  // 本 ADR 在本分支上还没有这三个字段，显式加入。**本 lane 只定义 type + 进
  // signals 存储结构，computation 全部留 Phase 3**：值由 Phase 3 候选收集层计算
  // （examRelevance 据考纲映射、misconceptionRecurrence 据错题家族复发频次、
  // transferGap 据迁移缺口诊断），本 lane 仅定 schema，不算任何值。
  // ───────────────────────────────────────────────────────────────────────────
  /** 考纲相关度 0-1（考点权重）。computation-deferred：Phase 3 据考纲映射计算。 */
  examRelevance?: number;
  /** 错误观念复发度 0-1（错题家族复发频次）。computation-deferred：Phase 3 计算。 */
  misconceptionRecurrence?: number;
  /** 迁移缺口 0-1（跨情境迁移诊断）。computation-deferred：Phase 3 计算。 */
  transferGap?: number;
}

/**
 * MFI 评分：2PL（a=1）的 item information = p(1−p)，p = σ(θ̂ − b)。
 * θ̂ = b 时取最大 0.25（信息量最大处 = 能力与难度匹配处）。
 *
 * 直接复用 theta.ts 的 `fisherInformation`（同一 Rasch item information 公式，
 * 与 θ_precision 累积共用同一真相）——避免 core/ 里同公式两份分叉（选题评分
 * 与 θ̂ 不确定性累积必须用同一 item information 定义，否则两端会悄悄漂移）。
 */
export function mfiScore(thetaHat: number, b: number): number {
  return fisherInformation(thetaHat, b);
}

/**
 * 不确定性降权因子 ∈ (0,1)：precision 越高（θ̂ 越确定）越接近 1，
 * precision 越低（噪声大）越接近 0。√precision / (1+√precision) 单调饱和形态，
 * 给高不确定 θ̂ 的诊断价值降权（避免在噪声估计上浪费选题）。
 */
export function uncertaintyPenalty(thetaPrecision: number): number {
  const s = Math.sqrt(Math.max(thetaPrecision, 1e-9));
  return s / (1 + s);
}

/**
 * 诊断评分：MFI × 不确定性降权。高信息量 × 高确定性 → 高诊断价值。
 */
export function diagnosticScore(thetaHat: number, b: number, thetaPrecision: number): number {
  return mfiScore(thetaHat, b) * uncertaintyPenalty(thetaPrecision);
}

/**
 * Softmax 概率（温度可调）。temperature 越低越尖锐（趋近 argmax），越高越均匀。
 * 数值稳定：减最大值后再 exp。空输入返回空数组。
 *
 * 这是 Phase 3 随机化选题的 π_i（inclusion probability）来源：non-due 槽按
 * 评分 softmax 抽样，π_i 是 active-PPI 重标定（D17 推翻后）必需的慢热资产。
 *
 * Fail-fast 护栏（π_i 慢热资产不可被静默污染，同 recordSelectionObservation 哲学）：
 *   - temperature 必须 > 0：T≤0 会除零（→ 全 NaN π_i）或负温反转排序（抽到最差候选）。
 *   - score 必须有限：非有限 score 是上游 bug（θ̂/b 没兜底），fail-fast 而非
 *     产出全 NaN 的 π_i（单个 NaN 经 max/exp 会污染整批分布）。
 *   - 用 reduce 求 max，**不用 `Math.max(...scores)`**——超大候选集 spread 会爆栈。
 */
export function softmaxProbabilities(scores: number[], temperature = 0.25): number[] {
  if (scores.length === 0) return [];
  if (!(temperature > 0)) {
    throw new Error(`softmaxProbabilities: temperature must be > 0, got ${temperature}`);
  }
  let max = Number.NEGATIVE_INFINITY;
  for (const s of scores) {
    if (!Number.isFinite(s)) {
      throw new Error(`softmaxProbabilities: non-finite score ${s}`);
    }
    if (s > max) max = s;
  }
  const exps = scores.map((s) => Math.exp((s - max) / temperature));
  const total = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / total);
}
