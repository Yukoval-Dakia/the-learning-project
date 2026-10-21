// B1 (ADR-0035 决定#2) — PFA p(L) 掌握诊断投影。纯函数、无 IO、跨学科。
//
// ADR-0035 的规范形态是 logit(p) = β_kc + γ·success + ρ·fail。本实现把 KC 代表性
// hard-track item_calibration.b 当作难度方向来源，以负号进入：logit = γ·success +
// ρ·fail − β。β 越大（题越难），同样的对错历史证明的掌握越低。ρ 自带负号，与
// Pavlik 2009 一致；ADR 是单一真相，故不做 -ρ·fail 的外提写法。
//
// γ/ρ 是 owner 拍板、经 review 的模块常量，不是等待 refit 的占位：仓库没有任何
// refit γ/ρ 的 job，nightly 只 refit item 难度。n=1 下也没有 cohort 可回归。
// YUK-539 retune（γ 0.4→0.5、ρ −0.2→−0.25）把硬锚解锁所需的干净连对从 10 降到 8，
// 同时保持 2:1 与 |ρ|<γ；再调只在真实分布或 β 推导方式改变时做。

import { POLY_SIGMOID_ENABLED, polySigmoid } from './poly-exp';

/** Logistic CDF; the flag swaps in the bit-exact polynomial σ. */
function sigmoid(x: number): number {
  return POLY_SIGMOID_ENABLED ? polySigmoid(x) : 1 / (1 + Math.exp(-x));
}

/**
 * Owner-fixed PFA coefficients: γ=0.5 per success, ρ=−0.25 per fail, keeping the
 * 2:1 ratio |ρ|<γ. Retune only through a reviewed PR; see the file header.
 */
export const PFA_GAMMA = 0.5;
export const PFA_RHO = -0.25;

/**
 * Enables difficulty-aware β. Always true on the live projection; the flag is a
 * quick-return switch if β calibration misbehaves, not a second projection path.
 */
export const PFA_DIFFICULTY_AWARE = true;

/**
 * PFA logit: γ·success + ρ·fail − β. β is the KC's representative IRT difficulty,
 * entering negatively so harder items lower p(L); 0 means no anchor.
 */
export function pfaLogit(
  beta: number,
  gamma: number,
  rho: number,
  success: number,
  fail: number,
): number {
  // β enters negatively: harder item, lower p(L).
  return gamma * success + rho * fail - beta;
}

/**
 * p(L) = σ(pfaLogit(...)). Cold start (0/0, β=0) is 0.5, not a placeholder. Monotone
 * in success↑, fail↑, and β↑.
 */
export function pLearned(
  beta: number,
  gamma: number,
  rho: number,
  success: number,
  fail: number,
): number {
  return sigmoid(pfaLogit(beta, gamma, rho, success, fail));
}

/** p(L) 置信带 — 点估计 + 上下界 + low-confidence 旗。 */
export interface PLearnedBand {
  /** 下界（点 logit − thetaSe，过 σ）。 */
  lo: number;
  /** 点估计（pointLogit 过 σ）。 */
  point: number;
  /** 上界（点 logit + thetaSe，过 σ）。 */
  hi: number;
  /** θ̂ 仍不确定时为 true（thetaSe ≥ {@link LOW_CONFIDENCE_SE_THRESHOLD}）。 */
  lowConfidence: boolean;
}

/**
 * Low-confidence threshold: SE at or above this marks the point estimate as
 * untrustworthy, so presentation should show the band. 1.0 is the no-evidence SE;
 * owner-fixed and unrelated to γ/ρ or the frontier evidence gate.
 */
export const LOW_CONFIDENCE_SE_THRESHOLD = 1.0;

/**
 * Convert point logit and θ SE into a p(L) band: ±SE on the logit scale, then σ.
 * The band is symmetric in logit space and therefore asymmetric in p, which is the
 * correct logit-normal behaviour.
 */
export function pLearnedBand(pointLogit: number, thetaSe: number): PLearnedBand {
  const se = Math.max(thetaSe, 0);
  return {
    lo: sigmoid(pointLogit - se),
    point: sigmoid(pointLogit),
    hi: sigmoid(pointLogit + se),
    lowConfidence: se >= LOW_CONFIDENCE_SE_THRESHOLD,
  };
}
