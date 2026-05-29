'use client';

import cytoscape, { type Core, type ElementDefinition, type StylesheetJson } from 'cytoscape';
import fcose, { type FcoseLayoutOptions } from 'cytoscape-fcose';
import { useEffect, useRef } from 'react';

// Register the fcose force-directed layout exactly once per module load. This
// runs at import time, but the module is only imported on the client (the page
// pulls KnowledgeGraph in via next/dynamic ssr:false), so it never executes
// during SSR/prerender. cytoscape.use() is idempotent-safe for our usage.
let fcoseRegistered = false;
function ensureFcose() {
  if (!fcoseRegistered) {
    cytoscape.use(fcose);
    fcoseRegistered = true;
  }
}

// Relation-type visual contract — see docs/design/loom-design-v2.1/README.md
// "Mesh 视觉决策" table and docs/design/2026-05-15-design-brief-v2.1.md §2.3.b.
// `tone` keys map to design-token CSS variable *names* (resolved to concrete
// hexes at mount via getComputedStyle, because cytoscape needs literal colors,
// not var()). `arrow` toggles a target-arrow; `dashed` toggles line-style.
type RelationVisual = { token: string; arrow: boolean; dashed: boolean };

const RELATION_VISUAL: Record<string, RelationVisual> = {
  prerequisite: { token: '--coral', arrow: true, dashed: false },
  applied_in: { token: '--info', arrow: true, dashed: false },
  derived_from: { token: '--ink-5', arrow: true, dashed: false },
  contrasts_with: { token: '--contrasts', arrow: false, dashed: false },
  related_to: { token: '--ink-4', arrow: false, dashed: true },
};

// Tokens the cytoscape stylesheet needs as concrete values. Read once per
// (re)mount + on theme change, so dark mode resolves correctly.
const TOKEN_NAMES = [
  '--coral',
  '--coral-soft',
  '--info',
  '--ink-2',
  '--ink-4',
  '--ink-5',
  '--contrasts',
  '--line-strong',
  '--paper-raised',
  '--font-sans',
] as const;

type TokenMap = Record<(typeof TOKEN_NAMES)[number], string>;

function readTokens(): TokenMap {
  const cs = getComputedStyle(document.documentElement);
  const out = {} as TokenMap;
  for (const name of TOKEN_NAMES) {
    out[name] = cs.getPropertyValue(name).trim();
  }
  return out;
}

// PRESERVE the prior node radius rule: 12 + min(20, mistakeCount*4).
function nodeRadius(mistakeCount: number): number {
  return 12 + Math.min(20, mistakeCount * 4);
}

export interface KnowledgeGraphNode {
  id: string;
  name: string;
  parent_id: string | null;
}

export interface KnowledgeGraphEdge {
  id: string;
  from_knowledge_id: string;
  to_knowledge_id: string;
  relation_type: string;
  weight: number;
}

export interface KnowledgeGraphProps {
  nodes: KnowledgeGraphNode[];
  edges: KnowledgeGraphEdge[];
  selectedId: string | null;
  onNodeClick: (id: string) => void;
  /** mistake_count per node id — drives node radius (∝ mistakes). */
  mistakeCounts: Map<string, number>;
}

function buildElements(
  nodes: KnowledgeGraphNode[],
  edges: KnowledgeGraphEdge[],
  mistakeCounts: Map<string, number>,
): ElementDefinition[] {
  const nodeIds = new Set(nodes.map((n) => n.id));
  const elements: ElementDefinition[] = [];

  for (const node of nodes) {
    const r = nodeRadius(mistakeCounts.get(node.id) ?? 0);
    elements.push({
      group: 'nodes',
      data: { id: node.id, label: node.name, diameter: r * 2 },
    });
  }

  // Tree edges (parent_id) — the receded skeleton底色. Rendered with low
  // z-index so mesh edges paint on top ("mesh 是主角，tree 是底色").
  for (const node of nodes) {
    if (node.parent_id && nodeIds.has(node.parent_id)) {
      elements.push({
        group: 'edges',
        data: {
          id: `tree-${node.id}`,
          source: node.parent_id,
          target: node.id,
          kind: 'tree',
        },
      });
    }
  }

  // Mesh edges, keyed by relation_type. Unknown / experimental relation types
  // fall back to the neutral related_to visual (matches the prior edgeColor
  // default of --ink-4) but stay above tree edges.
  for (const edge of edges) {
    if (!nodeIds.has(edge.from_knowledge_id) || !nodeIds.has(edge.to_knowledge_id)) continue;
    const visualKey = RELATION_VISUAL[edge.relation_type] ? edge.relation_type : 'related_to';
    elements.push({
      group: 'edges',
      data: {
        id: edge.id,
        source: edge.from_knowledge_id,
        target: edge.to_knowledge_id,
        kind: 'mesh',
        relation: visualKey,
        // PRESERVE prior stroke width: 1 + weight * 1.5.
        width: 1 + edge.weight * 1.5,
      },
    });
  }

  return elements;
}

