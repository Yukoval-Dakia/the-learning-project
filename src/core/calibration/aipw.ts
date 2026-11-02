// 难度标定的纯数值核心：锚定 θ̂ 反推的难度残差/标签与 Hájek AIPW 估计器。
// 写侧（mastery 的 label hook / recalibrateQuestion / family delta）与离线重放共用同一份
// 数值与门槛常量，任何改动都会同时改变生产写入与对照基线。

import { expectedScore, quantile } from '@/core/theta';

// For one observation, p = σ(θ̂ − b_anchor). Dividing the residual (outcome − p) by the
// Fisher information p(1−p) gives the Newton-style step in b on the logit scale:
//   residual_logit = −(outcome − p) / max(p(1−p), MIN_FISHER), clamped ±MAX_RESIDUAL_LOGIT.
// A wrong answer yields a positive (harder) offset; a right answer a negative one.
const MIN_FISHER = 0.05; // p(1−p) floor near p≈0.05/0.95, so the logit step cannot explode.
const MAX_RESIDUAL_LOGIT = 2.0; // Cap one extreme surprise's weight in the mean.

/** One observation's implied difficulty offset in logit scale (wrong → harder). */
export function impliedDifficultyResidual(theta: number, bAnchor: number, outcome: 0 | 1): number {
  const p = expectedScore(theta, bAnchor);
  const fisher = Math.max(p * (1 - p), MIN_FISHER);
  const raw = -(outcome - p) / fisher;
  return Math.max(-MAX_RESIDUAL_LOGIT, Math.min(MAX_RESIDUAL_LOGIT, raw));
}

// ─────────────────────────────────────────────────────────────────────────────
// impliedBLabel — 单次 fixed-anchor IRT 反推的难度标签（Task 11 step 3，ADR-0043 §6）。
//
// 给定 (outcome, theta_snapshot, b_anchor)，反推「这道题对这个能力学习者隐含的难度」：
//   b_label = b_anchor + impliedDifficultyResidual(θ, b_anchor, outcome)
// 即从锚出发沿 1PL 对数似然对 b 走一步牛顿方向：答错 → 更难，答对 → 更易。
// 这是锚定 θ 的反推，不是裸 outcome；单条噪声大，池上聚合去噪。
// ─────────────────────────────────────────────────────────────────────────────
export function impliedBLabel(theta: number, bAnchor: number, outcome: 0 | 1): number {
  return bAnchor + impliedDifficultyResidual(theta, bAnchor, outcome);
}

// ─────────────────────────────────────────────────────────────────────────────
// aipwMean — AIPW / PPI rectifier 均值，Hájek 自归一化形：
//   aipwMean = predictionMean(pool) + [Σ_labeled(ξ_j/π_j)] / [Σ_labeled(1/π_j)]
//   ξ_j = label_j − 锚预测_j
// 先在整池取锚预测均值（低方差但有偏），再用已标注子集的残差做自归一化 IPW 校正。
// 分母必须是精确的 Σ(1/π)；labeled 为空 → 校正项 0。π ≤ 0 抛错（positivity）。
// ─────────────────────────────────────────────────────────────────────────────
export interface LabeledResidual {
  /** ξ = label − 锚预测（该已标注样本的残差）。 */
  residual: number;
  /** π = 真随机抽样的 inclusion probability ∈ (0, 1]。≤0 抛错（positivity）。 */
  pi: number;
}

