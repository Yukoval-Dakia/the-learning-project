'use client';

import {
  type LayoutMap,
  type Point,
  computeDepths,
  computeLayout,
} from '@/ui/knowledge-graph/layout';
import { Icon } from '@/ui/primitives/Icon';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';

// Relation-type visual contract — see docs/design/loom-design-v2.1/README.md
// "Mesh 视觉决策" table and docs/design/2026-05-15-design-brief-v2.1.md §2.3.b.
// `token` keys are design-token CSS variable *names*. With the SVG rewrite these
// are referenced directly as `var(--x)` on the stroke (cytoscape needed literal
// hexes; SVG does not), so dark mode follows the theme for free — no token
// re-read / MutationObserver. `arrow` toggles a target-arrow; `dashed` toggles a
// dashed line-style.
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
// proposed relation in the same words as the drawer's EdgeProposalCard. The
// label is keyed off the visualKey — unknown / experimental types collapse to
// the related_to visual, so they surface here as "相关".
export const RELATION_LABEL: Record<string, string> = {
  prerequisite: '前置',
  related_to: '相关',
  contrasts_with: '对照',
  applied_in: '应用于',
  derived_from: '派生自',
};

// Non-color glyph cue per relation (design screen-knowledge.jsx REL_CUE). Fused
// with RELATION_VISUAL (color / dash / arrow) + RELATION_LABEL (zh) so the mesh
// edges + legend read the relation KIND by shape AND glyph, not color alone. We
// keep the PRODUCTION color/dash/arrow (RELATION_VISUAL) and only borrow the
// glyph — the design mock's tones (good/hard amber etc.) are intentionally NOT
// used (issue YUK-297 §⑤ token correction).
const RELATION_GLYPH: Record<string, string> = {
  prerequisite: '→',
  applied_in: '↦',
  derived_from: '↳',
  contrasts_with: '⇆',
  related_to: '—',
};

/** Resolve an arbitrary relation_type to its visual key (unknown → related_to). */
export function relationVisualKey(relationType: string): string {
  return RELATION_VISUAL[relationType] ? relationType : 'related_to';
}

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

// NOTE: the node DISC color no longer comes from MasteryBand — it uses the design
// 3-tone (masteryTone) per owner「全抄 design」. MasteryBand still drives the 掌握度
// FILTER + isWeakish (evidence-gated diagnostic), so the type + label map stay.

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

// design 3-tone (screen-knowledge.jsx L83): mastery → good / hard / again. The
// disc fill + arc + track read this directly (owner 2026-06-08「全抄 design」),
// replacing the 5-band diagnostic palette as the NODE COLOR. Thresholds align to
// the MasteryBand cutoffs (0.7 / 0.4) so disc color, the 掌握度 filter, and the
// legend all agree. NULL mastery (never practiced) → 0 → 'again': the design has
// no untrained/insufficient tone, and that grey "证据不足" encoding was
// intentionally dropped as the node color (the evidence gate still drives the
// FILTER + isWeakish, just not the disc fill).
export type MasteryTone = 'good' | 'hard' | 'again';

export function masteryTone(mastery: number | null | undefined): MasteryTone {
  const m = mastery ?? 0;
  if (m >= 0.7) return 'good';
  if (m >= 0.4) return 'hard';
  return 'again';
}

// design node radius (screen-knowledge.jsx L84): hub = 24, leaf = 18. A node is a
// "hub" if it is some other node's parent. Replaces the radius-∝-mistake_count
// encoding (owner「全抄 design」: clean uniform discs over the diagnostic sizing).
export const HUB_RADIUS = 24;
export const LEAF_RADIUS = 18;

// Legend labels for the 3 design tones (reuse the mastery vocabulary).
export const TONE_LABEL: Record<MasteryTone, string> = {
  good: '已掌握',
  hard: '学习中',
  again: '薄弱',
};

// A node at the 2nd level or deeper (depth >= 1, i.e. not a top-level root) with
// MORE than this many children is NOT expanded inline (owner 2026-06-08): dumping
// 40+ siblings deep in the tree floods the canvas even with progressive disclosure.
// Such a node focuses + opens the drawer (browse its children there) instead of
// expanding in the graph. Top-level roots (depth 0) are exempt — their breadth is
// the overview the disclosure default is meant to show.
export const MAX_INLINE_EXPAND_CHILDREN = 40;

