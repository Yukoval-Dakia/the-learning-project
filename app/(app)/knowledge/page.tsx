'use client';

import { ApiAuthError, apiJson } from '@/ui/lib/api';
import { Button } from '@/ui/primitives/Button';
import { Card } from '@/ui/primitives/Card';
import { Icon } from '@/ui/primitives/Icon';
import { MasteryBadge, type MasteryData } from '@/ui/primitives/MasteryBadge';
import { PageHeader } from '@/ui/primitives/PageHeader';
import { type SuggestionKind, SuggestionKindTag } from '@/ui/primitives/SuggestionKindTag';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import dynamic from 'next/dynamic';
import { useCallback, useMemo, useState } from 'react';

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
  const [view, setView] = useState<'tree' | 'graph'>('tree');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [edgeProposalStatus, setEdgeProposalStatus] = useState<Record<string, ProposalDecision>>(
    {},
  );

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
    <main className="knowledge-page">
      <PageHeader
        eyebrow={`KNOWLEDGE · ${nodes.length} nodes · ${edges.length} edges (mesh)`}
        title="知识"
        sub="树是骨架，mesh 是肌肉。点节点 → 右侧抽屉看关系 + 活动 + AI 提议。"
      >
        <div className="kg-toggle" aria-label="知识视图切换">
          <button
            type="button"
            className={view === 'tree' ? 'is-on' : ''}
            onClick={() => setView('tree')}
          >
            树
          </button>
          <button
            type="button"
            className={view === 'graph' ? 'is-on' : ''}
            onClick={() => setView('graph')}
          >
            Graph
          </button>
        </div>
        <Button
          variant="primary"
          icon="plus"
          onClick={() => setShowEdgeCreate((v) => !v)}
          className="knowledge-btn-primary"
        >
          {showEdgeCreate ? '取消' : '新建关系'}
        </Button>
      </PageHeader>

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

      {knowledgeQ.error && <LoadError error={knowledgeQ.error} />}

      {knowledgeQ.isSuccess && optionalDataError && (
        <Card pad="lg" style={{ marginBottom: 'var(--s-4)' }}>
          <p className="knowledge-empty-text">
            tree 已加载；mesh / AI 提议 / 活动数据暂时不可用：{(optionalDataError as Error).message}
          </p>
        </Card>
      )}

      {pendingEdgeProposals.length > 0 && (
        <div className="quality-strip knowledge-proposal-strip">
          <Icon name="link" size={20} />
          <div className="qtxt">
            <h5>AI 提议了 {pendingEdgeProposals.length} 条新关系</h5>
            <p>来自 Dreaming / Maintenance。节点选中后可在右侧抽屉里接受、改方向、改关系或忽略。</p>
          </div>
          <div className="rescue">
            <Button
              variant="primary"
              size="sm"
              iconRight="arrowR"
              className="knowledge-btn-primary"
              onClick={() => {
                // Jump to the first node with pending edge proposals and open
                // its drawer; user can step through subsequent nodes manually.
                const firstId = edgeProposalsByNode.keys().next().value ?? null;
                if (firstId) setSelectedId(firstId);
              }}
            >
              集中审批
            </Button>
          </div>
        </div>
      )}

      {knowledgeQ.isLoading && (
        <Card pad="lg">
          <p className="knowledge-empty-text">正在加载知识网...</p>
        </Card>
      )}

      {knowledgeQ.isSuccess && roots.length === 0 && (
        <Card pad="lg">
          <p className="knowledge-empty-text">还没有知识节点。AI 会在归因 / 提议时自动生成。</p>
        </Card>
      )}

      {knowledgeQ.isSuccess && roots.length > 0 && view === 'tree' && (
        <section className="knowledge-tree" aria-label="知识树">
          {flattened.map((node) => {
            const nodeMistakes = mistakeCounts.get(node.id) ?? 0;
            const activityCount =
              nodeMistakes +
              (proposalsByParent.get(node.id)?.length ?? 0) +
              (edgeProposalsByNode.get(node.id)?.length ?? 0) +
              (edgeCountByNode.get(node.id) ?? 0);
            const hasProposal =
              (proposalsByParent.get(node.id)?.length ?? 0) > 0 ||
              (edgeProposalsByNode.get(node.id)?.length ?? 0) > 0;

            return (
              <button
                key={node.id}
                type="button"
                className={[
                  'tree-node',
                  hasProposal ? 'has-proposal' : '',
                  node.id === selectedId ? 'is-selected' : '',
                ]
                  .join(' ')
                  .trim()}
                data-depth={Math.min(node.depth, 4)}
                onClick={() => setSelectedId(node.id)}
              >
                <div className="name">
                  <span className="indent" />
                  {node.depth > 0 && <span className="tree-hook">↳</span>}
                  <span className="tree-title">{node.name}</span>
                  <code>{node.id}</code>
                </div>
                <div className="activity">
                  {node.effective_domain && <span>{node.effective_domain}</span>}
                  {nodeMistakes > 0 && <span>{nodeMistakes} 错</span>}
                  {activityCount > 0 && <span>{activityCount} 事件</span>}
                  {(edgeProposalsByNode.get(node.id)?.length ?? 0) > 0 && (
                    <span className="mini-badge">新关系</span>
                  )}
                </div>
                <div className="actions">→</div>
              </button>
            );
          })}
        </section>
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

      {selected && (
        <aside className="detail-drawer" aria-label={`${selected.name} 详情`}>
          <header className="dd-head">
            <div>
              <h3>{selected.name}</h3>
              <div className="meta">
                <code>{selected.id}</code> · depth {selected.depth}
                {selected.parent_id ? ` · parent ${selected.parent_id}` : ' · root'}
              </div>
              <div className="dd-mastery">
                <MasteryBadge data={masteryData(selected)} />
              </div>
            </div>
            <Button
              variant="ghost"
              icon="x"
              onClick={() => setSelectedId(null)}
              aria-label="关闭"
              className="knowledge-btn-ghost"
            />
          </header>
          <div className="dd-body">
            {selectedPendingEdges.length > 0 && (
              <section className="dd-section">
                <h4>AI 建议关系 · {selectedPendingEdges.length} 待审</h4>
                <div className="dd-stack">
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
              </section>
            )}

            <section className="dd-section">
              <h4>层级 · tree</h4>
              <div className="relations-list">
                {selected.parent_id ? (
                  <div className="relation tone-neutral">
                    <span className="rel-arrow">↑</span>
                    <span className="rel-type">父</span>
                    <span className="rel-target">
                      {byId.get(selected.parent_id)?.name ?? selected.parent_id}
                    </span>
                  </div>
                ) : (
                  <div className="empty-tiny">根节点</div>
                )}
                {(childrenByParent.get(selected.id) ?? []).map((child) => (
                  <div className="relation tone-neutral" key={child.id}>
                    <span className="rel-arrow">↓</span>
                    <span className="rel-type">子</span>
                    <span className="rel-target">{child.name}</span>
                  </div>
                ))}
              </div>
            </section>

            <section className="dd-section">
              <h4>关系 · mesh · {selectedEdges.length}</h4>
              {selectedEdges.length === 0 && (
                <div className="empty-tiny">尚无 mesh 边。tree backbone 之外没有横向链接。</div>
              )}
              <div className="relations-list">
                {RELATION_ORDER.map((relationType) => {
                  const group = selectedEdges.filter((edge) => edge.relation_type === relationType);
                  if (group.length === 0) return null;
                  return (
                    <div className="relations-group" key={relationType}>
                      {group.map((edge) => (
                        <KnowledgeRelation
                          key={edge.id}
                          edge={edge}
                          currentNodeId={selected.id}
                          nodesById={byId}
                        />
                      ))}
                    </div>
                  );
                })}
              </div>
            </section>

            {selectedNodeProposals.length > 0 && (
              <section className="dd-section">
                <h4>AI 建议子节点 · {selectedNodeProposals.length}</h4>
                <div className="dd-stack">
                  {selectedNodeProposals.map((proposal) => (
                    <div className="proposal" key={proposal.id}>
                      <div className="proposal-head">
                        <span className="mini-badge info">AI · 新节点</span>
                        <span className="title">{proposal.payload.name ?? '未命名节点'}</span>
                      </div>
                      <div className="body">{proposal.reasoning}</div>
                      <div className="proposal-actions">
                        <Button
                          variant="good"
                          size="sm"
                          icon="check"
                          disabled={proposalDecision.isPending}
                          className="knowledge-btn-good"
                          onClick={() =>
                            proposalDecision.mutate({ id: proposal.id, decision: 'accept' })
                          }
                        >
                          接受
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          icon="x"
                          disabled={proposalDecision.isPending}
                          className="knowledge-btn-ghost"
                          onClick={() =>
                            proposalDecision.mutate({ id: proposal.id, decision: 'reject' })
                          }
                        >
                          忽略
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            <section className="dd-section">
              <h4>近活动 · {selectedActivity.length}</h4>
              {selectedActivity.length === 0 && <div className="empty-tiny">无近期事件</div>}
              <div className="dd-activity">
                {selectedActivity.map((row) => (
                  <div className="dd-activity-row" key={row.id}>
                    <div className="top">
                      <ActorPill actor={row.actor} />
                      <span>{row.label}</span>
                      <span style={{ marginLeft: 'auto' }}>{row.meta}</span>
                    </div>
                    <div className="body">{row.detail}</div>
                  </div>
                ))}
              </div>
            </section>
          </div>
        </aside>
      )}
    </main>
  );
}

function LoadError({ error }: { error: unknown }) {
  return (
    <Card pad="lg" style={{ marginBottom: 'var(--s-4)' }}>
      <p className="knowledge-error-text">
        {error instanceof ApiAuthError
          ? `${error.message} — 请重新进入页面输入 token`
          : `加载失败：${(error as Error).message}`}
      </p>
    </Card>
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

function masteryData(node: KnowledgeNode): MasteryData {
  return {
    mastery: node.mastery,
    evidence_count: node.evidence_count,
    last_evidence_at: node.last_evidence_at,
  };
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

function ActorPill({ actor }: { actor: 'user' | 'agent' | 'system' | string }) {
  const icon = actor === 'agent' ? 'bot' : actor === 'user' ? 'user' : 'cog';
  const label = actor === 'agent' ? 'AI' : actor === 'user' ? '用户' : 'system';
  return (
    <span
      className={`actor-pill ${actor === 'agent' ? 'agent' : actor === 'user' ? 'user' : 'system'}`}
    >
      <Icon name={icon} size={11} />
      <span>{label}</span>
    </span>
  );
}

function KnowledgeRelation({
  edge,
  currentNodeId,
  nodesById,
}: {
  edge: KnowledgeEdgeRow;
  currentNodeId: string;
  nodesById: Map<string, TreeNode>;
}) {
  const meta = relationMeta(edge.relation_type);
  const isFromHere = edge.from_knowledge_id === currentNodeId;
  const otherId = isFromHere ? edge.to_knowledge_id : edge.from_knowledge_id;
  const arrow = meta.directed ? (isFromHere ? '→' : '←') : meta.arrow;
  return (
    <div className={`relation tone-${meta.tone}`}>
      <span className="rel-arrow">{arrow}</span>
      <span className="rel-type">{meta.label}</span>
      <span className="rel-target">{nodeName(nodesById, otherId)}</span>
      <span className="rel-weight">{edge.weight.toFixed(1)}</span>
      {createdByActor(edge.created_by) === 'agent' && <ActorPill actor="agent" />}
      {edge.reasoning && (
        <span className="rel-info" title={edge.reasoning}>
          <Icon name="info" size={12} />
        </span>
      )}
    </div>
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
  const meta = relationMeta(event.payload.relation_type);
  const suggestionKind = event.payload.suggestion_kind ?? 'proactive';
  const disabled = status !== undefined || pending;
  return (
    <div
      className={`edge-proposal tone-${meta.tone} ${status ? `is-${status}` : ''} ${
        suggestionKind === 'corrective' ? 'is-corrective' : ''
      }`}
    >
      <div className="edge-proposal-head">
        <span className="mini-badge info">
          <Icon name="link" size={11} /> AI · 关系
          <SuggestionKindTag kind={suggestionKind} />
        </span>
        <span className="ep-graph">
          <code>{nodeName(nodesById, fromId)}</code>
          <span className={`ep-arrow tone-${meta.tone}`}>
            <span className="ep-arrow-glyph">{meta.arrow}</span>
            <sub className="ep-arrow-lbl">{meta.label}</sub>
          </span>
          <code>{nodeName(nodesById, toId)}</code>
        </span>
        <span className="meta-row">
          {event.actor_ref}
          {event.task_run_id ? ` · ${event.task_run_id}` : ''}
          {event.cost_micro_usd ? ` · $${(event.cost_micro_usd / 1_000_000).toFixed(4)}` : ''}
        </span>
      </div>
      {event.payload.reasoning && <div className="ep-reason">推理 — {event.payload.reasoning}</div>}
      <div className="ep-actions">
        <Button
          variant="good"
          size="sm"
          icon="check"
          disabled={disabled}
          className="knowledge-btn-good"
          onClick={() => onDecision('accept')}
        >
          {status === 'accept' ? '已接受' : '接受'}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={disabled}
          className="knowledge-btn-secondary"
          onClick={() => onDecision('reverse')}
        >
          改方向
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={disabled}
          className="knowledge-btn-secondary"
          onClick={() => {
            // Pick the next relation type from the core enum, skipping the
            // current one. The full picker is a later UX polish; cycling lets
            // users at least round-trip the decision through the server.
            const cur = event.payload.relation_type;
            const next = (Object.keys(RELATION_TYPES) as RelationType[]).find((r) => r !== cur);
            if (next) onDecision('change_type', next);
          }}
        >
          改关系
        </Button>
        <Button
          variant="ghost"
          size="sm"
          icon="x"
          disabled={disabled}
          className="knowledge-btn-ghost"
          onClick={() => onDecision('dismiss')}
        >
          {status === 'dismiss' ? '已忽略' : '忽略'}
        </Button>
      </div>
    </div>
  );
}
