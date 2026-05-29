'use client';

import cytoscape, { type Core, type ElementDefinition, type StylesheetJson } from 'cytoscape';
import fcose, { type FcoseLayoutOptions } from 'cytoscape-fcose';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

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

// ── Mastery bands (Slice 1b 诊断 overlay) ────────────────────────────────────
// Thresholds mirror src/ui/primitives/MasteryBadge.tsx exactly: >=0.7 good,
// >=0.4 mid (learning), <0.4 weak. NULL mastery = never practiced (the
// knowledge_mastery PG view emits NULL when there is zero evidence; ADR-0012).
// Each band reuses an EXISTING semantic token (no new color tokens) — see
// app/globals.css :root. We deliberately reserve --again (deep alarm red) for
// the prerequisite-weakness ring so it does not collide with the weak-band fill
// (--hard amber).
export type MasteryBand = 'weak' | 'learning' | 'mastered' | 'untrained';

const MASTERY_BAND_TOKEN: Record<MasteryBand, string> = {
  weak: '--hard', // amber — derivable shaky area
  learning: '--info', // steel blue — neutral mid
  mastered: '--good', // green — solid
  untrained: '--ink-5', // faint neutral — never practiced (mastery == null)
};

export function masteryBand(mastery: number | null | undefined): MasteryBand {
  if (mastery == null) return 'untrained';
  if (mastery < 0.4) return 'weak';
  if (mastery < 0.7) return 'learning';
  return 'mastered';
}

export const MASTERY_BAND_LABEL: Record<MasteryBand, string> = {
  weak: '薄弱',
  learning: '学习中',
  mastered: '已掌握',
  untrained: '未练习',
};

// "薄弱" filter target — weak OR never-practiced collapses to the diagnostic
// "看我哪里弱" set (the principle: NULL never-practiced is also unproven).
export function isWeakish(mastery: number | null | undefined): boolean {
  const band = masteryBand(mastery);
  return band === 'weak' || band === 'untrained';
}

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
  // mastery-band fills
  '--hard',
  '--good',
  // prerequisite-weakness ring
  '--again',
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
  // Slice 1b — diagnostic overlay + domain filter. Both already loaded by
  // app/(app)/knowledge/page.tsx from GET /api/knowledge (knowledge_mastery
  // view + effective_domain). NULL mastery = never practiced.
  mastery?: number | null;
  domain?: string | null;
  effective_domain?: string | null;
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

// fcose layout options carry extension-specific keys not present in
// cytoscape's BaseLayoutOptions; typed via the fcose module declaration.
const FCOSE_LAYOUT: FcoseLayoutOptions = {
  name: 'fcose',
  quality: 'default',
  randomize: true,
  animate: false,
  fit: true,
  padding: 40,
  nodeSeparation: 80,
};