// A node is expandable inline iff it has children AND is either a top-level root or
// has a manageable number of children. Centralised so the tap handler + the badge
// affordance + tests all agree.
export function isInlineExpandable(depth: number, childCount: number): boolean {
  if (childCount <= 0) return false;
  return depth < 1 || childCount <= MAX_INLINE_EXPAND_CHILDREN;
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
  /**
   * Per-node review-due counts (overdue / due_soon). Nodes with overdue > 0 get
   * the coral due halo + are the target of the "今天该复习" quick filter. Empty
   * map when the summary endpoint is unavailable (graceful: no halos shown).
   */
  dueCounts?: Map<string, NodeDueSummary>;
  /**
   * Pending AI edge proposals (Slice 3 — "AI 画布"). Rendered as distinct dotted
   * proposed edges between their endpoints when BOTH endpoints are visible under
   * the current filter/focus. Tapping one surfaces an inline accept / dismiss
   * that calls onProposalDecision (the SAME decision endpoint the drawer's
   * EdgeProposalCard uses). Should be a stable/memoized ref from the page.
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
    // YUK-249 derived-axis seam: subject is a VIEW derived from effective_domain
    // (effective_domain ?? domain), never a stored column. The domain chips +
    // this dedupe are the派生轴 consumer; a future subject rename flows through
    // effective_domain automatically. Do not add a subject column here.
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

// ── SVG render geometry ──────────────────────────────────────────────────────
// The layout solver positions nodes inside a 1000x560 logical box (design viewBox).
const VIEW_BOX_W = 1000;
const VIEW_BOX_H = 560;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2;
// animationDelay cap so a large graph's last node doesn't wait seconds to fade in.
const FADE_DELAY_STEP_MS = 50;
const FADE_DELAY_CAP_MS = 800;
// Focus-fit camera move duration — mirrors production cy.animate({ fit }, 280ms).
// Must stay in sync with the .kg-camera CSS transition in globals.css.
const CAMERA_FIT_MS = 280;

interface ViewTransform {
  x: number;
  y: number;
  k: number;
}

/** A rendered mesh/tree/proposed edge in SVG terms. */
interface RenderedEdge {
  id: string;
  kind: 'tree' | 'mesh' | 'proposed';
  from: Point;
  to: Point;
  /** endpoint node ids — used by focus-mode edge fading. */
  fromId: string;
  toId: string;
  relation: string;
  width: number;
  proposalId?: string;
}

/**
 * Convert an SVG-space point (the layout's logical coords) to container pixels,
 * applying the pan/zoom view AND the viewBox→container mapping. Used to anchor the
 * inline proposal popover at an edge midpoint (replaces cytoscape's
 * renderedMidpoint()). `stage` is the rendered stage size in px.
 *
 * The <svg> uses preserveAspectRatio="xMidYMid meet", so the viewBox is scaled
 * UNIFORMLY by s = min(stageW/vbW, stageH/vbH) and letterbox-centred — NOT by
 * independent per-axis scales. Anchoring off independent axis scales drifts
 * horizontally (or vertically) whenever the rendered stage aspect ≠ vbW:vbH, e.g.
 * the production `.kg-svg-stage { width:100%; height:560px }` whose width tracks
 * the parent column. So we reproduce the meet transform exactly: pan/zoom the
 * point in logical units, then apply the uniform scale + letterbox offset.
 */
export function svgPointToContainerPx(
  p: Point,
  view: ViewTransform,
  stage: { width: number; height: number },
): { x: number; y: number } {
  // The <g> applies translate(view.x view.y) scale(view.k) in logical units
  // BEFORE the viewBox mapping: logical → (pan/zoom) → (viewBox meet) → px.
  const lx = p.x * view.k + view.x;
  const ly = p.y * view.k + view.y;
  // meet → uniform scale + centred letterbox.
  const s = Math.min(stage.width / VIEW_BOX_W, stage.height / VIEW_BOX_H);
  const offsetX = (stage.width - VIEW_BOX_W * s) / 2;
  const offsetY = (stage.height - VIEW_BOX_H * s) / 2;
  return { x: offsetX + lx * s, y: offsetY + ly * s };
}

/** A positioned, sized node for camera-fit bbox math. */
interface FitPoint {
  point: Point;
  r: number;
}

// Focus-mode camera fit padding (logical units) — mirrors production's
// cy.animate({ fit: { padding: 60 } }).
const FOCUS_FIT_PADDING = 60;

/**
 * Compute the pan/zoom `view` that frames a focus neighborhood, restoring the
 * zoom-into-neighborhood affordance the cytoscape version had via
 * `cy.animate({ fit: { eles: closedNeighborhood, padding: 60 } })`. The SVG
 * version only faded non-neighbors; this re-adds the camera move.
 *
 * Returns a ViewTransform applied as translate(x y) scale(k) in the same logical
 * space as the layout. k is clamped to [ZOOM_MIN, 1] — never zoom PAST 1:1 (owner
 * 2026-06-07「点太大了」), so a tiny 1-2 node neighborhood doesn't balloon. With an
 * empty/zero-extent set we fall back to the identity-ish reset view.
 */
export function fitViewToNeighborhood(points: FitPoint[]): ViewTransform {
  if (points.length === 0) return { x: 0, y: 0, k: 1 };
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const { point, r } of points) {
    minX = Math.min(minX, point.x - r);
    minY = Math.min(minY, point.y - r);
    maxX = Math.max(maxX, point.x + r);
    maxY = Math.max(maxY, point.y + r);
  }
  const bw = maxX - minX + FOCUS_FIT_PADDING * 2;
  const bh = maxY - minY + FOCUS_FIT_PADDING * 2;
  // Scale so the padded bbox fits the logical viewBox; clamp into [ZOOM_MIN, 1].
  const fit = Math.min(VIEW_BOX_W / bw, VIEW_BOX_H / bh);
  const k = Math.min(1, Math.max(ZOOM_MIN, Number(fit.toFixed(2))));
  // Centre the bbox: after scale(k), the neighborhood centre (cx,cy) must land at
  // the viewBox centre, so translate = viewBoxCentre − k*centre.
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return {
    x: VIEW_BOX_W / 2 - k * cx,
    y: VIEW_BOX_H / 2 - k * cy,
    k,
  };
}

/**
 * Knowledge graph as a "诊断 + 局部聚焦" instrument (Wave 7 T-KG Slice 1b;
 * locked direction D1). Rendered as a hand-owned SVG layer (YUK-297) — cytoscape
 * is now a build-time headless layout solver only (see layout.ts), so the design
 * MeshGraph visual language (node disc/track/mastery-arc, error-staggered
 * fade-in, animated arc, 5 typed edges, pan/zoom) renders with native CSS
 * @keyframes / transitions that a <canvas> renderer could never fire.
 *
 * Slice 1a behaviors preserved: relation visual contract, mesh-over-tree, node
 * size ∝ mistakes, tap → drawer + focus, dark-mode (CSS var() follows theme for
 * free), pan/zoom/drag. Slice 1b/2/3 preserved: mastery-band fill + evidence
 * gate + 0.5 sentinel, shaky-prereq ring, due halo, filters, on-graph proposed
 * edges + inline accept/dismiss.
 */
