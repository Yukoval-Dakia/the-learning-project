// B1-W1 (ADR-0035 阶段② Elo/θ 追踪) — 纯函数 Elo θ̂ 在线更新。
//
// 只更新 θ̂；b 是锁死外部锚，永不回写（G4 红线，item-更新半边 n=1 结构性失效）。
// 喂 PFA p(L) 诊断维，不碰 FSRS R 调度维。
//
// K 不按 1/√n 单调衰减（VERIFY:elo-k-schedule 已 REFUTED）：非平稳上升的 θ 会被
// downward lag bias 拖住。这里用有界 K：冷启段 kCold，之后 kFloor，永不衰到 0。
//
// θ̂_min 属选题/MFI 聚合语义（ADR-0042），不是本模块的 ex-post 更新语义。
// ADR-0046 §4 的 live θ̂ 迁移窗口与豁免登记见该 ADR 的「豁免登记」R3/R4。

import { POLY_SIGMOID_ENABLED, polySigmoid } from './poly-exp';

/** Logistic CDF. The dark flag swaps Math.exp for the shared bit-exact polynomial. */
function logistic(x: number): number {
  return POLY_SIGMOID_ENABLED ? polySigmoid(x) : 1 / (1 + Math.exp(-x));
}

/** P(correct) under the 1PL ICC; exposed so credit assignment need not re-derive it. */
export function expectedScore(theta: number, b: number): number {
  return logistic(theta - b);
}

/**
 * σ(θ̂) at b=0. Not the displayed mastery number since YUK-420; that is PFA p(L).
 * Kept for callers that explicitly want the bare ability projection.
 */
export function thetaToMastery(thetaHat: number): number {
  return expectedScore(thetaHat, 0);
}

export interface EloKConfig {
  /** Cold-start step; logit scale, placeholder pending calibration. */
  kCold?: number; // default 0.4
  /** Steady-state floor, so θ̂ never loses the ability to track a rising learner. */
  kFloor?: number; // default 0.12
  /** Cold-start length; θ̂ is prior-dominated here, so K stays large. */
  coldStartN?: number; // default 4
}

/** Bounded K: kCold during cold start, then kFloor. */
export function eloK(evidenceCount: number, cfg: EloKConfig = {}): number {
  const kCold = cfg.kCold ?? 0.4;
  const kFloor = cfg.kFloor ?? 0.12;
  const coldStartN = cfg.coldStartN ?? 4;
  return evidenceCount < coldStartN ? kCold : kFloor;
}

/**
 * One-KC θ̂ update. weight folds multi-KC responsibility and the weak-anchor discount;
 * b is an input-only anchor (G4).
 */
export function updateTheta(
  theta: number,
  b: number,
  outcome: 0 | 1,
  k: number,
  weight = 1,
): number {
  const expected = expectedScore(theta, b);
  return theta + k * weight * (outcome - expected);
}

/**
 * Parameter-free conjunctive (DINA with s=g=0) item success probability:
 * P_item = ∏_j σ(θ_j − b). Single source for the product used by conjunctive
 * credit and the multi-KC forward predictor.
 *
 * n=1 red line: θ_j are the learner's own abilities and b is an owner/loader anchor;
 * no slip/guess or cross-examinee parameter is introduced.
 */
export function conjunctiveItemProb(thetas: number[], b: number): number {
  return thetas.map((t) => expectedScore(t, b)).reduce((acc, p) => acc * p, 1);
}

/**
 * Multi-KC conjunctive credit assignment: one outcome, several θ_k. Returns each KC's
 * log-likelihood gradient; the caller applies its own K and bWeight.
 *
 *   correct: (1 − p_k)
 *   wrong:   −(1 − p_k) · P_item/(1 − P_item)
 *
 * The (1−p_k) sensitivity makes the weakest KC move most in both directions; the
 * item-level surprise replaces per-KC residuals, which cancelled at the extremes.
 * Wrong-branch odds use a 1e-9 denominator floor and per-KC clamp to 1 against float
 * saturation. Single KC reduces exactly to standard Elo.
 */
export function conjunctiveCredits(thetas: number[], b: number, outcome: 0 | 1): number[] {
  const ps = thetas.map((t) => expectedScore(t, b));
  if (ps.length <= 1) {
    // Single KC (or empty) reduces to the standard Elo residual.
    return ps.map((p) => outcome - p);
  }
  if (outcome === 1) {
    return ps.map((p) => 1 - p);
  }
  const pItem = conjunctiveItemProb(thetas, b);
  const odds = pItem / Math.max(1 - pItem, 1e-9);
  return ps.map((p) => Math.max(-(1 - p) * odds, -1));
}

/**
 * difficulty(1-5) → logit fallback. A placeholder, not a calibrated scale: callers
 * must label it difficulty_proxy and downweight (~0.3); prefer item_calibration.b.
 */
