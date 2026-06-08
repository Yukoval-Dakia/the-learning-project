// YUK-297 — SVG render-layer coverage for the rewritten KnowledgeGraph. The unit
// partition runs in the `node` env with no jsdom / @testing-library, so (matching
// the app/(app)/inbox/inbox.test.tsx precedent) we statically render the component
// with react-dom/server's renderToString and assert the emitted SVG markup. This
// covers the visual contract that the old buildElements/buildStylesheet tests
// guarded — design 3-tone fills, mastery-arc geometry, the 5 typed-edge token/dash/arrow
// mapping (production RELATION_VISUAL, NOT the design mock tones), tree/mesh/
// proposed z-order via DOM order, the due halo, and unique marker/filter defs.
//
// NOT covered here (no live DOM in the node unit env): click → onNodeClick /
// onProposalDecision dispatch, pan/zoom drag, focus fading. Those are behavioural;
// the geometry under them (svgPointToContainerPx) is unit-tested below, and the
// §视觉验收 manual playwright pass in the plan exercises the live interactions.

import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  HUB_RADIUS,
  type KnowledgeEdgeProposal,
  KnowledgeGraph,
  type KnowledgeGraphEdge,
  type KnowledgeGraphNode,
  LEAF_RADIUS,
  type NodeDueSummary,
  fitViewToNeighborhood,
  svgPointToContainerPx,
} from './KnowledgeGraph';

function node(partial: Partial<KnowledgeGraphNode> & { id: string }): KnowledgeGraphNode {
  return { name: partial.id, parent_id: null, ...partial };
}

function edge(
  partial: Partial<KnowledgeGraphEdge> & {
    id: string;
    from_knowledge_id: string;
    to_knowledge_id: string;
  },
): KnowledgeGraphEdge {
  return { relation_type: 'related_to', weight: 1, ...partial };
}

function render(
  props: Partial<Parameters<typeof KnowledgeGraph>[0]> & {
    nodes: KnowledgeGraphNode[];
    edges: KnowledgeGraphEdge[];
  },
): string {
  return renderToString(<KnowledgeGraph selectedId={null} onNodeClick={() => {}} {...props} />);
}

