'use client';

import { ApiAuthError, apiJson } from '@/ui/lib/api';
import { formatRelTime } from '@/ui/lib/utils';
import { Badge } from '@/ui/primitives/Badge';
import { Button } from '@/ui/primitives/Button';
import { Card } from '@/ui/primitives/Card';
import { Icon } from '@/ui/primitives/Icon';
import { PageHeader } from '@/ui/primitives/PageHeader';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';

interface KnowledgeNode {
  id: string;
  name: string;
  parent_id: string | null;
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

interface EventRow {
  id: string;
  actor_kind: string;
  actor_ref: string;
  action: string;
  subject_kind: string;
  subject_id: string;
  outcome: string;
  payload: Record<string, unknown>;
  caused_by_event_id?: string | null;
  task_run_id?: string | null;
  cost_micro_usd?: number | null;
  created_at: string;
}

type RelationType =
  | 'prerequisite'
  | 'related_to'
  | 'contrasts_with'
  | 'applied_in'
  | 'derived_from'
  | `experimental:${string}`;

type EdgeDecision = 'accept' | 'reverse' | 'change_type' | 'dismiss';
type ArtifactRating = 'accept' | 'dismiss';

const RELATION_TYPES: Record<
  string,
  {
    label: string;
    arrow: string;
    tone: 'coral' | 'neutral' | 'hard' | 'info' | 'good';
  }
> = {
  prerequisite: { label: '前置', arrow: '→', tone: 'coral' },
  related_to: { label: '相关', arrow: '↔', tone: 'neutral' },
  contrasts_with: { label: '对照', arrow: '⇆', tone: 'hard' },
  applied_in: { label: '应用于', arrow: '→', tone: 'info' },
  derived_from: { label: '派生自', arrow: '↳', tone: 'good' },
};

const RELATION_ORDER = Object.keys(RELATION_TYPES) as RelationType[];

export default function InboxPage() {
  const queryClient = useQueryClient();

  const knowledgeQ = useQuery({
    queryKey: ['inbox', 'knowledge'],
    queryFn: () => apiJson<{ rows: KnowledgeNode[] }>('/api/knowledge'),
  });
  const nodeProposalsQ = useQuery({
    queryKey: ['inbox', 'knowledge-proposals', 'pending'],
    queryFn: () =>
      apiJson<{ rows: KnowledgeProposal[] }>('/api/knowledge/proposals?status=pending'),
  });
  const edgeProposalsQ = useQuery({
    queryKey: ['inbox', 'knowledge-edge-proposals'],
    queryFn: () =>
      apiJson<{ rows: EventRow[] }>(
        '/api/events?action=propose&subject_kind=knowledge_edge&limit=200',
      ),
  });
  const edgeRatesQ = useQuery({
    queryKey: ['inbox', 'knowledge-edge-rates'],
    queryFn: () =>
      apiJson<{ rows: EventRow[] }>(
        '/api/events?action=rate&subject_kind=knowledge_edge&limit=200',
      ),
  });
  const artifactEventsQ = useQuery({
    queryKey: ['inbox', 'artifact-generations'],
    queryFn: () =>
      apiJson<{ rows: EventRow[] }>(
        '/api/events?action=generate&subject_kind=artifact&actor_kind=agent&limit=200',
      ),
  });
  const eventRatesQ = useQuery({
    queryKey: ['inbox', 'event-rates'],
    queryFn: () =>
      apiJson<{ rows: EventRow[] }>('/api/events?action=rate&subject_kind=event&limit=200'),
  });

  const nodesById = new Map((knowledgeQ.data?.rows ?? []).map((node) => [node.id, node]));
  const edgeRatedIds = new Set(
    (edgeRatesQ.data?.rows ?? [])
      .map((row) => row.caused_by_event_id)
      .filter((id): id is string => Boolean(id)),
  );
  const eventRatedIds = new Set(
    (eventRatesQ.data?.rows ?? [])
      .map((row) => row.caused_by_event_id)
      .filter((id): id is string => Boolean(id)),
  );

  const edgeProposals = (edgeProposalsQ.data?.rows ?? []).filter(
    (row) => !edgeRatedIds.has(row.id),
  );
  const nodeProposals = nodeProposalsQ.data?.rows ?? [];
  const artifacts = (artifactEventsQ.data?.rows ?? []).filter(
    (row) => row.outcome === 'success' && !eventRatedIds.has(row.id),
  );
  const pendingTotal = edgeProposals.length + nodeProposals.length + artifacts.length;
  const totalCostUsd =
    edgeProposals.concat(artifacts).reduce((sum, row) => sum + (row.cost_micro_usd ?? 0), 0) /
    1_000_000;

  const edgeDecision = useMutation({
    mutationFn: ({
      id,
      decision,
      new_relation_type,
    }: {
      id: string;
      decision: EdgeDecision;
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
        queryClient.invalidateQueries({ queryKey: ['inbox', 'knowledge-edge-proposals'] }),
        queryClient.invalidateQueries({ queryKey: ['inbox', 'knowledge-edge-rates'] }),
        queryClient.invalidateQueries({ queryKey: ['inbox', 'knowledge'] }),
      ]);
    },
  });