export function KnowledgeGraph({
  nodes,
  edges,
  selectedId,
  onNodeClick,
  dueCounts,
  proposals,
  onProposalDecision,
}: KnowledgeGraphProps) {
  // Unique def ids so the <marker>/<filter> never collide across remounts.
  const defsId = useId();
  const arrowId = `kg-arrow-${defsId}`;
  const shadowId = `kg-shadow-${defsId}`;

  const stageRef = useRef<HTMLDivElement | null>(null);

  // Latest callbacks without forcing re-renders to thread through identity.
  const onNodeClickRef = useRef(onNodeClick);
  onNodeClickRef.current = onNodeClick;
  const onProposalDecisionRef = useRef(onProposalDecision);
  onProposalDecisionRef.current = onProposalDecision;

  // Stable empty fallbacks so memo identities stay steady when endpoints are
  // unavailable.
  const due = useMemo(() => dueCounts ?? new Map<string, NodeDueSummary>(), [dueCounts]);
  const allProposals = useMemo(() => proposals ?? ([] as KnowledgeEdgeProposal[]), [proposals]);

  const totalOverdueNodes = useMemo(() => {
    let n = 0;
    for (const v of due.values()) if (v.overdue > 0) n += 1;
    return n;
  }, [due]);

  const domains = useMemo(() => distinctDomains(nodes), [nodes]);

  // Default view (NOT the full hairball, per D1): more than one domain → default
  // to the first domain alphabetically; single/zero domain → show all.
  const [filter, setFilter] = useState<FilterState>(() => ({
    domain: domains.length > 1 ? domains[0] : null,
    mastery: 'all',
    dueOnly: false,
  }));

  // Re-default the domain filter if the domain set changes and it's now invalid.
  useEffect(() => {
    setFilter((f) => {
      if (f.domain !== null && !domains.includes(f.domain)) {
        return { ...f, domain: domains.length > 1 ? domains[0] : null };
      }
      return f;
    });
  }, [domains]);

  // Pan/zoom view (design screen-knowledge.jsx L39-45). We own this — cytoscape
  // touches nothing the user interacts with.
  const [view, setView] = useState<ViewTransform>({ x: 0, y: 0, k: 1 });
  const dragRef = useRef<{ px: number; py: number; x: number; y: number } | null>(null);
  // The camera <g> animates ONLY for focus-fit and focus→unfocus moves — direct
  // manipulation (drag-pan, wheel/button zoom, the 复位 reset button) stays instant
  // so it tracks input. `cameraAnimating` gates the CSS transition; it's pulsed
  // true around a focus move and auto-cleared after the 280ms transition.
  const [cameraAnimating, setCameraAnimating] = useState(false);
  const cameraTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const animateCamera = useCallback((next: ViewTransform) => {
    setCameraAnimating(true);
    setView(next);
    if (cameraTimerRef.current) clearTimeout(cameraTimerRef.current);
    cameraTimerRef.current = setTimeout(() => setCameraAnimating(false), CAMERA_FIT_MS);
  }, []);
  useEffect(
    () => () => {
      if (cameraTimerRef.current) clearTimeout(cameraTimerRef.current);
    },
    [],
  );

  // focusId is the spatial complement to selectedId (the drawer). Tapping a node
  // does both.
  const [focusId, setFocusId] = useState<string | null>(null);

  // Slice 3 inline action: which proposed edge is "open", anchored in container px.
  const [activeProposal, setActiveProposal] = useState<{
    proposalId: string;
    relation: string;
    fromName: string;
    toName: string;
    x: number;
    y: number;
  } | null>(null);

  // Progressive disclosure (YUK-297): the universe is the filtered set; we only
  // SHOW the disclosed subset — roots + the children of every EXPANDED node — so
  // each view stays sparse and the tidy-tree layout always breathes. Drilling in =
  // tap a node → expand it (reveal its children) + focus it. Default = roots
  // expanded → exactly 2 levels (root + direct children).
  const universeNodes = useMemo(
    () => nodes.filter((n) => passesFilter(n, filter, due)),
    [nodes, filter, due],
  );
  const universeIds = useMemo(() => new Set(universeNodes.map((n) => n.id)), [universeNodes]);
  const childrenByParent = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const n of universeNodes) {
      if (n.parent_id != null && universeIds.has(n.parent_id)) {
        const arr = m.get(n.parent_id) ?? [];
        arr.push(n.id);
        m.set(n.parent_id, arr);
      }
    }
    return m;
  }, [universeNodes, universeIds]);
  // Depth within the (filtered) universe — drives the deep+wide inline-expand cap.
  const depthByNode = useMemo(() => computeDepths(universeNodes), [universeNodes]);
  const rootIds = useMemo(
    () =>
      universeNodes
        .filter((n) => n.parent_id == null || !universeIds.has(n.parent_id))
        .map((n) => n.id),
    [universeNodes, universeIds],
  );

  // Expanded set drives disclosure. Initialised to the roots so the 2-level default
  // is correct on the FIRST render (incl. SSR / renderToString, where effects don't
  // run) — no empty-then-expand flash. The effect below re-defaults to the roots
  // only when the universe (filter / data) actually changes.
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(() => new Set(rootIds));
  const rootKey = useMemo(() => [...rootIds].sort().join('|'), [rootIds]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: rootKey is the stable change-trigger for rootIds; depending on rootIds (a fresh array each render) would reset expansion every render.
  useEffect(() => {
    setExpandedIds(new Set(rootIds));
    setFocusId(null);
  }, [rootKey]);

  const disclosedIds = useMemo(() => {
    const out = new Set<string>(rootIds);
    const queue = [...rootIds];
    while (queue.length > 0) {
      const id = queue.shift() as string;
      if (!expandedIds.has(id)) continue;
      for (const c of childrenByParent.get(id) ?? []) {
        if (!out.has(c)) {
          out.add(c);
          queue.push(c);
        }
      }
    }
    return out;
  }, [rootIds, childrenByParent, expandedIds]);

  const visibleNodes = useMemo(
    () => universeNodes.filter((n) => disclosedIds.has(n.id)),
    [universeNodes, disclosedIds],
  );
  const visibleNodeIds = useMemo(() => new Set(visibleNodes.map((n) => n.id)), [visibleNodes]);
  const visibleEdges = useMemo(
    () =>
      edges.filter(
        (e) => visibleNodeIds.has(e.from_knowledge_id) && visibleNodeIds.has(e.to_knowledge_id),
      ),
    [edges, visibleNodeIds],
  );
  const visibleProposals = useMemo(
    () =>
      allProposals.filter(
        (p) => visibleNodeIds.has(p.from_knowledge_id) && visibleNodeIds.has(p.to_knowledge_id),
      ),
    [allProposals, visibleNodeIds],
  );

  // Layout: solve coordinates ONCE per visible-graph change (not on pan/zoom — a
  // pan only mutates `view`). cytoscape spins up headless in computeLayout and is
  // destroyed before this returns, so nothing persists.
  const layout: LayoutMap = useMemo(
    () => computeLayout(visibleNodes, visibleEdges),
    [visibleNodes, visibleEdges],
  );

  // mastery + evidence lookup for prerequisite-weakness derivation (Fix B: a
  // low-evidence prerequisite is shaky too).
  const bandInputById = useMemo(() => {
    const m = new Map<
      string,
      { mastery: number | null | undefined; evidence: number | null | undefined }
    >();
    for (const n of nodes) m.set(n.id, { mastery: n.mastery, evidence: n.evidence_count });
    return m;
  }, [nodes]);

  // Legend tallies by the design 3-tone (good/hard/again), matching the disc fill.
  const toneCounts = useMemo(() => {
    const acc: Record<MasteryTone, number> = { good: 0, hard: 0, again: 0 };
    for (const n of visibleNodes) acc[masteryTone(n.mastery)]++;
    return acc;
  }, [visibleNodes]);

  // hub vs leaf radius (design hub=24 / leaf=18): a node is a hub if it parents
  // another node. Structural over the full node set, not the filtered view.
  const hubIds = useMemo(() => {
    const s = new Set<string>();
    for (const n of nodes) if (n.parent_id) s.add(n.parent_id);
    return s;
  }, [nodes]);

  const nameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const n of nodes) m.set(n.id, n.name);
    return m;
  }, [nodes]);

  // Focus neighborhood (closed 1-hop): the focused node + every node directly
  // connected by a tree or mesh edge. Nodes outside fade; this drives the overlay
  // classes (replaces cytoscape closedNeighborhood()).
  const focusNeighborhood = useMemo(() => {
    if (!focusId || !visibleNodeIds.has(focusId)) return null;
    const hood = new Set<string>([focusId]);
    for (const n of visibleNodes) {
      // outer guard already proved n.parent_id is non-null, so add it directly.
      if (n.parent_id && (n.parent_id === focusId || n.id === focusId)) {
        hood.add(n.parent_id);
        hood.add(n.id);
      }
    }
    for (const e of visibleEdges) {
      if (e.from_knowledge_id === focusId) hood.add(e.to_knowledge_id);
      if (e.to_knowledge_id === focusId) hood.add(e.from_knowledge_id);
    }
    // Proposed edges count too — mirrors the cytoscape closedNeighborhood() this
    // replaced, so focusing a node keeps its AI-proposed links (and their far
    // endpoint) lit instead of fading them out.
    for (const p of visibleProposals) {
      if (p.from_knowledge_id === focusId) hood.add(p.to_knowledge_id);
      if (p.to_knowledge_id === focusId) hood.add(p.from_knowledge_id);
    }
    return hood;
  }, [focusId, visibleNodeIds, visibleNodes, visibleEdges, visibleProposals]);

  // Shaky prerequisites of the focused node: prerequisite mesh edges pointing INTO
  // focus (to == focus) whose SOURCE is weakish. Reserved --again ring.
  const shakyPrereqIds = useMemo(() => {
    const out = new Set<string>();
    if (!focusId) return out;
    for (const e of visibleEdges) {
      if (e.to_knowledge_id !== focusId) continue;
      if (relationVisualKey(e.relation_type) !== 'prerequisite') continue;
      const input = bandInputById.get(e.from_knowledge_id);
      if (isWeakish(input?.mastery, input?.evidence)) out.add(e.from_knowledge_id);
    }
    return out;
  }, [focusId, visibleEdges, bandInputById]);

  // Build the rendered edge list (tree skeleton底色 first, then mesh, then
  // proposed — DOM order = z order, so later paints on top). Dangling endpoints
  // are skipped via the layout map (only positioned nodes have coords).
  const renderedEdges = useMemo<RenderedEdge[]>(() => {
    const out: RenderedEdge[] = [];
    // Tree edges (parent_id skeleton).
    for (const n of visibleNodes) {
      if (!n.parent_id) continue;
      const from = layout.get(n.parent_id);
      const to = layout.get(n.id);
      if (!from || !to) continue;
      out.push({
        id: `tree-${n.id}`,
        kind: 'tree',
        from,
        to,
        fromId: n.parent_id,
        toId: n.id,
        relation: 'tree',
        width: 1,
      });
    }
    // Mesh edges.
    for (const e of visibleEdges) {
      const from = layout.get(e.from_knowledge_id);
      const to = layout.get(e.to_knowledge_id);
      if (!from || !to) continue;
      out.push({
        id: e.id,
        kind: 'mesh',
        from,
        to,
        fromId: e.from_knowledge_id,
        toId: e.to_knowledge_id,
        relation: relationVisualKey(e.relation_type),
        // PRESERVE prior stroke width: 1 + weight * 1.5.
        width: 1 + e.weight * 1.5,
      });
    }
    // Proposed edges (AI suggestions).
    for (const p of visibleProposals) {
      const from = layout.get(p.from_knowledge_id);
      const to = layout.get(p.to_knowledge_id);
      if (!from || !to) continue;
      out.push({
        id: `proposed-${p.key}`,
        kind: 'proposed',
        from,
        to,
        fromId: p.from_knowledge_id,
        toId: p.to_knowledge_id,
        relation: relationVisualKey(p.relation_type),
        width: 2,
        proposalId: p.id,
      });
    }
    return out;
  }, [visibleNodes, visibleEdges, visibleProposals, layout]);

  // Rendered node descriptors (position + radius + band + halo flag).
  const renderedNodes = useMemo(() => {
    return visibleNodes
      .map((n, i) => {
        const p = layout.get(n.id);
        if (!p) return null;
        const r = hubIds.has(n.id) ? HUB_RADIUS : LEAF_RADIUS;
        const tone = masteryTone(n.mastery);
        const overdue = due.get(n.id)?.overdue ?? 0;
        // mastery arc progress + disc-内 integer: NULL mastery → 0 (never
        // practiced). design (mesh-node-pct) ALWAYS shows the digit.
        const masteryPct = Math.max(0, Math.min(1, n.mastery ?? 0));
        return {
          id: n.id,
          name: n.name,
          point: p,
          r,
          tone,
          masteryPct,
          pctLabel: Math.round(masteryPct * 100),
          overdue,
          fadeDelayMs: Math.min(i * FADE_DELAY_STEP_MS, FADE_DELAY_CAP_MS),
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
  }, [visibleNodes, layout, hubIds, due]);

  // position + radius lookup for the focus-mode camera fit (below).
  const renderedNodeById = useMemo(() => {
    const m = new Map<string, { point: Point; r: number }>();
    for (const n of renderedNodes) m.set(n.id, { point: n.point, r: n.r });
    return m;
  }, [renderedNodes]);

  // ── Focus camera fit: when a focus neighborhood is set, move the camera to
  // frame it (mirrors production's cy.animate({ fit: { eles: closedNeighborhood,
  // padding: 60 } }, 280ms) — the SVG rewrite previously only FADED non-neighbors
  // and never zoomed in). The set→null edge returns to the reset view; we track
  // the prior state with a ref so a data refresh while UNFOCUSED doesn't clobber a
  // user's manual pan/zoom. The 280ms animation is the CSS transition on the
  // camera <g> (.kg-camera).
  const wasFocusedRef = useRef(false);
  useEffect(() => {
    if (focusNeighborhood === null) {
      // Only snap back on the focus→unfocus transition, not on every unfocused
      // data refresh (manual pan/zoom must survive a refresh).
      if (wasFocusedRef.current) animateCamera({ x: 0, y: 0, k: 1 });
      wasFocusedRef.current = false;
      return;
    }
    wasFocusedRef.current = true;
    const points: { point: Point; r: number }[] = [];
    for (const id of focusNeighborhood) {
      const rn = renderedNodeById.get(id);
      if (rn) points.push(rn);
    }
    if (points.length === 0) return;
    animateCamera(fitViewToNeighborhood(points));
  }, [focusNeighborhood, renderedNodeById, animateCamera]);

  // ── Initial fit: when the visible set changes (layout recomputed), clamp zoom
  // ≤ 1 (owner 2026-06-07「点太大了」) and drop any stale inline action. The layout
  // already centres roughly in the 1000x560 box, so the default identity view
  // fits; we only clamp k. `layout` is intentionally a CHANGE TRIGGER (the effect
  // doesn't read it, but must re-fire once per data change) — Biome flags it as
  // removable because it's unread, but removing it would only fit on first mount.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `layout` is a change-trigger, not a read — keep it so the fit re-runs per data change.
  useEffect(() => {
    setView((v) => (v.k > 1 ? { ...v, k: 1 } : v));
    setActiveProposal(null);
  }, [layout]);

  // If the focused node is filtered out, exit focus.
  useEffect(() => {
    if (focusId && !visibleNodeIds.has(focusId)) setFocusId(null);
  }, [visibleNodeIds, focusId]);

  // ── Pan / zoom handlers (design screen-knowledge.jsx) ──────────────────────
  const onDown = useCallback(
    (e: React.MouseEvent) => {
      dragRef.current = { px: e.clientX, py: e.clientY, x: view.x, y: view.y };
    },
    [view.x, view.y],
  );
  const onMove = useCallback((e: React.MouseEvent) => {
    const d = dragRef.current;
    if (!d) return;
    // Panning moves edges under any open inline action — close it (Slice 3).
    setActiveProposal(null);
    setView((v) => ({ ...v, x: d.x + (e.clientX - d.px), y: d.y + (e.clientY - d.py) }));
  }, []);
  const onUp = useCallback(() => {
    dragRef.current = null;
  }, []);
  // Wheel handling via a NON-PASSIVE native listener so preventDefault works (React
  // registers onWheel as passive → it can't stop the page from scrolling, which
  // would let a two-finger pan scroll the whole page). Plain wheel-zoom is BANNED
  // (owner 2026-06-08); a trackpad PINCH arrives as wheel+ctrlKey → zoom; a plain
  // wheel / two-finger scroll → PAN. Drag-pan (mouse) still works via onMouse*.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheelNative = (e: WheelEvent) => {
      e.preventDefault();
      setActiveProposal(null);
      if (e.ctrlKey) {
        setView((v) => ({
          ...v,
          k: Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Number((v.k - e.deltaY * 0.01).toFixed(2)))),
        }));
      } else {
        setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
      }
    };
    el.addEventListener('wheel', onWheelNative, { passive: false });
    return () => el.removeEventListener('wheel', onWheelNative);
  }, []);
  const resetView = useCallback(() => {
    setActiveProposal(null);
    setView({ x: 0, y: 0, k: 1 });
  }, []);

  // ── Node tap → drill-down (expand/collapse) + focus + drawer. ──────────────
  // A node with hidden children EXPANDS (reveal them, animated); re-tapping an
  // expanded node COLLAPSES its subtree. Leaves just focus + open the drawer. The
  // focus + expand together drive the camera fit and the fade of other branches.
  const handleNodeTap = useCallback(
    (id: string) => {
      setActiveProposal(null);
      onNodeClickRef.current(id);
      setFocusId(id);
      const childCount = childrenByParent.get(id)?.length ?? 0;
      if (childCount === 0) return; // leaf → just focus + drawer
      const depth = depthByNode.get(id) ?? 0;
      setExpandedIds((prev) => {
        const isExpanded = prev.has(id);
        // A deep + wide node (depth ≥ 1, > 40 children) does NOT expand inline — it
        // floods the canvas; the drawer (opened above) is where you browse it.
        // Collapse is always allowed (so a node never gets stuck open).
        if (!isExpanded && !isInlineExpandable(depth, childCount)) return prev;
        const next = new Set(prev);
        if (isExpanded) next.delete(id);
        else next.add(id);
        return next;
      });
    },
    [childrenByParent, depthByNode],
  );

  // ── Proposed-edge tap → inline accept/dismiss at the edge midpoint. ────────
  const handleProposedTap = useCallback(
    (edge: RenderedEdge) => {
      if (!edge.proposalId) return;
      const stage = stageRef.current;
      const mid: Point = {
        x: (edge.from.x + edge.to.x) / 2,
        y: (edge.from.y + edge.to.y) / 2,
      };
      const px = stage
        ? svgPointToContainerPx(mid, view, {
            width: stage.clientWidth,
            height: stage.clientHeight,
          })
        : { x: 0, y: 0 };
      // Resolve endpoint names from the proposal (source/target order).
      const meta = visibleProposals.find((p) => p.id === edge.proposalId);
      setActiveProposal({
        proposalId: edge.proposalId,
        relation: edge.relation,
        fromName: meta ? (nameById.get(meta.from_knowledge_id) ?? meta.from_knowledge_id) : '',
        toName: meta ? (nameById.get(meta.to_knowledge_id) ?? meta.to_knowledge_id) : '',
        x: px.x,
        y: px.y,
      });
    },
    [view, visibleProposals, nameById],
  );

  // Tapping empty canvas exits focus, closes the inline action, and collapses the
  // tree back to the 2-level default (drill all the way back out).
  const onStageClick = useCallback(
    (e: React.MouseEvent) => {
      // Blank-canvas click = the stage <div> OR the <svg> root (the svg fills the
      // div, so empty-area clicks land on the svg, not the div — checking only the
      // div meant this reset almost never fired). Node / proposed-edge clicks
      // stopPropagation; mesh edges/labels target deeper SVG elements, so this
      // still resets only on a genuine empty-canvas click.
      if (e.target === e.currentTarget || e.target instanceof SVGSVGElement) {
        setFocusId(null);
        setActiveProposal(null);
        setExpandedIds(new Set(rootIds));
      }
    },
    [rootIds],
  );

  const showWeak = useCallback(() => {
    setFilter((f) => ({ ...f, mastery: 'weak', dueOnly: false }));
    setFocusId(null);
  }, []);
  const toggleDue = useCallback(() => {
    setFilter((f) => ({ ...f, dueOnly: !f.dueOnly, domain: f.dueOnly ? f.domain : null }));
    setFocusId(null);
  }, []);
  const exitFocus = useCallback(() => {
    setFocusId(null);
    setExpandedIds(new Set(rootIds));
  }, [rootIds]);

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

  // Whether a node / edge is faded by focus mode.
  const isFaded = useCallback(
    (id: string) => focusNeighborhood !== null && !focusNeighborhood.has(id),
    [focusNeighborhood],
  );
  const isEdgeFaded = useCallback(
    (e: RenderedEdge) => {
      if (focusNeighborhood === null) return false;
      // an edge is in-focus only if BOTH endpoints are in the neighborhood.
      return !(focusNeighborhood.has(e.fromId) && focusNeighborhood.has(e.toId));
    },
    [focusNeighborhood],
  );

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
        {/* Camera controls pill. Manual +/− zoom is removed (owner 2026-06-08):
            zoom is by trackpad pinch, pan by two-finger scroll / drag. The only
            button is 复位 — reset to the fitted default view. The % is live feedback. */}
        <div className="kg-zoom-controls" aria-label="视图控制">
          <span className="kg-zoom-pct mono">{Math.round(view.k * 100)}%</span>
          <span className="kg-zoom-div" />
          <button
            type="button"
            className="kg-zoom-btn"
            title="复位视图"
            aria-label="复位视图"
            onClick={resetView}
          >
            <Icon name="refresh" size={15} />
          </button>
        </div>

        {/* The stage is the pan/zoom camera surface (drag + wheel + click-empty-to-
            exit-focus). The real interactive affordances are the focusable node
            groups + the focus-bar "返回全图" button (keyboard path to exit focus); the
            stage's own onClick is a pointer convenience, with Escape as the keyboard
            equivalent. */}
        <div
          ref={stageRef}
          className="kg-svg-stage"
          role="application"
          aria-label="知识关系图，可平移缩放"
          onMouseDown={onDown}
          onMouseMove={onMove}
          onMouseUp={onUp}
          onMouseLeave={onUp}
          onClick={onStageClick}
          onKeyDown={(ev) => {
            if (ev.key === 'Escape') {
              setFocusId(null);
              setActiveProposal(null);
            }
          }}
        >
          <svg
            className="kg-svg"
            width="100%"
            height="100%"
            viewBox={`0 0 ${VIEW_BOX_W} ${VIEW_BOX_H}`}
            preserveAspectRatio="xMidYMid meet"
            role="img"
            aria-label="知识关系图"
          >
            <title>知识关系图</title>
            <defs>
              {/* One arrow marker per arrowed relation, each with an explicit
                  fill = the relation's design token. SVG2 `fill="context-stroke"`
                  (inherit the edge's stroke) is Firefox-only — Chrome/Safari fall
                  back to black, breaking the directed-relation color contract — so
                  we bind the color per relation instead of one shared marker. */}
              {Object.entries(RELATION_VISUAL)
                .filter(([, v]) => v.arrow)
                .map(([rel, v]) => (
                  <marker
                    key={rel}
                    id={`${arrowId}-${rel}`}
                    viewBox="0 0 10 10"
                    refX="9"
                    refY="5"
                    markerWidth="7"
                    markerHeight="7"
                    orient="auto-start-reverse"
                  >
                    <path d="M0 0 L10 5 L0 10 z" fill={`var(${v.token})`} />
                  </marker>
                ))}
              <filter id={shadowId} x="-40%" y="-40%" width="180%" height="180%">
                <feDropShadow dx="0" dy="2" stdDeviation="3" floodColor="rgba(60,50,30,0.18)" />
              </filter>
            </defs>
            <g
              className={`kg-camera${cameraAnimating ? ' is-animating' : ''}`}
              transform={`translate(${view.x} ${view.y}) scale(${view.k})`}
            >
              {/* Edges first (tree底色 → mesh → proposed), then nodes on top. */}
              {renderedEdges.map((e) => {
                const visual = RELATION_VISUAL[e.relation];
                const color =
                  e.kind === 'tree' ? 'var(--ink-5)' : `var(${visual?.token ?? '--ink-4'})`;
                const dash =
                  e.kind === 'tree'
                    ? '3 5'
                    : e.kind === 'proposed'
                      ? '2 4'
                      : visual?.dashed
                        ? '5 4'
                        : undefined;
                const showArrow = e.kind === 'mesh' && visual?.arrow;
                const faded = isEdgeFaded(e);
                const curve = curvedEdge(e.from, e.to, e.kind);
                return (
                  <g
                    key={e.id}
                    className={`kg-edge kg-edge-${e.kind} rel-${e.relation}${
                      faded ? ' is-faded' : ''
                    }`}
                  >
                    {/* Invisible fat hit-area so thin proposed edges are clickable.
                        Pointer affordance only — the keyboard path to accept/dismiss
                        a proposal is the drawer's EdgeProposalCard (same decision
                        endpoint), so a focusable SVG edge is intentionally omitted. */}
                    {e.kind === 'proposed' && (
                      // biome-ignore lint/a11y/useKeyWithClickEvents: SVG edge pointer affordance; keyboard parity lives in the drawer EdgeProposalCard.
                      <path
                        d={curve.d}
                        className="kg-edge-hit"
                        onClick={(ev) => {
                          ev.stopPropagation();
                          handleProposedTap(e);
                        }}
                      />
                    )}
                    <path
                      d={curve.d}
                      className="kg-edge-line"
                      stroke={color}
                      strokeWidth={e.width}
                      strokeDasharray={dash}
                      markerEnd={showArrow ? `url(#${arrowId}-${e.relation})` : undefined}
                    />
                    {e.kind === 'mesh' && (
                      <text x={curve.apex.x} y={curve.apex.y - 4} className="kg-edge-label mono">
                        {RELATION_GLYPH[e.relation]} {RELATION_LABEL[e.relation] ?? e.relation}
                      </text>
                    )}
                  </g>
                );
              })}

              {renderedNodes.map((n) => {
                const circ = 2 * Math.PI * n.r;
                const selected = n.id === selectedId;
                const shaky = shakyPrereqIds.has(n.id);
                const faded = isFaded(n.id);
                const childCount = childrenByParent.get(n.id)?.length ?? 0;
                const depth = depthByNode.get(n.id) ?? 0;
                const expandable = isInlineExpandable(depth, childCount);
                const isExpanded = childCount > 0 && expandedIds.has(n.id);
                const hiddenKids = childCount > 0 && !isExpanded ? childCount : 0;
                // capped = has hidden children but is too deep + wide to expand inline
                // (>40 children below the top level) — browse it in the drawer instead.
                const capped = hiddenKids > 0 && !expandable;
                return (
                  <g
                    key={n.id}
                    className={`kg-node tone-${n.tone}${selected ? ' is-selected' : ''}${
                      shaky ? ' is-shaky' : ''
                    }${focusId === n.id ? ' is-focus-root' : ''}${faded ? ' is-faded' : ''}`}
                    // Position via CSS transform (not the SVG attribute) so a re-layout
                    // on drill-down EASES to the new spot (transition on .kg-node) instead
                    // of jumping; newly-revealed children still fade in via kg-node-fade.
                    style={{
                      transform: `translate(${n.point.x}px, ${n.point.y}px)`,
                      animationDelay: `${n.fadeDelayMs}ms`,
                    }}
                    tabIndex={0}
                    // biome-ignore lint/a11y/useSemanticElements: SVG <g> cannot be a <button>; role=button + tabIndex + onKeyDown is the correct ARIA for a focusable graph node.
                    role="button"
                    aria-label={
                      hiddenKids === 0
                        ? n.name
                        : capped
                          ? `${n.name}，含 ${childCount} 个子节点，过多，在详情中查看`
                          : `${n.name}，含 ${hiddenKids} 个子节点，可展开`
                    }
                    aria-expanded={childCount > 0 && expandable ? isExpanded : undefined}
                    onClick={(ev) => {
                      ev.stopPropagation();
                      handleNodeTap(n.id);
                    }}
                    onKeyDown={(ev) => {
                      if (ev.key === 'Enter' || ev.key === ' ') {
                        ev.preventDefault();
                        handleNodeTap(n.id);
                      }
                    }}
                  >
                    {/* Coral due halo (overdue > 0) — its own layer behind the disc. */}
                    {n.overdue > 0 && <circle r={n.r + 6} className="kg-node-halo" />}
                    {/* Filled disc (tone fill via class) with drop shadow. */}
                    <circle r={n.r} className="kg-node-disc" filter={`url(#${shadowId})`} />
                    {/* Full track ring under the arc. */}
                    <circle r={n.r} fill="none" className="kg-node-track" />
                    {/* Mastery arc on top — animated stroke-dashoffset. */}
                    <circle
                      r={n.r}
                      fill="none"
                      className="kg-node-arc"
                      stroke={`var(--${n.tone})`}
                      strokeWidth={3.5}
                      strokeLinecap="round"
                      strokeDasharray={circ}
                      strokeDashoffset={circ * (1 - n.masteryPct)}
                      transform="rotate(-90)"
                    />
                    {/* disc-内 掌握度整数 (design mesh-node-pct) — always shown. */}
                    <text y={4} textAnchor="middle" className="kg-node-pct mono">
                      {n.pctLabel}
                    </text>
                    <text y={nodeLabelY(n.r)} textAnchor="middle" className="kg-node-label">
                      {n.name}
                    </text>
                    {/* Hidden-children badge. Expandable → coral "+N" drill affordance;
                        capped (deep + >40) → muted grey count, signalling "too many to
                        expand here, browse in the drawer". The count is in the node's
                        aria-label, so the badge is purely visual (no aria-hidden — that's
                        disallowed on the focusable node group). */}
                    {hiddenKids > 0 && (
                      <g className={`kg-node-badge${capped ? ' is-capped' : ''}`}>
                        <circle
                          cx={n.r * 0.72}
                          cy={-n.r * 0.72}
                          r={10}
                          className="kg-node-badge-bg"
                        />
                        <text
                          x={n.r * 0.72}
                          y={-n.r * 0.72 + 3.5}
                          textAnchor="middle"
                          className="kg-node-badge-t mono"
                        >
                          {capped ? (hiddenKids > 99 ? '99+' : hiddenKids) : `+${hiddenKids}`}
                        </text>
                      </g>
                    )}
                  </g>
                );
              })}
            </g>
          </svg>
        </div>

        {activeProposal && (
          // Slice 3 inline action — accept/dismiss anchored at the proposed edge's
          // midpoint (container px). 改方向/改关系 stay in the drawer.
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
        {(['good', 'hard', 'again'] as const).map((tone) => (
          <span className="item" key={tone}>
            <span className="swatch dot" style={{ background: `var(--${tone})` }} />
            <span>
              {TONE_LABEL[tone]} {toneCounts[tone]}
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
            <span>
              {RELATION_GLYPH[relation]} {relation}
            </span>
          </span>
        ))}
        <span className="kg-legend-section">AI</span>
        <span className="item">
          <span className="swatch proposed" />
          <span>提议关系 {visibleProposals.length}</span>
        </span>
        <span className="kg-legend-note">
          圆 = 节点 · 填色 = 掌握度（绿 / 琥珀 / 红）· 大圆 = 有子节点 · 珊瑚光晕 = 有逾期复习 ·
          点虚线 = AI 提议（点击接受 / 忽略）· 点节点聚焦 · 拖拽 / 双指滚动 = 平移 · 捏合 = 缩放
        </span>
      </div>
    </section>
  );
}

