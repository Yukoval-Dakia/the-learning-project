// A5 (YUK-441) — graph-Laplacian smoothing prior, unit tests (no DB).

import { describe, expect, it } from 'vitest';

import {
  GRAPH_LAPLACIAN_ENABLED,
  GRAPH_LAPLACIAN_KAPPA,
  GRAPH_LAPLACIAN_LAMBDA,
  GRAPH_SMOOTH_COMPONENT_CAP,
  type SymmetricEdge,
  buildLaplacian,
  connectedComponents,
  gmrfPosteriorMean,
  smoothTheta,
  smoothThetaByComponent,
  solveDense,
} from './graph-laplacian';

describe('A5 dark-ship flag + conservative priors', () => {
  it('GRAPH_LAPLACIAN_ENABLED defaults to false (byte-identical regression anchor)', () => {
    expect(GRAPH_LAPLACIAN_ENABLED).toBe(false);
  });
  it('λ/κ are conservative positive priors (κ > 0 for properness)', () => {
    expect(GRAPH_LAPLACIAN_LAMBDA).toBeGreaterThan(0);
    expect(GRAPH_LAPLACIAN_KAPPA).toBeGreaterThan(0);
    // κ ≪ λ: the ridge barely shrinks observed KCs, λ does the smoothing.
    expect(GRAPH_LAPLACIAN_KAPPA).toBeLessThan(GRAPH_LAPLACIAN_LAMBDA);
  });
});

describe('buildLaplacian — symmetric PSD, row-sums zero', () => {
  it('two-node single edge: L = [[w,-w],[-w,w]]', () => {
    const { L } = buildLaplacian(['a', 'b'], [{ a: 'a', b: 'b', weight: 2 }]);
    expect(L).toEqual([
      [2, -2],
      [-2, 2],
    ]);
  });

  it('is symmetric and every row sums to 0 (the constant null space)', () => {
    const nodes = ['a', 'b', 'c'];
    const edges: SymmetricEdge[] = [
      { a: 'a', b: 'b', weight: 1 },
      { a: 'b', b: 'c', weight: 0.5 },
    ];
    const { L } = buildLaplacian(nodes, edges);
    for (let i = 0; i < 3; i++) {
      let rowSum = 0;
      for (let j = 0; j < 3; j++) {
        rowSum += L[i][j];
        expect(L[i][j]).toBeCloseTo(L[j][i], 12); // symmetric
      }
      expect(rowSum).toBeCloseTo(0, 12); // row-sum zero
    }
  });

  it('default weight is 1 when omitted', () => {
    const { L } = buildLaplacian(['a', 'b'], [{ a: 'a', b: 'b' }]);
    expect(L[0][1]).toBe(-1);
  });

  it('skips self-loops, out-of-set endpoints, and non-positive weights', () => {
    const { L } = buildLaplacian(
      ['a', 'b'],
      [
        { a: 'a', b: 'a', weight: 5 }, // self-loop
        { a: 'a', b: 'zzz', weight: 5 }, // endpoint outside node set
        { a: 'a', b: 'b', weight: 0 }, // non-positive weight
        { a: 'a', b: 'b', weight: -3 }, // negative weight
      ],
    );
    expect(L).toEqual([
      [0, 0],
      [0, 0],
    ]);
  });

  it('accumulates parallel edges (duplicate related_to reinforces)', () => {
    const { L } = buildLaplacian(
      ['a', 'b'],
      [
        { a: 'a', b: 'b', weight: 1 },
        { a: 'a', b: 'b', weight: 1 },
      ],
    );
    expect(L[0][1]).toBe(-2);
  });
});

describe('solveDense — exact linear solve, no input mutation', () => {
  it('solves a 2×2 system exactly', () => {
    // 2x + y = 5 ; x + 3y = 10  →  x=1, y=3
    const x = solveDense(
      [
        [2, 1],
        [1, 3],
      ],
      [5, 10],
    );
    expect(x[0]).toBeCloseTo(1, 12);
    expect(x[1]).toBeCloseTo(3, 12);
  });

  it('does not mutate A or b', () => {
    const A = [
      [2, 1],
      [1, 3],
    ];
    const b = [5, 10];
    const Acopy = A.map((r) => [...r]);
    const bcopy = [...b];
    solveDense(A, b);
    expect(A).toEqual(Acopy);
    expect(b).toEqual(bcopy);
  });

  it('requires partial pivoting (zero leading pivot)', () => {
    // 0·x + 1·y = 2 ; 1·x + 0·y = 3  →  x=3, y=2 (needs a row swap)
    const x = solveDense(
      [
        [0, 1],
        [1, 0],
      ],
      [2, 3],
    );
    expect(x[0]).toBeCloseTo(3, 12);
    expect(x[1]).toBeCloseTo(2, 12);
  });
});

