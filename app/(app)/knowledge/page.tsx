'use client';

import { ApiAuthError, apiJson } from '@/ui/lib/api';
import { Button } from '@/ui/primitives/Button';
import { Card } from '@/ui/primitives/Card';
import { Icon } from '@/ui/primitives/Icon';
import { PageHeader } from '@/ui/primitives/PageHeader';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';

interface KnowledgeNode {
  id: string;
  name: string;
  domain: string | null;
  parent_id: string | null;
  archived_at: string | null;
  effective_domain: string | null;
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
    tone: 'coral' | 'neutral' | 'hard' | 'info' | 'good';
  }
> = {
  prerequisite: { label: '前置', arrow: '→', directed: true, tone: 'coral' },
  related_to: { label: '相关', arrow: '↔', directed: false, tone: 'neutral' },
  contrasts_with: { label: '对照', arrow: '⇆', directed: false, tone: 'hard' },
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

  const nodes = knowledgeQ.data?.rows ?? [];
  const edges = edgesQ.data?.rows ?? [];
  const nodeProposals = proposalsQ.data?.rows ?? [];
  const pendingEdgeProposals = (edgeProposalsQ.data?.rows ?? []).filter(
    (p) => edgeProposalStatus[edgeProposalKey(p)] === undefined,
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
    edgesQ.error ?? proposalsQ.error ?? edgeProposalsQ.error ?? mistakesQ.error;

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
          title="节点创建表单待 Phase 1d 接入"
          className="knowledge-btn-primary"
        >
          新建节点
        </Button>
      </PageHeader>

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
              edges.filter(
                (edge) =>
                  edge.archived_at === null &&
                  (edge.from_knowledge_id === node.id || edge.to_knowledge_id === node.id),
              ).length;
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
          edges={edges.filter((edge) => edge.archived_at === null)}
          selectedId={selectedId}
          onSelect={setSelectedId}
          mistakeCounts={mistakeCounts}
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
                      onDecision={(decision) =>
                        setEdgeProposalStatus((current) => ({
                          ...current,
                          [edgeProposalKey(event)]: decision,
                        }))
                      }
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

function EdgeProposalCard({
  event,
  nodesById,
  status,
  onDecision,
}: {
  event: EdgeProposalEvent;
  nodesById: Map<string, TreeNode>;
  status: ProposalDecision | undefined;
  onDecision: (decision: ProposalDecision) => void;
}) {
  const fromId = edgeProposalFrom(event);
  const toId = edgeProposalTo(event);
  const meta = relationMeta(event.payload.relation_type);
  const disabled = status !== undefined;
  return (
    <div className={`edge-proposal tone-${meta.tone} ${status ? `is-${status}` : ''}`}>
      <div className="edge-proposal-head">
        <span className="mini-badge info">
          <Icon name="link" size={11} /> AI · 关系
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
          onClick={() => onDecision('change_type')}
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

function KnowledgeGraph({
  nodes,
  edges,
  selectedId,
  onSelect,
  mistakeCounts,
}: {
  nodes: TreeNode[];
  edges: KnowledgeEdgeRow[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  mistakeCounts: Map<string, number>;
}) {
  const width = 1000;
  const height = 520;
  const positions = useMemo(() => layoutGraph(nodes, edges, width, height), [nodes, edges]);
  const byPosition = new Map(positions.map((p) => [p.id, p]));
  const treeEdges = nodes
    .filter((node) => node.parent_id && byPosition.has(node.parent_id))
    .map((node) => ({ id: `tree-${node.id}`, from: node.parent_id as string, to: node.id }));

  const radius = (id: string) => 12 + Math.min(20, (mistakeCounts.get(id) ?? 0) * 4);

  return (
    <section className="kg-stage" aria-label="知识关系图">
      <svg
        className="kg-svg"
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height={height}
        role="img"
        aria-label="知识关系图"
      >
        <defs>
          {RELATION_ORDER.map((type) => (
            <marker
              key={type}
              id={`arrow-${type}`}
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill={edgeColor(type)} />
            </marker>
          ))}
        </defs>

        {treeEdges.map((edge) => {
          const from = byPosition.get(edge.from);
          const to = byPosition.get(edge.to);
          if (!from || !to) return null;
          return (
            <line
              key={edge.id}
              x1={from.x}
              y1={from.y}
              x2={to.x}
              y2={to.y}
              stroke="var(--ink-5)"
              strokeWidth={1}
              strokeDasharray="3 5"
              opacity={0.45}
            />
          );
        })}

        {edges.map((edge) => {
          const from = byPosition.get(edge.from_knowledge_id);
          const to = byPosition.get(edge.to_knowledge_id);
          if (!from || !to) return null;
          const meta = relationMeta(edge.relation_type);
          const dx = to.x - from.x;
          const dy = to.y - from.y;
          const len = Math.sqrt(dx * dx + dy * dy) || 1;
          const targetRadius = radius(edge.to_knowledge_id);
          const x2 = to.x - (dx / len) * targetRadius;
          const y2 = to.y - (dy / len) * targetRadius;
          const markerType = RELATION_TYPES[edge.relation_type] ? edge.relation_type : undefined;
          return (
            <line
              key={edge.id}
              x1={from.x}
              y1={from.y}
              x2={x2}
              y2={y2}
              stroke={edgeColor(edge.relation_type)}
              strokeWidth={1 + edge.weight * 1.5}
              strokeDasharray={edge.relation_type === 'related_to' ? '4 4' : undefined}
              opacity={0.72}
              markerEnd={meta.directed && markerType ? `url(#arrow-${markerType})` : undefined}
            />
          );
        })}

        {positions.map((position) => {
          const node = nodes.find((item) => item.id === position.id);
          const selected = position.id === selectedId;
          const r = radius(position.id);
          return (
            <a
              key={position.id}
              className="kg-node"
              href={`/knowledge/${position.id}`}
              onClick={(event) => {
                event.preventDefault();
                onSelect(position.id);
              }}
              style={{ cursor: 'pointer' }}
            >
              <title>{node?.name ?? position.id}</title>
              <circle
                cx={position.x}
                cy={position.y}
                r={r}
                fill={selected ? 'var(--coral-soft)' : 'var(--paper-raised)'}
                stroke={selected ? 'var(--coral)' : 'var(--line-strong)'}
                strokeWidth={selected ? 2 : 1}
              />
              <text
                x={position.x}
                y={position.y + r + 14}
                textAnchor="middle"
                fontFamily="var(--font-sans)"
                fontSize="12"
                fill="var(--ink-2)"
              >
                {node?.name ?? position.id}
              </text>
            </a>
          );
        })}
      </svg>
      <div className="kg-legend">
        <span className="item">
          <span className="swatch dashed" />
          <span>tree (parent_id)</span>
        </span>
        {RELATION_ORDER.map((type) => {
          const meta = RELATION_TYPES[type];
          return (
            <span className="item" key={type}>
              <span className="swatch" style={{ borderTopColor: edgeColor(type) }} />
              <span>
                {meta.label} ({type})
              </span>
            </span>
          );
        })}
        <span className="kg-legend-note">圆 = 节点 · 半径 ∝ mistake_count</span>
      </div>
    </section>
  );
}

function layoutGraph(nodes: TreeNode[], edges: KnowledgeEdgeRow[], width: number, height: number) {
  if (nodes.length === 0) return [];
  type LayoutEdge = {
    from_knowledge_id: string;
    to_knowledge_id: string;
    relation_type: string;
    weight: number;
  };
  const treeEdges: LayoutEdge[] = nodes
    .filter((node) => node.parent_id)
    .map((node) => ({
      from_knowledge_id: node.parent_id as string,
      to_knowledge_id: node.id,
      relation_type: '__tree__',
      weight: 0.5,
    }));
  const allEdges: LayoutEdge[] = [...treeEdges, ...edges];
  const positions = nodes.map((node, index) => ({
    id: node.id,
    x: width / 2 + Math.cos((index / nodes.length) * Math.PI * 2) * Math.min(width, height) * 0.32,
    y: height / 2 + Math.sin((index / nodes.length) * Math.PI * 2) * Math.min(width, height) * 0.32,
    vx: 0,
    vy: 0,
  }));
  const indexById = new Map(positions.map((position, index) => [position.id, index]));

  for (let iter = 0; iter < 220; iter++) {
    for (let i = 0; i < positions.length; i++) {
      for (let j = i + 1; j < positions.length; j++) {
        const dx = positions[j].x - positions[i].x;
        const dy = positions[j].y - positions[i].y;
        const d2 = dx * dx + dy * dy + 0.01;
        const d = Math.sqrt(d2);
        const f = 2400 / d2;
        const fx = (dx / d) * f;
        const fy = (dy / d) * f;
        positions[i].vx -= fx;
        positions[i].vy -= fy;
        positions[j].vx += fx;
        positions[j].vy += fy;
      }
    }

    for (const edge of allEdges) {
      const a = indexById.get(edge.from_knowledge_id);
      const b = indexById.get(edge.to_knowledge_id);
      if (a === undefined || b === undefined) continue;
      const dx = positions[b].x - positions[a].x;
      const dy = positions[b].y - positions[a].y;
      const d = Math.sqrt(dx * dx + dy * dy) + 0.01;
      const isTree = edge.relation_type === '__tree__';
      const rest = isTree ? 95 : edge.relation_type === 'prerequisite' ? 110 : 130;
      const k = isTree ? 0.05 : edge.weight * 0.06;
      const fx = ((d - rest) / d) * dx * k;
      const fy = ((d - rest) / d) * dy * k;
      positions[a].vx += fx;
      positions[a].vy += fy;
      positions[b].vx -= fx;
      positions[b].vy -= fy;
    }

    for (const p of positions) {
      p.vx += (width / 2 - p.x) * 0.005;
      p.vy += (height / 2 - p.y) * 0.005;
      p.vx *= 0.78;
      p.vy *= 0.78;
      p.x += p.vx;
      p.y += p.vy;
      p.x = Math.max(40, Math.min(width - 40, p.x));
      p.y = Math.max(40, Math.min(height - 40, p.y));
    }
  }

  return positions;
}

function edgeColor(type: string): string {
  switch (type) {
    case 'prerequisite':
      return 'var(--coral)';
    case 'contrasts_with':
      return 'var(--hard)';
    case 'applied_in':
      return 'var(--info)';
    case 'derived_from':
      return 'var(--good)';
    default:
      return 'var(--ink-4)';
  }
}