  const nodeDecision = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: 'accept' | 'reject' }) =>
      apiJson(`/api/knowledge/proposals/${id}`, {
        method: 'POST',
        body: JSON.stringify({ decision }),
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['inbox', 'knowledge-proposals', 'pending'] }),
        queryClient.invalidateQueries({ queryKey: ['inbox', 'knowledge'] }),
      ]);
    },
  });

  const artifactDecision = useMutation({
    mutationFn: ({ id, rating }: { id: string; rating: ArtifactRating }) =>
      apiJson(`/api/events/${id}/rate`, {
        method: 'POST',
        body: JSON.stringify({ rating }),
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['inbox', 'artifact-generations'] }),
        queryClient.invalidateQueries({ queryKey: ['inbox', 'event-rates'] }),
      ]);
    },
  });

  const loading =
    knowledgeQ.isLoading ||
    nodeProposalsQ.isLoading ||
    edgeProposalsQ.isLoading ||
    edgeRatesQ.isLoading ||
    artifactEventsQ.isLoading ||
    eventRatesQ.isLoading;
  const firstError =
    knowledgeQ.error ??
    nodeProposalsQ.error ??
    edgeProposalsQ.error ??
    edgeRatesQ.error ??
    artifactEventsQ.error ??
    eventRatesQ.error;

  return (
    <main className="page inbox-page">
      <PageHeader
        title="AI 提议收件箱"
        eyebrow="INBOX · 24h · events action IN (propose, generate) · 未 rate"
        sub="集中决断。每一行你 accept / dismiss 一次，写入一条 action=rate 事件，下次不再露面。"
      >
        <Link href="/today" style={{ textDecoration: 'none' }}>
          <Button variant="ghost" icon="arrowL">
            回今日
          </Button>
        </Link>
        <Button variant="secondary" disabled={pendingTotal === 0}>
          全部忽略
        </Button>
      </PageHeader>

      <div className="inbox-meta-line">
        {pendingTotal} 条待审 · 累计成本 ${totalCostUsd.toFixed(3)} · 大部分来自夜间 Dreaming
        session
      </div>

      {loading && (
        <Card pad="lg">
          <p className="inbox-empty">正在加载提议…</p>
        </Card>
      )}

      {firstError && (
        <Card pad="lg">
          <p className="inbox-error">
            {firstError instanceof ApiAuthError
              ? `${firstError.message} — 请重新进入页面输入 token`
              : `加载失败：${(firstError as Error).message}`}
          </p>
        </Card>
      )}

      {!loading && !firstError && (
        <>
          <InboxSection
            title="关系建议"
            count={edgeProposals.length}
            empty="没有待审知识关系。"
            note="subject_kind=knowledge_edge · ADR-0010 mesh"
          >
            {edgeProposals.map((event) => (
              <EdgeProposalCard
                key={event.id}
                event={event}
                nodesById={nodesById}
                pending={edgeDecision.isPending}
                onDecision={(decision, new_relation_type) =>
                  edgeDecision.mutate({ id: event.id, decision, new_relation_type })
                }
              />
            ))}
          </InboxSection>

          <InboxSection
            title="新节点"
            count={nodeProposals.length}
            empty="没有待审知识节点。"
            note="subject_kind=knowledge · 加到 tree backbone"
          >
            {nodeProposals.map((proposal) => (
              <NodeProposalCard
                key={proposal.id}
                proposal={proposal}
                nodesById={nodesById}
                pending={nodeDecision.isPending}
                onDecision={(decision) => nodeDecision.mutate({ id: proposal.id, decision })}
              />
            ))}
          </InboxSection>

          <InboxSection
            title="内容生成"
            count={artifacts.length}
            empty="没有待审内容生成。"
            note="action=generate subject_kind=artifact · 变式 / 笔记 / 小测 / 总结"
          >
            {artifacts.map((event) => (
              <ArtifactProposalCard
                key={event.id}
                event={event}
                pending={artifactDecision.isPending}
                onRate={(rating) => artifactDecision.mutate({ id: event.id, rating })}
              />
            ))}
          </InboxSection>
        </>
      )}
    </main>
  );
}

