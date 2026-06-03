'use client';

import { ApiAuthError, apiJson } from '@/ui/lib/api';
// Loom primitives — chrome / banner / states / tree row (redraw slice 3, YUK-169).
import { Badge } from '@/ui/primitives/Badge';
import { Btn } from '@/ui/primitives/Btn';
// Legacy primitives — still consumed by the EdgeCreateForm + cytoscape graph
// territory (slice-3c). The NodeDrawer / edge-proposal cards were migrated to
// loom primitives (Btn / IconBtn / LoomIcon / Badge / Ring) in slice-3b.
import { Button } from '@/ui/primitives/Button';
import { Card } from '@/ui/primitives/Card';
import { EmptyState } from '@/ui/primitives/EmptyState';
import { ErrorState } from '@/ui/primitives/ErrorState';
import { IconBtn } from '@/ui/primitives/IconBtn';
import { LoomCard } from '@/ui/primitives/LoomCard';
import { LoomIcon, type LoomIconName } from '@/ui/primitives/LoomIcon';
import { Ring } from '@/ui/primitives/Ring';
import { SkLines } from '@/ui/primitives/SkLines';
import { Stateful } from '@/ui/primitives/Stateful';
// SuggestionKind type only — used by the EdgeProposalEvent payload shape;
// the SuggestionKindTag component was dropped in the slice-3b card rewrite.
import type { SuggestionKind } from '@/ui/primitives/SuggestionKindTag';
import { useFocusTrap } from '@/ui/primitives/useFocusTrap';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

// cytoscape touches window/document, so the graph primitive must never run
// during SSR/prerender. It already guards itself (cytoscape init lives inside
// useEffect), and we additionally load it ssr:false as a belt-and-suspenders
// boundary so the module never even evaluates on the server.
const KnowledgeGraph = dynamic(
  () => import('@/ui/KnowledgeGraph').then((mod) => mod.KnowledgeGraph),
  {
    ssr: false,
    loading: () => (
      <section className="kg-stage" aria-label="知识关系图">
        <div className="kg-canvas kg-canvas-loading">正在加载关系图...</div>
      </section>
    ),
  },
);

interface KnowledgeNode {
  id: string;
  name: string;
  domain: string | null;
  parent_id: string | null;
  archived_at: string | null;
  effective_domain: string | null;
  mastery: number | null;
  evidence_count: number;
  last_evidence_at: string | null;
  last_active_at: string;
}

interface TreeNode extends KnowledgeNode {
  depth: number;
  children: TreeNode[];
}

interface KnowledgeEdgeRow {
  id: string;
  from_knowledge_id: string;
  to_knowledge_id: string;
  relation_type: RelationType;
  weight: number;
  created_by: unknown;
  reasoning: string | null;
  created_at: string;
  archived_at: string | null;
}

interface KnowledgeProposal {
  id: string;
  payload: {
    mutation: string;
    name?: string;
    parent_id?: string | null;
  };
  reasoning: string;
  status: 'pending' | 'accepted' | 'dismissed' | 'stale';
  proposed_at: string;
}

interface EdgeProposalEvent {
  id: string;
  actor_kind: 'user' | 'agent' | 'cron' | 'system';
  actor_ref: string;
  action: 'propose';
  subject_kind: 'knowledge_edge';
  subject_id: string;
  outcome: 'success' | 'partial';
  payload: {
    from_knowledge_id?: string;
    to_knowledge_id?: string;
    from_id?: string;
    to_id?: string;
    relation_type?: RelationType;
    weight?: number;
    reasoning?: string;
    suggestion_kind?: SuggestionKind;
  };
  task_run_id?: string;
  cost_micro_usd?: number;
}

interface MistakeRow {
  id: string;
  knowledge_ids: string[];
  cause: { primary_category: string } | null;
  created_at: number;
}

// Slice 2 (YUK-142) — per-node FSRS due summary from
// GET /api/knowledge/review-due-summary.
interface ReviewDueSummary {
  now: string;
  due_soon_window_hours: number;
  summary: Record<string, { overdue: number; due_soon: number }>;
}

type RelationType =
  | 'prerequisite'
  | 'related_to'
  | 'contrasts_with'
  | 'applied_in'
  | 'derived_from'
  | `experimental:${string}`;

type ProposalDecision = 'accept' | 'reverse' | 'change_type' | 'dismiss';

const RELATION_TYPES: Record<
  string,
  {
    label: string;
    arrow: string;
    directed: boolean;
    tone: 'coral' | 'neutral' | 'hard' | 'info' | 'good' | 'contrasts';
  }
> = {
  prerequisite: { label: '前置', arrow: '→', directed: true, tone: 'coral' },
  related_to: { label: '相关', arrow: '↔', directed: false, tone: 'neutral' },
  contrasts_with: { label: '对照', arrow: '⇆', directed: false, tone: 'contrasts' },
  applied_in: { label: '应用于', arrow: '→', directed: true, tone: 'info' },
  derived_from: { label: '派生自', arrow: '↳', directed: true, tone: 'good' },
};

const RELATION_ORDER = Object.keys(RELATION_TYPES);

