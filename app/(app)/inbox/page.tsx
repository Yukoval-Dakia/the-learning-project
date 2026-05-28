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
import { useSearchParams } from 'next/navigation';
import type { ReactNode } from 'react';

interface KnowledgeNode {
  id: string;
  name: string;
  parent_id: string | null;
}

type ProposalStatus = 'pending' | 'accepted' | 'dismissed' | 'stale';
type ProposalKind =
  | 'knowledge_node'
  | 'knowledge_edge'
  | 'learning_item'
  | 'note_update'
  | 'variant_question'
  | 'completion'
  | 'relearn'
  | 'record_links'
  | 'record_promotion'
  | 'archive'
  | 'judge_retraction';

interface ProposalTarget {
  subject_kind: string;
  subject_id: string | null;
}

interface ProposalEvidenceRef {
  kind: 'event' | 'question' | 'knowledge' | 'artifact' | 'record';
  id: string;
}

type RelationType =
  | 'prerequisite'
  | 'related_to'
  | 'contrasts_with'
  | 'applied_in'
  | 'derived_from'
  | `experimental:${string}`;

interface BaseProposalPayload {
  kind: ProposalKind;
  target: ProposalTarget;
  reason_md: string;
  evidence_refs: ProposalEvidenceRef[];
  proposed_change: Record<string, unknown>;
  rollback_plan?: unknown;
  cooldown_key?: string;
}

interface KnowledgeNodeProposalPayload extends BaseProposalPayload {
  kind: 'knowledge_node';
  target: { subject_kind: 'knowledge'; subject_id: string | null };
  proposed_change: {
    mutation: 'propose_new';
    name: string;
    parent_id: string;
  };
}

interface KnowledgeEdgeProposalPayload extends BaseProposalPayload {
  kind: 'knowledge_edge';
  target: { subject_kind: 'knowledge_edge'; subject_id: string | null };
  proposed_change: {
    from_knowledge_id: string;
    to_knowledge_id: string;
    relation_type: RelationType;
    weight: number;
  };
}

type ProposalPayload =
  | KnowledgeNodeProposalPayload
  | KnowledgeEdgeProposalPayload
  | BaseProposalPayload;

interface ProposalInboxRow {
  id: string;
  kind: ProposalKind;
  target: ProposalTarget;
  payload: ProposalPayload;
  status: ProposalStatus;
  proposed_at: string;
  decided_at: string | null;
  actor_ref: string;
  task_run_id: string | null;
  cost_micro_usd: number | null;
  source_action: string;
  source_subject_kind: string;
}

type EdgeDecision = 'accept' | 'reverse' | 'change_type';

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

const KIND_LABELS: Record<ProposalKind, string> = {
  knowledge_node: '新知识节点',
  knowledge_edge: '知识关系',
  learning_item: '学习项',
  note_update: '笔记更新',
  variant_question: '变式题',
  completion: '完成状态',
  relearn: '重学安排',
  record_links: '记录链接',
  record_promotion: '记录升级',
  archive: '归档',
  judge_retraction: '判题撤回',
};

