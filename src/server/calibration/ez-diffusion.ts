// EZ-diffusion closed-form recovery — Wagenmakers, van der Maas & Grasman (2007),
//   "An EZ-diffusion model for response time and accuracy", Psychonomic Bulletin & Review
//   14(1), 3-22 (≈2000+ citations). The recovery (data → parameters) is closed-form and
//   explicitly designed for data-sparse SINGLE-SUBJECT designs — one of the few RT/accuracy
//   models that fits an n=1 learner without a cohort.
//
// PURE — no IO, no DB (lives beside auc/ece/replay in the calibration barrel so the unit
// partition holds; the DB-touching batch writer is src/server/calibration/axis-writer.ts).
//
// ── n=1 admissibility (YUK-445 / litmus) ────────────────────────────────────────────────
// (v, a, Ter) are recovered SOLELY from ONE learner's own sufficient statistics:
//   Pc       = that learner's proportion correct,
//   MRT, VRT = the mean & variance of that SAME learner's CORRECT response times.
// NO cross-subject variance component enters. In particular this `a` (boundary separation)
// is THIS learner's own decision-boundary / response caution — it is NOT, and must never be
// read as, a 2PL item DISCRIMINATION (those are the litmus-forbidden a/slip/guess/φ family
// that require between-subject variance). `s` is an owner-fixed scaling constant (the field's
// standard 0.1 convention), not an estimated parameter.
//
// ── what it is / is NOT ─────────────────────────────────────────────────────────────────
// The outputs are a SLOW-VARYING DESCRIPTOR (the "谨慎 / 速度-精度" axis, orthogonal to θ̂).
// They are NEVER fed to θ̂ / p(L) / item selection. A11 is a Tier-3 (preprint / by-analogy)
// signal — kept strictly as a descriptor so it touches no LIVE estimation engine (no flag
// needed; see axis-writer.ts).
//
// ── interpretation ──────────────────────────────────────────────────────────────────────
//   v   — drift rate: speed of evidence accumulation. Low v = "slow because the material is
//         harder for this learner". CONFOUNDED in an adaptive flow (item selection pins Pc),
//         so v is only trustworthy on a NON-adaptive probe-set — the writer gates this.
//   a   — boundary separation: how much evidence the learner waits for before committing.
//         High a = "slow because this learner is more cautious" (the answer to A11's question:
//         distinguishing "can't" from "too careful"). Stable enough to keep in adaptive flow.
//   Ter — non-decision time (s): motor + encoding baseline, deducted to refine the decision
//         component of RT. Stable enough to keep in adaptive flow.

/** Owner-fixed scaling constant `s` (Wagenmakers convention). NOT an estimated parameter. */
export const EZ_SCALING_S = 0.1;

/** Below this |Pc − 0.5| the recovery is degenerate (v → 0, a = 0/0): chance performance
 * carries no caution signal, so we return null rather than fabricate one. */
const CHANCE_EPS = 1e-9;

export interface EzInputs {
  /** proportion correct, RAW (pre-edge-correction), in [0,1]. */
  pc: number;
  /** variance of this learner's CORRECT-response RT, in seconds² (sample variance). */
  vrt: number;
  /** mean of this learner's CORRECT-response RT, in seconds. */
  mrt: number;
  /** total scored responses backing `pc` — used ONLY for the Pc∈{0,1} edge correction. */
  n: number;
  /** scaling constant `s` (owner-fixed). Defaults to EZ_SCALING_S = 0.1. */
  s?: number;
}

export type EzReason =
  | 'ok'
  /** Pc ≈ 0.5 → drift ≈ 0, boundary = 0/0. No caution signal at chance. */
  | 'degenerate-chance'
  /** VRT ≤ 0 (need ≥2 distinct correct RTs for a positive variance). */
  | 'nonpositive-vrt'
  /** L·(…) < 0 — only reachable from corrupt/contradictory inputs; 4th root would be NaN. */
  | 'nonpositive-radicand'
  /** NaN / non-finite / out-of-range Pc / n < 1. */
  | 'invalid-input';

export interface EzResult {
  /** drift rate v. null on any non-'ok' reason. */
  v: number | null;
  /** boundary separation a (caution). null on any non-'ok' reason. */
  a: number | null;
  /** non-decision time Ter, seconds. null on any non-'ok' reason. May be negative under
   * model misfit (MDT > MRT) — returned as-is; the caller decides whether to surface it. */
  ter: number | null;
  /** the Pc actually used (after Pc∈{0,1} edge correction). */
  pcUsed: number;
  reason: EzReason;
}

/** logit (qlogis): ln(p / (1−p)). Caller guarantees 0 < p < 1. */
function logit(p: number): number {
  return Math.log(p / (1 - p));
}

function sign(x: number): number {
  return x > 0 ? 1 : x < 0 ? -1 : 0;
}

/**
 * Wagenmakers Appendix edge correction for perfect / zero accuracy. With Pc exactly 1 (or 0)
 * the logit diverges, so nudge it in by half an observation: Pc=1 → 1 − 1/(2n), Pc=0 → 1/(2n).
 * Interior Pc is returned unchanged.
 */