function InboxSection({
  title,
  count,
  empty,
  note,
  children,
}: {
  title: string;
  count: number;
  empty: string;
  note: string;
  children: React.ReactNode;
}) {
  return (
    <section className="section inbox-section">
      <div className="inbox-section-head">
        <h2>
          {title} · {count}
        </h2>
        <div className="meta">{note}</div>
      </div>
      {count === 0 ? (
        <p className="inbox-empty">{empty}</p>
      ) : (
        <div className="inbox-card-list">{children}</div>
      )}
    </section>
  );
}

function EdgeProposalCard({
  event,
  nodesById,
  pending,
  onDecision,
}: {
  event: EventRow;
  nodesById: Map<string, KnowledgeNode>;
  pending: boolean;
  onDecision: (decision: EdgeDecision, new_relation_type?: RelationType) => void;
}) {
  const fromId = edgeEndpoint(event, 'from');
  const toId = edgeEndpoint(event, 'to');
  const relationType = stringField(event.payload, 'relation_type') as RelationType | undefined;
  const meta = relationMeta(relationType);
  const nextRelation = RELATION_ORDER.find((type) => type !== relationType) ?? 'related_to';
  return (
    <article className={`edge-proposal tone-${meta.tone}`}>
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
        <span className="meta-row">{eventMeta(event)}</span>
      </div>
      {stringField(event.payload, 'reasoning') && (
        <div className="ep-reason">推理 — {stringField(event.payload, 'reasoning')}</div>
      )}
      <div className="ep-actions">
        <Button
          variant="good"
          size="sm"
          icon="check"
          disabled={pending}
          onClick={() => onDecision('accept')}
        >
          接受
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={pending}
          onClick={() => onDecision('reverse')}
        >
          改方向
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={pending}
          onClick={() => onDecision('change_type', nextRelation)}
        >
          改关系
        </Button>
        <Button
          variant="ghost"
          size="sm"
          icon="x"
          disabled={pending}
          onClick={() => onDecision('dismiss')}
        >
          忽略
        </Button>
        <Link href={`/events/${event.id}`} className="inbox-inline-link">
          事件链
        </Link>
      </div>
    </article>
  );
}

function NodeProposalCard({
  proposal,
  nodesById,
  pending,
  onDecision,
}: {
  proposal: KnowledgeProposal;
  nodesById: Map<string, KnowledgeNode>;
  pending: boolean;
  onDecision: (decision: 'accept' | 'reject') => void;
}) {
  const parentId = proposal.payload.parent_id ?? null;
  return (
    <article className="proposal inbox-node-proposal">
      <div className="proposal-head">
        <span className="mini-badge info">
          <Icon name="network" size={11} /> AI · 新节点
        </span>
        <span className="title">{proposal.payload.name ?? '未命名节点'}</span>
        <span className="inbox-card-meta">
          {parentId ? `parent · ${nodeName(nodesById, parentId)}` : 'root'} ·{' '}
          {formatRelTime(proposal.proposed_at)}
        </span>
      </div>
      <div className="body">{proposal.reasoning || '无推理说明'}</div>
      <div className="proposal-actions">
        <Button
          variant="good"
          size="sm"
          icon="check"
          disabled={pending}
          onClick={() => onDecision('accept')}
        >
          接受
        </Button>
        <Button
          variant="ghost"
          size="sm"
          icon="x"
          disabled={pending}
          onClick={() => onDecision('reject')}
        >
          忽略
        </Button>
        <Link href={`/events/${proposal.id}`} className="inbox-inline-link">
          事件链
        </Link>
      </div>
    </article>
  );
}

