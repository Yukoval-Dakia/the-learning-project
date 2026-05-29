'use client';

import { Icon } from '@/ui/primitives/Icon';
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

export const RELATION_VISUAL: Record<string, RelationVisual> = {
  prerequisite: { token: '--coral', arrow: true, dashed: false },
  applied_in: { token: '--info', arrow: true, dashed: false },
  derived_from: { token: '--ink-5', arrow: true, dashed: false },
  contrasts_with: { token: '--contrasts', arrow: false, dashed: false },
  related_to: { token: '--ink-4', arrow: false, dashed: true },
};

// Chinese relation labels (mirror app/(app)/knowledge/page.tsx RELATION_TYPES)
// for the Slice 3 inline proposal action so the on-graph popover reads the
// proposed relation in the same words as the drawer's EdgeProposalCard. Unknown /
// experimental types fall through to the raw relation_type at the call site.
export const RELATION_LABEL: Record<string, string> = {
  prerequisite: '前置',
  related_to: '相关',
  contrasts_with: '对照',
  applied_in: '应用于',
  derived_from: '派生自',
};

// ── Mastery bands (Slice 1b 诊断 overlay) ────────────────────────────────────
// Bands mirror src/ui/primitives/MasteryBadge.tsx EXACTLY, evidence_count first:
//   • evidence_count === 0       → 'untrained'   (MasteryBadge "未练习")
//   • evidence_count < 3         → 'insufficient' (MasteryBadge "证据不足 · n<3")
//   • then by mastery: >=0.7 'mastered', >=0.4 'learning', <0.4 'weak'.
// The knowledge_mastery PG view emits mastery = 0.5 as a SENTINEL for the
// low-evidence (1-2 pieces) case, so band logic that ignored evidence_count
// painted those nodes as confident "学习中" — Fix B (YUK-142 review) threads
// evidence_count in so the graph fill matches the badge. NULL mastery is the
// never-practiced / zero-evidence case (ADR-0012) and collapses to 'untrained'.
//
// Each band reuses an EXISTING semantic token (no new color tokens) — see
// app/globals.css :root. We deliberately reserve --again (deep alarm red) for
// the prerequisite-weakness ring so it does not collide with the weak-band fill
// (--hard amber). 'insufficient' shares the faint --ink-5 neutral with
// 'untrained' (both are "unproven", visually receded) but is a distinct band so
// it can carry its own label + filter behavior.
export type MasteryBand = 'weak' | 'learning' | 'mastered' | 'untrained' | 'insufficient';

const MASTERY_BAND_TOKEN: Record<MasteryBand, string> = {
  weak: '--hard', // amber — derivable shaky area
  learning: '--info', // steel blue — neutral mid
  mastered: '--good', // green — solid
  untrained: '--ink-5', // faint neutral — never practiced (evidence_count == 0)
  insufficient: '--ink-5', // faint neutral — unproven (1-2 evidence pieces)
};

// Band from the full mastery record (mirrors MasteryBadge). evidence_count is
// the gate: 0 → untrained, <3 → insufficient (regardless of the 0.5 sentinel),
// then the mastery thresholds. evidence_count defaults to a large number when
// undefined so callers that only know `mastery` keep the legacy threshold-only
// behavior.
export function masteryBand(
  mastery: number | null | undefined,
  evidenceCount?: number | null,
): MasteryBand {
  const evidence = evidenceCount ?? Number.POSITIVE_INFINITY;
  if (evidence === 0) return 'untrained';
  if (evidence < 3) return 'insufficient';
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
  insufficient: '证据不足',
};

// "薄弱" filter target — weak, never-practiced, OR low-evidence collapses to the
// diagnostic "看我哪里弱" set (the principle: anything unproven is also a gap to
// surface). insufficient/untrained are both "not yet confident".
export function isWeakish(
  mastery: number | null | undefined,
  evidenceCount?: number | null,
): boolean {
  const band = masteryBand(mastery, evidenceCount);
  return band === 'weak' || band === 'untrained' || band === 'insufficient';
}