export function edgeCorrectPc(pc: number, n: number): number {
  if (pc >= 1) return 1 - 1 / (2 * n);
  if (pc <= 0) return 1 / (2 * n);
  return pc;
}

const FAIL = (pcUsed: number, reason: EzReason): EzResult => ({
  v: null,
  a: null,
  ter: null,
  pcUsed,
  reason,
});

/**
 * EZ-diffusion recovery: (Pc, VRT, MRT) → (v, a, Ter). Closed form, PURE.
 *
 * Mirrors the published `get.vaTer` recovery (Wagenmakers 2007 Eqs. 5-8) verbatim so the math
 * is auditable line-for-line:
 *   L   = logit(Pc)
 *   x   = L · (L·Pc² − L·Pc + Pc − ½) / VRT
 *   v   = sign(Pc − ½) · s · x^(1/4)                 (Eq. 5)
 *   a   = s² · L / v                                  (Eq. 6)
 *   y   = −v·a/s²   (= −L)
 *   MDT = (a / 2v) · (1 − e^y) / (1 + e^y)
 *   Ter = MRT − MDT                                   (Eq. 8)
 *
 * Degenerate / contradictory inputs return all-null with a typed reason (NEVER a fabricated
 * neutral value — same discipline as forwardAuc returning null for a single-class sample).
 */
export function computeEzDiffusion(inputs: EzInputs): EzResult {
  const s = inputs.s ?? EZ_SCALING_S;
  const { pc, vrt, mrt, n } = inputs;

  // Input hygiene: every numeric must be finite; Pc a probability; n ≥ 1 (edge correction
  // divides by 2n); s > 0.
  if (
    !Number.isFinite(pc) ||
    !Number.isFinite(vrt) ||
    !Number.isFinite(mrt) ||
    !Number.isFinite(n) ||
    !Number.isFinite(s) ||
    pc < 0 ||
    pc > 1 ||
    n < 1 ||
    s <= 0
  ) {
    return FAIL(pc, 'invalid-input');
  }

  const pcUsed = edgeCorrectPc(pc, n);

  // Chance performance: drift ≈ 0 and a = s²·0/0 is undefined → no caution signal.
  if (Math.abs(pcUsed - 0.5) < CHANCE_EPS) return FAIL(pcUsed, 'degenerate-chance');

  // Variance must be strictly positive (needs ≥2 distinct correct RTs); the 4th root and the
  // a/2v term both blow up at VRT ≤ 0.
  if (vrt <= 0) return FAIL(pcUsed, 'nonpositive-vrt');

  const s2 = s * s;
  const L = logit(pcUsed);
  // radicand = L·(L·Pc² − L·Pc + Pc − ½)/VRT. The bracket is sign-symmetric about Pc=½, so
  // L·bracket ≥ 0 for every valid Pc≠½ (verified across the Pc range); a negative value can
  // only come from corrupt inputs, where x^(1/4) would be NaN — guard it.
  const radicand = (L * (L * pcUsed * pcUsed - L * pcUsed + pcUsed - 0.5)) / vrt;
  if (radicand < 0) return FAIL(pcUsed, 'nonpositive-radicand');

  const v = sign(pcUsed - 0.5) * s * radicand ** 0.25;
  const a = (s2 * L) / v;
  const y = (-v * a) / s2;
  const expY = Math.exp(y);
  const mdt = (a / (2 * v)) * ((1 - expY) / (1 + expY));
  const ter = mrt - mdt;

  return { v, a, ter, pcUsed, reason: 'ok' };
}

/**
 * Reduce a learner's per-KC CORRECT response times (seconds) and total scored count into the
 * EZ sufficient statistics, then recover (v, a, Ter). PURE.
 *
 * Contract:
 *   - `correctRtSeconds` = RTs of the CORRECT responses only (EZ uses correct-trial RT moments).
 *   - `correctCount`/`totalCount` give Pc = correctCount/totalCount over the SAME response set.
 *   - VRT is the SAMPLE variance (÷ (m−1)); needs ≥2 correct RTs, else 'nonpositive-vrt'.
 * The usage gate (minimum N before we even attempt this) lives in the batch writer, not here —
 * this stays a pure reducer so it is unit-testable without a DB.
 */
export function ezFromResponses(
  correctRtSeconds: number[],
  correctCount: number,
  totalCount: number,
  s: number = EZ_SCALING_S,
): EzResult {
  if (
    !Number.isInteger(correctCount) ||
    !Number.isInteger(totalCount) ||
    totalCount < 1 ||
    correctCount < 0 ||
    correctCount > totalCount
  ) {
    return FAIL(Number.NaN, 'invalid-input');
  }
  const pc = correctCount / totalCount;
  const m = correctRtSeconds.length;
  if (m < 2) {
    // Pc may still be defined, but with <2 correct RTs there is no variance → no recovery.
    return FAIL(pc, 'nonpositive-vrt');
  }
  const mean = correctRtSeconds.reduce((acc, x) => acc + x, 0) / m;
  const ss = correctRtSeconds.reduce((acc, x) => acc + (x - mean) * (x - mean), 0);
  const vrt = ss / (m - 1); // sample variance
  return computeEzDiffusion({ pc, vrt, mrt: mean, n: totalCount, s });
}
