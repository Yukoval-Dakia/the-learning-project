// YUK-297 — knowledge-graph layout engine. Pure coordinate solver, decoupled
// from rendering. Used by KnowledgeGraph's SVG layer (the SVG <g> per node reads
// the {x,y} this returns); it never touches the DOM at module scope.
//
// Two branches (see docs/superpowers/plans/2026-06-08-yuk297-visual-refinement.md
// §2.2 + the layout_decision field):
//   • small graphs (node count ≤ RADIAL_THRESHOLD) → deterministic radial-by-depth,
//     the design prototype's exact formula (screen-knowledge.jsx L29-37). Closest
//     to the Loom mock, snapshot-testable, no cytoscape spin-up.
//   • larger graphs → cytoscape + fcose run HEADLESS: we build a throwaway cy
//     instance with { headless: true }, run the fcose layout, read each node's
//     position into a Map, and destroy the instance. cytoscape contributes ONLY
//     coordinates here — all rendering is our own SVG. This is the path that was
//     already battle-tested at ~200-node scale in this codebase.
//
// The radial branch keeps the design's coordinate system (viewBox 0 0 1000 560),
// so a 7-9 node graph lands pixel-faithful to the prototype. fcose output is then
// re-fit into the same logical box by the SVG layer's initial-fit clamp.

import cytoscape from 'cytoscape';
import fcose, { type FcoseLayoutOptions } from 'cytoscape-fcose';

export interface LayoutNode {
  id: string;
  parent_id: string | null;
}

export interface LayoutEdge {
  from_knowledge_id: string;
  to_knowledge_id: string;
}

export interface Point {
  x: number;
  y: number;
}

export type LayoutMap = Map<string, Point>;

// Logical canvas the design prototype draws into (screen-knowledge.jsx svg
// viewBox). The radial branch positions inside this box; the SVG layer renders
// with the same viewBox so radial coordinates are pixel-faithful to the mock.
export const LAYOUT_WIDTH = 1000;
export const LAYOUT_HEIGHT = 560;

// At/under this node count we use the deterministic radial-by-depth layout (covers
// the 7-9 node mock + synthetic seed). Above it, fcose headless keeps same-depth
// rows from collapsing into an overlapping line (the radial x-formula degrades at
// scale — see plan §2.2).
export const RADIAL_THRESHOLD = 12;

// Register fcose exactly once per module load (idempotent for our usage). Guarded
// so repeated computeLayout calls don't re-register. cytoscape.use throws if the
// same extension registers twice in some versions, so the flag is load-bearing.
let fcoseRegistered = false;
function ensureFcose(): void {
  if (!fcoseRegistered) {
    cytoscape.use(fcose);
    fcoseRegistered = true;
  }
}

/**
 * Depth of each node = length of its parent chain (root = 0). Cycles / missing
 * parents terminate the walk (a parent_id with no node, or a visited id, stops
 * at the current depth) so this is total over any node set. Mirrors the design's
 * `n.depth` field, which production doesn't store — we derive it from parent_id.
 */
export function computeDepths(nodes: LayoutNode[]): Map<string, number> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const depthCache = new Map<string, number>();

  const depthOf = (id: string, seen: Set<string>): number => {
    const cached = depthCache.get(id);
    if (cached !== undefined) return cached;
    const node = byId.get(id);
    // No parent, dangling parent, or a cycle → treat as a root at this level.
    if (!node || node.parent_id == null || !byId.has(node.parent_id) || seen.has(id)) {
      return 0;
    }
    seen.add(id);
    const d = depthOf(node.parent_id, seen) + 1;
    depthCache.set(id, d);
    return d;
  };

  const out = new Map<string, number>();
  for (const n of nodes) out.set(n.id, depthOf(n.id, new Set()));
  return out;
}

/**
 * Design prototype's deterministic radial-by-depth layout
 * (screen-knowledge.jsx L29-37). Rows are stacked by depth; within a row, nodes
 * spread evenly across a fixed horizontal band, with odd rows offset for a woven
 * look. Deterministic → snapshot-testable.
 */
export function radialByDepth(nodes: LayoutNode[]): LayoutMap {
  const depths = computeDepths(nodes);
  const byDepth = new Map<number, LayoutNode[]>();
  for (const n of nodes) {
    const d = depths.get(n.id) ?? 0;
    const row = byDepth.get(d) ?? [];
    row.push(n);
    byDepth.set(d, row);
  }

  const pos: LayoutMap = new Map();
  for (const [d, row] of byDepth) {
    const y = 90 + d * 115;
    const span = 760 / Math.max(1, row.length);
    row.forEach((n, i) => {
      pos.set(n.id, { x: 130 + i * span + (d % 2) * 60, y });
    });
  }
  return pos;
}

/**
 * fcose force layout, run HEADLESS — build a throwaway cy instance, run the
 * layout synchronously (animate:false), read positions, destroy. Contributes
 * coordinates only; never renders. Returns finite {x,y} for every input node.
 */
export function fcoseHeadless(nodes: LayoutNode[], edges: LayoutEdge[]): LayoutMap {
  ensureFcose();
  const nodeIds = new Set(nodes.map((n) => n.id));
  const cy = cytoscape({
    headless: true,
    elements: [
      ...nodes.map((n) => ({ group: 'nodes' as const, data: { id: n.id } })),
      ...edges
        .filter((e) => nodeIds.has(e.from_knowledge_id) && nodeIds.has(e.to_knowledge_id))
        .map((e, i) => ({
          group: 'edges' as const,
          data: {
            id: `l${i}`,
            source: e.from_knowledge_id,
            target: e.to_knowledge_id,
          },
        })),
    ],
  });

  // fcose layout options carry extension-specific keys not present in
  // cytoscape's BaseLayoutOptions; typed via the cytoscape-fcose module shim.
  const layoutOptions: FcoseLayoutOptions = {
    name: 'fcose',
    quality: 'default',
    randomize: true,
    animate: false,
    fit: true,
    padding: 40,
    nodeSeparation: 80,
  };

  try {
    cy.layout(layoutOptions).run();

    const pos: LayoutMap = new Map();
    for (const n of cy.nodes()) {
      const p = n.position();
      // Guard against a degenerate NaN from an empty/single-node layout — fall
      // back to the canvas centre so the SVG never renders a node at NaN.
      const x = Number.isFinite(p.x) ? p.x : LAYOUT_WIDTH / 2;
      const y = Number.isFinite(p.y) ? p.y : LAYOUT_HEIGHT / 2;
      pos.set(n.id(), { x, y });
    }
    return pos;
  } finally {
    cy.destroy();
  }
}

/**
 * Entry point. Branches on node count: small → deterministic radial-by-depth,
 * large → fcose headless. Always returns a finite {x,y} for every node id.
 */
export function computeLayout(nodes: LayoutNode[], edges: LayoutEdge[]): LayoutMap {
  if (nodes.length === 0) return new Map();
  if (nodes.length <= RADIAL_THRESHOLD) return radialByDepth(nodes);
  return fcoseHeadless(nodes, edges);
}
