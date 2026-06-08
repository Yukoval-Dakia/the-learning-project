// YUK-297 — unit tests for the knowledge-graph layout engine. Pure coordinate
// solver; the fcose branch runs cytoscape in headless mode (no DOM), so this
// stays in the unit partition (src/ui/**/*.test.ts) — no DB/AI/R2 imports.

import { describe, expect, it } from 'vitest';
import {
  LAYOUT_HEIGHT,
  LAYOUT_WIDTH,
  type LayoutEdge,
  type LayoutNode,
  RADIAL_THRESHOLD,
  computeDepths,
  computeLayout,
  fcoseHeadless,
  radialByDepth,
} from './layout';

function n(id: string, parent_id: string | null = null): LayoutNode {
  return { id, parent_id };
}

// Property assertion shared by every fcose path: after the bbox-normalise step
// (which compensates for headless `fit:true` being a no-op) every coordinate
// must be finite AND land inside the logical viewBox the SVG layer renders into.
// If normalise regressed, fcose's raw centred coordinates would fall outside
// [0,LAYOUT_WIDTH]×[0,LAYOUT_HEIGHT] (the original "clump in the corner" bug).
function expectInViewBox(pos: ReturnType<typeof fcoseHeadless>): void {
  for (const [id, p] of pos) {
    expect(Number.isFinite(p.x), `${id}.x finite`).toBe(true);
    expect(Number.isFinite(p.y), `${id}.y finite`).toBe(true);
    expect(p.x, `${id}.x ≥ 0`).toBeGreaterThanOrEqual(0);
    expect(p.x, `${id}.x ≤ LAYOUT_WIDTH`).toBeLessThanOrEqual(LAYOUT_WIDTH);
    expect(p.y, `${id}.y ≥ 0`).toBeGreaterThanOrEqual(0);
    expect(p.y, `${id}.y ≤ LAYOUT_HEIGHT`).toBeLessThanOrEqual(LAYOUT_HEIGHT);
  }
}

// Count of distinct rounded values along an axis. fcose is randomised, so we
// assert the *property* that the graph is a 2-D web (≥2 distinct y) rather than
// a horizontal row (all y equal — the radial-by-depth-for-everything bug owner
// caught). Rounding absorbs sub-pixel float noise.
function distinctAxis(pos: ReturnType<typeof fcoseHeadless>, axis: 'x' | 'y'): number {
  return new Set([...pos.values()].map((p) => Math.round(p[axis]))).size;
}

describe('computeDepths', () => {
  it('roots are depth 0, children count their parent chain', () => {
    const depths = computeDepths([n('a'), n('b', 'a'), n('c', 'b')]);
    expect(depths.get('a')).toBe(0);
    expect(depths.get('b')).toBe(1);
    expect(depths.get('c')).toBe(2);
  });

  it('treats a dangling parent_id as a root (depth 0)', () => {
    const depths = computeDepths([n('orphan', 'missing')]);
    expect(depths.get('orphan')).toBe(0);
  });

  it('terminates on a parent cycle without infinite recursion', () => {
    // a → b → a cycle. Both must resolve to a finite depth.
    const depths = computeDepths([n('a', 'b'), n('b', 'a')]);
    expect(Number.isFinite(depths.get('a'))).toBe(true);
    expect(Number.isFinite(depths.get('b'))).toBe(true);
  });
});

describe('radialByDepth (design prototype formula)', () => {
  it('matches the design x/y formula for the first node of each depth row', () => {
    // depth 0 row, single node → y = 90, x = 130 + 0 + (0%2)*60 = 130.
    const pos = radialByDepth([n('root')]);
    expect(pos.get('root')).toEqual({ x: 130, y: 90 });
  });

  it('stacks rows by depth (y = 90 + depth*115) and offsets odd rows', () => {
    const pos = radialByDepth([n('a'), n('b', 'a'), n('c', 'b')]);
    // depth 0 → y 90, x 130
    expect(pos.get('a')).toEqual({ x: 130, y: 90 });
    // depth 1 (odd) → y 205, x 130 + 0 + 60 = 190
    expect(pos.get('b')).toEqual({ x: 190, y: 205 });
    // depth 2 (even) → y 320, x 130
    expect(pos.get('c')).toEqual({ x: 130, y: 320 });
  });

  it('spreads same-depth nodes evenly across the 760px band', () => {
    // two roots at depth 0 → span = 760/2 = 380. i=0 → 130, i=1 → 510.
    const pos = radialByDepth([n('a'), n('b')]);
    expect(pos.get('a')).toEqual({ x: 130, y: 90 });
    expect(pos.get('b')).toEqual({ x: 510, y: 90 });
  });

  it('returns a finite point for every node, no NaN', () => {
    const nodes = [n('a'), n('b', 'a'), n('c', 'a'), n('d', 'b')];
    const pos = radialByDepth(nodes);
    expect(pos.size).toBe(nodes.length);
    for (const p of pos.values()) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
  });
});