export function difficultyToLogitB(difficulty: number, scale = 0.85): number {
  return (difficulty - 3) * scale;
}

/** Weak-anchor update weight (difficulty_proxy). */
export const DIFFICULTY_PROXY_WEIGHT = 0.3;

// A2 (YUK-434) — hierarchical Elo. θ_global is a slow per-domain anchor; θ_KC is an
// offset above it, so a new KC in a known domain inherits the domain level instead of
// starting at 0. HIERARCHICAL_ELO_ENABLED=false treats θ_global as 0 and leaves the
// single-layer path byte-identical. The predictive gain is small; the point is cold-start
// inheritance and the offset scaffold A5/A6 later borrow through.

/**
 * Master flag for two-layer Elo. True by default; false is still a supported,
 * regression-anchored path (θ_global ≡ 0, single-layer bytes).
 */
export const HIERARCHICAL_ELO_ENABLED = true;

/**
 * Global-layer step. Well below kFloor so the domain anchor drifts slower than the
 * per-KC offset, which absorbs item-level surprise.
 */
export const ELO_K_GLOBAL = 0.048;

// A1 (YUK-433) — signed residual time (SRT). Maris & van der Maas make signed
// residual time sufficient for θ in a speed-accuracy model; here the time limit d is
// the owner-controlled design constant instead of an un-estimable per-examinee
// discrimination. Only the binary outcome is replaced by srtOutcome ∈ [0,1]; the rest
// of the credit path is untouched. SRT_ENABLED=false is the byte-identical binary path.

/**
 * Master flag for SRT credit. True by default; when true but RT or d is unavailable,
 * the path falls back to binary. False is still supported and regression-anchored.
 *
 * Deferred: replace the population-seeded d with a per-KC RT quantile once enough RT
 * accumulates (YUK-449).
 */
export const SRT_ENABLED = true;

/**
 * Floor for the residual-time fraction. Without it, a timed-out answer collapses both
 * correct and wrong to 0.5, erasing the correctness sign. Flooring keeps correct in
 * (0.5, 1] and wrong in [0, 0.5) with a guaranteed gap; fast answers keep the binary
 * endpoints. 0.15 is owner-tunable.
 */
export const SRT_MIN_SIGNAL = 0.15;

/**
 * Dark flag for the Fisher-conditioned time weight, w = 4·p(1−p). RT carries the most
 * θ information near p=0.5 and is noisiest at the extremes, so the time term fades
 * there. It never estimates a per-item time-discrimination φ. False keeps w=1 and the
 * pre-YUK-450 bytes; the correctness sign still holds at every weight.
 */
export const SRT_FISHER_WEIGHT_ENABLED = false;

function clamp01(x: number): number {
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

/**
 * SRT outcome analogue fed into the existing `outcome − p` credit.
 *
 *   r     = clamp((d − t) / d, 0, 1)
 *   r_eff = SRT_MIN_SIGNAL + (1 − SRT_MIN_SIGNAL)·r
 *   correct: 0.5 + 0.5·r_eff   wrong: 0.5 − 0.5·r_eff
 *
 * Fast answers reproduce the binary endpoints; slow answers keep a floored gap so a
 * wrong answer never moves θ like a correct one. `timeWeight` fades the time term
 * toward binary without touching the correctness sign; w=1 is byte-identical to the
 * pre-YUK-450 form.
 */
export function srtOutcome(correct: boolean, d: number, t: number, timeWeight = 1): number {
  // A bad d means no time signal; keep the floored residual rather than 0.5 so the
  // correctness sign survives. Raw r=0 also floors, never collapsing correct and wrong.
  const rEff =
    d > 0 ? SRT_MIN_SIGNAL + (1 - SRT_MIN_SIGNAL) * clamp01((d - t) / d) : SRT_MIN_SIGNAL;
  // Endpoint-exact interpolation: w=1 gives r_eff exactly, w=0 gives pure binary. Do not
  // rewrite as 1 − w·(1 − r_eff); it drifts ~1 ULP from the pre-YUK-450 live path.
  const rEffW = timeWeight * rEff + (1 - timeWeight);
  return correct ? 0.5 + 0.5 * rEffW : 0.5 - 0.5 * rEffW;
}

/** Population-seeded time limit d in seconds; a fixed difficulty map, not a fit. */
export function resolveSrtTimeLimit(difficulty: number): number {
  // Harder items get more time. Out-of-range / NaN falls back to difficulty 3.
  const map: Record<number, number> = { 1: 20, 2: 25, 3: 30, 4: 40, 5: 50 };
  const d = map[Math.round(difficulty)];
  return d ?? 30;
}

/** Ring-buffer capacity for correct response times per KC. */
export const SRT_RT_BUFFER_K = 20;

/**
 * Persisted shape of mastery_state.rt_correct_ms: the last ≤ SRT_RT_BUFFER_K correct
 * RTs in milliseconds, oldest→newest. Collected for snapshot restore, not θ̂ estimation.
 */
export interface RtCorrectBuffer {
  /** last ≤ SRT_RT_BUFFER_K correct RTs in ms, oldest→newest. */
  samples: number[];
}

/**
 * Exact type-7 quantile; buffers are tiny, so approximation buys nothing. Returns NaN
 * for empty input; the caller's array is not mutated.
 */
export function quantile(values: number[], q: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, z) => a - z);
  if (sorted.length === 1) return sorted[0];
  const qc = q < 0 ? 0 : q > 1 ? 1 : q;
  const pos = qc * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  const frac = pos - lo;
  return sorted[lo] + (sorted[hi] - sorted[lo]) * frac;
}