export default function InboxPage() {
  const queryClient = useQueryClient();
  // YUK-15 — `?evidence_record=<id>` filters the inbox to proposals citing
  // that record. Used by the record list backlink to surface "已产生 N 条 AI
  // 提议" navigation.
  const searchParams = useSearchParams();
  const evidenceRecordFilter = searchParams?.get('evidence_record') ?? null;

  const knowledgeQ = useQuery({
    queryKey: ['inbox', 'knowledge'],
    queryFn: () => apiJson<{ rows: KnowledgeNode[] }>('/api/knowledge'),
  });
  const proposalsQ = useQuery({
    queryKey: ['inbox', 'proposals', 'pending'],
    queryFn: () => apiJson<{ rows: ProposalInboxRow[] }>('/api/proposals?status=pending&limit=200'),
  });

  const refreshInbox = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['inbox', 'proposals', 'pending'] }),
      queryClient.invalidateQueries({ queryKey: ['inbox', 'knowledge'] }),
    ]);
  };

  const acceptMutation = useMutation({
    mutationFn: ({
      id,
      decision,
      new_relation_type,
    }: {
      id: string;
      decision?: EdgeDecision;
      new_relation_type?: RelationType;
    }) =>
      apiJson(`/api/proposals/${id}/accept`, {
        method: 'POST',
        body: JSON.stringify({
          ...(decision ? { decision } : {}),
          ...(new_relation_type ? { new_relation_type } : {}),
        }),
      }),
    onSuccess: refreshInbox,
  });

  const dismissMutation = useMutation({
    mutationFn: ({ id }: { id: string }) =>
      apiJson(`/api/proposals/${id}/dismiss`, {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    onSuccess: refreshInbox,
  });

  const retractMutation = useMutation({
    mutationFn: ({ id }: { id: string }) =>
      apiJson(`/api/proposals/${id}/retract`, {
        method: 'POST',
        body: JSON.stringify({ reason_md: '用户在收件箱撤回该提议。' }),
      }),
    onSuccess: refreshInbox,
  });

  const nodesById = new Map((knowledgeQ.data?.rows ?? []).map((node) => [node.id, node]));
  const allProposals = proposalsQ.data?.rows ?? [];
  // YUK-15 — client-side filter when `?evidence_record=<id>` is present.
  const proposals = evidenceRecordFilter
    ? allProposals.filter((row) =>
        row.payload.evidence_refs.some(
          (ref) => ref.kind === 'record' && ref.id === evidenceRecordFilter,
        ),
      )
    : allProposals;
  const proposalGroups = groupByKind(proposals);
  const pendingTotal = proposals.length;
  const totalCostUsd =
    proposals.reduce((sum, row) => sum + (row.cost_micro_usd ?? 0), 0) / 1_000_000;
  const mutating =
    acceptMutation.isPending || dismissMutation.isPending || retractMutation.isPending;

  const loading = knowledgeQ.isLoading || proposalsQ.isLoading;
  const firstError = knowledgeQ.error ?? proposalsQ.error;

  return (
    <main className="page inbox-page">
      <PageHeader
        title="AI 提议收件箱"
        eyebrow="INBOX · /api/proposals · pending"
        sub="统一处理 AI proposal。接受、忽略或撤回都会写入事件链，处理后从待审队列移除。"
      >
        <Link href="/today" style={{ textDecoration: 'none' }}>
          <Button variant="ghost" icon="arrowL">
            回今日
          </Button>
        </Link>
      </PageHeader>

      <div className="inbox-meta-line">
        {pendingTotal} 条待审 · 累计成本 ${totalCostUsd.toFixed(3)} · 包含 Dreaming 与后续 producer
        写入的 proposal
      </div>

      {evidenceRecordFilter && (
        <Card>
          <p className="inbox-meta-line">
            仅显示引用 record <code>{evidenceRecordFilter.slice(0, 12)}…</code> 的提议。
            <Link href="/inbox" className="inbox-inline-link" style={{ marginLeft: 8 }}>
              清除过滤
            </Link>
          </p>
        </Card>
      )}

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
        <InboxSection
          title="待审提议"
          count={pendingTotal}
          empty="没有待审提议。"
          note="按 proposal kind 分组；当前 node / edge 可直接接受，其他 kind 先支持忽略与撤回。"
        >
          <div className="proposal-kind-list">
            {proposalGroups.map((group) => (
              <section className="proposal-kind-group" key={group.kind}>
                <div className="proposal-kind-head">
                  <Badge tone={kindTone(group.kind)}>{kindLabel(group.kind)}</Badge>
                  <span>{group.rows.length} 条</span>
                </div>
                <div className="inbox-card-list">
                  {group.rows.map((row) => {
                    if (isKnowledgeEdgeProposal(row)) {
                      return (
                        <EdgeProposalCard
                          key={row.id}
                          proposal={row}
                          nodesById={nodesById}
                          pending={mutating}
                          onAccept={(decision, new_relation_type) =>
                            acceptMutation.mutate({ id: row.id, decision, new_relation_type })
                          }
                          onDismiss={() => dismissMutation.mutate({ id: row.id })}
                          onRetract={() => retractMutation.mutate({ id: row.id })}
                        />
                      );
                    }
                    if (isKnowledgeNodeProposal(row)) {
                      return (
                        <NodeProposalCard
                          key={row.id}
                          proposal={row}
                          nodesById={nodesById}
                          pending={mutating}
                          onAccept={() => acceptMutation.mutate({ id: row.id })}
                          onDismiss={() => dismissMutation.mutate({ id: row.id })}
                          onRetract={() => retractMutation.mutate({ id: row.id })}
                        />
                      );
                    }
                    return (
                      <GenericProposalCard
                        key={row.id}
                        proposal={row}
                        pending={mutating}
                        onDismiss={() => dismissMutation.mutate({ id: row.id })}
                        onRetract={() => retractMutation.mutate({ id: row.id })}
                      />
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        </InboxSection>
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
  children: ReactNode;
}) {
  return (
    <section className="section inbox-section">
      <div className="inbox-section-head">
        <h2>
          {title} · {count}
        </h2>
        <div className="meta">{note}</div>
      </div>
      {count === 0 ? <p className="inbox-empty">{empty}</p> : children}
    </section>
  );
}

function EdgeProposalCard({
  proposal,
  nodesById,
  pending,
  onAccept,
  onDismiss,
  onRetract,
}: {
  proposal: ProposalInboxRow & { payload: KnowledgeEdgeProposalPayload };
  nodesById: Map<string, KnowledgeNode>;
  pending: boolean;
  onAccept: (decision: EdgeDecision, new_relation_type?: RelationType) => void;
  onDismiss: () => void;
  onRetract: () => void;
}) {
  const change = proposal.payload.proposed_change;
  const meta = relationMeta(change.relation_type);
  const nextRelation = RELATION_ORDER.find((type) => type !== change.relation_type) ?? 'related_to';
  return (
    <article className={`edge-proposal tone-${meta.tone}`}>
      <div className="edge-proposal-head">
        <span className="mini-badge info">
          <Icon name="link" size={11} /> AI · 关系
        </span>
        <span className="ep-graph">
          <code>{nodeName(nodesById, change.from_knowledge_id)}</code>
          <span className={`ep-arrow tone-${meta.tone}`}>
            <span className="ep-arrow-glyph">{meta.arrow}</span>
            <sub className="ep-arrow-lbl">{meta.label}</sub>
          </span>
          <code>{nodeName(nodesById, change.to_knowledge_id)}</code>
        </span>
        <span className="meta-row">{proposalMeta(proposal)}</span>
      </div>
      {proposal.payload.reason_md && (
        <div className="ep-reason">推理 — {proposal.payload.reason_md}</div>
      )}
      <ProposalStatusRow proposal={proposal} />
      <div className="ep-actions">
        <Button
          variant="good"
          size="sm"
          icon="check"
          disabled={pending}
          onClick={() => onAccept('accept')}
        >
          接受
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={pending}
          onClick={() => onAccept('reverse')}
        >
          改方向
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={pending}
          onClick={() => onAccept('change_type', nextRelation)}
        >
          改关系
        </Button>
        <Button variant="ghost" size="sm" icon="x" disabled={pending} onClick={onDismiss}>
          忽略
        </Button>
        <Button
          variant="danger"
          size="sm"
          icon="trash"
          className="proposal-retract"
          disabled={pending}
          onClick={onRetract}
        >
          撤回
        </Button>
        <Link href={`/events/${proposal.id}`} className="inbox-inline-link">
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
  onAccept,
  onDismiss,
  onRetract,
}: {
  proposal: ProposalInboxRow & { payload: KnowledgeNodeProposalPayload };
  nodesById: Map<string, KnowledgeNode>;
  pending: boolean;
  onAccept: () => void;
  onDismiss: () => void;
  onRetract: () => void;
}) {
  const change = proposal.payload.proposed_change;
  return (
    <article className="proposal inbox-node-proposal">
      <div className="proposal-head">
        <span className="mini-badge info">
          <Icon name="network" size={11} /> AI · 新节点
        </span>
        <span className="title">{change.name}</span>
        <span className="inbox-card-meta">
          parent · {nodeName(nodesById, change.parent_id)} · {formatRelTime(proposal.proposed_at)}
        </span>
      </div>
      <div className="body">{proposal.payload.reason_md || '无推理说明'}</div>
      <ProposalStatusRow proposal={proposal} />
      <div className="proposal-actions">
        <Button variant="good" size="sm" icon="check" disabled={pending} onClick={onAccept}>
          接受
        </Button>
        <Button variant="ghost" size="sm" icon="x" disabled={pending} onClick={onDismiss}>
          忽略
        </Button>
        <Button
          variant="danger"
          size="sm"
          icon="trash"
          className="proposal-retract"
          disabled={pending}
          onClick={onRetract}
        >
          撤回
        </Button>
        <Link href={`/events/${proposal.id}`} className="inbox-inline-link">
          事件链
        </Link>
      </div>
    </article>
  );
}

function GenericProposalCard({
  proposal,
  pending,
  onDismiss,
  onRetract,
}: {
  proposal: ProposalInboxRow;
  pending: boolean;
  onDismiss: () => void;
  onRetract: () => void;
}) {
  return (
    <article className="proposal proposal-generic">
      <div className="proposal-head">
        <Badge tone={kindTone(proposal.kind)}>{kindLabel(proposal.kind)}</Badge>
        <span className="title">{targetLabel(proposal.target)}</span>
        <span className="inbox-card-meta">{proposalMeta(proposal)}</span>
      </div>
      <div className="body">{proposal.payload.reason_md || '无推理说明'}</div>
      <ProposalStatusRow proposal={proposal} />
      <div className="proposal-summary">
        <strong>proposed_change</strong>
        <pre className="proposal-json">
          {JSON.stringify(proposal.payload.proposed_change, null, 2)}
        </pre>
      </div>
      {proposal.payload.evidence_refs.length > 0 && (
        <div className="artifact-ref-row">
          {proposal.payload.evidence_refs.slice(0, 5).map((ref) => (
            <EvidenceRefChip ref={ref} key={`${ref.kind}:${ref.id}`} />
          ))}
        </div>
      )}
      <div className="proposal-actions">
        <Button
          variant="secondary"
          size="sm"
          icon="check"
          disabled
          title="YUK-44 接入 owner-service 后启用"
        >
          待接入
        </Button>
        <Button variant="ghost" size="sm" icon="x" disabled={pending} onClick={onDismiss}>
          忽略
        </Button>
        <Button
          variant="danger"
          size="sm"
          icon="trash"
          className="proposal-retract"
          disabled={pending}
          onClick={onRetract}
        >
          撤回
        </Button>
        <Link href={`/events/${proposal.id}`} className="inbox-inline-link">
          事件链
        </Link>
      </div>
    </article>
  );
}

// YUK-15 — clickable backlinks for evidence_refs. `event` jumps to the
// event-chain detail page (existing route). `record` jumps to the record
// list focused on the cited id. `question` is currently uninked — there's
// no per-question detail route yet (Linear follow-up if/when one lands).
function EvidenceRefChip({ ref }: { ref: ProposalEvidenceRef }) {
  const label = `${ref.kind}:${ref.id.slice(0, 8)}…`;
  const key = `${ref.kind}:${ref.id}`;
  if (ref.kind === 'event') {
    return (
      <Link href={`/events/${ref.id}`} key={key}>
        {label}
      </Link>
    );
  }
  if (ref.kind === 'record') {
    return (
      <Link href={`/record?focus=${encodeURIComponent(ref.id)}`} key={key}>
        {label}
      </Link>
    );
  }
  return <span key={key}>{label}</span>;
}

function ProposalStatusRow({ proposal }: { proposal: ProposalInboxRow }) {
  return (
    <div className="proposal-status-row">
      <span>{proposal.source_action}</span>
      <span>{proposal.source_subject_kind}</span>
      <span>{targetLabel(proposal.target)}</span>
      {proposal.task_run_id && <span>{proposal.task_run_id.slice(0, 12)}</span>}
      {typeof proposal.cost_micro_usd === 'number' && proposal.cost_micro_usd > 0 && (
        <span>${(proposal.cost_micro_usd / 1_000_000).toFixed(4)}</span>
      )}
    </div>
  );
}

function groupByKind(
  rows: ProposalInboxRow[],
): Array<{ kind: ProposalKind; rows: ProposalInboxRow[] }> {
  const groups = new Map<ProposalKind, ProposalInboxRow[]>();
  for (const row of rows) {
    const current = groups.get(row.kind);
    if (current) {
      current.push(row);
    } else {
      groups.set(row.kind, [row]);
    }
  }
  return [...groups.entries()].map(([kind, groupRows]) => ({ kind, rows: groupRows }));
}

function isKnowledgeNodeProposal(
  row: ProposalInboxRow,
): row is ProposalInboxRow & { payload: KnowledgeNodeProposalPayload } {
  return row.kind === 'knowledge_node';
}

function isKnowledgeEdgeProposal(
  row: ProposalInboxRow,
): row is ProposalInboxRow & { payload: KnowledgeEdgeProposalPayload } {
  return row.kind === 'knowledge_edge';
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

function proposalMeta(proposal: ProposalInboxRow): string {
  const parts = [
    proposal.actor_ref,
    proposal.task_run_id ? proposal.task_run_id.slice(0, 12) : null,
    typeof proposal.cost_micro_usd === 'number' && proposal.cost_micro_usd > 0
      ? `$${(proposal.cost_micro_usd / 1_000_000).toFixed(4)}`
      : null,
    formatRelTime(proposal.proposed_at),
  ].filter(Boolean);
  return parts.join(' · ');
}

function kindLabel(kind: ProposalKind): string {
  return KIND_LABELS[kind] ?? kind;
}

function kindTone(kind: ProposalKind): 'info' | 'good' | 'hard' | 'coral' | 'neutral' {
  switch (kind) {
    case 'knowledge_node':
      return 'info';
    case 'knowledge_edge':
      return 'coral';
    case 'learning_item':
    case 'completion':
    case 'record_links':
    case 'record_promotion':
      return 'good';
    case 'judge_retraction':
      return 'hard';
    case 'variant_question':
      return 'coral';
    default:
      return 'neutral';
  }
}

function targetLabel(target: ProposalTarget): string {
  return target.subject_id ? `${target.subject_kind}:${target.subject_id}` : target.subject_kind;
}
