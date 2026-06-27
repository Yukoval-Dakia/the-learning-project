// YUK-495 S5 #41 — re-derivation + compare core (engine-agnostic, bit-exact via polySigmoid).

import { describe, expect, it } from 'vitest';
import { PFA_GAMMA, PFA_RHO, pLearnedBand, pfaLogit } from '../pfa';
import { polySigmoid } from '../poly-exp';
import { thetaSe } from '../theta';
import {
  type ProfileKcEvidence,
  compareKc,
  deriveProfileKc,
  tsSigmoidBatch,
} from './derive-profile-kc';

// The flag-ON server display for a KC (σ = polySigmoid) — what the bit-exact compare targets.
function serverBandPolyExact(kc: ProfileKcEvidence) {
  const se = Math.max(thetaSe(kc.theta_precision), 0);
  const pointLogit = pfaLogit(kc.beta, PFA_GAMMA, PFA_RHO, kc.success_count, kc.fail_count);
  return {
    theta_se: se,
    p_l: polySigmoid(pointLogit),
    mastery_lo: polySigmoid(pointLogit - se),
    mastery_hi: polySigmoid(pointLogit + se),
  };
}

const FIXTURES: ProfileKcEvidence[] = [
  { success_count: 0, fail_count: 0, beta: 0, theta_precision: 1 }, // cold start
  { success_count: 5, fail_count: 1, beta: 0.8, theta_precision: 9 },
  { success_count: 1, fail_count: 4, beta: -1.5, theta_precision: 2.5 },
  { success_count: 12, fail_count: 0, beta: 2.3, theta_precision: 50 },
  { success_count: 3, fail_count: 3, beta: 0, theta_precision: 1 },
];

describe('deriveProfileKc — bit-exact re-derivation (YUK-495 S5 #41)', () => {
  it('re-derives lo/point/hi/SE Object.is-equal to the polySigmoid server band', () => {
    for (const kc of FIXTURES) {
      const server = serverBandPolyExact(kc);
      const derived = deriveProfileKc(kc); // default TS polySigmoid
      expect(Object.is(derived.se, server.theta_se)).toBe(true);
      expect(Object.is(derived.point, server.p_l)).toBe(true);
      expect(Object.is(derived.lo, server.mastery_lo)).toBe(true);
      expect(Object.is(derived.hi, server.mastery_hi)).toBe(true);
      expect(compareKc(server, derived).match).toBe(true);
    }
  });

  it('the non-σ chain (SE, pointLogit) is pure-IEEE → reproduces regardless of σ', () => {
    for (const kc of FIXTURES) {
      const d = deriveProfileKc(kc);
      expect(Object.is(d.se, Math.max(thetaSe(kc.theta_precision), 0))).toBe(true);
      expect(
        Object.is(
          d.pointLogit,
          pfaLogit(kc.beta, PFA_GAMMA, PFA_RHO, kc.success_count, kc.fail_count),
        ),
      ).toBe(true);
    }
  });

  it('compareKc flags drift per-field (and overall) when a server value is tweaked', () => {
    const kc = FIXTURES[1];
    const server = serverBandPolyExact(kc);
    const derived = deriveProfileKc(kc);
    // bump the displayed point by 1 ULP → pointOk false, others true, match false.
    const drifted = { ...server, p_l: nextUp(server.p_l) };
    const cmp = compareKc(drifted, derived);
    expect(cmp.pointOk).toBe(false);
    expect(cmp.loOk).toBe(true);
    expect(cmp.hiOk).toBe(true);
    expect(cmp.seOk).toBe(true);
    expect(cmp.match).toBe(false);
  });

  it('engine-agnostic: an injected sigmoidBatch matching polySigmoid yields identical numbers', () => {
    // Simulates the WASM polySigmoidBatch swap-in — must be Object.is to the TS default.
    const wasmLike = (xs: number[]) => tsSigmoidBatch(xs);
    for (const kc of FIXTURES) {
      const a = deriveProfileKc(kc);
      const b = deriveProfileKc(kc, wasmLike);
      expect(Object.is(a.lo, b.lo)).toBe(true);
      expect(Object.is(a.point, b.point)).toBe(true);
      expect(Object.is(a.hi, b.hi)).toBe(true);
    }
  });

  it('matches the live pLearnedBand chain to ≤1 ULP (flag-OFF Math.exp shift)', () => {
    // Proves deriveProfileKc IS the getMasteryProjection→pLearnedBand chain; while
    // POLY_SIGMOID_ENABLED is OFF the server σ is Math.exp, so the band shifts by ≤1 ULP.
    for (const kc of FIXTURES) {
      const d = deriveProfileKc(kc);
      const band = pLearnedBand(d.pointLogit, d.se);
      expect(Math.abs(d.point - band.point)).toBeLessThan(1e-12);
      expect(Math.abs(d.lo - band.lo)).toBeLessThan(1e-12);
      expect(Math.abs(d.hi - band.hi)).toBeLessThan(1e-12);
    }
  });

  it('is pure (same input → same output)', () => {
    const kc = FIXTURES[2];
    const a = deriveProfileKc(kc);
    const b = deriveProfileKc(kc);
    expect(a).toEqual(b);
  });
});

// next representable f64 above x (for the 1-ULP drift probe).
function nextUp(x: number): number {
  const buf = new ArrayBuffer(8);
  const f = new Float64Array(buf);
  const u = new BigUint64Array(buf);
  f[0] = x;
  u[0] = u[0] + 1n;
  return f[0];
}