// Node label vertical offset below the disc (mirror design `y={r + 18}`).
function nodeLabelY(r: number): number {
  return r + 18;
}

// Quadratic-bezier edge path with a perpendicular bow so near-parallel / same-row
// edges separate visually instead of stacking into one muddy line (the straight-
// line "边分不开" fix — YUK-297). Tree edges bow gently; mesh edges bow proportional
// to length so long cross-branch links arc clearly across open space. The end
// marker auto-orients to the curve tangent, so arrowheads need no extra math.
// Returns the path `d` plus the on-curve apex (the label anchor).
function curvedEdge(
  from: Point,
  to: Point,
  kind: RenderedEdge['kind'],
): { d: string; apex: Point } {
  const mx = (from.x + to.x) / 2;
  const my = (from.y + to.y) / 2;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  const bow = kind === 'tree' ? 16 : Math.min(72, len * 0.22);
  const cx = mx + (-dy / len) * bow;
  const cy = my + (dx / len) * bow;
  // apex of a quadratic bezier at t=0.5 is the midpoint of (chord-mid, control).
  return {
    d: `M${from.x} ${from.y} Q${cx} ${cy} ${to.x} ${to.y}`,
    apex: { x: (mx + cx) / 2, y: (my + cy) / 2 },
  };
}

export default KnowledgeGraph;
