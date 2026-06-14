// YUK-297 — knowledge-graph layout engine. Pure coordinate solver, decoupled
// from rendering. Used by KnowledgeGraph's SVG layer (the SVG <g> per node reads
// the {x,y} this returns); it never touches the DOM at module scope.
//
// Two branches:
//   • the normal path → deterministic `tidyTree` (children clustered under parent,
//     depth rows). Progressive disclosure (YUK-297) keeps the disclosed/visible set
//     small + sparse, so a tidy tree reads clean and is stable across reloads
//     (no random seed). No cytoscape spin-up.
//   • a WIDE disclosed set (one expanded node with many siblings, > FORCE_THRESHOLD)
//     → cytoscape + fcose run HEADLESS: a throwaway { headless:true } cy instance,
//     run fcose, read positions, destroy. This spreads a large sibling fan RADIALLY
//     instead of cramming it into one tidy row. cytoscape contributes ONLY
//     coordinates; all rendering is our own SVG.
//
// Both branches emit coords in the design viewBox (0 0 1000 560); the SVG layer +
// camera fit re-frame from there.

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

// tidyTree is the default; above this many VISIBLE nodes computeLayout switches to
// fcose. Progressive disclosure normally keeps the set well under this, but one
// expanded node can still have many children — a wide sibling fan that a tidy row
// would cram. fcose spreads such a fan radially instead. Tuned generous so the
// common case (a handful of children) always stays on the clean deterministic path.
export const FORCE_THRESHOLD = 60;

