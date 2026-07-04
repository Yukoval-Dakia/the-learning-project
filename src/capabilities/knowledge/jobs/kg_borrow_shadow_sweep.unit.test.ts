// YUK-559 (S3 / C8) — pure-function unit tests for the kg-borrowing SHADOW sweep.
//
// Import surface is DELIBERATELY connection-free: `@/server/mastery/state` /
// `@/core/graph-laplacian` / `@/core/prereq-propagation` are pure (Db is type-only in their
// closures), so these run in the no-DB unit partition (`*.unit.test.ts`). Pins:
//   - quantileSummary uses type-7 (linear interpolation) — the `@/core/theta` convention.
//   - componentHistogram buckets are DERIVED from the cap (+ a >cap overflow bucket).
//   - computeShadowBorrowStats attributes the borrow effect three ways {a5_only, a6_only, joint}.
//   - SHADOW_BORROW_COMPONENT_CAP is pinned equal to the live A5 guard cap.
//   - splitProjectionEdgeRows (C9 shared splitter) orientation-normalises + admits by type.

import { describe, expect, it } from 'vitest';

import { GRAPH_SMOOTH_COMPONENT_CAP, type SymmetricEdge } from '@/core/graph-laplacian';
import type { DirectedEdge } from '@/core/prereq-propagation';
import { PROJECTION_EDGE_RELATION_TYPES, splitProjectionEdgeRows } from '@/server/mastery/state';
import {
  SHADOW_BORROW_COMPONENT_CAP,
  componentHistogram,
  computeShadowBorrowStats,
  quantileSummary,
} from './kg_borrow_shadow_sweep';

