// TASK 4 — Cohen's κ for two raters on a binary/categorical label (future A9 gate).
// Source: Cohen, Educ Psychol Meas 1960. Known-answer tests HAND-COMPUTED.

import { describe, expect, it } from 'vitest';
import { cohenKappa } from './kappa';

// Build parallel rater arrays from a 2x2 confusion matrix [[n_aa,n_ab],[n_ba,n_bb]].
function fromConfusion(m: [[number, number], [number, number]]): {
  r1: string[];
  r2: string[];
} {
  const r1: string[] = [];
  const r2: string[] = [];
  const push = (a: string, b: string, count: number) => {
    for (let i = 0; i < count; i++) {
      r1.push(a);
      r2.push(b);
    }
  };
  push('a', 'a', m[0][0]);
  push('a', 'b', m[0][1]);
  push('b', 'a', m[1][0]);
  push('b', 'b', m[1][1]);
  return { r1, r2 };
}

describe('cohenKappa', () => {
  it('anchor: κ = 0.70 (confusion [[8,2],[1,9]], N=20, hand-computed)', () => {
    // po = (8+9)/20 = 0.85; rows {10,10}, cols {9,11};
    // pe = 0.5*0.45 + 0.5*0.55 = 0.50; κ = (0.85-0.50)/(1-0.50) = 0.70
    const { r1, r2 } = fromConfusion([
      [8, 2],
      [1, 9],
    ]);
    const r = cohenKappa(r1, r2);
    expect(r.po).toBeCloseTo(0.85, 10);
    expect(r.pe).toBeCloseTo(0.5, 10);
    expect(r.kappa).toBeCloseTo(0.7, 10);
    expect(r.n).toBe(20);
  });

  it('perfect agreement (both categories present) → 1.0', () => {
    const r = cohenKappa(['a', 'a', 'b', 'b'], ['a', 'a', 'b', 'b']);
    expect(r.kappa).toBeCloseTo(1.0, 10);
  });

  it('po == pe construction → κ ≈ 0', () => {
    // Independent raters each 50/50 with no association: confusion [[1,1],[1,1]] (N=4).
    // po = 2/4 = 0.5; rows {2,2}, cols {2,2}; pe = 0.5*0.5 + 0.5*0.5 = 0.5; κ = 0.
    const { r1, r2 } = fromConfusion([
      [1, 1],
      [1, 1],
    ]);
    const r = cohenKappa(r1, r2);
    expect(r.kappa).toBeCloseTo(0, 10);
  });

  it('both raters all one category → pe=1 → null, no-variance', () => {
    const r = cohenKappa(['correct', 'correct', 'correct'], ['correct', 'correct', 'correct']);
    expect(r.kappa).toBeNull();
    expect(r.reason).toBe('no-variance');
  });

  it('anti-correlated → κ < 0', () => {
    // confusion [[0,5],[5,0]] (N=10): po=0, rows {5,5}, cols {5,5}, pe=0.5, κ=(0-0.5)/0.5=-1.
    const { r1, r2 } = fromConfusion([
      [0, 5],
      [5, 0],
    ]);
    const r = cohenKappa(r1, r2);
    expect(r.kappa).toBeLessThan(0);
    expect(r.kappa).toBeCloseTo(-1.0, 10);
  });

  it('empty → null, empty', () => {
    const r = cohenKappa([], []);
    expect(r.kappa).toBeNull();
    expect(r.reason).toBe('empty');
  });

  it('length mismatch throws', () => {
    expect(() => cohenKappa(['a', 'b'], ['a'])).toThrow(/equal length/);
  });
});