// Register fcose exactly once per module load (idempotent for our usage). Guarded
// so repeated computeLayout calls don't re-register. cytoscape.use throws if the
// same extension registers twice in some versions, so the flag is load-bearing.
let fcoseRegistered = false;
function ensureFcose(): void {
  if (!fcoseRegistered) {
    try {
      cytoscape.use(fcose);
    } catch {
      // Already registered — e.g. an HMR reload re-ran this module (resetting
      // fcoseRegistered to false) while cytoscape's core kept the extension.
      // cytoscape.use throws on a duplicate register in some versions; swallow
      // it and proceed so the layout module survives hot reloads.
    }
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
 * fcose force layout, run HEADLESS — build a throwaway cy instance, run the
 * layout synchronously (animate:false), read positions, destroy. Contributes
 * coordinates only; never renders. Returns finite {x,y} for every input node.
 */
export function fcoseHeadless(nodes: LayoutNode[], edges: LayoutEdge[]): LayoutMap {
  ensureFcose();
  const nodeIds = new Set(nodes.map((n) => n.id));
  // Feed fcose the FULL connectivity so the force solver lays out a web:
  //   • tree skeleton (parent_id) — the structural backbone, derived here since
  //     production doesn't store explicit tree edges; and
  //   • mesh typed edges (related/applied/prerequisite/derived/contrasts).
  // Without the tree edges fcose only saw the sparse mesh and left most nodes
  // unconnected → a near-linear smear. With both, nodes spread by their real
  // relationships and the graph reads as a mesh (the fix for the YUK-297 v1 bug).
  const treeEdges = nodes
    // Type predicate narrows parent_id to string in the map below, so no cast /
    // non-null assertion is needed (the runtime guard and the type agree).
    .filter((n): n is LayoutNode & { parent_id: string } => {
      return n.parent_id != null && nodeIds.has(n.parent_id);
    })
    .map((n, i) => ({
      group: 'edges' as const,
      data: { id: `t${i}`, source: n.parent_id, target: n.id },
    }));
  const cy = cytoscape({
    headless: true,
    elements: [
      ...nodes.map((n) => ({ group: 'nodes' as const, data: { id: n.id } })),
      ...treeEdges,
      ...edges
        .filter((e) => nodeIds.has(e.from_knowledge_id) && nodeIds.has(e.to_knowledge_id))
        .map((e, i) => ({
          group: 'edges' as const,
          data: {
            id: `m${i}`,
            source: e.from_knowledge_id,
            target: e.to_knowledge_id,
          },
        })),
    ],
  });

  // fcose layout options carry extension-specific keys not present in
  // cytoscape's BaseLayoutOptions; typed via the cytoscape-fcose module shim.
  // idealEdgeLength + nodeRepulsion tuned so a wide sibling fan (this branch only
  // runs above FORCE_THRESHOLD) spreads into a readable web rather than clumping;
  // gravity keeps it centred. randomize:true is REQUIRED: we build the cy
  // instance headless with no seed positions, so fcose needs its own spectral
  // draft to start from — randomize:false would begin every node at the origin
  // and degenerate. The trade-off is this (rarely-hit) branch is NOT deterministic
  // across reloads, unlike the default tidyTree path. Acceptable for a >60-node
  // safety valve, where exact reload-stability isn't a concern.
  const layoutOptions: FcoseLayoutOptions = {
    name: 'fcose',
    quality: 'proof',
    randomize: true,
    animate: false,
    fit: true,
    padding: 50,
    nodeSeparation: 120,
    idealEdgeLength: 130,
    nodeRepulsion: 9000,
    gravity: 0.25,
  };

  try {
    cy.layout(layoutOptions).run();

    // fcose returns CENTRED coordinates (origin ~0,0, any scale) — `fit:true`
    // is a viewport op that does nothing headless. Normalise the raw bbox into
    // the logical viewBox (LAYOUT_WIDTH × LAYOUT_HEIGHT) with padding so the SVG
    // layer (which renders at that viewBox, same as radialByDepth) shows the
    // whole web filling the canvas instead of a clump in one corner.
    const raw: Array<[string, Point]> = [];
    for (const n of cy.nodes()) {
      const p = n.position();
      raw.push([n.id(), { x: Number.isFinite(p.x) ? p.x : 0, y: Number.isFinite(p.y) ? p.y : 0 }]);
    }
    if (raw.length === 0) return new Map();

    const xs = raw.map(([, p]) => p.x);
    const ys = raw.map(([, p]) => p.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const PAD = 80;
    const spanX = maxX - minX || 1;
    const spanY = maxY - minY || 1;
    // uniform scale (preserve aspect) to fit inside the padded viewBox
    const scale = Math.min((LAYOUT_WIDTH - 2 * PAD) / spanX, (LAYOUT_HEIGHT - 2 * PAD) / spanY);
    const drawnW = spanX * scale;
    const drawnH = spanY * scale;
    const offsetX = (LAYOUT_WIDTH - drawnW) / 2;
    const offsetY = (LAYOUT_HEIGHT - drawnH) / 2;

    const pos: LayoutMap = new Map();
    for (const [id, p] of raw) {
      pos.set(id, { x: offsetX + (p.x - minX) * scale, y: offsetY + (p.y - minY) * scale });
    }
    return pos;
  } finally {
    cy.destroy();
  }
}

/**
 * Deterministic tidy tree (Reingold–Tilford style): children are clustered UNDER
 * their parent, each depth is a row, leaves are spaced evenly left-to-right and a
 * parent sits centred over its children. This is THE layout for the progressive-
 * disclosure view (YUK-297) — only the disclosed/visible nodes are ever passed in,
 * so the set is always small and sparse, and a tidy tree reads far cleaner than a
 * full-width depth band (the "7-siblings-cramped-in-a-row" problem owner caught).
 *
 * Raw slot/depth coords are normalised into the logical viewBox (LAYOUT_WIDTH ×
 * LAYOUT_HEIGHT) with padding so any disclosed set fills the canvas. Multiple roots
 * (e.g. several domains, or a focus subtree whose parent is hidden) lay out left to
 * right sharing one slot cursor. Pure tree layout — mesh edges don't affect node
 * placement (they render as curves over these positions).
 */
export function tidyTree(nodes: LayoutNode[]): LayoutMap {
  if (nodes.length === 0) return new Map();
  const ids = new Set(nodes.map((n) => n.id));
  const childrenOf = new Map<string, string[]>();
  for (const n of nodes) {
    if (n.parent_id != null && ids.has(n.parent_id)) {
      const arr = childrenOf.get(n.parent_id) ?? [];
      arr.push(n.id);
      childrenOf.set(n.parent_id, arr);
    }
  }
  const depths = computeDepths(nodes);
  // roots within this set = nodes whose parent isn't present.
  const roots = nodes.filter((n) => n.parent_id == null || !ids.has(n.parent_id)).map((n) => n.id);
  const slot = new Map<string, number>();
  let cursor = 0;
  const assign = (id: string, seen: Set<string>): number => {
    // cycle guard — return the cursor WITHOUT consuming a slot (we never
    // slot.set this id here; the trailing fallback below gives it a real slot).
    if (seen.has(id)) return cursor;
    seen.add(id);
    const ch = childrenOf.get(id) ?? [];
    if (ch.length === 0) {
      const x = cursor++;
      slot.set(id, x);
      return x;
    }
    const xs = ch.map((c) => assign(c, seen));
    const x = (xs[0] + xs[xs.length - 1]) / 2;
    slot.set(id, x);
    return x;
  };
  for (const r of roots) assign(r, new Set());
  // any node missed (orphaned by a cycle) gets a trailing slot.
  for (const n of nodes) if (!slot.has(n.id)) slot.set(n.id, cursor++);

  let maxDepth = 0;
  for (const n of nodes) maxDepth = Math.max(maxDepth, depths.get(n.id) ?? 0);
  const slots = [...slot.values()];
  const minX = Math.min(...slots);
  const maxX = Math.max(...slots);
  const spanX = maxX - minX || 1;
  const PAD_X = 120;
  const PAD_Y = 90;
  // S5 (YUK-335): cap rowGap so a shallow tree (maxDepth 1-2) isn't stretched full-
  // height into a ~380px inter-row void (audit §3.8). The cap only bites shallow trees;
  // deeper trees (rawRowGap < cap) keep the canvas-filling spread unchanged. When
  // capped, center the used band vertically so slack falls top+bottom, not below.
  const ROW_GAP_MAX = 150;
  const rawRowGap = maxDepth > 0 ? (LAYOUT_HEIGHT - 2 * PAD_Y) / maxDepth : 0;
  const rowGap = Math.min(ROW_GAP_MAX, rawRowGap);
  const startY = (LAYOUT_HEIGHT - maxDepth * rowGap) / 2;
  const colScale = (LAYOUT_WIDTH - 2 * PAD_X) / spanX;

  const pos: LayoutMap = new Map();
  for (const n of nodes) {
    const sx = slot.get(n.id) ?? 0;
    const d = depths.get(n.id) ?? 0;
    const x = maxX === minX ? LAYOUT_WIDTH / 2 : PAD_X + (sx - minX) * colScale;
    const y = maxDepth === 0 ? LAYOUT_HEIGHT / 2 : startY + d * rowGap;
    pos.set(n.id, { x, y });
  }
  return pos;
}

/**
 * Entry point. Disclosed/visible sets are small (progressive disclosure), so the
 * deterministic tidy tree is the default; fcose headless is a never-normally-hit
 * safety valve for a pathologically large set (e.g. disclosure disabled). Always
 * returns a finite {x,y} for every node id.
 */
export function computeLayout(nodes: LayoutNode[], edges: LayoutEdge[]): LayoutMap {
  if (nodes.length === 0) return new Map();
  if (nodes.length > FORCE_THRESHOLD) {
    try {
      return fcoseHeadless(nodes, edges);
    } catch {
      // fcose can throw (extension load failure, degenerate elements). This runs
      // inside a useMemo in KnowledgeGraph with no ErrorBoundary above it, so an
      // uncaught throw would white-screen the whole graph. Degrade to the
      // deterministic tidy tree — cramped for a huge set, but it always renders.
      return tidyTree(nodes);
    }
  }
  return tidyTree(nodes);
}