function buildElements(
  nodes: KnowledgeGraphNode[],
  edges: KnowledgeGraphEdge[],
  mistakeCounts: Map<string, number>,
): ElementDefinition[] {
  const nodeIds = new Set(nodes.map((n) => n.id));
  const elements: ElementDefinition[] = [];

  for (const node of nodes) {
    const r = nodeRadius(mistakeCounts.get(node.id) ?? 0);
    const band = masteryBand(node.mastery);
    elements.push({
      group: 'nodes',
      // `band` drives the diagnostic fill via a stylesheet data-selector.
      // `mistakes` lets the "看我哪里弱" filter rank high-mistake nodes too.
      data: {
        id: node.id,
        label: node.name,
        diameter: r * 2,
        band,
        mistakes: mistakeCounts.get(node.id) ?? 0,
      },
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
      // Base node — fill now comes from the mastery band (see band selectors
      // below), so the default fill is the neutral untrained color.
      selector: 'node',
      style: {
        'background-color': t['--ink-5'],
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
    // ── Mastery-band diagnostic fills ──────────────────────────────────────
    {
      selector: 'node[band = "weak"]',
      style: { 'background-color': t['--hard'] },
    },
    {
      selector: 'node[band = "learning"]',
      style: { 'background-color': t['--info'] },
    },
    {
      selector: 'node[band = "mastered"]',
      style: { 'background-color': t['--good'] },
    },
    {
      selector: 'node[band = "untrained"]',
      style: { 'background-color': t['--ink-5'] },
    },
    {
      selector: 'node:selected',
      style: {
        'border-color': t['--coral'],
        'border-width': 3,
        'z-index': 30,
      },
    },
    // ── Focus mode ─────────────────────────────────────────────────────────
    // `.kg-faded` fades everything outside the focused node's neighborhood;
    // `.kg-focus-root` highlights the focused node itself.
    {
      selector: '.kg-faded',
      style: { opacity: 0.12 },
    },
    {
      selector: 'node.kg-focus-root',
      style: {
        'border-color': t['--coral'],
        'border-width': 3,
        'z-index': 40,
      },
    },
    // ── Prerequisite-weakness ring ─────────────────────────────────────────
    // A shaky prerequisite (a prerequisite-edge SOURCE whose mastery is
    // null/<0.4) of the focused node gets a deep --again alarm ring. Reserved
    // token so it never collides with the weak-band amber fill.
    {
      selector: 'node.kg-shaky-prereq',
      style: {
        'border-color': t['--again'],
        'border-width': 4,
        'border-style': 'double',
        'z-index': 35,
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

// ── Filter model (client-only; derived from already-loaded node data) ────────
type MasteryFilter = 'all' | 'weak' | 'learning' | 'mastered';

interface FilterState {
  // null domain = "全部" (all domains); otherwise an effective_domain value.
  domain: string | null;
  mastery: MasteryFilter;
}

function distinctDomains(nodes: KnowledgeGraphNode[]): string[] {
  const seen = new Set<string>();
  for (const n of nodes) {
    const d = n.effective_domain ?? n.domain;
    if (d) seen.add(d);
  }
  return [...seen].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
}

function passesFilter(node: KnowledgeGraphNode, filter: FilterState): boolean {
  if (filter.domain !== null) {
    const d = node.effective_domain ?? node.domain ?? null;
    if (d !== filter.domain) return false;
  }
  if (filter.mastery === 'all') return true;
  const band = masteryBand(node.mastery);
  if (filter.mastery === 'weak') return band === 'weak' || band === 'untrained';
  if (filter.mastery === 'learning') return band === 'learning';
  return band === 'mastered'; // 'mastered'
}

/**
 * Cytoscape-backed knowledge graph as a "诊断 + 局部聚焦" instrument
 * (Wave 7 T-KG Slice 1b; locked direction D1 in
 * docs/superpowers/plans/2026-05-29-wave7-ready-to-launch.md — default is NOT
 * the full hairball: filter by domain / mastery band + focus subgraph, with the
 * weak area visually highlighted).
 *
 * Slice 1a behaviors preserved: relation visual contract, mesh-over-tree,
 * node size ∝ mistakes, tap → drawer, dark-mode token re-read, native
 * pan/zoom/drag. cytoscape touches window/document, so it is initialised
 * strictly inside useEffect (client-only) and torn down on unmount; the page
 * additionally loads this primitive via next/dynamic ssr:false.
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

  const domains = useMemo(() => distinctDomains(nodes), [nodes]);

  // Default view (NOT the full hairball, per D1): if there is more than one
  // domain, default to the first domain alphabetically; with a single (or zero)
  // domain there is no hairball to avoid, so show all. Mastery filter defaults
  // to "all" but weak nodes are always visually emphasized by their band fill.
  const [filter, setFilter] = useState<FilterState>(() => ({
    domain: domains.length > 1 ? domains[0] : null,
    mastery: 'all',
  }));

  // If the domain set changes (new data load) and the current domain filter is
  // no longer valid, re-default it rather than showing an empty canvas.
  useEffect(() => {
    setFilter((f) => {
      if (f.domain !== null && !domains.includes(f.domain)) {
        return { ...f, domain: domains.length > 1 ? domains[0] : null };
      }
      return f;
    });
  }, [domains]);

  // focusId is the spatial complement to selectedId (the drawer). Tapping a
  // node does both. A node can be focused without the drawer (e.g. restored)
  // but in practice they move together via onNodeClick.
  const [focusId, setFocusId] = useState<string | null>(null);
  // Latest focusId without re-running the build effect just to re-read it
  // (the build effect reapplies the focus overlay onto fresh elements).
  const focusIdRef = useRef(focusId);
  focusIdRef.current = focusId;

  const visibleNodes = useMemo(() => nodes.filter((n) => passesFilter(n, filter)), [nodes, filter]);
  const visibleNodeIds = useMemo(() => new Set(visibleNodes.map((n) => n.id)), [visibleNodes]);
  const visibleEdges = useMemo(
    () =>
      edges.filter(
        (e) => visibleNodeIds.has(e.from_knowledge_id) && visibleNodeIds.has(e.to_knowledge_id),
      ),
    [edges, visibleNodeIds],
  );

  // mastery lookup for prerequisite-weakness derivation.
  const masteryById = useMemo(() => {
    const m = new Map<string, number | null | undefined>();
    for (const n of nodes) m.set(n.id, n.mastery);
    return m;
  }, [nodes]);

  const counts = useMemo(() => {
    const acc = { weak: 0, learning: 0, mastered: 0, untrained: 0 };
    for (const n of visibleNodes) acc[masteryBand(n.mastery)]++;
    return acc;
  }, [visibleNodes]);

  // ── Focus mode + prerequisite-weakness overlay ──────────────────────────
  // When a node is focused: reveal its closed 1-hop neighborhood, fade
  // everything else, fit the viewport to it, and ring its shaky prerequisites.
  // All derived from the cytoscape graph + the node mastery map — zero new
  // backend. Shared so it can be (re)applied both on focus change AND right
  // after a graph rebuild (a rebuild drops the focus classes). `id` is passed
  // explicitly so the latest masteryById is closed over without staleness.
  const applyFocus = useCallback(
    (id: string | null) => {
      const cy = cyRef.current;
      if (!cy) return;
      cy.batch(() => {
        cy.elements().removeClass('kg-faded kg-focus-root kg-shaky-prereq');
        if (!id) return;
        const root = cy.getElementById(id);
        if (root.empty()) return;

        const hood = root.closedNeighborhood();
        cy.elements().difference(hood).addClass('kg-faded');
        root.addClass('kg-focus-root');

        // Shaky prerequisites: prerequisite mesh edges pointing INTO the focused
        // node (to == focus); their SOURCE is the prerequisite. Flag those whose
        // mastery is null or < 0.4. cytoscape edge direction = source→target, and
        // we built prerequisite edges as from→to, so incomers carries them.
        const prereqEdges = root.incomers('edge[kind = "mesh"][relation = "prerequisite"]');
        for (const src of prereqEdges.sources().toArray()) {
          if (isWeakish(masteryById.get(src.id()))) src.addClass('kg-shaky-prereq');
        }
      });
      if (id) {
        const root = cy.getElementById(id);
        if (root.nonempty()) {
          cy.animate({ fit: { eles: root.closedNeighborhood(), padding: 60 } }, { duration: 280 });
        }
      }
    },
    [masteryById],
  );

  // Init / rebuild cytoscape when the *visible* graph data changes. Tokens are
  // read here (client-only) and fed as concrete colors.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    ensureFcose();
    const tokens = readTokens();
    const cy = cytoscape({
      container,
      elements: buildElements(visibleNodes, visibleEdges, mistakeCounts),
      style: buildStylesheet(tokens),
      layout: FCOSE_LAYOUT,
      minZoom: 0.1,
      maxZoom: 4,
      wheelSensitivity: 0.2,
    });
    cyRef.current = cy;

    cy.on('tap', 'node', (event) => {
      const id = event.target.id();
      if (id) {
        // Tap = open drawer (preserved Slice 1a behavior) AND enter focus mode.
        onNodeClickRef.current(id);
        setFocusId(id);
      }
    });
    // Tapping empty canvas exits focus (but leaves the drawer to the page).
    cy.on('tap', (event) => {
      if (event.target === cy) setFocusId(null);
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

    // Reapply the focus overlay onto the freshly-built elements (rebuild drops
    // the prior focus classes). Selection is reflected by its own effect below.
    applyFocus(focusIdRef.current);

    return () => {
      attrObserver.disconnect();
      media.removeEventListener('change', restyle);
      cy.destroy();
      cyRef.current = null;
    };
  }, [visibleNodes, visibleEdges, mistakeCounts, applyFocus]);

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

  // Live focus changes (without a rebuild).
  useEffect(() => {
    applyFocus(focusId);
  }, [focusId, applyFocus]);

  // If the focused node is filtered out, exit focus rather than leave a stale
  // ring on a node that is no longer rendered.
  useEffect(() => {
    if (focusId && !visibleNodeIds.has(focusId)) {
      setFocusId(null);
    }
  }, [visibleNodeIds, focusId]);

  const showWeak = useCallback(() => {
    setFilter((f) => ({ ...f, mastery: 'weak' }));
    setFocusId(null);
  }, []);

  const exitFocus = useCallback(() => setFocusId(null), []);

  const focusName = focusId ? (nodes.find((n) => n.id === focusId)?.name ?? focusId) : null;

  return (
    <section className="kg-stage" aria-label="知识关系图">
      <div className="kg-controls" aria-label="图谱筛选">
        <fieldset className="kg-control-group" aria-label="按学科筛选">
          <span className="kg-control-label">学科</span>
          <button
            type="button"
            className={`kg-chip${filter.domain === null ? ' is-on' : ''}`}
            onClick={() => setFilter((f) => ({ ...f, domain: null }))}
          >
            全部
          </button>
          {domains.map((d) => (
            <button
              key={d}
              type="button"
              className={`kg-chip${filter.domain === d ? ' is-on' : ''}`}
              onClick={() => setFilter((f) => ({ ...f, domain: d }))}
            >
              {d}
            </button>
          ))}
        </fieldset>
        <fieldset className="kg-control-group" aria-label="按掌握度筛选">
          <span className="kg-control-label">掌握度</span>
          {(['all', 'weak', 'learning', 'mastered'] as const).map((m) => (
            <button
              key={m}
              type="button"
              className={`kg-chip kg-chip-${m}${filter.mastery === m ? ' is-on' : ''}`}
              onClick={() => setFilter((f) => ({ ...f, mastery: m }))}
            >
              {m === 'all'
                ? '全部'
                : m === 'weak'
                  ? `${MASTERY_BAND_LABEL.weak} / ${MASTERY_BAND_LABEL.untrained}`
                  : m === 'learning'
                    ? MASTERY_BAND_LABEL.learning
                    : MASTERY_BAND_LABEL.mastered}
            </button>
          ))}
        </fieldset>
        <button type="button" className="kg-chip kg-chip-diagnose" onClick={showWeak}>
          看我哪里弱
        </button>
      </div>

      {focusId && (
        <div className="kg-focus-bar" aria-live="polite">
          <span className="kg-focus-crumb">聚焦 · {focusName}</span>
          <button type="button" className="kg-chip" onClick={exitFocus}>
            ← 返回全图
          </button>
        </div>
      )}

      <div ref={containerRef} className="kg-canvas" role="img" aria-label="知识关系图" />

      <div className="kg-legend">
        <span className="kg-legend-section">掌握度</span>
        {(['weak', 'learning', 'mastered', 'untrained'] as const).map((band) => (
          <span className="item" key={band}>
            <span
              className="swatch dot"
              style={{ background: `var(${MASTERY_BAND_TOKEN[band]})` }}
            />
            <span>
              {MASTERY_BAND_LABEL[band]}
              {band === 'weak'
                ? ` ${counts.weak}`
                : band === 'learning'
                  ? ` ${counts.learning}`
                  : band === 'mastered'
                    ? ` ${counts.mastered}`
                    : ` ${counts.untrained}`}
            </span>
          </span>
        ))}
        <span className="kg-legend-section">关系</span>
        <span className="item">
          <span className="swatch dashed" />
          <span>tree</span>
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
        <span className="kg-legend-note">
          圆 = 节点 · 填色 ∝ 掌握度 · 半径 ∝ mistake_count · 点节点聚焦 · 拖拽 / 滚轮缩放
        </span>
      </div>
    </section>
  );
}

export default KnowledgeGraph;
