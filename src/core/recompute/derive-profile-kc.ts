// Device-side re-derivation of one KC's displayed band and SE, mirroring the server
// display chain exactly. σ is injected: the default polySigmoid uses only correctly
// rounded IEEE ops, so it is bit-identical across engines; WASM is an optional swap-in.
// Exact equality holds only while the server also uses polySigmoid
// (POLY_SIGMOID_ENABLED); with Math.exp the honest preview may differ by ≤1 ULP.
// Pure and read-only.

import { PFA_GAMMA, PFA_RHO, pfaLogit } from '../pfa';
import { polySigmoid } from '../poly-exp';
import { thetaSe } from '../theta';

/** Batched σ; the default is the shared bit-exact polynomial. */
export type SigmoidBatch = (xs: number[]) => number[];

export const tsSigmoidBatch: SigmoidBatch = (xs) => xs.map(polySigmoid);

export interface ProfileKcEvidence {
  success_count: number;
  fail_count: number;
  /** Difficulty anchor β fed to pfaLogit. */
  beta: number;
  /** Cumulative Fisher information; SE = 1/√precision. */
  theta_precision: number;
}

/** Full f64 values, not rounded for display. */
export interface ProfileKcDisplay {
  p_l: number;
  mastery_lo: number;
  mastery_hi: number;
  theta_se: number;
}

export interface DerivedKc {
  se: number;
  pointLogit: number;
  lo: number;
  point: number;
  hi: number;
}

/** Mirror pLearnedBand with the injected σ. */
export function deriveProfileKc(
  kc: ProfileKcEvidence,
  sigmoidBatch: SigmoidBatch = tsSigmoidBatch,
): DerivedKc {
  // Mirror pLearnedBand's clamp.
  const se = Math.max(thetaSe(kc.theta_precision), 0);
  const pointLogit = pfaLogit(kc.beta, PFA_GAMMA, PFA_RHO, kc.success_count, kc.fail_count);
  // Same evaluation order as pLearnedBand.
  const [lo, point, hi] = sigmoidBatch([pointLogit - se, pointLogit, pointLogit + se]);
  return { se, pointLogit, lo, point, hi };
}

export interface KcCompare {
  /** All fields match bit-for-bit. */
  match: boolean;
  seOk: boolean;
  loOk: boolean;
  pointOk: boolean;
  hiOk: boolean;
}

/**
 * Object.is compare: −0/+0 stay distinct and NaN matches itself. SE is pure IEEE and
 * always comparable; the band matches only when the server also uses polySigmoid.
 */
export function compareKc(server: ProfileKcDisplay, derived: DerivedKc): KcCompare {
  const seOk = Object.is(server.theta_se, derived.se);
  const loOk = Object.is(server.mastery_lo, derived.lo);
  const pointOk = Object.is(server.p_l, derived.point);
  const hiOk = Object.is(server.mastery_hi, derived.hi);
  return { match: seOk && loOk && pointOk && hiOk, seOk, loOk, pointOk, hiOk };
}
