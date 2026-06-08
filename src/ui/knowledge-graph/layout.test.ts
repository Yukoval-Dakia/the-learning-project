// YUK-297 — unit tests for the knowledge-graph layout engine. Pure coordinate
// solver; the fcose branch runs cytoscape in headless mode (no DOM), so this
// stays in the unit partition (src/ui/**/*.test.ts) — no DB/AI/R2 imports.

import { describe, expect, it } from 'vitest';
import {
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

  it('switches to fcose above the threshold (finite coords for all nodes)', () => {
    const count = RADIAL_THRESHOLD + 5;
    const nodes = Array.from({ length: count }, (_, i) => n(`k${i}`, i === 0 ? null : `k${i - 1}`));
    const edges: LayoutEdge[] = nodes
      .filter((node) => node.parent_id)
      .map((node) => ({ from_knowledge_id: node.parent_id as string, to_knowledge_id: node.id }));
    const pos = computeLayout(nodes, edges);
    expect(pos.size).toBe(count);
    for (const p of pos.values()) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
  });
});