describe('KnowledgeGraph SVG render — nodes', () => {
  const nodes = [
    node({ id: 'root', parent_id: null, mastery: 0.8, evidence_count: 5 }),
    node({ id: 'child', parent_id: 'root', mastery: 0.3, evidence_count: 5 }),
    node({ id: 'lonely', mastery: 0.5, evidence_count: 1 }),
  ];

  it('renders one node <g> per node with its design 3-tone class', () => {
    const html = render({ nodes, edges: [] });
    // good (root 0.8), again (child 0.3), hard (lonely 0.5) — tone is by mastery
    // only now (evidence no longer gates the disc color, owner「全抄 design」).
    expect(html).toContain('tone-good');
    expect(html).toContain('tone-again');
    expect(html).toContain('tone-hard');
    // three kg-node groups.
    const count = (html.match(/class="kg-node /g) ?? []).length;
    expect(count).toBe(3);
  });

  it('arc dashoffset encodes mastery (circ * (1 - mastery))', () => {
    const html = render({ nodes: [node({ id: 'a', mastery: 0.5, evidence_count: 5 })], edges: [] });
    const r = LEAF_RADIUS; // single leaf node (no children)
    const circ = 2 * Math.PI * r;
    const expected = circ * (1 - 0.5);
    // stroke-dashoffset is rendered on the arc circle.
    expect(html).toContain(`stroke-dashoffset="${expected}"`);
  });

  it('NULL mastery → arc fully empty (dashoffset = circ)', () => {
    const html = render({
      nodes: [node({ id: 'a', mastery: null, evidence_count: 0 })],
      edges: [],
    });
    const circ = 2 * Math.PI * LEAF_RADIUS;
    expect(html).toContain(`stroke-dashoffset="${circ}"`);
  });

  it('disc-内 pct integer shown for confident bands, rounded like MasteryBadge', () => {
    // 0.624 → 62 (matches MasteryBadge Math.round(mastery*100)).
    const html = render({
      nodes: [node({ id: 'a', mastery: 0.624, evidence_count: 5 })],
      edges: [],
    });
    expect(html).toContain('class="kg-node-pct mono"');
    expect(html).toMatch(/class="kg-node-pct mono"[^>]*>62</);
  });

  it('disc-内 pct ALWAYS shown incl. never-practiced (null → 0) — design paints the digit', () => {
    // owner「全抄 design」: the prototype always shows the mastery integer. NULL
    // mastery (never practiced) collapses to 0; low-evidence shows its rounded %.
    const untrained = render({
      nodes: [node({ id: 'a', mastery: null, evidence_count: 0 })],
      edges: [],
    });
    expect(untrained).toMatch(/class="kg-node-pct mono"[^>]*>0</);
    const lowEvidence = render({
      nodes: [node({ id: 'a', mastery: 0.5, evidence_count: 2 })],
      edges: [],
    });
    expect(lowEvidence).toMatch(/class="kg-node-pct mono"[^>]*>50</);
  });

  it('radius is hub (24) for a parent, leaf (18) for a childless node (design hub/leaf)', () => {
    const html = render({
      nodes: [node({ id: 'p', parent_id: null }), node({ id: 'c', parent_id: 'p' })],
      edges: [],
    });
    // 'p' parents 'c' → hub r=24; 'c' has no children → leaf r=18.
    expect(html).toContain(`r="${HUB_RADIUS}"`);
    expect(html).toContain(`r="${LEAF_RADIUS}"`);
  });

  it('overdue node gets a coral due halo circle', () => {
    const due = new Map<string, NodeDueSummary>([['a', { overdue: 2, due_soon: 0 }]]);
    const html = render({
      nodes: [node({ id: 'a', mastery: 0.5, evidence_count: 5 })],
      edges: [],
      dueCounts: due,
    });
    expect(html).toContain('kg-node-halo');
  });

  it('non-overdue node has no halo', () => {
    const html = render({
      nodes: [node({ id: 'a', mastery: 0.5, evidence_count: 5 })],
      edges: [],
    });
    expect(html).not.toContain('kg-node-halo');
  });

  it('selected node carries the is-selected class', () => {
    const html = render({
      nodes: [node({ id: 'a', mastery: 0.5, evidence_count: 5 })],
      edges: [],
      selectedId: 'a',
    });
    expect(html).toContain('is-selected');
  });
});

describe('KnowledgeGraph SVG render — edges', () => {
  const nodes = [node({ id: 'a', parent_id: null }), node({ id: 'b', parent_id: 'a' })];

  it('renders a tree edge for a parent/child pair', () => {
    const html = render({ nodes, edges: [] });
    expect(html).toContain('kg-edge-tree');
  });

  it('maps the 5 typed relations to their production token color + glyph + label', () => {
    const cases: Array<[string, string, string]> = [
      ['prerequisite', 'var(--coral)', '→'],
      ['applied_in', 'var(--info)', '↦'],
      ['derived_from', 'var(--ink-5)', '↳'],
      ['contrasts_with', 'var(--contrasts)', '⇆'],
      ['related_to', 'var(--ink-4)', '—'],
    ];
    for (const [rel, color, glyph] of cases) {
      const html = render({
        nodes,
        edges: [
          edge({
            id: `e-${rel}`,
            from_knowledge_id: 'a',
            to_knowledge_id: 'b',
            relation_type: rel,
          }),
        ],
      });
      expect(html, `${rel} color`).toContain(`stroke="${color}"`);
      expect(html, `${rel} class`).toContain(`rel-${rel}`);
      expect(html, `${rel} glyph`).toContain(glyph);
    }
  });

  it('unknown/experimental relation_type falls back to related_to visual', () => {
    const html = render({
      nodes,
      edges: [
        edge({
          id: 'ex',
          from_knowledge_id: 'a',
          to_knowledge_id: 'b',
          relation_type: 'experimental:co_occurs',
        }),
      ],
    });
    expect(html).toContain('rel-related_to');
    expect(html).toContain('stroke="var(--ink-4)"');
  });

  it('skips a mesh edge with a dangling endpoint', () => {
    const html = render({
      nodes,
      edges: [edge({ id: 'd', from_knowledge_id: 'a', to_knowledge_id: 'ghost' })],
    });
    // No mesh edge group is rendered for the dangling edge id.
    expect(html).not.toContain('kg-edge-mesh');
  });

  it('mesh edge stroke width follows weight (1 + weight*1.5)', () => {
    const html = render({
      nodes,
      edges: [edge({ id: 'w', from_knowledge_id: 'a', to_knowledge_id: 'b', weight: 2 })],
    });
    expect(html).toContain('stroke-width="4"'); // 1 + 2*1.5
  });

  it('paints tree edges before nodes (mesh-over-tree z via DOM order)', () => {
    const html = render({ nodes, edges: [] });
    const treeIdx = html.indexOf('kg-edge-tree');
    const nodeIdx = html.indexOf('kg-node ');
    expect(treeIdx).toBeGreaterThan(-1);
    expect(nodeIdx).toBeGreaterThan(-1);
    expect(treeIdx).toBeLessThan(nodeIdx);
  });
});

describe('KnowledgeGraph SVG render — proposed edges (Slice 3)', () => {
  const nodes = [node({ id: 'a' }), node({ id: 'b' })];
  const proposals: KnowledgeEdgeProposal[] = [
    {
      id: 'p1',
      key: 'subj:a:b:rel:actor',
      from_knowledge_id: 'a',
      to_knowledge_id: 'b',
      relation_type: 'prerequisite',
    },
  ];

  it('renders a proposed edge (dotted, with a fat hit-area) when both endpoints visible', () => {
    const html = render({ nodes, edges: [], proposals });
    expect(html).toContain('kg-edge-proposed');
    expect(html).toContain('kg-edge-hit');
  });

  it('skips a proposed edge whose endpoint is filtered out', () => {
    const html = render({
      nodes,
      edges: [],
      proposals: [
        {
          id: 'p2',
          key: 'k2',
          from_knowledge_id: 'a',
          to_knowledge_id: 'ghost',
          relation_type: 'prerequisite',
        },
      ],
    });
    expect(html).not.toContain('kg-edge-proposed');
  });
});

describe('KnowledgeGraph SVG render — defs uniqueness', () => {
  it('emits an arrow marker + node-shadow filter with instance-unique ids', () => {
    const html = render({
      nodes: [node({ id: 'a', mastery: 0.5, evidence_count: 5 })],
      edges: [],
    });
    expect(html).toMatch(/<marker id="kg-arrow-/);
    expect(html).toMatch(/<filter id="kg-shadow-/);
  });
});

describe('svgPointToContainerPx', () => {
  it('identity view + matching stage maps logical → px 1:1', () => {
    const px = svgPointToContainerPx(
      { x: 500, y: 280 },
      { x: 0, y: 0, k: 1 },
      { width: 1000, height: 560 },
    );
    expect(px).toEqual({ x: 500, y: 280 });
  });

  it('applies pan + zoom before the viewBox scale', () => {
    // k=2, pan (100,50); stage half-size (matched aspect) → uniform scale 0.5,
    // zero letterbox.
    const px = svgPointToContainerPx(
      { x: 100, y: 100 },
      { x: 100, y: 50, k: 2 },
      { width: 500, height: 280 },
    );
    // logical: 100*2 + 100 = 300 ; 100*2 + 50 = 250. px: *0.5 → 150 ; *0.5 → 125.
    expect(px).toEqual({ x: 150, y: 125 });
  });

  it('letterboxes under a non-1000:560 stage aspect (preserveAspectRatio meet)', () => {
    // Wider-than-viewBox stage: meet scales by min(1200/1000, 560/560)=1.0 and
    // centres horizontally → offsetX = (1200 - 1000)/2 = 100. A NON-centre point
    // must pick up that offset; the old independent-axis approximation (scaleX=1.2)
    // would drift it left.
    const px = svgPointToContainerPx(
      { x: 250, y: 280 },
      { x: 0, y: 0, k: 1 },
      { width: 1200, height: 560 },
    );
    // correct: offsetX + 250*1 = 100 + 250 = 350 (old buggy: 250*1.2 = 300).
    expect(px).toEqual({ x: 350, y: 280 });
  });

  it('letterboxes vertically when the stage is taller than the viewBox aspect', () => {
    // Taller stage: meet scales by min(1000/1000, 840/560)=1.0, centres vertically
    // → offsetY = (840 - 560)/2 = 140.
    const px = svgPointToContainerPx(
      { x: 500, y: 100 },
      { x: 0, y: 0, k: 1 },
      { width: 1000, height: 840 },
    );
    expect(px).toEqual({ x: 500, y: 240 }); // 140 + 100*1
  });
});

describe('fitViewToNeighborhood (focus camera fit)', () => {
  it('empty neighborhood → reset (identity) view', () => {
    expect(fitViewToNeighborhood([])).toEqual({ x: 0, y: 0, k: 1 });
  });

  it('centres the padded bbox at the viewBox centre and never zooms past 1:1', () => {
    // A tight 2-node cluster near the top-left. The padded bbox is much smaller
    // than the viewBox, so the raw fit scale would exceed 1 — it must clamp to 1
    // (owner「点太大了」), and translate so the cluster centre lands at (500,280).
    const v = fitViewToNeighborhood([
      { point: { x: 200, y: 150 }, r: 18 },
      { point: { x: 260, y: 190 }, r: 18 },
    ]);
    expect(v.k).toBe(1);
    // cluster centre = ((182..278)/2 etc.) → bbox x [182,278], y [132,208];
    // centre = (230, 170). translate = viewBoxCentre − k*centre.
    expect(v.x).toBeCloseTo(500 - 230, 5);
    expect(v.y).toBeCloseTo(280 - 170, 5);
  });

  it('zooms OUT (k < 1) for a neighborhood larger than the viewBox', () => {
    // A spread that, padded, overflows 1000×560 → fit scale < 1, clamped ≥ 0.5.
    const v = fitViewToNeighborhood([
      { point: { x: 0, y: 0 }, r: 20 },
      { point: { x: 2000, y: 1000 }, r: 20 },
    ]);
    expect(v.k).toBeLessThan(1);
    expect(v.k).toBeGreaterThanOrEqual(0.5);
    // centre of bbox = (1000, 500) must map to viewBox centre after scale.
    expect(v.x).toBeCloseTo(500 - v.k * 1000, 5);
    expect(v.y).toBeCloseTo(280 - v.k * 500, 5);
  });
});

describe('KnowledgeGraph — progressive disclosure + curved edges (YUK-297)', () => {
  it('default view discloses only 2 levels — a depth-2 grandchild is hidden', () => {
    const html = render({
      nodes: [
        node({ id: 'root' }),
        node({ id: 'child', parent_id: 'root' }),
        node({ id: 'grand', parent_id: 'child' }),
      ],
      edges: [],
    });
    expect(html).toMatch(/class="kg-node-label">root</);
    expect(html).toMatch(/class="kg-node-label">child</);
    // grandchild is collapsed away by default (only root + direct children show).
    expect(html).not.toMatch(/class="kg-node-label">grand</);
  });

  it('a node with hidden children shows a "+N" badge and aria-expanded=false', () => {
    const html = render({
      nodes: [
        node({ id: 'root' }),
        node({ id: 'child', parent_id: 'root' }),
        node({ id: 'g1', parent_id: 'child' }),
        node({ id: 'g2', parent_id: 'child' }),
      ],
      edges: [],
    });
    expect(html).toContain('kg-node-badge');
    // "child" has 2 hidden grandchildren → expandable "+2" badge.
    expect(html).toMatch(/kg-node-badge-t mono">\+2</);
    expect(html).not.toContain('is-capped');
    expect(html).toContain('aria-expanded="false"');
  });

  it('a deep node with >40 children is capped — grey badge, count only, not inline-expandable', () => {
    const grandkids = Array.from({ length: 41 }, (_, i) =>
      node({ id: `g${i}`, parent_id: 'child' }),
    );
    const html = render({
      nodes: [node({ id: 'root' }), node({ id: 'child', parent_id: 'root' }), ...grandkids],
      edges: [],
    });
    // child is depth 1 with 41 hidden children → capped: muted badge, no "+", and the
    // node is NOT marked aria-expandable (it opens the drawer instead of expanding).
    expect(html).toContain('kg-node-badge is-capped');
    expect(html).toMatch(/kg-node-badge-t mono">41</);
    expect(html).toContain('过多，在详情中查看');
  });

  it('a 2nd-level node with exactly 40 children still gets a normal "+N" expand badge', () => {
    const kids = Array.from({ length: 40 }, (_, i) => node({ id: `k${i}`, parent_id: 'child' }));
    const html = render({
      nodes: [node({ id: 'root' }), node({ id: 'child', parent_id: 'root' }), ...kids],
      edges: [],
    });
    expect(html).not.toContain('is-capped');
    expect(html).toMatch(/kg-node-badge-t mono">\+40</);
  });

  it('renders edges as quadratic-bezier curves (Q), not straight L lines', () => {
    const html = render({
      nodes: [node({ id: 'a' }), node({ id: 'b', parent_id: 'a' })],
      edges: [],
    });
    // the tree edge a→b is a bowed bezier: its path d carries a Q command.
    expect(html).toMatch(/<path d="M[^"]*Q[^"]*"/);
  });

  it('positions a node via a CSS transform so re-layout eases (not the SVG attribute)', () => {
    const html = render({ nodes: [node({ id: 'solo' })], edges: [] });
    expect(html).toMatch(/style="transform:translate\(/);
  });
});