describe('gmrfPosteriorMean — λ→0 退回独立 + identity', () => {
  const nodes = ['a', 'b'];
  const edges: SymmetricEdge[] = [{ a: 'a', b: 'b', weight: 1 }];
  const { L } = buildLaplacian(nodes, edges);

  it('λ=0, κ=0, all observed ⇒ EXACT identity θ̃ = θ̂ (退回独立)', () => {
    const theta = new Map([
      ['a', 1.5],
      ['b', -0.7],
    ]);
    const prec = new Map([
      ['a', 1],
      ['b', 1],
    ]);
    const out = gmrfPosteriorMean({
      nodeIds: nodes,
      thetaHat: theta,
      observationPrecision: prec,
      L,
      lambda: 0,
      kappa: 0,
    });
    expect(out.get('a')).toBeCloseTo(1.5, 12);
    expect(out.get('b')).toBeCloseTo(-0.7, 12);
  });

  it('λ=0 ⇒ each node is INDEPENDENT of its neighbour (no graph coupling)', () => {
    // Same node a, two different neighbour b values → a's θ̃ must be identical at λ=0.
    const prec = new Map([
      ['a', 1],
      ['b', 1],
    ]);
    const runA = (bVal: number) =>
      gmrfPosteriorMean({
        nodeIds: nodes,
        thetaHat: new Map([
          ['a', 1.0],
          ['b', bVal],
        ]),
        observationPrecision: prec,
        L,
        lambda: 0,
        kappa: 0.1,
      }).get('a');
    expect(runA(5)).toBeCloseTo(runA(-5) as number, 12); // neighbour b irrelevant at λ=0
  });

  it('λ=0, κ>0, observed ⇒ independent shrink (dθ̂+κμ₀)/(d+κ) toward μ₀', () => {
    const out = gmrfPosteriorMean({
      nodeIds: ['a'],
      thetaHat: new Map([['a', 2]]),
      observationPrecision: new Map([['a', 3]]),
      L: [[0]],
      lambda: 0,
      kappa: 1,
      priorMean: 0,
    });
    // (3·2 + 1·0)/(3+1) = 1.5
    expect(out.get('a')).toBeCloseTo(1.5, 12);
  });
});

describe('gmrfPosteriorMean — unobserved KC borrows from observed neighbour', () => {
  const nodes = ['obs', 'unobs'];
  const edges: SymmetricEdge[] = [{ a: 'obs', b: 'unobs', weight: 1 }];
  const { L } = buildLaplacian(nodes, edges);

  it('unobserved neighbour is pulled toward the observed neighbour (firm-up)', () => {
    const out = gmrfPosteriorMean({
      nodeIds: nodes,
      thetaHat: new Map([['obs', 2.0]]), // unobs absent → latent
      observationPrecision: new Map([['obs', 5]]), // unobs absent → dₖ=0
      L,
      lambda: 1,
      kappa: 0.01,
      priorMean: 0,
    });
    const obs = out.get('obs') as number;
    const unobs = out.get('unobs') as number;
    // Observed node stays near its strong evidence; unobserved is pulled toward it,
    // strictly between the prior mean (0) and the observed value (2).
    expect(obs).toBeGreaterThan(1.5);
    expect(unobs).toBeGreaterThan(0);
    expect(unobs).toBeLessThan(obs);
  });

  it('larger λ ⇒ unobserved borrows MORE (closer to the observed neighbour)', () => {
    const run = (lambda: number) =>
      gmrfPosteriorMean({
        nodeIds: nodes,
        thetaHat: new Map([['obs', 2.0]]),
        observationPrecision: new Map([['obs', 5]]),
        L,
        lambda,
        kappa: 0.01,
      }).get('unobs') as number;
    expect(run(2)).toBeGreaterThan(run(0.2));
  });

  it('STRONG direct evidence on a node overrides smoothing (likelihood盖过先验)', () => {
    // Both observed; one with huge precision must barely move despite a far neighbour.
    const out = gmrfPosteriorMean({
      nodeIds: nodes,
      thetaHat: new Map([
        ['obs', 3.0],
        ['unobs', -3.0],
      ]),
      observationPrecision: new Map([
        ['obs', 1000], // near-certain
        ['unobs', 1],
      ]),
      L,
      lambda: 1,
      kappa: 0.01,
    });
    expect(out.get('obs')).toBeCloseTo(3.0, 1); // pinned by strong likelihood
  });
});

describe('smoothTheta convenience wrapper', () => {
  it('λ→0 returns the per-node independent shrink (κ ridge only)', () => {
    const out = smoothTheta(
      ['a', 'b'],
      [{ a: 'a', b: 'b', weight: 1 }],
      new Map([
        ['a', 4],
        ['b', 0],
      ]),
      new Map([
        ['a', 1],
        ['b', 1],
      ]),
      0,
      0,
    );
    expect(out.get('a')).toBeCloseTo(4, 12);
    expect(out.get('b')).toBeCloseTo(0, 12);
  });
});