describe('fcoseHeadless (large-graph branch)', () => {
  // Build a graph above the radial threshold with a spanning tree of edges.
  function bigGraph(count: number): { nodes: LayoutNode[]; edges: LayoutEdge[] } {
    const nodes: LayoutNode[] = [];
    const edges: LayoutEdge[] = [];
    for (let i = 0; i < count; i++) {
      const parent = i === 0 ? null : `k${Math.floor((i - 1) / 2)}`;
      nodes.push(n(`k${i}`, parent));
      if (parent) edges.push({ from_knowledge_id: parent, to_knowledge_id: `k${i}` });
    }
    return { nodes, edges };
  }

  it('returns a finite {x,y} for every node (node count conserved)', () => {
    const { nodes, edges } = bigGraph(40);
    const pos = fcoseHeadless(nodes, edges);
    expect(pos.size).toBe(nodes.length);
    for (const node of nodes) {
      const p = pos.get(node.id);
      expect(p, `missing position for ${node.id}`).toBeDefined();
      expect(Number.isFinite(p?.x)).toBe(true);
      expect(Number.isFinite(p?.y)).toBe(true);
    }
  });

  it('normalises every node inside the logical viewBox (no corner clump)', () => {
    const { nodes, edges } = bigGraph(40);
    expectInViewBox(fcoseHeadless(nodes, edges));
  });

  it('lays out a 2-D web — nodes spread on both axes, not a single row', () => {
    const { nodes, edges } = bigGraph(40);
    const pos = fcoseHeadless(nodes, edges);
    // A horizontal row (the bug) collapses every node onto one y. A web spreads
    // them: require ≥2 distinct y AND ≥2 distinct x so it is genuinely 2-D.
    expect(distinctAxis(pos, 'y')).toBeGreaterThanOrEqual(2);
    expect(distinctAxis(pos, 'x')).toBeGreaterThanOrEqual(2);
  });

  it('derives tree edges from parent_id — flat-depth data still spreads as a web', () => {
    // Root + N same-depth leaves, NO mesh edges. Under the old radial-by-depth
    // path this collapsed into one horizontal line (all leaves share depth 1).
    // fcose only avoids that because fcoseHeadless synthesises tree edges from
    // parent_id; with those edges the star spreads radially around the root.
    const nodes = [n('root'), ...Array.from({ length: 9 }, (_, i) => n(`leaf${i}`, 'root'))];
    const pos = fcoseHeadless(nodes, []);
    expect(pos.size).toBe(nodes.length);
    expectInViewBox(pos);
    // The defining proof the tree edges entered the solver: a parent-linked star
    // is NOT collinear (a row would be a single y). ≥3 distinct y on a 10-node
    // star is only reachable if the parent_id-derived edges drove placement.
    expect(distinctAxis(pos, 'y')).toBeGreaterThanOrEqual(3);
  });

  it('skips dangling edges without throwing', () => {
    const nodes = [n('a'), n('b')];
    const edges: LayoutEdge[] = [{ from_knowledge_id: 'a', to_knowledge_id: 'ghost' }];
    const pos = fcoseHeadless(nodes, edges);
    expect(pos.size).toBe(2);
  });
});

describe('computeLayout (branch selection)', () => {
  it('returns empty map for no nodes', () => {
    expect(computeLayout([], []).size).toBe(0);
  });

  it('uses the deterministic radial layout at/under the threshold', () => {
    const nodes = Array.from({ length: RADIAL_THRESHOLD }, (_, i) =>
      n(`k${i}`, i === 0 ? null : 'k0'),
    );
    const viaCompute = computeLayout(nodes, []);
    const viaRadial = radialByDepth(nodes);
    // Identical → confirms the radial branch was taken (fcose is randomized).
    expect([...viaCompute.entries()]).toEqual([...viaRadial.entries()]);
  });

  it('switches to fcose above the threshold (in-box, spread, all nodes)', () => {
    // A BRANCHING tree (2 children per node), not a path. A pure chain has no
    // 2-D structure, so a force solver may legitimately lay it out near-straight;
    // a branching tree (what real knowledge graphs are, and what the row bug was
    // about) forces a genuine web. count chosen above RADIAL_THRESHOLD so the
    // fcose branch is exercised.
    const count = RADIAL_THRESHOLD + 7;
    const nodes = Array.from({ length: count }, (_, i) =>
      n(`k${i}`, i === 0 ? null : `k${Math.floor((i - 1) / 2)}`),
    );
    const edges: LayoutEdge[] = nodes
      .filter((node) => node.parent_id)
      .map((node) => ({ from_knowledge_id: node.parent_id as string, to_knowledge_id: node.id }));
    const pos = computeLayout(nodes, edges);
    expect(pos.size).toBe(count);
    // Finite + inside the viewBox (normalise) + genuinely 2-D (not a row).
    expectInViewBox(pos);
    expect(distinctAxis(pos, 'y')).toBeGreaterThanOrEqual(2);
    expect(distinctAxis(pos, 'x')).toBeGreaterThanOrEqual(2);
  });
});
