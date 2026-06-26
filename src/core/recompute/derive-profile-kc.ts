// YUK-495 S5 #41 — Reproducible Diagnostic Profile: the device-side re-derivation.
//
// Re-derives ONE KC's displayed band {lo, point, hi} + SE from its RAW evidence scalars
// {success_count, fail_count, beta, theta_precision}, mirroring the server display chain
// EXACTLY (src/server/mastery/state.ts getMasteryProjection → pLearnedBand):
//   pointLogit = pfaLogit(beta, PFA_GAMMA, PFA_RHO, success, fail)   [pure +−×, IEEE-exact]
//   se         = max(thetaSe(precision), 0)                          [1/√·, pure IEEE sqrt]
//   {lo,point,hi} = σ([pointLogit−se, pointLogit, pointLogit+se])    [σ = the only non-±×÷ op]
//
// ENGINE-AGNOSTIC σ (the #41 bit-exact contract):
//   The σ here is INJECTED. The default `tsSigmoidBatch` is the shared `polySigmoid`
//   (poly-exp.ts) — a fixed polynomial built only from IEEE-754 correctly-rounded ops, so
//   it is BIT-IDENTICAL across any conforming JS engine (V8 server ↔ browser). That makes
//   the pure-TS re-derivation already bit-exact vs the server — NOT a display-precision
//   stand-in. The Rust isomorphic core compiled to WASM (`polySigmoidBatch`) is an optional
//   swap-in that produces the identical numbers (proven Object.is in the wasm-parity suite);
//   it is the "recomputed by the literal compiled core" trust upgrade, with pure-TS as the
//   always-correct floor.
//
// BIT-EXACT ⇔ server σ is ALSO polySigmoid ⇔ POLY_SIGMOID_ENABLED=true. While the flag is
// OFF the server σ is `Math.exp` (libm, ≤1 ULP, not bit-specified) → the band compare can
// disagree by ≤1 ULP; that is the honest "preview" regime until the flip (S5 Slice E).
//
// Pure: no IO, no UI, cross-subject. Read-only — re-derivation never mutates anything.

import { PFA_GAMMA, PFA_RHO, pfaLogit } from '../pfa';
import { polySigmoid } from '../poly-exp';
import { thetaSe } from '../theta';

/** A batched σ: maps each x → σ(x). Default = the shared bit-exact polynomial. */
export type SigmoidBatch = (xs: number[]) => number[];

/** Default σ — pure-TS `polySigmoid`, bit-identical to the Rust/WASM core (the F0 floor). */
export const tsSigmoidBatch: SigmoidBatch = (xs) => xs.map(polySigmoid);

/** The raw per-KC evidence the device re-derives from (a subset of the profile payload). */
export interface ProfileKcEvidence {
  success_count: number;
  fail_count: number;
  /** KC difficulty anchor β (effectiveB), fed to pfaLogit. */
  beta: number;
  /** Cumulative Fisher info → SE = 1/√precision. */
  theta_precision: number;
}

/** The server-displayed band a re-derivation is checked against (full f64, not rounded). */
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

/**
 * Re-derive a KC's band from raw evidence. Mirrors getMasteryProjection → pLearnedBand
 * with the σ injected (default: bit-exact TS `polySigmoid`).
 */
export function deriveProfileKc(
  kc: ProfileKcEvidence,
  sigmoidBatch: SigmoidBatch = tsSigmoidBatch,
): DerivedKc {
  // se mirrors pLearnedBand's internal `const se = Math.max(thetaSe, 0)` (pfa.ts:140).
  const se = Math.max(thetaSe(kc.theta_precision), 0);
  const pointLogit = pfaLogit(kc.beta, PFA_GAMMA, PFA_RHO, kc.success_count, kc.fail_count);
  // SAME order pLearnedBand evaluates: lo = σ(point−se), point = σ(point), hi = σ(point+se).
  const [lo, point, hi] = sigmoidBatch([pointLogit - se, pointLogit, pointLogit + se]);
  return { se, pointLogit, lo, point, hi };
}

export interface KcCompare {
  /** Every checked field re-derived bit-for-bit (Object.is) vs the server display. */
  match: boolean;
  seOk: boolean;
  loOk: boolean;
  pointOk: boolean;
  hiOk: boolean;
}

/**
 * Bit-for-bit compare of a re-derivation vs the server's displayed values (Object.is, so
 * −0/+0 distinct and NaN===NaN). SE is pure-IEEE (no σ) → matches regardless of the flag;
 * lo/point/hi match iff the server σ is also polySigmoid (POLY_SIGMOID_ENABLED=true).
 */
export function compareKc(server: ProfileKcDisplay, derived: DerivedKc): KcCompare {
  const seOk = Object.is(server.theta_se, derived.se);
  const loOk = Object.is(server.mastery_lo, derived.lo);
  const pointOk = Object.is(server.p_l, derived.point);
  const hiOk = Object.is(server.mastery_hi, derived.hi);
  return { match: seOk && loOk && pointOk && hiOk, seOk, loOk, pointOk, hiOk };
}
