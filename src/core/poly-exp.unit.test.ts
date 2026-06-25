// YUK-495 Phase 0 (decision ②) — shared-polynomial exp/σ ACCURACY gate.
//
// This suite measures polyExp/polySigmoid vs the libm `Math.exp` they will replace
// (theta.ts logistic / pfa.ts sigmoid). It is the "cost of the swap" number: how far
// the bit-exact poll moves the displayed θ̂/p(L) from today's Math.exp values.
// The JS↔Rust BIT-parity is asserted separately in the calibration-native
// differential suite (native-parity.unit.test.ts) — here we only gate accuracy +
// shape (no Rust dependency, always runs).

import { describe, expect, it } from 'vitest';
import { polyExp, polySigmoid } from './poly-exp';

// ULP distance between two finite f64 (monotone bit-ordering trick).
function ulpDistance(a: number, b: number): number {
  if (a === b) return 0;
  const buf = new ArrayBuffer(8);
  const f = new Float64Array(buf);
  const bi = new BigInt64Array(buf);
  f[0] = a;
  let ka = bi[0];
  f[0] = b;
  let kb = bi[0];
  // map sign-magnitude → monotone ordering
  const flip = (k: bigint) => (k < 0n ? -9223372036854775808n - k : k);
  ka = flip(ka);
  kb = flip(kb);
  const d = ka - kb;
  return Number(d < 0n ? -d : d);
}

describe('poly-exp — shared fixed-polynomial exp/σ (YUK-495 Phase 0)', () => {
  it('exact anchors: polyExp(0)=1, polySigmoid(0)=0.5', () => {
    expect(Object.is(polyExp(0), 1)).toBe(true);
    expect(Object.is(polySigmoid(0), 0.5)).toBe(true);
  });

  it('polyExp accuracy vs Math.exp over the σ operating range (|x| ≤ 40)', () => {
    let maxUlp = 0;
    let maxRel = 0;
    let worstX = 0;
    for (let x = -40; x <= 40; x += 0.001) {
      const got = polyExp(x);
      const ref = Math.exp(x);
      const rel = Math.abs(got - ref) / ref;
      const ulp = ulpDistance(got, ref);
      if (ulp > maxUlp) {
        maxUlp = ulp;
        worstX = x;
      }
      if (rel > maxRel) maxRel = rel;
    }
    // Decision-② cost number — recorded, not just asserted.
    console.log(
      `[poly-exp] vs Math.exp over [-40,40]: maxUlp=${maxUlp} maxRel=${maxRel.toExponential(3)} worstX=${worstX.toFixed(3)}`,
    );
    // Faithful to a handful of ULP across the whole range (degree-13 Taylor on reduced r).
    expect(maxUlp).toBeLessThanOrEqual(8);
    expect(maxRel).toBeLessThan(1e-14);
  });

  it('polySigmoid accuracy vs Math 1/(1+exp(-x)) — the live sigmoid swap cost', () => {
    let maxAbs = 0;
    let maxUlp = 0;
    let worstX = 0;
    for (let x = -25; x <= 25; x += 0.0005) {
      const got = polySigmoid(x);
      const ref = 1 / (1 + Math.exp(-x));
      const abs = Math.abs(got - ref);
      const ulp = ulpDistance(got, ref);
      if (abs > maxAbs) {
        maxAbs = abs;
        worstX = x;
      }
      if (ulp > maxUlp) maxUlp = ulp;
    }
    console.log(
      `[poly-sigmoid] vs Math sigmoid over [-25,25]: maxAbs=${maxAbs.toExponential(3)} maxUlp=${maxUlp} worstX=${worstX.toFixed(4)}`,
    );
    // p(L)/θ̂ display moves by < 1e-15 absolute — invisible at any UI precision.
    expect(maxAbs).toBeLessThan(1e-12);
  });

  it('shape: strictly in (0,1), monotone increasing, symmetric σ(-x)=1-σ(x) to tolerance', () => {
    let prev = -1;
    for (let x = -30; x <= 30; x += 0.25) {
      const s = polySigmoid(x);
      expect(s).toBeGreaterThan(0);
      expect(s).toBeLessThan(1);
      expect(s).toBeGreaterThanOrEqual(prev); // monotone non-decreasing
      prev = s;
      const sym = polySigmoid(-x);
      expect(Math.abs(s + sym - 1)).toBeLessThan(1e-12);
    }
  });

  it('tails saturate cleanly (range guards)', () => {
    expect(polySigmoid(1000)).toBe(1); // 1/(1+0)
    expect(polySigmoid(-1000)).toBe(0); // 1/(1+inf)
    expect(polyExp(800)).toBe(Number.POSITIVE_INFINITY);
    expect(polyExp(-800)).toBe(0);
    expect(Number.isNaN(polyExp(Number.NaN))).toBe(true);
  });

  it('no sign-flip garbage anywhere: polyExp ≥ 0 and never NaN/−Inf for real x', () => {
    // Regression for the −745 guard bug (review finding): pow2i can only build NORMAL
    // exponents, so an over-loose lower guard let x ≈ −709 produce sign-flipped garbage.
    // The −708 symmetric guard must keep polyExp non-negative and finite (or +Inf) everywhere.
    for (let x = -800; x <= 800; x += 0.13) {
      const y = polyExp(x);
      expect(y).toBeGreaterThanOrEqual(0); // never negative
      expect(Number.isNaN(y)).toBe(false);
      expect(y === Number.NEGATIVE_INFINITY).toBe(false);
    }
    // boundary: −708 still in the normal-exponent window (small positive), −709 saturates to 0.
    expect(polyExp(-708)).toBeGreaterThan(0);
    expect(polyExp(-708)).toBeLessThan(1e-300);
    expect(polyExp(-709)).toBe(0);
  });
});