export function aipwMean(
  poolPredictions: number[],
  labeledResiduals: LabeledResidual[],
  capFactor: number = IPW_WEIGHT_CAP_C,
): number {
  const N = poolPredictions.length;
  if (N === 0) {
    throw new Error('aipwMean: poolPredictions must be non-empty (N=0 → undefined mean)');
  }
  const predictionMean = poolPredictions.reduce((a, b) => a + b, 0) / N;
  // positivity 先于 cap（YUK-558 M1）——IPW 权重分母 ≤0 是上游 bug（伪 π / 确定性选题），
  // fail-fast，且必须先于截权（cap 不救 ≤0 的 π）。
  for (const r of labeledResiduals) {
    if (!(Number.isFinite(r.pi) && r.pi > 0)) {
      throw new Error(
        `aipwMean: inclusion probability must be a finite number > 0 (positivity), got ${r.pi}`,
      );
    }
  }
  // median-相对截权（与 ppiPlusMean(λ=1) 恒等；aipwMean 保留导出）。
  const { weights } = cappedIpwWeights(
    labeledResiduals.map((r) => r.pi),
    capFactor,
  );
  let residualCorrection = 0;
  let weightSum = 0; // Σ(capped 1/π)，Hájek 分母。
  for (let i = 0; i < labeledResiduals.length; i++) {
    const r = labeledResiduals[i];
    const w = weights[i];
    // 未截项保留 residual/π 单舍入，与旧实现逐位一致；截项走 residual*w。
    residualCorrection += w === 1 / r.pi ? r.residual / r.pi : r.residual * w;
    weightSum += weights[i];
  }
  // Hájek 自归一化：÷ Σ(capped 1/π)；labeled 为空 → 校正项 0。
  return predictionMean + (weightSum > 0 ? residualCorrection / weightSum : 0);
}

/** AIPW / PPI++ 的已标注样本（label = b_label，prediction = 锚预测 m̂）。 */
export interface LabeledSample {
  /** 难度标签 b_label（该样本反推的隐含难度）。 */
  label: number;
  /** 该样本的锚预测 m̂（= b_anchor，候选池预测同源）。 */
  prediction: number;
  /** 真随机抽样 inclusion probability ∈ (0, 1]。 */
  pi: number;
}

// 该题攒够这么多 difficulty_calibration_label 条才 firm-up b_calib；未达则不写，
// effectiveB 退回 b_anchor ?? b。owner 可调的保守起步值（单题标签稀疏）。
export const RECALIBRATION_MIN_LABELS = 12;

// ─────────────────────────────────────────────────────────────────────────────
// IPW_WEIGHT_CAP_C — median-相对 IPW 截权常数（owner 拍 C=4）。
//
// 保守初值，非拟合结果：单条标签权重 1/π 封顶于 C·median(该题标签批内未截权重)。
// median-相对而非绝对 floor：honest 权重尺度随候选池增长，固定 floor 在大池时把
// 所有权重压平成无权均值。
//
// 这是 deliberate bias-for-variance 交易，不免费：截权拉向高-π 标签的均值，部分
// 重引入 IPW 要去除的 selection bias。默认 ON 只立足「首写不可逆 + 在线消费不可回放
// ⇒ 有界方差优于无偏」。回滚旋钮 = C = Infinity，精确还原 uncapped 旧行为。
// ─────────────────────────────────────────────────────────────────────────────
export const IPW_WEIGHT_CAP_C = 4;

/**
 * 批内 median-相对截权：w_j = min(1/π_j, C·median(1/π))。
 *
 * positivity throw 由 caller 先行（cap 不救 ≤0 的 π）。capFactor=Infinity ⇒ cap 永不
 * bind，weights 与原始 1/π 逐位相等，精确还原旧行为。下方 `1/pi` 必须保持字面除法：
 * estimator 用 `w === 1/π` 判别未截项，改写成 Math.pow 会破坏逐位回滚。
 *
 * @returns weights 与 pis 等长同序；clipped 为被截权条数。
 */
export function cappedIpwWeights(
  pis: number[],
  capFactor: number = IPW_WEIGHT_CAP_C,
): { weights: number[]; clipped: number } {
  if (pis.length === 0) return { weights: [], clipped: 0 };
  const raw = pis.map((pi) => 1 / pi);
  // 批内未截权重中位数（quantile type-7，与旧 medianOfWeights 偶数取中两点均值逐位一致）。
  // 空数组已被上方 early-return 挡 ⇒ quantile 的 NaN-on-empty 契约不可达。
  const cap = capFactor * quantile(raw, 0.5);
  let clipped = 0;
  const weights = raw.map((w) => {
    if (w > cap) {
      clipped++;
      return cap;
    }
    return w;
  });
  return { weights, clipped };
}