export default function KnowledgePage() {
  const queryClient = useQueryClient();
  const router = useRouter();
  const [view, setView] = useState<'tree' | 'graph'>('tree');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [edgeProposalStatus, setEdgeProposalStatus] = useState<Record<string, ProposalDecision>>(
    {},
  );
  // NodeDrawer focus trap (slice-3b) — Tab containment + Esc-to-close + focus
  // restore for the CSS-class `.drawer`. Declared at the top level so the hook
  // runs unconditionally; gated on `!!selectedId` (open) below.
  const drawerRef = useRef<HTMLElement | null>(null);

  const knowledgeQ = useQuery({
    queryKey: ['knowledge'],
    queryFn: () => apiJson<{ rows: KnowledgeNode[] }>('/api/knowledge'),
  });
  const edgesQ = useQuery({
    queryKey: ['knowledge-edges'],
    queryFn: () => apiJson<{ rows: KnowledgeEdgeRow[] }>('/api/knowledge/edges'),
  });
  const proposalsQ = useQuery({
    queryKey: ['knowledge-proposals', 'pending'],
    queryFn: () =>
      apiJson<{ rows: KnowledgeProposal[] }>('/api/knowledge/proposals?status=pending'),
  });
  const edgeProposalsQ = useQuery({
    queryKey: ['knowledge-edge-proposals'],
    queryFn: () =>
      apiJson<{ rows: EdgeProposalEvent[] }>(
        '/api/events?action=propose&subject_kind=knowledge_edge&limit=100',
      ),
  });
  const mistakesQ = useQuery({
    queryKey: ['knowledge-mistakes'],
    queryFn: () => apiJson<{ rows: MistakeRow[] }>('/api/mistakes?limit=200'),
  });
  const reviewDueQ = useQuery({
    queryKey: ['knowledge-review-due-summary'],
    queryFn: () => apiJson<ReviewDueSummary>('/api/knowledge/review-due-summary'),
  });

  const proposalDecision = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: 'accept' | 'reject' }) =>
      apiJson(`/api/knowledge/proposals/${id}`, {
        method: 'POST',
        body: JSON.stringify({ decision }),
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['knowledge'] }),
        queryClient.invalidateQueries({ queryKey: ['knowledge-proposals', 'pending'] }),
      ]);
    },
  });

  // Phase 1c.2 — wire knowledge_edge proposal decisions through to the server.
  // Pre-1c.2 this was local state only; now decisions write rate + (for accept)
  // generate events and insert the actual knowledge_edge row, so subsequent
  // page loads remember what the user decided.
  const edgeProposalDecision = useMutation({
    mutationFn: ({
      id,
      decision,
      new_relation_type,
    }: {
      id: string;
      decision: ProposalDecision;
      new_relation_type?: RelationType;
    }) =>
      apiJson(`/api/knowledge/edges/proposals/${id}`, {
        method: 'POST',
        body: JSON.stringify({
          decision,
          ...(new_relation_type ? { new_relation_type } : {}),
        }),
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['knowledge-edges'] }),
        queryClient.invalidateQueries({ queryKey: ['knowledge-edge-proposals'] }),
      ]);
    },
  });

  const nodes = knowledgeQ.data?.rows ?? [];
  const edges = edgesQ.data?.rows ?? [];
  const nodeProposals = proposalsQ.data?.rows ?? [];
  // Stable identity for the pending (not-yet-decided) edge proposal set.
  // Computing `.filter(...)` inline produced a fresh array every KnowledgePage
  // render, which cascaded into graphProposals / edgeProposalsByNode /
  // handleGraphProposalDecision (all keyed on this) changing identity every
  // render — re-running KnowledgeGraph's build effect (which lists
  // visibleProposals + proposalMetaById in its deps), re-initializing cytoscape
  // with the randomized fcose layout and re-scattering the graph + discarding
  // manual drag positions on every selection click. Memoizing on the real
  // inputs (the fetched rows + the optimistic decision map) keeps it steady
  // across selection re-renders — same discipline as activeEdges below.
  const pendingEdgeProposals = useMemo(
    () =>
      (edgeProposalsQ.data?.rows ?? []).filter(
        (p) => edgeProposalStatus[edgeProposalKey(p)] === undefined,
      ),
    [edgeProposalsQ.data, edgeProposalStatus],
  );
  const mistakes = mistakesQ.data?.rows ?? [];

  const { roots, flattened, byId, childrenByParent } = useMemo(() => buildTree(nodes), [nodes]);
  const selected = selectedId ? (byId.get(selectedId) ?? null) : null;
  // Stable onClose so useFocusTrap's effect deps don't churn on every render
  // (an inline arrow is a fresh ref each render → background refetch / mutation /
  // state update would tear down + rebuild the trap, kicking focus back to the
  // trigger). Reused for the scrim onClick + close IconBtn for consistency.
  const closeDrawer = useCallback(() => setSelectedId(null), []);
  useFocusTrap(!!selected, closeDrawer, drawerRef);
  // Switching nodes inside the open drawer (parent/child/typed-relation row)
  // changes selectedId but keeps the drawer mounted; the previously-focused
  // button unmounts and focus falls outside the dialog. Re-focus the first
  // tabbable element inside the drawer whenever the selected node changes.
  // selected?.id is the trigger — re-focus only on node switch, not on every
  // `selected` object identity change (which would refire on unrelated re-renders).
  // biome-ignore lint/correctness/useExhaustiveDependencies: selected?.id is the node-switch trigger
  useEffect(() => {
    if (!selected || !drawerRef.current) return;
    const first = drawerRef.current.querySelector<HTMLElement>(
      'button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
    );
    first?.focus();
  }, [selected?.id]);

  const mistakeCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const m of mistakes) {
      for (const id of m.knowledge_ids ?? []) {
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
    }
    return counts;
  }, [mistakes]);

  const dueCounts = useMemo(() => {
    const counts = new Map<string, { overdue: number; due_soon: number }>();
    const summary = reviewDueQ.data?.summary;
    if (summary) {
      for (const [id, v] of Object.entries(summary)) counts.set(id, v);
    }
    return counts;
  }, [reviewDueQ.data]);

  // Stable identity for the active (non-archived) edge set fed to KnowledgeGraph.
  // Computing `edges.filter(...)` inline in JSX produced a fresh array every
  // KnowledgePage render, and KnowledgeGraph's build effect deps include the
  // edges prop — so a selection click (onNodeClick → setSelectedId → re-render)
  // would re-init cytoscape and re-run the randomized fcose layout, re-scattering
  // the graph and discarding manual node-drag positions. Memoizing here keeps the
  // prop reference steady across selection re-renders so only the dedicated
  // [selectedId] effect reacts to selection. (`nodes`/`mistakeCounts` are already
  // memoized above; `dueCounts` has its own stable empty-Map fallback inside
  // KnowledgeGraph.)
  const activeEdges = useMemo(() => edges.filter((edge) => edge.archived_at === null), [edges]);

  // Tree-row edge count, precomputed once per edges change. The tree render
  // previously did `edges.filter(...)` inside each node row (O(nodes × edges) per
  // render — ~6e4 ops for 200 nodes × 300 edges); build a per-node count Map in a
  // single pass so the row lookup is O(1). An undirected edge touching the same
  // node on both endpoints (self-loop) is counted once, matching the old
  // `||`-filter (the filter kept the edge once regardless of which endpoint hit).
  const edgeCountByNode = useMemo(() => {
    const counts = new Map<string, number>();
    for (const edge of activeEdges) {
      const { from_knowledge_id: from, to_knowledge_id: to } = edge;
      counts.set(from, (counts.get(from) ?? 0) + 1);
      if (to !== from) counts.set(to, (counts.get(to) ?? 0) + 1);
    }
    return counts;
  }, [activeEdges]);

  // Slice 3 ("AI 画布") — normalize pending edge proposals into the KnowledgeGraph
  // proposed-edge shape. Same stable-ref discipline as activeEdges: KnowledgeGraph
  // includes `proposals` in its rebuild-effect deps, so an inline array literal
  // here would re-init cytoscape (re-running the randomized fcose layout +
  // discarding manual drag positions) on every KnowledgePage re-render. Memoize so
  // the prop reference only changes when the pending set actually changes. We
  // forward only proposals with both endpoints resolved (the graph guards on
  // visibility too, but skipping endpoint-less ones keeps the array clean). `key`
  // is the page's dedupe key so optimistic "already decided" hiding lines up.
  const graphProposals = useMemo(
    () =>
      pendingEdgeProposals.flatMap((p) => {
        const from = edgeProposalFrom(p);
        const to = edgeProposalTo(p);
        const relation = p.payload.relation_type;
        if (!from || !to || !relation) return [];
        return [
          {
            id: p.id,
            key: edgeProposalKey(p),
            from_knowledge_id: from,
            to_knowledge_id: to,
            relation_type: relation,
          },
        ];
      }),
    [pendingEdgeProposals],
  );

  // Inline graph decision — reuse the EXACT path the drawer's EdgeProposalCard
  // uses: optimistically mark the proposal decided (so it vanishes from the
  // pending set immediately) and fire edgeProposalDecision, which POSTs to
  // /api/knowledge/edges/proposals/[id] and invalidates the edges + proposals
  // queries on success. accept → server inserts the real knowledge_edge, which
  // reappears as a solid mesh edge after refetch; dismiss → just gone. The graph
  // only surfaces accept/dismiss inline (改方向/改关系 stay in the drawer).
  const handleGraphProposalDecision = useCallback(
    (proposalId: string, decision: 'accept' | 'dismiss') => {
      const event = pendingEdgeProposals.find((p) => p.id === proposalId);
      if (!event) return;
      setEdgeProposalStatus((current) => ({
        ...current,
        [edgeProposalKey(event)]: decision,
      }));
      edgeProposalDecision.mutate({ id: proposalId, decision });
    },
    [pendingEdgeProposals, edgeProposalDecision],
  );

  const proposalsByParent = useMemo(() => {
    const grouped = new Map<string | null, KnowledgeProposal[]>();
    for (const p of nodeProposals) {
      const parent = p.payload.parent_id ?? null;
      grouped.set(parent, [...(grouped.get(parent) ?? []), p]);
    }
    return grouped;
  }, [nodeProposals]);

  const edgeProposalsByNode = useMemo(() => {
    const grouped = new Map<string, EdgeProposalEvent[]>();
    for (const p of pendingEdgeProposals) {
      const from = edgeProposalFrom(p);
      const to = edgeProposalTo(p);
      if (from) grouped.set(from, [...(grouped.get(from) ?? []), p]);
      if (to) grouped.set(to, [...(grouped.get(to) ?? []), p]);
    }
    return grouped;
  }, [pendingEdgeProposals]);

  const selectedEdges = selectedId
    ? edges.filter(
        (edge) =>
          edge.archived_at === null &&
          (edge.from_knowledge_id === selectedId || edge.to_knowledge_id === selectedId),
      )
    : [];
  const selectedPendingEdges = selectedId ? (edgeProposalsByNode.get(selectedId) ?? []) : [];
  const selectedNodeProposals = selectedId ? (proposalsByParent.get(selectedId) ?? []) : [];
  const selectedActivity = selectedId
    ? buildNodeActivity({
        nodeId: selectedId,
        mistakes,
        nodeProposals: selectedNodeProposals,
        edgeProposals: selectedPendingEdges,
        edges: selectedEdges,
      })
    : [];

  const optionalDataError =
    edgesQ.error ?? proposalsQ.error ?? edgeProposalsQ.error ?? mistakesQ.error ?? reviewDueQ.error;

  const createEdgeM = useMutation({
    mutationFn: (vars: {
      from_knowledge_id: string;
      to_knowledge_id: string;
      relation_type: RelationType;
      reasoning?: string;
    }) =>
      apiJson('/api/knowledge/edges', {
        method: 'POST',
        body: JSON.stringify({
          ...vars,
          // created_by accepts the literal 'user' (per AgentRefLike on the
          // server) or any non-empty agent ref string — not an object.
          created_by: 'user',
          reasoning: vars.reasoning ?? null,
        }),
      }),
    onSuccess: () => {
      setShowEdgeCreate(false);
      queryClient.invalidateQueries({ queryKey: ['knowledge-edges'] });
    },
  });
  const [showEdgeCreate, setShowEdgeCreate] = useState(false);

  return (
    <main className="knowledge-page knowledge-loom">
      {/* loom chrome — eyebrow / serif title / tree·graph seg / CTA / lead.
          Scoped under .knowledge-loom so the loom .page-head / .eyebrow /
          .page-title / .seg rules apply without touching the legacy globals
          (pre-flight §5). */}
      <div className="page-head">
        <div className="eyebrow">
          KNOWLEDGE · {nodes.length} nodes · {edges.length} edges (mesh)
        </div>
        <div className="page-head-row">
          <h1 className="page-title serif">知识</h1>
          <div className="hero-cta">
            <div className="seg" aria-label="知识视图切换">
              <button
                type="button"
                aria-pressed={view === 'tree'}
                className={view === 'tree' ? 'on' : ''}
                onClick={() => setView('tree')}
              >
                <LoomIcon name="tree" size={15} />树
              </button>
              <button
                type="button"
                aria-pressed={view === 'graph'}
                className={view === 'graph' ? 'on' : ''}
                onClick={() => setView('graph')}
              >
                <LoomIcon name="graph" size={15} />
                Graph
              </button>
            </div>
            {/* CTA keeps its real behaviour (toggle edge-create form, slice-3b
                territory) — loom-ified to Btn, real label, no fake「新建节点」
                wiring (pre-flight §4). */}
            <Btn variant="primary" icon="plus" onClick={() => setShowEdgeCreate((v) => !v)}>
              {showEdgeCreate ? '取消' : '新建关系'}
            </Btn>
          </div>
        </div>
        <p className="page-lead">
          树是骨架（parent/child），mesh 是 5 类 typed 关系。点节点看详情抽屉；图可平移缩放。
        </p>
      </div>

      {showEdgeCreate && (
        <Card pad="lg" style={{ marginBottom: 'var(--s-4)' }}>
          <EdgeCreateForm
            nodes={nodes}
            onSubmit={(vars) => createEdgeM.mutate(vars)}
            pending={createEdgeM.isPending}
            error={createEdgeM.error as Error | null}
          />
        </Card>
      )}

      {/* hard error — knowledge list itself failed (ApiAuthError-aware). The
          loom ErrorState replaces the legacy LoadError Card. */}
      {knowledgeQ.error && (
        <ErrorState
          text={
            knowledgeQ.error instanceof ApiAuthError
              ? `${knowledgeQ.error.message} — 请重新进入页面输入 token`
              : `知识图加载失败：${(knowledgeQ.error as Error).message}`
          }
          onRetry={() => knowledgeQ.refetch()}
        />
      )}

      {/* optional-data degradation — tree loaded but mesh / proposals / activity
          are unavailable. Compact loom ErrorState, ApiAuthError-aware. */}
      {knowledgeQ.isSuccess && optionalDataError && (
        <ErrorState
          compact
          text={
            optionalDataError instanceof ApiAuthError
              ? `tree 已加载；mesh / AI 提议 / 活动数据需要重新输入 token：${optionalDataError.message}`
              : `tree 已加载；mesh / AI 提议 / 活动数据暂时不可用：${(optionalDataError as Error).message}`
          }
        />
      )}

      {/* AI relation-proposals banner — loom sunk LoomCard, routes to /inbox for
          central review (pre-flight: legacy opened a drawer, loom → /inbox). */}
      {pendingEdgeProposals.length > 0 && (
        <LoomCard
          pad
          sunk
          style={{
            marginBottom: 'var(--s-5)',
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--s-4)',
            flexWrap: 'wrap',
            borderColor: 'var(--coral-line)',
          }}
        >
          <span className="card-icon accent">
            <LoomIcon name="link" size={18} />
          </span>
          <div style={{ flex: 1, minWidth: 180 }}>
            <div style={{ fontWeight: 500 }}>AI 提议了 {pendingEdgeProposals.length} 条新关系</div>
            <div className="meta">
              来自 Dreaming / Maintenance · 在收件箱集中接受 / 改方向 / 改关系 / 忽略
            </div>
          </div>
          <Btn variant="secondary" size="sm" iconEnd="arrow" onClick={() => router.push('/inbox')}>
            集中审批
          </Btn>
        </LoomCard>
      )}

      {/* tree view — loom .know-node rows inside Stateful (loading / empty /
          error / ok). The graph branch is rendered as a sibling below and keeps
          cytoscape untouched (slice-3b). */}
      {/* Hard error is owned by the top-level ErrorState above; gate the tree
          Stateful out of the error case so it doesn't stack a second error. */}
      {view === 'tree' && !knowledgeQ.error && (
        <Stateful
          status={
            knowledgeQ.isLoading
              ? 'loading'
              : knowledgeQ.isSuccess && roots.length === 0
                ? 'empty'
                : 'ok'
          }
          skeleton={
            <LoomCard pad>
              <SkLines rows={5} />
            </LoomCard>
          }
          empty={
            <EmptyState
              icon="knowledge"
              title="知识网为空"
              text="录入材料后，AI 会从中抽取节点并提议关系。"
            />
          }
        >
          <LoomCard>
            {flattened.map((node) => {
              const nodeMistakes = mistakeCounts.get(node.id) ?? 0;
              const meshCount = edgeCountByNode.get(node.id) ?? 0;
              // Mastery evidence-guard (pre-flight §4 / mirrors MasteryBadge):
              // a ring % is misleading below 3 evidence, so render a muted
              // neutral indicator instead of a colored ring; 0 evidence is the
              // untrained state. Only ≥3 evidence shows the real Ring.
              const masteryPct = Math.round((node.mastery ?? 0) * 100);
              const lowEvidence = node.evidence_count < 3;
              return (
                <button
                  key={node.id}
                  type="button"
                  className="know-node"
                  style={{
                    paddingLeft: `calc(var(--s-5) + ${node.depth * 22}px)`,
                    width: '100%',
                    textAlign: 'left',
                    border: 0,
                    background: 'transparent',
                  }}
                  onClick={() => setSelectedId(node.id)}
                >
                  {node.depth > 0 && <span className="know-twig">└</span>}
                  {lowEvidence ? (
                    <span
                      className="mastery mastery-low-evidence"
                      title={
                        node.evidence_count === 0
                          ? 'evidence_count=0 · 尚无 attempt / review event'
                          : `evidence_count<3 · 暂不展示稳定掌握度 · n=${node.evidence_count}`
                      }
                      style={{ flex: 'none' }}
                    >
                      <LoomIcon name="target" size={12} />
                      {node.evidence_count === 0 ? '未练习' : `n=${node.evidence_count}`}
                    </span>
                  ) : (
                    // Ring primitive is fixed 84px; scale the wrapper to ~30px
                    // to fit the compact tree row (loom MasteryRing size=30).
                    <span
                      style={{
                        flex: 'none',
                        width: 30,
                        height: 30,
                        display: 'inline-flex',
                      }}
                    >
                      <span
                        style={{
                          transform: 'scale(0.357)',
                          transformOrigin: 'top left',
                        }}
                      >
                        <Ring percent={masteryPct} />
                      </span>
                    </span>
                  )}
                  <span className="know-title wenyan">{node.name}</span>
                  <span className="chip chip-k mono">{node.id.slice(0, 8)}</span>
                  <div className="know-end">
                    <span className="meta mono">{node.evidence_count} ev</span>
                    {nodeMistakes > 0 && <Badge tone="again">{nodeMistakes} 错</Badge>}
                    {meshCount > 0 && (
                      <Badge tone="info">
                        <LoomIcon name="link" size={11} />
                        {meshCount}
                      </Badge>
                    )}
                    <LoomIcon name="arrow" size={15} className="thread-arrow" />
                  </div>
                </button>
              );
            })}
          </LoomCard>
        </Stateful>
      )}

      {knowledgeQ.isSuccess && roots.length > 0 && view === 'graph' && (
        <KnowledgeGraph
          nodes={flattened}
          edges={activeEdges}
          selectedId={selectedId}
          onNodeClick={setSelectedId}
          mistakeCounts={mistakeCounts}
          dueCounts={dueCounts}
          proposals={graphProposals}
          onProposalDecision={handleGraphProposalDecision}
        />
      )}

      {/* NodeDrawer — loom .drawer/.scrim pattern (slice-3b). scrim + focus trap
          (declared above) replace the legacy .detail-drawer. All selection data
          (selectedEdges / selectedPendingEdges / selectedNodeProposals /
          selectedActivity) and the edge/node proposal mutations are unchanged. */}
      {selected && (
        <button type="button" className="scrim open" onClick={closeDrawer} aria-label="关闭" />
      )}
      <aside
        ref={drawerRef}
        // biome-ignore lint/a11y/useSemanticElements: CSS-class-driven drawer (.open
        // toggle + custom useFocusTrap), not a native <dialog>; role="dialog" +
        // aria-modal is the correct ARIA for this modal pattern (same as slice-1/2).
        role="dialog"
        aria-modal
        aria-label={selected?.name}
        aria-hidden={!selected}
        className={`drawer${selected ? ' open' : ''}`}
      >
        {selected && (
          <>
            <div className="drawer-head">
              <NodeRing node={selected} size={40} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="drawer-title serif">{selected.name}</div>
                <div className="meta mono">{selected.id.slice(0, 8)}</div>
              </div>
              <IconBtn icon="close" size={16} onClick={closeDrawer} aria-label="关闭" />
            </div>

            <div className="drawer-body">
              {/* node metrics — 3-up: 掌握度 / evidence / 关系 (mesh count).
                  The loom decay cell has no FSRS backing here → replaced with the
                  real mesh edge count (pre-flight §4). */}
              <div className="node-metrics">
                <div className="nm">
                  {/* Mirror NodeRing's evidence guard (pre-flight §4): a mastery %
                      is misleading below 3 evidence, so show the untrained /
                      low-evidence state instead of a misleading "0%". */}
                  <div className="nm-n serif">
                    {selected.evidence_count === 0
                      ? '未练习'
                      : selected.evidence_count < 3
                        ? '证据不足'
                        : `${Math.round((selected.mastery ?? 0) * 100)}%`}
                  </div>
                  <div className="nm-l meta">掌握度</div>
                </div>
                <div className="nm">
                  <div className="nm-n serif">{selected.evidence_count}</div>
                  <div className="nm-l meta">evidence</div>
                </div>
                <div className="nm">
                  <div className="nm-n serif">{edgeCountByNode.get(selected.id) ?? 0}</div>
                  <div className="nm-l meta">关系</div>
                </div>
              </div>

              {/* hierarchy block — parent / children (parent_id + childrenByParent) */}
              <div className="drawer-sec">
                <div className="drawer-sec-h">
                  <LoomIcon name="tree" size={14} />
                  层级 hierarchy
                </div>
                {selected.parent_id && byId.get(selected.parent_id) ? (
                  <button
                    type="button"
                    className="rel-row"
                    onClick={() => {
                      const parent = byId.get(selected.parent_id ?? '');
                      if (parent) setSelectedId(parent.id);
                    }}
                  >
                    <span className="rel-kind mono">parent</span>
                    <span className="wenyan">{byId.get(selected.parent_id)?.name}</span>
                    <LoomIcon name="arrow" size={13} className="thread-arrow" />
                  </button>
                ) : (
                  <div className="quiet-empty">根节点（无父）</div>
                )}
                {(childrenByParent.get(selected.id) ?? []).map((child) => (
                  <button
                    type="button"
                    key={child.id}
                    className="rel-row indent"
                    onClick={() => setSelectedId(child.id)}
                  >
                    <span className="rel-kind mono">child</span>
                    <span className="wenyan">{child.name}</span>
                    <NodeRing node={child} size={24} />
                  </button>
                ))}
              </div>

              {/* typed relations block — mesh edges grouped by RELATION_ORDER */}
              <div className="drawer-sec">
                <div className="drawer-sec-h">
                  <LoomIcon name="link" size={14} />
                  关系 typed edges
                </div>
                {selectedEdges.length === 0 && <div className="quiet-empty">暂无 typed 关系。</div>}
                {RELATION_ORDER.flatMap((relationType) =>
                  selectedEdges
                    .filter((edge) => edge.relation_type === relationType)
                    .map((edge) => (
                      <KnowledgeRelation
                        key={edge.id}
                        edge={edge}
                        currentNodeId={selected.id}
                        nodesById={byId}
                        onNavigate={setSelectedId}
                      />
                    )),
                )}
              </div>

              {/* AI edge proposals — accept / reverse / change-type / dismiss */}
              {selectedPendingEdges.length > 0 && (
                <div className="drawer-sec">
                  <div className="drawer-sec-h">
                    <LoomIcon name="sparkle" size={14} />
                    AI 提议的边 · {selectedPendingEdges.length}
                  </div>
                  {selectedPendingEdges.map((event) => (
                    <EdgeProposalCard
                      key={edgeProposalKey(event)}
                      event={event}
                      nodesById={byId}
                      status={edgeProposalStatus[edgeProposalKey(event)]}
                      pending={edgeProposalDecision.isPending}
                      onDecision={(decision, new_relation_type) => {
                        setEdgeProposalStatus((current) => ({
                          ...current,
                          [edgeProposalKey(event)]: decision,
                        }));
                        edgeProposalDecision.mutate({
                          id: event.id,
                          decision,
                          new_relation_type,
                        });
                      }}
                    />
                  ))}
                </div>
              )}

              {/* AI child-node proposals — loom omits this, but it is fully wired
                  (proposalDecision) and useful, so kept as an extra section. */}
              {selectedNodeProposals.length > 0 && (
                <div className="drawer-sec">
                  <div className="drawer-sec-h">
                    <LoomIcon name="sparkle" size={14} />
                    AI 建议子节点 · {selectedNodeProposals.length}
                  </div>
                  {selectedNodeProposals.map((proposal) => (
                    <div className="edge-prop" key={proposal.id}>
                      <div className="edge-prop-head">
                        <Badge tone="info">
                          <LoomIcon name="sparkle" size={11} />
                          AI · 新节点
                        </Badge>
                        <span className="wenyan">{proposal.payload.name ?? '未命名节点'}</span>
                      </div>
                      <div className="meta" style={{ marginBottom: 'var(--s-2)' }}>
                        {proposal.reasoning}
                      </div>
                      <div className="edge-prop-acts">
                        <Btn
                          variant="good"
                          size="sm"
                          icon="check"
                          disabled={proposalDecision.isPending}
                          onClick={() =>
                            proposalDecision.mutate({ id: proposal.id, decision: 'accept' })
                          }
                        >
                          接受
                        </Btn>
                        <Btn
                          variant="ghost"
                          size="sm"
                          icon="close"
                          disabled={proposalDecision.isPending}
                          onClick={() =>
                            proposalDecision.mutate({ id: proposal.id, decision: 'reject' })
                          }
                        >
                          忽略
                        </Btn>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* recent activity — loom keeps this on the detail page; kept here as
                  an extra section (buildNodeActivity / selectedActivity unchanged). */}
              <div className="drawer-sec">
                <div className="drawer-sec-h">
                  <LoomIcon name="history" size={14} />
                  近活动 · {selectedActivity.length}
                </div>
                {selectedActivity.length === 0 && <div className="quiet-empty">无近期事件</div>}
                {selectedActivity.map((row) => (
                  <div className="rel-row" key={row.id} style={{ cursor: 'default' }}>
                    <ActorPill actor={row.actor} />
                    <span className="wenyan">{row.label}</span>
                    <span className="meta mono" style={{ marginLeft: 'auto', flex: 'none' }}>
                      {row.meta}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <div className="drawer-foot">
              <Btn
                variant="primary"
                block
                iconEnd="arrow"
                onClick={() => router.push(`/knowledge/${selected.id}`)}
              >
                打开节点详情页
              </Btn>
            </div>
          </>
        )}
      </aside>
    </main>
  );
}

function buildTree(nodes: KnowledgeNode[]) {
  const byId = new Map<string, TreeNode>();
  for (const node of nodes) {
    byId.set(node.id, { ...node, depth: 0, children: [] });
  }

  const roots: TreeNode[] = [];
  const childrenByParent = new Map<string, TreeNode[]>();
  for (const node of byId.values()) {
    if (node.parent_id && byId.has(node.parent_id)) {
      const parent = byId.get(node.parent_id);
      parent?.children.push(node);
      childrenByParent.set(node.parent_id, [...(childrenByParent.get(node.parent_id) ?? []), node]);
    } else {
      roots.push(node);
    }
  }

  const sortByName = (a: TreeNode, b: TreeNode) => a.name.localeCompare(b.name, 'zh-Hans-CN');
  const visit = (node: TreeNode, depth: number, out: TreeNode[]) => {
    node.depth = depth;
    node.children.sort(sortByName);
    out.push(node);
    for (const child of node.children) visit(child, depth + 1, out);
  };

  roots.sort(sortByName);
  for (const list of childrenByParent.values()) list.sort(sortByName);

  const flattened: TreeNode[] = [];
  for (const root of roots) visit(root, 0, flattened);

  return { roots, flattened, byId, childrenByParent };
}

function edgeProposalFrom(event: EdgeProposalEvent): string | undefined {
  return event.payload.from_knowledge_id ?? event.payload.from_id;
}

function edgeProposalTo(event: EdgeProposalEvent): string | undefined {
  return event.payload.to_knowledge_id ?? event.payload.to_id;
}

function edgeProposalKey(event: EdgeProposalEvent): string {
  return [
    event.subject_id,
    edgeProposalFrom(event),
    edgeProposalTo(event),
    event.payload.relation_type,
    event.actor_ref,
  ]
    .filter(Boolean)
    .join(':');
}

function relationMeta(type: string | undefined) {
  return type
    ? (RELATION_TYPES[type] ?? relationMetaForExperimental(type))
    : relationMetaForExperimental('related');
}

function relationMetaForExperimental(type: string) {
  return {
    label: type.startsWith('experimental:') ? type.replace('experimental:', '') : type,
    arrow: '→',
    directed: true,
    tone: 'neutral' as const,
  };
}

function nodeName(nodesById: Map<string, TreeNode>, id: string | undefined): string {
  if (!id) return 'unknown';
  return nodesById.get(id)?.name ?? id;
}

function buildNodeActivity({
  nodeId,
  mistakes,
  nodeProposals,
  edgeProposals,
  edges,
}: {
  nodeId: string;
  mistakes: MistakeRow[];
  nodeProposals: KnowledgeProposal[];
  edgeProposals: EdgeProposalEvent[];
  edges: KnowledgeEdgeRow[];
}) {
  const activity = [];
  for (const m of mistakes.filter((row) => row.knowledge_ids.includes(nodeId)).slice(0, 3)) {
    activity.push({
      id: `mistake-${m.id}`,
      actor: m.cause ? 'agent' : 'user',
      label: m.cause ? '错题归因' : '错题记录',
      meta: relDate(m.created_at),
      detail: m.cause ? `cause=${m.cause.primary_category}` : '等待 AI 归因',
    });
  }
  for (const edge of edgeProposals.slice(0, 3)) {
    const meta = relationMeta(edge.payload.relation_type);
    activity.push({
      id: `edge-proposal-${edgeProposalKey(edge)}`,
      actor: 'agent',
      label: '关系提议',
      meta: edge.actor_ref,
      detail: `${meta.label} · ${edge.payload.reasoning ?? '等待审阅'}`,
    });
  }
  for (const proposal of nodeProposals.slice(0, 3)) {
    activity.push({
      id: `node-proposal-${proposal.id}`,
      actor: 'agent',
      label: '子节点提议',
      meta: relDate(proposal.proposed_at),
      detail: proposal.reasoning,
    });
  }
  for (const edge of edges.slice(0, 3)) {
    const meta = relationMeta(edge.relation_type);
    activity.push({
      id: `edge-${edge.id}`,
      actor: createdByActor(edge.created_by),
      label: 'mesh 关系',
      meta: meta.label,
      detail: edge.reasoning ?? `${edge.from_knowledge_id} ${meta.arrow} ${edge.to_knowledge_id}`,
    });
  }
  return activity.slice(0, 8);
}

function relDate(value: string | number): string {
  const date =
    typeof value === 'number'
      ? new Date(value < 10_000_000_000 ? value * 1000 : value)
      : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const deltaMs = Date.now() - date.getTime();
  const minutes = Math.max(1, Math.round(deltaMs / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function createdByActor(value: unknown): 'user' | 'agent' | 'system' {
  if (value === 'user') return 'user';
  if (typeof value === 'object' && value !== null && 'actor_kind' in value) {
    const actor = (value as { actor_kind?: unknown }).actor_kind;
    if (actor === 'agent') return 'agent';
    if (actor === 'user') return 'user';
  }
  return 'system';
}

// NodeRing — loom MasteryRing for the drawer, sharing the tree's evidence-guard
// (pre-flight §4): a ring % is misleading below 3 evidence, so render a muted
// neutral chip instead of a colored ring; 0 evidence is the untrained state.
// The Ring primitive is fixed 84px, so scale the wrapper to the requested size.
function NodeRing({
  node,
  size,
}: {
  node: Pick<KnowledgeNode, 'mastery' | 'evidence_count'>;
  size: number;
}) {
  if (node.evidence_count < 3) {
    return (
      <span
        className="mastery mastery-low-evidence"
        title={
          node.evidence_count === 0
            ? 'evidence_count=0 · 尚无 attempt / review event'
            : `evidence_count<3 · 暂不展示稳定掌握度 · n=${node.evidence_count}`
        }
        style={{ flex: 'none' }}
      >
        <LoomIcon name="target" size={12} />
        {node.evidence_count === 0 ? '未练习' : `n=${node.evidence_count}`}
      </span>
    );
  }
  const masteryPct = Math.round((node.mastery ?? 0) * 100);
  return (
    <span
      style={{
        flex: 'none',
        width: size,
        height: size,
        display: 'inline-flex',
      }}
    >
      <span style={{ transform: `scale(${size / 84})`, transformOrigin: 'top left' }}>
        <Ring percent={masteryPct} />
      </span>
    </span>
  );
}

// ActorPill — loom mono actor chip (replaces the legacy .actor-pill). LoomIcon by
// actor: agent→sparkle, user→record (the loom icon set has no person glyph;
// `record` is its user-input/capture mark — the closest human-action cue), else→moon.
function ActorPill({ actor }: { actor: 'user' | 'agent' | 'system' | string }) {
  const icon: LoomIconName = actor === 'agent' ? 'sparkle' : actor === 'user' ? 'record' : 'moon';
  const label = actor === 'agent' ? 'AI' : actor === 'user' ? '用户' : 'system';
  return (
    <span
      className="rel-kind mono"
      style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
    >
      <LoomIcon name={icon} size={11} />
      {label}
    </span>
  );
}

function KnowledgeRelation({
  edge,
  currentNodeId,
  nodesById,
  onNavigate,
}: {
  edge: KnowledgeEdgeRow;
  currentNodeId: string;
  nodesById: Map<string, TreeNode>;
  onNavigate: (id: string) => void;
}) {
  const meta = relationMeta(edge.relation_type);
  const isFromHere = edge.from_knowledge_id === currentNodeId;
  const otherId = isFromHere ? edge.to_knowledge_id : edge.from_knowledge_id;
  const arrow = meta.directed ? (isFromHere ? '→' : '←') : meta.arrow;
  return (
    <button type="button" className="rel-row" onClick={() => onNavigate(otherId)}>
      <span className={`rel-tag rel-tag-${edge.relation_type}`}>
        <span className="mono">{arrow}</span>
        {meta.label}
      </span>
      <span className="wenyan">{nodeName(nodesById, otherId)}</span>
      <LoomIcon name="arrow" size={13} className="thread-arrow" />
    </button>
  );
}

function EdgeCreateForm({
  nodes,
  onSubmit,
  pending,
  error,
}: {
  nodes: KnowledgeNode[];
  onSubmit: (vars: {
    from_knowledge_id: string;
    to_knowledge_id: string;
    relation_type: RelationType;
    reasoning?: string;
  }) => void;
  pending: boolean;
  error: Error | null;
}) {
  const [fromId, setFromId] = useState<string>('');
  const [toId, setToId] = useState<string>('');
  const [relation, setRelation] = useState<RelationType>('related_to');
  const [reasoning, setReasoning] = useState('');
  const sortedNodes = useMemo(
    () => [...nodes].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN')),
    [nodes],
  );
  const canSubmit = fromId && toId && fromId !== toId && !pending;
  return (
    <div>
      <h4 className="kf-title">新建知识关系</h4>
      <div className="kf-row">
        <label className="kf-label">
          From
          <select value={fromId} onChange={(e) => setFromId(e.target.value)} className="kf-select">
            <option value="">—</option>
            {sortedNodes.map((n) => (
              <option key={n.id} value={n.id}>
                {n.name}
              </option>
            ))}
          </select>
        </label>
        <label className="kf-label">
          关系
          <select
            value={relation}
            onChange={(e) => setRelation(e.target.value as RelationType)}
            className="kf-select"
          >
            {Object.entries(RELATION_TYPES).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label} ({k})
              </option>
            ))}
          </select>
        </label>
        <label className="kf-label">
          To
          <select value={toId} onChange={(e) => setToId(e.target.value)} className="kf-select">
            <option value="">—</option>
            {sortedNodes.map((n) => (
              <option key={n.id} value={n.id}>
                {n.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="kf-label" style={{ marginTop: 'var(--s-3)' }}>
        Reasoning（可选）
        <textarea
          value={reasoning}
          onChange={(e) => setReasoning(e.target.value)}
          rows={2}
          className="kf-textarea"
          placeholder="为什么这两个节点是这种关系"
        />
      </label>
      {fromId && toId && fromId === toId && <p className="kf-error">From 和 To 不能是同一节点</p>}
      {error && <p className="kf-error">创建失败：{error.message}</p>}
      <div className="kf-actions">
        <Button
          variant="primary"
          disabled={!canSubmit}
          onClick={() =>
            onSubmit({
              from_knowledge_id: fromId,
              to_knowledge_id: toId,
              relation_type: relation,
              reasoning: reasoning.trim() ? reasoning.trim() : undefined,
            })
          }
        >
          {pending ? '创建中…' : '创建关系'}
        </Button>
      </div>
    </div>
  );
}

const EDGE_DECISION_LABEL: Record<ProposalDecision, string> = {
  accept: '已接受',
  reverse: '已反向',
  change_type: '已改类型',
  dismiss: '已忽略',
};

function EdgeProposalCard({
  event,
  nodesById,
  status,
  pending,
  onDecision,
}: {
  event: EdgeProposalEvent;
  nodesById: Map<string, TreeNode>;
  status: ProposalDecision | undefined;
  pending: boolean;
  onDecision: (decision: ProposalDecision, new_relation_type?: RelationType) => void;
}) {
  const fromId = edgeProposalFrom(event);
  const toId = edgeProposalTo(event);
  const relType = event.payload.relation_type;
  const meta = relationMeta(relType);
  const disabled = status !== undefined || pending;

  // Resolved (decided) — optimistic terminal state; show the decision badge.
  if (status) {
    return (
      <div className="edge-prop resolved">
        <Badge tone="good">
          <LoomIcon name="check" size={12} />
          {EDGE_DECISION_LABEL[status]}
        </Badge>
        <span className="wenyan">
          {nodeName(nodesById, fromId)} {meta.arrow} {nodeName(nodesById, toId)}
        </span>
      </div>
    );
  }

  return (
    <div className="edge-prop">
      <div className="edge-prop-head">
        <span className={`rel-tag rel-tag-${relType ?? ''}`}>
          <span className="mono">{meta.arrow}</span>
          {meta.label}
        </span>
        {/* Corrective proposals don't count toward acceptance rate — mark them
            distinctly so review context survives the loom rewrite. Proactive
            proposals show nothing extra. */}
        {event.payload.suggestion_kind === 'corrective' && <Badge tone="info">修正</Badge>}
        <span className="wenyan">
          {nodeName(nodesById, fromId)} {meta.arrow} {nodeName(nodesById, toId)}
        </span>
        <span className="meta mono" style={{ marginLeft: 'auto' }}>
          {event.actor_ref}
          {typeof event.payload.weight === 'number' ? ` · w${event.payload.weight.toFixed(1)}` : ''}
          {event.cost_micro_usd ? ` · $${(event.cost_micro_usd / 1_000_000).toFixed(4)}` : ''}
        </span>
      </div>
      {event.payload.reasoning && (
        <div className="meta" style={{ marginBottom: 'var(--s-2)' }}>
          推理 — {event.payload.reasoning}
        </div>
      )}
      <div className="edge-prop-acts">
        <Btn
          variant="good"
          size="sm"
          icon="check"
          disabled={disabled}
          onClick={() => onDecision('accept')}
        >
          接受
        </Btn>
        <Btn
          variant="ghost"
          size="sm"
          icon="reverse"
          disabled={disabled}
          onClick={() => onDecision('reverse')}
        >
          改方向
        </Btn>
        <Btn
          variant="ghost"
          size="sm"
          icon="refresh"
          disabled={disabled}
          onClick={() => {
            // Rotate to the NEXT core relation type in RELATION_ORDER (wrapping
            // around), not the first different one. Keeps the server `change_type`
            // round-trip; the full picker is later UX polish.
            const currentIndex = RELATION_ORDER.indexOf(relType ?? 'related_to');
            const next = (
              currentIndex === -1
                ? RELATION_ORDER[0]
                : RELATION_ORDER[(currentIndex + 1) % RELATION_ORDER.length]
            ) as RelationType;
            onDecision('change_type', next);
          }}
        >
          改类型
        </Btn>
        <Btn
          variant="ghost"
          size="sm"
          icon="close"
          disabled={disabled}
          onClick={() => onDecision('dismiss')}
        >
          忽略
        </Btn>
      </div>
    </div>
  );
}