function ArtifactProposalCard({
  event,
  pending,
  onRate,
}: {
  event: EventRow;
  pending: boolean;
  onRate: (rating: ArtifactRating) => void;
}) {
  const kind = stringField(event.payload, 'artifact_kind') ?? 'artifact';
  const title = stringField(event.payload, 'title') ?? event.subject_id;
  const body = stringField(event.payload, 'body_md') ?? '';
  const refs = arrayField(event.payload, 'referenced_event_ids');
  return (
    <article className="artifact-proposal">
      <div className="artifact-proposal-head">
        <Badge tone={artifactTone(kind)}>{artifactLabel(kind)}</Badge>
        <h3>{title}</h3>
        <span className="inbox-card-meta">{eventMeta(event)}</span>
      </div>
      {body && <p className="artifact-proposal-body">{body}</p>}
      {refs.length > 0 && (
        <div className="artifact-ref-row">
          {refs.slice(0, 4).map((ref) => (
            <Link href={`/events/${ref}`} key={ref}>
              {ref.slice(0, 8)}…
            </Link>
          ))}
        </div>
      )}
      <div className="proposal-actions">
        <Button
          variant="good"
          size="sm"
          icon="check"
          disabled={pending}
          onClick={() => onRate('accept')}
        >
          接受
        </Button>
        <Button
          variant="ghost"
          size="sm"
          icon="x"
          disabled={pending}
          onClick={() => onRate('dismiss')}
        >
          忽略
        </Button>
        <Link href={`/events/${event.id}`} className="inbox-inline-link">
          事件链
        </Link>
      </div>
    </article>
  );
}

function edgeEndpoint(event: EventRow, side: 'from' | 'to'): string | undefined {
  return (
    stringField(event.payload, `${side}_knowledge_id`) ?? stringField(event.payload, `${side}_id`)
  );
}

function relationMeta(type: RelationType | undefined) {
  if (type && RELATION_TYPES[type]) return RELATION_TYPES[type];
  return {
    label: type?.startsWith('experimental:')
      ? type.replace('experimental:', '')
      : (type ?? 'related'),
    arrow: '→',
    tone: 'neutral' as const,
  };
}

function nodeName(nodesById: Map<string, KnowledgeNode>, id: string | null | undefined): string {
  if (!id) return 'unknown';
  return nodesById.get(id)?.name ?? id;
}

function stringField(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === 'string' ? value : undefined;
}

function arrayField(payload: Record<string, unknown>, key: string): string[] {
  const value = payload[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function eventMeta(event: EventRow): string {
  const parts = [
    event.actor_ref,
    event.task_run_id ? event.task_run_id.slice(0, 12) : null,
    typeof event.cost_micro_usd === 'number' && event.cost_micro_usd > 0
      ? `$${(event.cost_micro_usd / 1_000_000).toFixed(4)}`
      : null,
    formatRelTime(event.created_at),
  ].filter(Boolean);
  return parts.join(' · ');
}

function artifactLabel(kind: string): string {
  switch (kind) {
    case 'note':
      return '笔记';
    case 'quiz':
      return '小测';
    case 'variant':
      return '变式';
    case 'summary':
      return '总结';
    default:
      return kind;
  }
}

function artifactTone(kind: string): 'info' | 'good' | 'hard' | 'coral' | 'neutral' {
  switch (kind) {
    case 'note':
      return 'info';
    case 'quiz':
      return 'hard';
    case 'variant':
      return 'coral';
    case 'summary':
      return 'good';
    default:
      return 'neutral';
  }
}
