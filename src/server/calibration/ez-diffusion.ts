// Closed-form EZ recovery. Wagenmakers, van der Maas & Grasman, Psychonomic Bulletin
// & Review 2007. It fits one learner from that learner's own Pc and correct-RT moments.
// No cohort variance enters. The database writer was retired in YUK-1560; this module
// remains the pure closed form. ADR-0048 keeps it in TypeScript while the axis stays a
// descriptor; ADR-0046 lists the exemption and its port triggers.
// `a` is this learner's caution boundary. It is not a 2PL item discrimination.
// `s` is the fixed 0.1 scale, not an estimated parameter.
// Nothing here is an input to θ̂, p(L), or item selection.
// v is confounded when selection pins Pc, so the retired writer stored it only for a probe set.
// a and Ter stay meaningful in an adaptive flow.

/** Owner-fixed scaling constant `s` (Wagenmakers convention). NOT an estimated parameter. */
export const EZ_SCALING_S = 0.1;

/** |Pc − 0.5| below this makes a = 0/0. Chance performance is not a caution signal. */
const CHANCE_EPS = 1e-9;

export interface EzInputs {
  /** Raw Pc, before the 0/1 edge correction. */
  pc: number;
  /** Sample variance of this learner's correct RTs, seconds². */
  vrt: number;
  /** Mean of those correct RTs, seconds. */
  mrt: number;
  /** Used only to nudge Pc off 0 or 1. */
  n: number;
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
  v: number | null;
  a: number | null;
  /** Seconds. Null unless reason is 'ok'. Negative when mean decision time exceeds MRT. Returned as-is. */
  ter: number | null;
  /** Pc after the 0/1 nudge. */
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

/** Pc of 0 or 1 makes logit diverge. Nudge by half an observation. Interior Pc is unchanged. */
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

/** Wagenmakers 2007 `get.vaTer`. v is Eq. 7, a is Eq. 5, MDT is Eq. 9, Ter is Eq. 8. A bad input returns nulls, never a made-up (v, a, Ter). */
export function computeEzDiffusion(inputs: EzInputs): EzResult {
  const s = inputs.s ?? EZ_SCALING_S;
  const { pc, vrt, mrt, n } = inputs;

  // The edge correction divides by 2n, so n < 1 is not a degenerate result. It is a bad call.
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

  // Drift is ~0 and a is 0/0. There is no caution signal to return.
  if (Math.abs(pcUsed - 0.5) < CHANCE_EPS) return FAIL(pcUsed, 'degenerate-chance');

  // The fourth root and a/(2v) both blow up at VRT ≤ 0. That needs two distinct correct RTs.
  if (vrt <= 0) return FAIL(pcUsed, 'nonpositive-vrt');

  const s2 = s * s;
  const L = logit(pcUsed);
  // For a valid Pc other than 1/2 this radicand is ≥ 0. A negative value is corrupt input
  // and the fourth root would be NaN.
  const radicand = (L * (L * pcUsed * pcUsed - L * pcUsed + pcUsed - 0.5)) / vrt;
  if (radicand < 0) return FAIL(pcUsed, 'nonpositive-radicand');

  const v = sign(pcUsed - 0.5) * s * radicand ** 0.25; // Eq. 7
  const a = (s2 * L) / v; // Eq. 5
  const y = (-v * a) / s2;
  const expY = Math.exp(y);
  const mdt = (a / (2 * v)) * ((1 - expY) / (1 + expY)); // Eq. 9
  const ter = mrt - mdt; // Eq. 8

  return { v, a, ter, pcUsed, reason: 'ok' };
}

/** Correct-trial moments only. VRT divides by m−1. The usage gate lives in the batch writer. */
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
    // Pc can exist with one correct RT. The variance cannot.
    return FAIL(pc, 'nonpositive-vrt');
  }
  const mean = correctRtSeconds.reduce((acc, x) => acc + x, 0) / m;
  const ss = correctRtSeconds.reduce((acc, x) => acc + (x - mean) * (x - mean), 0);
  const vrt = ss / (m - 1);
  return computeEzDiffusion({ pc, vrt, mrt: mean, n: totalCount, s });
}