/**
 * Append one correct RT, keeping the last SRT_RT_BUFFER_K. Pure; non-finite or
 * non-positive samples are dropped so a bad RT cannot pollute the scale.
 */
export function pushRtCorrectSample(
  buffer: number[] | null | undefined,
  sampleMs: number,
): number[] {
  const base = buffer ?? [];
  if (!Number.isFinite(sampleMs) || sampleMs <= 0) return [...base];
  const next = [...base, sampleMs];
  return next.length > SRT_RT_BUFFER_K ? next.slice(next.length - SRT_RT_BUFFER_K) : next;
}

/**
 * Continuous conjunctive credit: accepts srtOutcome ∈ [0,1] and delegates at exactly
 * 0/1 so the binary path stays byte-identical. The direction magnitude m scales the
 * whole vector toward zero as the answer slows; the (1−p_k) sensitivity and per-KC
 * clamp are preserved.
 */
export function conjunctiveCreditsContinuous(
  thetas: number[],
  b: number,
  outcome: number,
): number[] {
  // Binary endpoints delegate to the exact live path for byte identity.
  if (outcome === 1) return conjunctiveCredits(thetas, b, 1);
  if (outcome === 0) return conjunctiveCredits(thetas, b, 0);

  const ps = thetas.map((t) => expectedScore(t, b));
  if (ps.length <= 1) {
    // Single KC (or empty) keeps the continuous Elo residual.
    return ps.map((p) => outcome - p);
  }
  if (outcome >= 0.5) {
    const m = 2 * (outcome - 0.5);
    return ps.map((p) => (1 - p) * m);
  }
  // Same clamped binary blame, scaled by how wrong/slow the answer is.
  const m = 2 * (0.5 - outcome);
  const pItem = conjunctiveItemProb(thetas, b);
  const odds = pItem / Math.max(1 - pItem, 1e-9);
  return ps.map((p) => Math.max(-(1 - p) * odds, -1) * m);
}

// YUK-361 Phase 2 — Urnings-lite θ uncertainty. Precision is additive Fisher
// information; SE is derived from it (1/√precision) rather than stored. Default
// precision = 1 keeps existing rows backfill-safe.

/**
 * Rasch/1PL Fisher information at b: I(θ) = p(1−p). Maximal at θ = b; near zero
 * when the item is far too easy or hard.
 */
export function fisherInformation(theta: number, b: number): number {
  const p = expectedScore(theta, b);
  return p * (1 - p);
}

/**
 * 3PL Fisher information with lower asymptote c. c is the structural 1/k guess rate
 * from choices_md, never a fitted cross-examinee parameter. c=0 delegates to the 1PL
 * function for the byte-identical anchor; c=1 is out of domain and returns 0.
 * Dark until the grid path consumes it.
 */
export function fisherInformation3pl(theta: number, b: number, c = 0): number {
  if (c === 0) return fisherInformation(theta, b);
  const phat = expectedScore(theta, b);
  const P = c + (1 - c) * phat;
  const dP = (1 - c) * phat * (1 - phat);
  const denom = P * (1 - P);
  if (!(denom > 0)) return 0; // P at 0/1 (c=1 or p̂→1) carries no information
  return (dP * dP) / denom;
}

/**
 * θ̂ standard error derived from cumulative precision: SE = 1/√precision. Derived on
 * read; only precision is persisted. Floor 1e-9 avoids division by zero.
 */
export function thetaSe(thetaPrecision: number): number {
  return 1 / Math.sqrt(Math.max(thetaPrecision, 1e-9));
}

/**
 * Accumulate Fisher information at the pre-update θ̂, using the same b anchor and
 * weight as the θ̂ update. Information enters as weight², matching a weighted MLE.
 */
export function updateThetaPrecision(
  thetaPrecision: number,
  thetaBefore: number,
  b: number,
  weight = 1,
): number {
  return thetaPrecision + weight * weight * fisherInformation(thetaBefore, b);
}