// YUK-559 (S4 / RP8) — component-partitioned solve + oversized-component fail-safe.
describe('connectedComponents — symmetric graph partition', () => {
  it('every node lands in exactly one component; edgeless nodes are singletons', () => {
    const comps = connectedComponents(
      ['a', 'b', 'c', 'd'],
      [{ a: 'a', b: 'b', weight: 1 }], // a-b connected; c, d isolated
    );
    const sorted = comps.map((c) => [...c].sort()).sort((x, y) => x[0].localeCompare(y[0]));
    expect(sorted).toEqual([['a', 'b'], ['c'], ['d']]);
    // partition covers all nodes exactly once
    expect(comps.flat().sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('a chain a-b-c is ONE component; edges to nodes outside the set are ignored', () => {
    const comps = connectedComponents(
      ['a', 'b', 'c'],
      [
        { a: 'a', b: 'b', weight: 1 },
        { a: 'b', b: 'c', weight: 1 },
        { a: 'c', b: 'z', weight: 1 }, // z ∉ node set → dropped
      ],
    );
    expect(comps).toHaveLength(1);
    expect([...comps[0]].sort()).toEqual(['a', 'b', 'c']);
  });
});

describe('smoothThetaByComponent — block-diagonal equivalence + cap fail-safe', () => {
  const thetaHat = new Map([
    ['a', 1.0],
    ['b', 0.0],
    ['c', 3.0],
    ['d', -2.0],
  ]);
  const precision = new Map([
    ['a', 4],
    ['b', 0],
    ['c', 5],
    ['d', 5],
  ]);
  // Two disjoint components: {a,b} via related_to, {c,d} via related_to.
  const edges: SymmetricEdge[] = [
    { a: 'a', b: 'b', weight: 1 },
    { a: 'c', b: 'd', weight: 1 },
  ];
  const nodes = ['a', 'b', 'c', 'd'];

  it('under-cap: chunked solve is IDENTICAL to the whole-set solve (block-diagonal)', () => {
    const whole = smoothTheta(nodes, edges, thetaHat, precision, 0.5, 0.01);
    const chunked = smoothThetaByComponent(nodes, edges, thetaHat, precision, 0.5, 0.01, 256);
    for (const id of nodes) {
      expect(chunked.theta.get(id)).toBeCloseTo(whole.get(id) as number, 12);
    }
    expect(chunked.skippedComponentSizes).toEqual([]);
    expect(chunked.componentSizes.sort()).toEqual([2, 2]);
  });

  it('over-cap: an oversized component is left UN-smoothed (raw θ̂) + its size recorded', () => {
    // cap = 1 forces BOTH 2-node components over the cap → passthrough raw θ̂.
    const chunked = smoothThetaByComponent(nodes, edges, thetaHat, precision, 0.5, 0.01, 1);
    expect(chunked.theta.get('a')).toBe(1.0); // raw, un-smoothed
    expect(chunked.theta.get('b')).toBe(0.0);
    expect(chunked.theta.get('c')).toBe(3.0);
    expect(chunked.theta.get('d')).toBe(-2.0);
    expect(chunked.skippedComponentSizes.sort()).toEqual([2, 2]);
  });

  it('mixed: under-cap components smooth, over-cap ones passthrough (per-component)', () => {
    // A 3-node chain {x,y,z} (over cap=2) + a 2-node component {a,b} (at cap=2).
    const nodes2 = ['x', 'y', 'z', 'a', 'b'];
    const edges2: SymmetricEdge[] = [
      { a: 'x', b: 'y', weight: 1 },
      { a: 'y', b: 'z', weight: 1 },
      { a: 'a', b: 'b', weight: 1 },
    ];
    const th = new Map([
      ['x', 2],
      ['y', 0],
      ['z', 0],
      ['a', 1],
      ['b', 0],
    ]);
    const pr = new Map([
      ['x', 5],
      ['y', 0],
      ['z', 0],
      ['a', 4],
      ['b', 0],
    ]);
    const chunked = smoothThetaByComponent(nodes2, edges2, th, pr, 0.5, 0.01, 2);
    // {x,y,z} over cap → raw passthrough.
    expect(chunked.theta.get('x')).toBe(2);
    expect(chunked.theta.get('y')).toBe(0);
    expect(chunked.skippedComponentSizes).toEqual([3]);
    // {a,b} at cap → smoothed (identical to a standalone solve of that component).
    const standalone = smoothTheta(['a', 'b'], [{ a: 'a', b: 'b', weight: 1 }], th, pr, 0.5, 0.01);
    expect(chunked.theta.get('a')).toBeCloseTo(standalone.get('a') as number, 12);
    expect(chunked.theta.get('b')).toBeCloseTo(standalone.get('b') as number, 12);
  });

  it('GRAPH_SMOOTH_COMPONENT_CAP is a positive owner-fixed conservative default', () => {
    expect(GRAPH_SMOOTH_COMPONENT_CAP).toBeGreaterThan(0);
    expect(Number.isInteger(GRAPH_SMOOTH_COMPONENT_CAP)).toBe(true);
  });
});