describe('quantileSummary — type-7 (linear interpolation)', () => {
  it('empty sample → null', () => {
    expect(quantileSummary([])).toBeNull();
  });

  it('[0..9] pins the type-7 quantiles (p50=4.5, p90=8.1, p99=8.91)', () => {
    const s = quantileSummary([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(s).not.toBeNull();
    if (!s) return;
    expect(s.min).toBe(0);
    expect(s.max).toBe(9);
    expect(s.p50).toBeCloseTo(4.5, 12);
    expect(s.p90).toBeCloseTo(8.1, 12);
    expect(s.p99).toBeCloseTo(8.91, 12);
  });

  it('unsorted input is sorted internally; single element → all quantiles equal it', () => {
    const s = quantileSummary([9, 0, 5, 2]);
    expect(s?.min).toBe(0);
    expect(s?.max).toBe(9);
    const one = quantileSummary([7]);
    expect(one).toEqual({ min: 7, p50: 7, p90: 7, p99: 7, max: 7 });
  });
});

describe('componentHistogram — cap-derived power-of-two buckets', () => {
  it('cap=256 reproduces the historical [1,2,4,…,256] buckets + >256 overflow', () => {
    const h = componentHistogram([1, 2, 3, 256, 257, 300], 256);
    expect(h['<=1']).toBe(1);
    expect(h['<=2']).toBe(1);
    expect(h['<=4']).toBe(1); // size 3 → <=4 bucket
    expect(h['<=256']).toBe(1); // size 256 lands in the top on-cap bucket
    expect(h['>256']).toBe(2); // 257, 300 overflow
  });

  it('cap derives the boundaries (cap=4 → [1,2,4] + >4)', () => {
    const h = componentHistogram([1, 2, 3, 4, 5], 4);
    expect(h).toEqual({ '<=1': 1, '<=2': 1, '<=4': 2, '>4': 1 });
  });
});

describe('computeShadowBorrowStats — three-variant attribution', () => {
  // A—B via related_to (A5 acts on the {A,B} component); C→D via prerequisite (A6 presses D
  // down + retro-credits C up). A5 also κ-shrinks the isolated observed node D toward μ₀=0.
  const observed = new Map([
    ['A', { theta_hat: 2, theta_precision: 4 }],
    ['B', { theta_hat: 0, theta_precision: 4 }],
    ['C', { theta_hat: 0, theta_precision: 4 }],
    ['D', { theta_hat: 3, theta_precision: 4 }],
  ]);
  const symmetric: SymmetricEdge[] = [{ a: 'A', b: 'B', weight: 1 }];
  const directed: DirectedEdge[] = [{ from: 'C', to: 'D', weight: 1 }];

  it('a5_only, a6_only, and joint attribute distinct move counts', () => {
    const stats = computeShadowBorrowStats(observed, symmetric, directed, 256);
    expect(stats.observed_count).toBe(4);
    // A5 moves A, B (coupling) and D (κ shrink from 3); C stays at prior 0 → 3 moved.
    expect(stats.a5_only.observed_moved_count).toBe(3);
    expect(stats.a5_only.would_borrow_count).toBe(0);
    // A6 (on bare θ̂) moves only the prereq edge's endpoints C, D → 2.
    expect(stats.a6_only.observed_moved_count).toBe(2);
    expect(stats.a6_only.would_borrow_count).toBe(0);
    // Joint = A5 then A6 → all four observed KCs moved.
    expect(stats.joint.observed_moved_count).toBe(4);
    expect(stats.joint.would_borrow_count).toBe(0);
  });

  it('component metrics are top-level A5 structure (one related_to pair + two singletons)', () => {
    const stats = computeShadowBorrowStats(observed, symmetric, directed, 256);
    expect(stats.component_count).toBe(3);
    expect(stats.component_size_max).toBe(2);
    expect(stats.skipped_components).toBe(0);
  });

  it('no symmetric edges ⇒ a5_only is identity and joint ≡ a6_only', () => {
    const stats = computeShadowBorrowStats(observed, [], directed, 256);
    expect(stats.a5_only.observed_moved_count).toBe(0);
    expect(stats.joint.observed_moved_count).toBe(stats.a6_only.observed_moved_count);
    expect(stats.joint.observed_moved_count).toBe(2);
  });
});

describe('SHADOW_BORROW_COMPONENT_CAP mirrors the live A5 guard cap', () => {
  it('equals GRAPH_SMOOTH_COMPONENT_CAP', () => {
    expect(SHADOW_BORROW_COMPONENT_CAP).toBe(GRAPH_SMOOTH_COMPONENT_CAP);
  });
});

describe('splitProjectionEdgeRows (C9 shared splitter)', () => {
  it('PROJECTION_EDGE_RELATION_TYPES is the admitted borrow relation set', () => {
    expect([...PROJECTION_EDGE_RELATION_TYPES]).toEqual([
      'related_to',
      'prerequisite',
      'derived_from',
    ]);
  });

  it('related_to → symmetric; prerequisite keeps orientation; derived_from FLIPS orientation', () => {
    const { symmetric, directed } = splitProjectionEdgeRows([
      { from_id: 'R1', to_id: 'R2', relation_type: 'related_to', weight: 0.5 },
      { from_id: 'P1', to_id: 'P2', relation_type: 'prerequisite', weight: 1 },
      { from_id: 'D1', to_id: 'D2', relation_type: 'derived_from', weight: 1 },
    ]);
    expect(symmetric).toEqual([{ a: 'R1', b: 'R2', weight: 0.5 }]);
    // prerequisite: from IS the prereq (from→to). derived_from: base `to` is the prereq → flip.
    expect(directed).toEqual([
      { from: 'P1', to: 'P2', weight: 1 },
      { from: 'D2', to: 'D1', weight: 1 },
    ]);
  });

  it('contrasts_with (and any non-admitted type) is dropped from both lists', () => {
    const { symmetric, directed } = splitProjectionEdgeRows([
      { from_id: 'X', to_id: 'Y', relation_type: 'contrasts_with', weight: 1 },
    ]);
    expect(symmetric).toEqual([]);
    expect(directed).toEqual([]);
  });
});