function buildStylesheet(t: TokenMap): StylesheetJson {
  const sheet: StylesheetJson = [
    {
      selector: 'node',
      style: {
        'background-color': t['--paper-raised'],
        'border-color': t['--line-strong'],
        'border-width': 1,
        width: 'data(diameter)',
        height: 'data(diameter)',
        label: 'data(label)',
        color: t['--ink-2'],
        'font-family': t['--font-sans'] || 'sans-serif',
        'font-size': 12,
        'text-valign': 'bottom',
        'text-halign': 'center',
        'text-margin-y': 4,
        'z-index': 10,
      },
    },
    {
      selector: 'node:selected',
      style: {
        'background-color': t['--coral-soft'],
        'border-color': t['--coral'],
        'border-width': 2,
        'z-index': 20,
      },
    },
    // Tree edges: --ink-5, dashed [3 5], NO arrow, visually receded (low
    // opacity), lowest z-index so mesh always paints over them. z-index-compare
    // 'manual' makes cytoscape honor edge-vs-edge z-index ordering (the default
    // 'auto' would ignore it) — this is the "mesh 是主角，tree 是底色" invariant.
    {
      selector: 'edge[kind = "tree"]',
      style: {
        width: 1,
        'line-color': t['--ink-5'],
        'line-style': 'dashed',
        'line-dash-pattern': [3, 5],
        'curve-style': 'bezier',
        opacity: 0.45,
        'z-index-compare': 'manual',
        'z-index': 1,
      },
    },
    // Mesh edges: shared base — above tree edges, native bezier curve, the
    // weight-driven width carried in data.
    {
      selector: 'edge[kind = "mesh"]',
      style: {
        width: 'data(width)',
        'curve-style': 'bezier',
        opacity: 0.72,
        'z-index-compare': 'manual',
        'z-index': 5,
      },
    },
  ];

  // Per-relation color / line-style / arrow, resolved from tokens.
  for (const [relation, visual] of Object.entries(RELATION_VISUAL)) {
    const color = t[visual.token as (typeof TOKEN_NAMES)[number]];
    sheet.push({
      selector: `edge[kind = "mesh"][relation = "${relation}"]`,
      style: {
        'line-color': color,
        'line-style': visual.dashed ? 'dashed' : 'solid',
        ...(visual.arrow
          ? { 'target-arrow-shape': 'triangle', 'target-arrow-color': color }
          : { 'target-arrow-shape': 'none' }),
      },
    });
  }

  return sheet;
}

/**
 * Cytoscape-backed knowledge graph. Behavior-preserving engine swap from the
 * prior hand-rolled SVG verlet graph — same data in, same node-click → drawer,
 * same relation visual language, node size ∝ mistakes — but scales to 200-1000
 * nodes with native pan / zoom / drag. cytoscape touches window/document, so it
 * is initialised strictly inside useEffect (client-only) and torn down on
 * unmount; the page additionally loads this primitive via next/dynamic ssr:false.
 */
export function KnowledgeGraph({
  nodes,
  edges,
  selectedId,
  onNodeClick,
  mistakeCounts,
}: KnowledgeGraphProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const cyRef = useRef<Core | null>(null);
  // Latest onNodeClick without forcing the graph to re-init when the parent
  // re-renders with a new function identity.
  const onNodeClickRef = useRef(onNodeClick);
  onNodeClickRef.current = onNodeClick;

  // Init / rebuild cytoscape when the graph data changes. Tokens are read here
  // (client-only) and fed as concrete colors.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    ensureFcose();
    const tokens = readTokens();
    // fcose layout options carry extension-specific keys not present in
    // cytoscape's BaseLayoutOptions; typed via the fcose module declaration.
    const layout: FcoseLayoutOptions = {
      name: 'fcose',
      quality: 'default',
      randomize: true,
      animate: false,
      fit: true,
      padding: 40,
      nodeSeparation: 80,
    };
    const cy = cytoscape({
      container,
      elements: buildElements(nodes, edges, mistakeCounts),
      style: buildStylesheet(tokens),
      layout,
      minZoom: 0.1,
      maxZoom: 4,
      wheelSensitivity: 0.2,
    });
    cyRef.current = cy;

    cy.on('tap', 'node', (event) => {
      const id = event.target.id();
      if (id) onNodeClickRef.current(id);
    });

    // Re-read tokens + restyle on theme change so dark mode resolves. Watches
    // the <html data-theme> attribute (explicit toggle) and the OS dark-mode
    // media query (system follow).
    const restyle = () => {
      if (!cyRef.current) return;
      cyRef.current.style(buildStylesheet(readTokens()));
    };
    const attrObserver = new MutationObserver(restyle);
    attrObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', restyle);

    return () => {
      attrObserver.disconnect();
      media.removeEventListener('change', restyle);
      cy.destroy();
      cyRef.current = null;
    };
  }, [nodes, edges, mistakeCounts]);

  // Reflect selection without rebuilding the graph.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.batch(() => {
      cy.nodes().unselect();
      if (selectedId) {
        const node = cy.getElementById(selectedId);
        if (node.nonempty()) node.select();
      }
    });
  }, [selectedId]);

  return (
    <section className="kg-stage" aria-label="知识关系图">
      <div ref={containerRef} className="kg-canvas" role="img" aria-label="知识关系图" />
      <div className="kg-legend">
        <span className="item">
          <span className="swatch dashed" />
          <span>tree (parent_id)</span>
        </span>
        {Object.entries(RELATION_VISUAL).map(([relation, visual]) => (
          <span className="item" key={relation}>
            <span
              className={`swatch${visual.dashed ? ' dashed' : ''}`}
              style={{ borderTopColor: `var(${visual.token})` }}
            />
            <span>{relation}</span>
          </span>
        ))}
        <span className="kg-legend-note">圆 = 节点 · 半径 ∝ mistake_count · 拖拽 / 滚轮缩放</span>
      </div>
    </section>
  );
}

export default KnowledgeGraph;