// Tokens the cytoscape stylesheet needs as concrete values. Read once per
// (re)mount + on theme change, so dark mode resolves correctly.
export const TOKEN_NAMES = [
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

// ── Due indicator encoding choice (Slice 2; YUK-142) ─────────────────────────
// Three signals can land on one node: (1) mastery band = node FILL color, (2)
// shaky-prerequisite = a deep `--again` DOUBLE BORDER ring, (3) overdue review =
// THIS coral UNDERLAY halo. We deliberately pick cytoscape's `underlay` (an
// ellipse drawn BEHIND the node, bleeding past its edge via underlay-padding)
// rather than another border or a fill tint, because:
//   • border slot is already taken by select / focus-root / shaky-prereq rings;
//   • background-color is already the mastery-band fill;
//   • an underlay coral glow sits in its own visual layer, so a weak-band amber
//     node with a shaky-prereq `--again` ring can ALSO show the coral due halo
//     without any of the three encodings overwriting another.
// Coral = the project's "needs action now" accent (matches the "看我哪里弱"
// diagnose chip + node:selected ring hue), so "今天该复习" reads as urgent but
// is distinguishable from the alarm-red `--again` prereq ring by layer (halo vs
// border), style (soft glow vs hard double stroke), and saturation.

export type TokenMap = Record<(typeof TOKEN_NAMES)[number], string>;

function readTokens(): TokenMap {
  const cs = getComputedStyle(document.documentElement);
  const out = {} as TokenMap;
  for (const name of TOKEN_NAMES) {
    out[name] = cs.getPropertyValue(name).trim();
  }
  return out;
}

// PRESERVE the prior node radius rule: 12 + min(20, mistakeCount*4).
export function nodeRadius(mistakeCount: number): number {
  return 12 + Math.min(20, mistakeCount * 4);
}

export interface KnowledgeGraphNode {
  id: string;
  name: string;
  parent_id: string | null;
  // Slice 1b — diagnostic overlay + domain filter. All loaded by
  // app/(app)/knowledge/page.tsx from GET /api/knowledge (knowledge_mastery
  // view + effective_domain). NULL mastery = never practiced.
  mastery?: number | null;
  // Fix B (YUK-142): evidence_count gates the band so the graph fill mirrors
  // MasteryBadge — 0 → untrained, 1-2 → insufficient (the mastery=0.5 sentinel
  // case), else by mastery threshold. Optional so non-page callers can omit it.
  evidence_count?: number | null;
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

/** Per-node FSRS due counts from GET /api/knowledge/review-due-summary. */
export interface NodeDueSummary {
  overdue: number;
  due_soon: number;
}

/**
 * A pending AI edge proposal, normalized for the graph (Slice 3 — "AI 画布").
 * page.tsx loads these from GET /api/events?action=propose&subject_kind=
 * knowledge_edge and decides them via POST /api/knowledge/edges/proposals/[id].
 * `id` is the propose-event id (the decision endpoint's path param). `key` is the
 * page's stable dedupe key (subject:from:to:relation:actor) used so optimistic
 * "already decided" hiding survives identical re-proposals. We carry both: `id`
 * for the endpoint, `key` for element ids + the decided-set lookup.
 */
export interface KnowledgeEdgeProposal {
  id: string;
  key: string;
  from_knowledge_id: string;
  to_knowledge_id: string;
  relation_type: string;
}

export interface KnowledgeGraphProps {
  nodes: KnowledgeGraphNode[];
  edges: KnowledgeGraphEdge[];
  selectedId: string | null;
  onNodeClick: (id: string) => void;
  /** mistake_count per node id — drives node radius (∝ mistakes). */
  mistakeCounts: Map<string, number>;
  /**
   * Per-node review-due counts (overdue / due_soon). Nodes with overdue > 0 get
   * the coral due halo + are the target of the "今天该复习" quick filter. Empty
   * map when the summary endpoint is unavailable (graceful: no halos shown).
   */
  dueCounts?: Map<string, NodeDueSummary>;
  /**
   * Pending AI edge proposals (Slice 3 — "AI 画布"). Rendered as distinct dotted
   * `kind: 'proposed'` edges between their endpoints when BOTH endpoints are
   * visible under the current filter/focus. Tapping one surfaces an inline
   * accept / dismiss that calls onProposalDecision (the SAME decision endpoint
   * the drawer's EdgeProposalCard uses). Must be a stable/memoized ref from the
   * page (see activeEdges memo) so it doesn't churn the cytoscape rebuild effect.
   */
  proposals?: KnowledgeEdgeProposal[];
  /**
   * Decide a proposal from the graph's inline action. `decision` reuses the
   * drawer's verb set; only 'accept' / 'dismiss' are surfaced inline (改方向 /
   * 改关系 stay in the drawer per Slice 3 scope). Same handler the page already
   * wires for the drawer, so the round-trip + query invalidation is shared.
   */
  onProposalDecision?: (proposalId: string, decision: 'accept' | 'dismiss') => void;
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

export function buildElements(
  nodes: KnowledgeGraphNode[],
  edges: KnowledgeGraphEdge[],
  mistakeCounts: Map<string, number>,
  dueCounts: Map<string, NodeDueSummary>,
): ElementDefinition[] {
  const nodeIds = new Set(nodes.map((n) => n.id));
  const elements: ElementDefinition[] = [];

  for (const node of nodes) {
    const r = nodeRadius(mistakeCounts.get(node.id) ?? 0);
    const band = masteryBand(node.mastery, node.evidence_count);
    const due = dueCounts.get(node.id);
    const overdue = due?.overdue ?? 0;
    elements.push({
      group: 'nodes',
      // `band` drives the diagnostic fill via a stylesheet data-selector.
      // `mistakes` lets the "看我哪里弱" filter rank high-mistake nodes too.
      // `overdue` drives the coral due-halo (overdue > 0) via the `.kg-due`
      // class (added below) — kept as data too so the "今天该复习" filter reads
      // it without re-deriving from the map.
      data: {
        id: node.id,
        label: node.name,
        diameter: r * 2,
        band,
        mistakes: mistakeCounts.get(node.id) ?? 0,
        overdue,
        due_soon: due?.due_soon ?? 0,
      },
      ...(overdue > 0 ? { classes: 'kg-due' } : {}),
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

// Slice 3 ("AI 画布") — map pending edge proposals to distinct `kind: 'proposed'`
// cytoscape edges. A proposal only renders when BOTH endpoints are visible under
// the current filter/focus (visibleNodeIds), mirroring the mesh-edge dangling
// guard; otherwise it would float to a node that isn't on screen. Element ids are
// prefixed `proposed-<key>` so they never collide with real edge ids (which are
// the raw knowledge_edge id) or tree ids (`tree-<node>`). `relation` carries the
// proposed relation_type so the stylesheet can tint the dotted line with that
// relation's color; unknown/experimental types fall back to related_to like mesh.
// `proposalId` rides on the element so the tap handler can call the decision
// endpoint without re-deriving it. z-index sits at/just above the mesh layer so
// the proposal reads as "a connection being suggested over the mesh" but its
// dotted + reduced-opacity + AI-marked styling keeps it from being mistaken for a
// committed mesh edge.
export function buildProposedEdgeElements(
  proposals: KnowledgeEdgeProposal[],
  visibleNodeIds: Set<string>,
): ElementDefinition[] {
  const elements: ElementDefinition[] = [];
  for (const p of proposals) {
    if (!visibleNodeIds.has(p.from_knowledge_id) || !visibleNodeIds.has(p.to_knowledge_id)) {
      continue;
    }
    const visualKey = RELATION_VISUAL[p.relation_type] ? p.relation_type : 'related_to';
    elements.push({
      group: 'edges',
      data: {
        id: `proposed-${p.key}`,
        source: p.from_knowledge_id,
        target: p.to_knowledge_id,
        kind: 'proposed',
        relation: visualKey,
        proposalId: p.id,
      },
      classes: 'kg-proposed',
    });
  }
  return elements;
}

export function buildStylesheet(t: TokenMap): StylesheetJson {
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
      // Low-evidence (1-2 pieces): faint --ink-5 like untrained, but at reduced
      // background-opacity so it reads as "unproven, some evidence" — distinct
      // from the solid untrained fill AND from every confident band. Mirrors
      // MasteryBadge's separate "证据不足" state instead of painting these as a
      // confident "学习中".
      selector: 'node[band = "insufficient"]',
      style: { 'background-color': t['--ink-5'], 'background-opacity': 0.4 },
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
    // ── Review-due halo (Slice 2) ──────────────────────────────────────────
    // Nodes with overdue review items (overdue > 0) get a coral UNDERLAY halo
    // that bleeds past the node edge. underlay-opacity is set directly (not via
    // :active) so the halo is always-on. Distinct LAYER from the mastery fill
    // (background-color) and the shaky-prereq border ring, so all three signals
    // can co-exist on one node without overwriting each other.
    {
      selector: 'node.kg-due',
      style: {
        'underlay-color': t['--coral'],
        'underlay-opacity': 0.28,
        'underlay-padding': 7,
        'underlay-shape': 'ellipse',
      },
    },
    // When a due node is also filtered/faded, fade its halo with it.
    {
      selector: 'node.kg-due.kg-faded',
      style: { 'underlay-opacity': 0.05 },
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
    // ── Proposed (AI-suggested) edges (Slice 3 — "AI 画布") ──────────────────
    // An AI edge proposal surfaced ON the graph. It must read as "AI suggests
    // this connection", NOT as a committed mesh edge, so it differs from mesh on
    // THREE axes: (1) always DOTTED (line-style dotted, distinct from tree's
    // dashed and from solid mesh), (2) reduced opacity (0.5 — fainter than
    // mesh's 0.72, "tentative"), (3) an --info AI-tone target-arrow source/target
    // marker. The per-relation block below tints the dotted line with the
    // proposed relation's own color so the user still reads what KIND of relation
    // is being proposed. z-index 6 sits just above mesh so a proposal between two
    // already-meshed nodes is still visible, but the dotted/faint styling keeps
    // mesh-over-tree legibility intact (proposed edges are visually subordinate
    // to solid mesh despite the +1 z so they never look "more real").
    {
      selector: 'edge[kind = "proposed"]',
      style: {
        width: 2,
        'curve-style': 'bezier',
        'line-style': 'dotted',
        opacity: 0.5,
        // --info is the project's AI-attributed tone (matches the "AI · 关系"
        // mini-badge + EdgeProposalCard tone-info). Source-arrow dot marks the
        // edge as a suggestion emanating from the AI, not a directed mesh edge.
        'source-arrow-shape': 'diamond',
        'source-arrow-color': t['--info'],
        'target-arrow-shape': 'triangle',
        'z-index-compare': 'manual',
        'z-index': 6,
      },
    },
    // Hovered/active proposed edge: lift opacity so the inline-action affordance
    // reads as interactive (the tap handler surfaces accept/dismiss).
    {
      selector: 'edge[kind = "proposed"]:active',
      style: { opacity: 0.85, width: 3 },
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
    // Proposed-edge per-relation tint: same relation color so the user reads the
    // proposed KIND, but the dotted line-style + reduced opacity (from the
    // edge[kind="proposed"] base above) keep it visually "tentative/AI". The
    // target arrow takes the relation color; the source --info diamond stays as
    // the AI marker. Line-style is NOT overridden here — it inherits dotted from
    // the base block so even a normally-dashed relation (related_to) reads as
    // dotted-proposed, not dashed-tree-like.
    sheet.push({
      selector: `edge[kind = "proposed"][relation = "${relation}"]`,
      style: {
        'line-color': color,
        'target-arrow-color': color,
      },
    });
  }

  return sheet;
}

// ── Filter model (client-only; derived from already-loaded node data) ────────
export type MasteryFilter = 'all' | 'weak' | 'learning' | 'mastered';

export interface FilterState {
  // null domain = "全部" (all domains); otherwise an effective_domain value.
  domain: string | null;
  mastery: MasteryFilter;
  // "今天该复习" quick filter (Slice 2): when true, restrict to nodes with
  // overdue review items. Orthogonal to domain/mastery so it composes with them.
  dueOnly: boolean;
}

export function distinctDomains(nodes: KnowledgeGraphNode[]): string[] {
  const seen = new Set<string>();
  for (const n of nodes) {
    const d = n.effective_domain ?? n.domain;
    if (d) seen.add(d);
  }
  return [...seen].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
}

export function passesFilter(
  node: KnowledgeGraphNode,
  filter: FilterState,
  dueCounts: Map<string, NodeDueSummary>,
): boolean {
  if (filter.domain !== null) {
    const d = node.effective_domain ?? node.domain ?? null;
    if (d !== filter.domain) return false;
  }
  if (filter.dueOnly && (dueCounts.get(node.id)?.overdue ?? 0) === 0) return false;
  if (filter.mastery === 'all') return true;
  const band = masteryBand(node.mastery, node.evidence_count);
  // "薄弱" target = anything unproven: weak band + never-practiced + low-evidence.
  if (filter.mastery === 'weak')
    return band === 'weak' || band === 'untrained' || band === 'insufficient';
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
  dueCounts,
  proposals,
  onProposalDecision,
}: KnowledgeGraphProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const cyRef = useRef<Core | null>(null);
  // Latest onNodeClick without forcing the graph to re-init when the parent
  // re-renders with a new function identity.
  const onNodeClickRef = useRef(onNodeClick);
  onNodeClickRef.current = onNodeClick;
  // Same latest-ref trick for the proposal decision callback so the build effect
  // doesn't re-init cytoscape when the parent passes a fresh function identity.
  const onProposalDecisionRef = useRef(onProposalDecision);
  onProposalDecisionRef.current = onProposalDecision;

  // Stable empty fallback so the build effect's dependency identity is steady
  // when the summary endpoint is unavailable.
  const due = useMemo(() => dueCounts ?? new Map<string, NodeDueSummary>(), [dueCounts]);
  // Same stable-empty pattern for proposals — when the page passes nothing
  // (proposals endpoint unavailable / no pending), keep a steady [] reference so
  // the build effect's deps don't churn.
  const allProposals = useMemo(() => proposals ?? ([] as KnowledgeEdgeProposal[]), [proposals]);
  const totalOverdueNodes = useMemo(() => {
    let n = 0;
    for (const v of due.values()) if (v.overdue > 0) n += 1;
    return n;
  }, [due]);

  const domains = useMemo(() => distinctDomains(nodes), [nodes]);

  // Default view (NOT the full hairball, per D1): if there is more than one
  // domain, default to the first domain alphabetically; with a single (or zero)
  // domain there is no hairball to avoid, so show all. Mastery filter defaults
  // to "all" but weak nodes are always visually emphasized by their band fill.
  const [filter, setFilter] = useState<FilterState>(() => ({
    domain: domains.length > 1 ? domains[0] : null,
    mastery: 'all',
    dueOnly: false,
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

  // Slice 3 inline action: which proposed edge is "open" for accept/dismiss, and
  // where to anchor the floating action over the canvas (rendered midpoint of the
  // edge, in container px). Cleared on decision, empty-canvas tap, or rebuild.
  const [activeProposal, setActiveProposal] = useState<{
    proposalId: string;
    relation: string;
    fromName: string;
    toName: string;
    x: number;
    y: number;
  } | null>(null);

  // focusId is the spatial complement to selectedId (the drawer). Tapping a
  // node does both. A node can be focused without the drawer (e.g. restored)
  // but in practice they move together via onNodeClick.
  const [focusId, setFocusId] = useState<string | null>(null);
  // Latest focusId without re-running the build effect just to re-read it
  // (the build effect reapplies the focus overlay onto fresh elements).
  const focusIdRef = useRef(focusId);
  focusIdRef.current = focusId;

  const visibleNodes = useMemo(
    () => nodes.filter((n) => passesFilter(n, filter, due)),
    [nodes, filter, due],
  );
  const visibleNodeIds = useMemo(() => new Set(visibleNodes.map((n) => n.id)), [visibleNodes]);
  const visibleEdges = useMemo(
    () =>
      edges.filter(
        (e) => visibleNodeIds.has(e.from_knowledge_id) && visibleNodeIds.has(e.to_knowledge_id),
      ),
    [edges, visibleNodeIds],
  );
  // Proposals whose BOTH endpoints survive the current filter/focus — only these
  // become proposed edges (buildProposedEdgeElements applies the same guard, but
  // computing the visible set here drives the build-effect deps + the legend).
  const visibleProposals = useMemo(
    () =>
      allProposals.filter(
        (p) => visibleNodeIds.has(p.from_knowledge_id) && visibleNodeIds.has(p.to_knowledge_id),
      ),
    [allProposals, visibleNodeIds],
  );

  // mastery + evidence lookup for prerequisite-weakness derivation. evidence is
  // carried so isWeakish() can treat a low-evidence prerequisite as shaky too
  // (Fix B), matching the band logic used for fills.
  const bandInputById = useMemo(() => {
    const m = new Map<
      string,
      { mastery: number | null | undefined; evidence: number | null | undefined }
    >();
    for (const n of nodes) m.set(n.id, { mastery: n.mastery, evidence: n.evidence_count });
    return m;
  }, [nodes]);

  const counts = useMemo(() => {
    const acc = { weak: 0, learning: 0, mastered: 0, untrained: 0, insufficient: 0 };
    for (const n of visibleNodes) acc[masteryBand(n.mastery, n.evidence_count)]++;
    return acc;
  }, [visibleNodes]);

  // Node-name lookup for the inline proposal popover (id → display name).
  const nameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const n of nodes) m.set(n.id, n.name);
    return m;
  }, [nodes]);

  // proposalId → its endpoints/relation, so the tap handler can label the inline
  // action without re-scanning the proposals array on every tap.
  const proposalMetaById = useMemo(() => {
    const m = new Map<string, { from: string; to: string; relation: string }>();
    for (const p of allProposals) {
      m.set(p.id, {
        from: p.from_knowledge_id,
        to: p.to_knowledge_id,
        relation: p.relation_type,
      });
    }
    return m;
  }, [allProposals]);

  // ── Focus mode + prerequisite-weakness overlay ──────────────────────────
  // When a node is focused: reveal its closed 1-hop neighborhood, fade
  // everything else, fit the viewport to it, and ring its shaky prerequisites.
  // All derived from the cytoscape graph + the node mastery map — zero new
  // backend. Shared so it can be (re)applied both on focus change AND right
  // after a graph rebuild (a rebuild drops the focus classes). `id` is passed
  // explicitly so the latest bandInputById is closed over without staleness.
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
        // node (to == focus); their SOURCE is the prerequisite. Flag those that
        // are weakish (weak / never-practiced / low-evidence). cytoscape edge
        // direction = source→target, and we built prerequisite edges as from→to,
        // so incomers carries them.
        const prereqEdges = root.incomers('edge[kind = "mesh"][relation = "prerequisite"]');
        for (const src of prereqEdges.sources().toArray()) {
          const input = bandInputById.get(src.id());
          if (isWeakish(input?.mastery, input?.evidence)) src.addClass('kg-shaky-prereq');
        }
      });
      if (id) {
        const root = cy.getElementById(id);
        if (root.nonempty()) {
          cy.animate({ fit: { eles: root.closedNeighborhood(), padding: 60 } }, { duration: 280 });
        }
      }
    },
    [bandInputById],
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
      elements: [
        ...buildElements(visibleNodes, visibleEdges, mistakeCounts, due),
        // Slice 3: proposed edges layered onto the same scene. They reference the
        // node ids built above; buildProposedEdgeElements already guards on the
        // visible set so every endpoint exists as a node element.
        ...buildProposedEdgeElements(visibleProposals, visibleNodeIds),
      ],
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
        // A node tap also dismisses any open inline proposal action.
        setActiveProposal(null);
        onNodeClickRef.current(id);
        setFocusId(id);
      }
    });
    // Slice 3: tapping a proposed edge opens the inline accept/dismiss action
    // anchored at the edge's rendered midpoint (container px). We DON'T open the
    // drawer here — the inline action is the on-graph affordance.
    cy.on('tap', 'edge[kind = "proposed"]', (event) => {
      const edge = event.target;
      const proposalId = edge.data('proposalId') as string | undefined;
      const relation = (edge.data('relation') as string | undefined) ?? 'related_to';
      if (!proposalId) return;
      const meta = proposalMetaById.get(proposalId);
      const mid = edge.renderedMidpoint();
      setActiveProposal({
        proposalId,
        relation,
        fromName: meta ? (nameById.get(meta.from) ?? meta.from) : edge.source().id(),
        toName: meta ? (nameById.get(meta.to) ?? meta.to) : edge.target().id(),
        x: mid.x,
        y: mid.y,
      });
    });
    // Tapping empty canvas exits focus AND closes the inline proposal action
    // (but leaves the drawer to the page).
    cy.on('tap', (event) => {
      if (event.target === cy) {
        setFocusId(null);
        setActiveProposal(null);
      }
    });
    // Pan/zoom moves the edge under any open inline action — close it rather than
    // leave the popover stranded at a stale position.
    cy.on('pan zoom', () => setActiveProposal(null));

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

    // A rebuild destroys the prior cy instance, so any open inline proposal
    // action points at a stale edge — close it.
    setActiveProposal(null);

    return () => {
      attrObserver.disconnect();
      media.removeEventListener('change', restyle);
      cy.destroy();
      cyRef.current = null;
    };
  }, [
    visibleNodes,
    visibleEdges,
    visibleProposals,
    visibleNodeIds,
    mistakeCounts,
    due,
    applyFocus,
    proposalMetaById,
    nameById,
  ]);

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
    setFilter((f) => ({ ...f, mastery: 'weak', dueOnly: false }));
    setFocusId(null);
  }, []);

  // "今天该复习" quick filter: toggle the overdue-only restriction across all
  // domains so the user can step straight into the actionable review set.
  const toggleDue = useCallback(() => {
    setFilter((f) => ({ ...f, dueOnly: !f.dueOnly, domain: f.dueOnly ? f.domain : null }));
    setFocusId(null);
  }, []);

  const exitFocus = useCallback(() => setFocusId(null), []);

  // Slice 3 inline decision: reuse the page's decision callback (the SAME handler
  // the drawer's EdgeProposalCard wires through edgeProposalDecision → POST
  // /api/knowledge/edges/proposals/[id]). We optimistically close the popover; the
  // page's onSuccess invalidation refetches edges + proposals, so an accepted
  // proposal disappears from `proposals` and reappears as a real mesh edge on the
  // next render, and a dismissed one just disappears.
  const decideActiveProposal = useCallback(
    (decision: 'accept' | 'dismiss') => {
      if (!activeProposal) return;
      onProposalDecisionRef.current?.(activeProposal.proposalId, decision);
      setActiveProposal(null);
    },
    [activeProposal],
  );

  const focusName = focusId ? (nodes.find((n) => n.id === focusId)?.name ?? focusId) : null;
  const activeRelationLabel = activeProposal
    ? (RELATION_LABEL[activeProposal.relation] ?? activeProposal.relation)
    : null;

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
        <button
          type="button"
          className={`kg-chip kg-chip-due${filter.dueOnly ? ' is-on' : ''}`}
          onClick={toggleDue}
          aria-pressed={filter.dueOnly}
        >
          今天该复习{totalOverdueNodes > 0 ? ` · ${totalOverdueNodes}` : ''}
        </button>
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

      <div className="kg-canvas-wrap">
        <div ref={containerRef} className="kg-canvas" role="img" aria-label="知识关系图" />
        {activeProposal && (
          // Slice 3 inline action — minimal accept/dismiss anchored at the
          // proposed edge's rendered midpoint. translate(-50%, …) centers it on
          // the edge; the negative Y lifts it above the line. 改方向/改关系 stay
          // in the drawer (Slice 3 scope), so only accept/dismiss are inline.
          <fieldset
            className="kg-proposal-action"
            style={{ left: activeProposal.x, top: activeProposal.y }}
            aria-label="AI 建议关系"
          >
            <span className="kg-proposal-label">
              <span className="mini-badge info">
                <Icon name="link" size={11} /> AI
              </span>
              <code>{activeProposal.fromName}</code>
              <span className="kg-proposal-rel">{activeRelationLabel}</span>
              <code>{activeProposal.toName}</code>
            </span>
            <div className="kg-proposal-buttons">
              <button
                type="button"
                className="kg-chip kg-proposal-accept"
                onClick={() => decideActiveProposal('accept')}
              >
                接受
              </button>
              <button
                type="button"
                className="kg-chip kg-proposal-dismiss"
                onClick={() => decideActiveProposal('dismiss')}
              >
                忽略
              </button>
            </div>
          </fieldset>
        )}
      </div>

      <div className="kg-legend">
        <span className="kg-legend-section">掌握度</span>
        {(['weak', 'learning', 'mastered', 'insufficient', 'untrained'] as const).map((band) => (
          <span className="item" key={band}>
            <span
              className="swatch dot"
              // insufficient shares --ink-5 with untrained but at reduced opacity
              // (matches its node fill), so the legend reads them as distinct.
              style={{
                background: `var(${MASTERY_BAND_TOKEN[band]})`,
                ...(band === 'insufficient' ? { opacity: 0.4 } : {}),
              }}
            />
            <span>
              {MASTERY_BAND_LABEL[band]} {counts[band]}
            </span>
          </span>
        ))}
        <span className="kg-legend-section">复习</span>
        <span className="item">
          <span className="swatch halo" />
          <span>逾期 {totalOverdueNodes}</span>
        </span>
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
        <span className="kg-legend-section">AI</span>
        <span className="item">
          {/* Dotted --info swatch = proposed (AI-suggested) edge; count = visible
              pending proposals under the current filter/focus. */}
          <span className="swatch proposed" />
          <span>提议关系 {visibleProposals.length}</span>
        </span>
        <span className="kg-legend-note">
          圆 = 节点 · 填色 ∝ 掌握度 · 半径 ∝ mistake_count · 珊瑚光晕 = 有逾期复习 · 点虚线 = AI
          提议（点击接受 / 忽略）· 点节点聚焦 · 拖拽 / 滚轮缩放
        </span>
      </div>
    </section>
  );
}

export default KnowledgeGraph;
