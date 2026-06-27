// A6 (YUK-442) — prerequisite directed soft propagation, unit tests (no DB).

import { describe, expect, it } from 'vitest';

import {
  type DirectedEdge,
  PREREQ_PROPAGATION_ENABLED,
  PREREQ_PROP_LAMBDA_DOWN,
  PREREQ_PROP_LAMBDA_UP,
  prereqAdjustments,
  propagatePrereq,
} from './prereq-propagation';

describe('A6 dark-ship flag + conservative priors', () => {
  it('PREREQ_PROPAGATION_ENABLED defaults to false (byte-identical regression anchor)', () => {
    expect(PREREQ_PROPAGATION_ENABLED).toBe(false);
  });
  it('retro-credit (up) is weaker than downstream press (down)', () => {
    expect(PREREQ_PROP_LAMBDA_UP).toBeGreaterThan(0);
    expect(PREREQ_PROP_LAMBDA_DOWN).toBeGreaterThan(0);
    expect(PREREQ_PROP_LAMBDA_UP).toBeLessThan(PREREQ_PROP_LAMBDA_DOWN);
  });
});

describe('prereqAdjustments — λ→0 退回独立', () => {
  it('both strengths 0 ⇒ empty adjustment map (identity)', () => {
    const theta = new Map([
      ['pre', 0],
      ['dep', 2],
    ]);
    const edges: DirectedEdge[] = [{ from: 'pre', to: 'dep' }];
    expect(prereqAdjustments(theta, edges, 0, 0).size).toBe(0);
  });

  it('no edges ⇒ empty adjustment map', () => {
    expect(prereqAdjustments(new Map([['a', 1]]), [], 0.3, 0.15).size).toBe(0);
  });
});

describe('prereqAdjustments — directional ordering soft prior', () => {
  it('答错先修: weak prereq presses dependent DOWN', () => {
    // prereq θ=0 (weak), dependent θ=2 (claims advanced) → ordering violation = 2.
    const theta = new Map([
      ['pre', 0],
      ['dep', 2],
    ]);
    const edges: DirectedEdge[] = [{ from: 'pre', to: 'dep', weight: 1 }];
    const delta = prereqAdjustments(theta, edges, 0.3, 0.15);
    // dependent pressed down by λ_down·w·violation = 0.3·1·2 = 0.6
    expect(delta.get('dep')).toBeCloseTo(-0.6, 12);
  });

  it('答对高阶 retro-credit: mastered dependent lifts prereq UP', () => {
    const theta = new Map([
      ['pre', 0],
      ['dep', 2],
    ]);
    const edges: DirectedEdge[] = [{ from: 'pre', to: 'dep', weight: 1 }];
    const delta = prereqAdjustments(theta, edges, 0.3, 0.15);
    // prereq retro-credited up by λ_up·w·violation = 0.15·1·2 = 0.3
    expect(delta.get('pre')).toBeCloseTo(0.3, 12);
  });

  it('ordering already satisfied (dependent ≤ prereq) ⇒ NO adjustment (one-directional)', () => {
    const theta = new Map([
      ['pre', 3], // strong prereq
      ['dep', 1], // weaker dependent — order holds
    ]);
    const edges: DirectedEdge[] = [{ from: 'pre', to: 'dep', weight: 1 }];
    expect(prereqAdjustments(theta, edges, 0.3, 0.15).size).toBe(0);
  });

  it('edge weight scales the propagation (low-confidence edge → weaker push)', () => {
    const theta = new Map([
      ['pre', 0],
      ['dep', 2],
    ]);
    const strong = prereqAdjustments(theta, [{ from: 'pre', to: 'dep', weight: 1 }], 0.3, 0.15);
    const weak = prereqAdjustments(theta, [{ from: 'pre', to: 'dep', weight: 0.25 }], 0.3, 0.15);
    expect(Math.abs(weak.get('dep') as number)).toBeLessThan(Math.abs(strong.get('dep') as number));
  });

  it('skips self-edges and non-positive weights', () => {
    const theta = new Map([['x', 2]]);
    const edges: DirectedEdge[] = [
      { from: 'x', to: 'x', weight: 1 }, // self-edge
      { from: 'a', to: 'b', weight: 0 }, // zero weight
    ];
    expect(prereqAdjustments(theta, edges, 0.3, 0.15).size).toBe(0);
  });

  it('a missing node is treated as latent at priorMean (0)', () => {
    // dependent present at 2, prereq absent → treated as 0 → violation 2.
    const delta = prereqAdjustments(new Map([['dep', 2]]), [{ from: 'pre', to: 'dep' }], 0.3, 0.15);
    expect(delta.get('dep')).toBeCloseTo(-0.6, 12);
    expect(delta.get('pre')).toBeCloseTo(0.3, 12);
  });

  it('accumulates across multiple prereqs of one dependent', () => {
    const theta = new Map([
      ['p1', 0],
      ['p2', 0.5],
      ['dep', 2],
    ]);
    const edges: DirectedEdge[] = [
      { from: 'p1', to: 'dep', weight: 1 },
      { from: 'p2', to: 'dep', weight: 1 },
    ];
    const delta = prereqAdjustments(theta, edges, 0.3, 0.15);
    // dep pressed by 0.3·(2−0) + 0.3·(2−0.5) = 0.6 + 0.45 = 1.05
    expect(delta.get('dep')).toBeCloseTo(-1.05, 12);
  });
});

describe('propagatePrereq — adjusted θ̃ = θ̂ + Δθ', () => {
  it('returns adjusted estimates for the requested node set', () => {
    const theta = new Map([
      ['pre', 0],
      ['dep', 2],
    ]);
    const out = propagatePrereq(
      ['pre', 'dep'],
      theta,
      [{ from: 'pre', to: 'dep', weight: 1 }],
      0.3,
      0.15,
    );
    expect(out.get('pre')).toBeCloseTo(0.3, 12); // 0 + retro-credit
    expect(out.get('dep')).toBeCloseTo(1.4, 12); // 2 − 0.6 press
  });

  it('λ→0 ⇒ θ̃ identical to θ̂ for every requested node', () => {
    const theta = new Map([
      ['pre', 0],
      ['dep', 2],
    ]);
    const out = propagatePrereq(['pre', 'dep'], theta, [{ from: 'pre', to: 'dep' }], 0, 0);
    expect(out.get('pre')).toBeCloseTo(0, 12);
    expect(out.get('dep')).toBeCloseTo(2, 12);
  });
});
