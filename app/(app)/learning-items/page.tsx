'use client';

import {
  CorrectionStateRenderer,
  type CorrectionStateSnapshot,
} from '@/ui/correction/CorrectionStateRenderer';
import { ApiAuthError, apiJson } from '@/ui/lib/api';
import { Btn } from '@/ui/primitives/Btn';
import { EmptyState } from '@/ui/primitives/EmptyState';
import { LoomBadge } from '@/ui/primitives/LoomBadge';
import { LoomCard } from '@/ui/primitives/LoomCard';
import { LoomIcon } from '@/ui/primitives/LoomIcon';
import { SectionLabel } from '@/ui/primitives/SectionLabel';
import { SkLines } from '@/ui/primitives/SkLines';
import { Stateful } from '@/ui/primitives/Stateful';
import { StatusBadge } from '@/ui/primitives/StatusBadge';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

function matchesKnowledgeFilter(
  node: { name: string; effective_domain: string | null },
  filter: string,
): boolean {
  const f = filter.trim().toLowerCase();
  if (!f) return true;
  return (
    node.name.toLowerCase().includes(f) || (node.effective_domain ?? '').toLowerCase().includes(f)
  );
}

type ItemStatus = 'pending' | 'in_progress' | 'done' | 'resting' | 'dismissed' | 'archived';
type StatusFilter = 'all' | ItemStatus;

interface LearningItem {
  id: string;
  source: string;
  source_ref: string | null;
  source_event: { id: string; correction_state: CorrectionStateSnapshot | null } | null;
  title: string;
  content: string;
  knowledge_ids: string[];
  status: ItemStatus;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  version: number;
}

// status enum metadata — non-color cue (loom icon + zh label) per
// loom-prototype STATUS_META (data.jsx L366). "全部" handled separately.
const STATUS_META: Record<
  ItemStatus,
  { label: string; icon: 'clock' | 'review' | 'checkCircle' | 'moon' | 'close' | 'layers' }
> = {
  pending: { label: '待办', icon: 'clock' },
  in_progress: { label: '进行中', icon: 'review' },
  done: { label: '已完成', icon: 'checkCircle' },
  resting: { label: '养护', icon: 'moon' },
  dismissed: { label: '已拒', icon: 'close' },
  archived: { label: '归档', icon: 'layers' },
};

// Tabs: 全部 + live statuses (archived is surfaced in the collapse zone, not a
// tab) per screen-items.jsx L102.
const TAB_STATUSES: ItemStatus[] = ['pending', 'in_progress', 'done', 'resting', 'dismissed'];

interface KnowledgeNode {
  id: string;
  name: string;
  effective_domain: string | null;
  mastery: number | null;
  evidence_count: number;
}

// /api/knowledge/review-due-summary response (existing GET endpoint). Inlined
// minimal shape so the client never imports the route module.
interface ReviewDueSummary {
  summary: Record<string, { overdue: number; due_soon: number }>;
}

interface IntentProposal {
  proposal_id: string;
  topic: string;
  knowledge_node: { id: string; name: string; domain: string | null };
  hub: { title: string; summary_md: string };
  atomics: Array<{ knowledge_id: string; title: string; one_line_intent: string }>;
}

// D11 health-bar aggregation (read-time only, zero owned state — see
// docs/design/2026-06-04-u0-decisions.md D11③). For a learning item's
// knowledge_ids: count nodes, sum overdue due-cards, average mastery over
// nodes WITH evidence. evidence-guard: if every node has evidence_count < 3
// the bar renders muted (no misleading mastery%).
function aggregateHealth(
  knowledgeIds: string[],
  knowledgeById: Map<string, KnowledgeNode>,
  dueSummary: Record<string, { overdue: number; due_soon: number }> | undefined,
): { nodeCount: number; dueCount: number; avgMastery: number | null; lowEvidence: boolean } {
  const nodeCount = knowledgeIds.length;
  let dueCount = 0;
  let masterySum = 0;
  let masteryNodes = 0;
  let anyEvidence = false;
  for (const kid of knowledgeIds) {
    dueCount += dueSummary?.[kid]?.overdue ?? 0;
    const node = knowledgeById.get(kid);
    if (node) {
      if (node.evidence_count >= 3) anyEvidence = true;
      if (node.evidence_count > 0 && node.mastery !== null) {
        masterySum += node.mastery;
        masteryNodes += 1;
      }
    }
  }
  const avgMastery = masteryNodes > 0 ? Math.round((masterySum / masteryNodes) * 100) : null;
  return { nodeCount, dueCount, avgMastery, lowEvidence: !anyEvidence };
}

function ItemHealthBar({
  health,
}: {
  health: { nodeCount: number; dueCount: number; avgMastery: number | null; lowEvidence: boolean };
}) {
  if (health.nodeCount === 0) return null;
  return (
    <div className={`item-health${health.lowEvidence ? ' muted' : ''}`}>
      <span className="health-seg">
        <span className="health-n tnum">{health.nodeCount}</span>
        <span className="health-l">知识点</span>
      </span>
      <span className="health-seg due">
        <span className="health-n tnum">{health.dueCount}</span>
        <span className="health-l">到期</span>
      </span>
      <span className="health-seg">
        <span className="health-n tnum">
          {health.avgMastery === null ? '—' : `${health.avgMastery}%`}
        </span>
        <span className="health-l">平均掌握</span>
      </span>
    </div>
  );
}

export default function LearningItemsPage() {
  const qc = useQueryClient();
  const router = useRouter();
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [newTitle, setNewTitle] = useState('');
  const [newKnowledgeIds, setNewKnowledgeIds] = useState<string[]>([]);
  const [knowledgeFilter, setKnowledgeFilter] = useState('');
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [editingKnowledgeId, setEditingKnowledgeId] = useState<string | null>(null);
  const [draftKnowledgeIds, setDraftKnowledgeIds] = useState<string[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);

  // Phase 2B intent flow state
  const [intentTopic, setIntentTopic] = useState('');
  const [intentProposal, setIntentProposal] = useState<IntentProposal | null>(null);
  const [intentError, setIntentError] = useState<string | null>(null);

  const intentPlanM = useMutation({
    mutationFn: (topic: string) =>
      apiJson<IntentProposal>('/api/learning-intents', {
        method: 'POST',
        body: JSON.stringify({ topic }),
      }),
    onSuccess: (data) => {
      setIntentProposal(data);
      setIntentError(null);
    },
    onError: (err: Error) => {
      setIntentError(err.message);
      setIntentProposal(null);
    },
  });

  const intentAcceptM = useMutation({
    mutationFn: (proposalId: string) =>
      apiJson<{ hub_learning_item_id: string }>(`/api/learning-intents/${proposalId}/accept`, {
        method: 'POST',
      }),
    onSuccess: (data) => {
      setIntentProposal(null);
      setIntentTopic('');
      qc.invalidateQueries({ queryKey: ['learning-items'] });
      router.push(`/learning-items/${data.hub_learning_item_id}`);
    },
  });

  // Fetch ALL items (no status filter) so the live grid + archived collapse
  // zone derive from one query (TDM 决策3 — archived is always available to
  // toggle, not gated behind a tab refetch). Client-side filter by tab below.
  const itemsQ = useQuery({
    queryKey: ['learning-items', 'all-with-archived'],
    queryFn: () =>
      apiJson<{ rows: LearningItem[] }>('/api/learning-items?limit=200&status=archived').then(
        async (archivedRes) => {
          const liveRes = await apiJson<{ rows: LearningItem[] }>('/api/learning-items?limit=200');
          return { rows: [...liveRes.rows, ...archivedRes.rows] };
        },
      ),
  });

  const knowledgeQ = useQuery({
    queryKey: ['knowledge'],
    queryFn: () => apiJson<{ rows: KnowledgeNode[] }>('/api/knowledge'),
  });
  const knowledgeById = new Map(knowledgeQ.data?.rows.map((n) => [n.id, n]) ?? []);

  // D11 health bar — per-knowledge-node overdue/due counts. Existing GET
  // endpoint (zero new table / write path; audit:schema unaffected).
  const dueSummaryQ = useQuery({
    queryKey: ['review-due-summary'],
    queryFn: () => apiJson<ReviewDueSummary>('/api/knowledge/review-due-summary'),
  });

  const createM = useMutation({
    mutationFn: (payload: { title: string; knowledge_ids: string[] }) =>
      apiJson<{ id: string }>('/api/learning-items', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      setNewTitle('');
      setNewKnowledgeIds([]);
      qc.invalidateQueries({ queryKey: ['learning-items'] });
    },
  });

  const updateM = useMutation({
    mutationFn: (vars: {
      id: string;
      version: number;
      status?: ItemStatus;
      knowledge_ids?: string[];
    }) =>
      apiJson(`/api/learning-items/${vars.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          version: vars.version,
          ...(vars.status ? { status: vars.status } : {}),
          ...(vars.knowledge_ids ? { knowledge_ids: vars.knowledge_ids } : {}),
        }),
      }),
    onSuccess: () => {
      setEditingKnowledgeId(null);
      qc.invalidateQueries({ queryKey: ['learning-items'] });
    },
  });

  // Preserved verbatim from the legacy page (signature + call unchanged per
  // "接线不动"). NOTE: the DELETE route requires a `?version=` query param it is
  // not sent here — this mismatch predates the redraw; not fixed in this UI-only
  // slice (out of scope). Tracked as a follow-up gap, not a redraw regression.
  const deleteM = useMutation({
    mutationFn: (id: string) => apiJson(`/api/learning-items/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      setPendingDeleteId(null);
      qc.invalidateQueries({ queryKey: ['learning-items'] });
    },
  });

  const allRows = itemsQ.data?.rows ?? [];
  const live = allRows.filter((i) => i.status !== 'archived');
  const archived = allRows.filter((i) => i.status === 'archived');
  const filtered = filter === 'all' ? live : live.filter((i) => i.status === filter);

  const dataState: 'loading' | 'error' | 'empty' | 'ok' = itemsQ.isLoading
    ? 'loading'
    : itemsQ.isError
      ? 'error'
      : live.length === 0
        ? 'empty'
        : 'ok';

  return (
    <main className="page prose items-loom">
      <div className="page-head">
        <div className="eyebrow">
          ITEMS · learning_item · {live.length} 活跃 · {archived.length} 归档
        </div>
        <div className="page-head-row">
          <h1 className="page-title serif">学习项</h1>
          <div className="hero-cta">
            <Btn variant="ghost" icon="history" onClick={() => router.push('/learning-sessions')}>
              会话历史
            </Btn>
            <Btn variant="secondary" icon="plus" onClick={() => setCreateOpen((o) => !o)}>
              新增
            </Btn>
          </div>
        </div>
        <p className="page-lead">
          自由 TODO，不进入 FSRS 排程。intent 可以拆成 hub + atomic learning
          items。归档项不在主列表显示。
        </p>
      </div>

      {/* Phase 2B — Learning Intent input (real wiring preserved; loom skin) */}
      <LoomCard pad className="intent-card">
        <div className="card-head">
          <span className="card-icon accent">
            <LoomIcon name="sparkle" size={18} />
          </span>
          <div className="card-title">我想学 → AI 拆解</div>
          <span className="meta mono" style={{ marginLeft: 'auto' }}>
            learning_item · propose
          </span>
        </div>
        <div className="intent-input-row" style={{ display: 'flex', gap: 'var(--s-2)' }}>
          <input
            type="text"
            value={intentTopic}
            onChange={(e) => setIntentTopic(e.target.value)}
            placeholder="例：虚词、文言句式、氧化还原反应"
            maxLength={80}
            disabled={intentPlanM.isPending || intentAcceptM.isPending}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && intentTopic.trim() && !intentPlanM.isPending) {
                intentPlanM.mutate(intentTopic.trim());
              }
            }}
            className="field-input"
            style={{ flex: 1 }}
          />
          <Btn
            variant="primary"
            icon="sparkle"
            onClick={() => intentTopic.trim() && intentPlanM.mutate(intentTopic.trim())}
            disabled={!intentTopic.trim() || intentPlanM.isPending || intentAcceptM.isPending}
          >
            {intentPlanM.isPending ? '生成中…' : '拆解'}
          </Btn>
        </div>
        {intentError && (
          <p className="meta" style={{ color: 'var(--again-ink)', marginTop: 'var(--s-2)' }}>
            {intentError}
          </p>
        )}
        {intentProposal && (
          <div className="decomp fade-key" style={{ marginTop: 'var(--s-3)' }}>
            <div className="decomp-hub">
              <LoomBadge tone="coral">
                <LoomIcon name="items" size={12} />
                hub
              </LoomBadge>
              <div>
                <div className="item-title">{intentProposal.hub.title}</div>
                <div className="item-sub">#{intentProposal.knowledge_node.name}</div>
              </div>
            </div>
            <div className="decomp-atomics">
              {intentProposal.atomics.map((a) => (
                <div key={a.knowledge_id} className="decomp-atomic">
                  <LoomBadge tone="info">atomic</LoomBadge>
                  <div>
                    <div className="item-title">{a.title}</div>
                    <div className="item-sub">{a.one_line_intent}</div>
                  </div>
                </div>
              ))}
            </div>
            <div className="hero-cta">
              <Btn
                variant="primary"
                icon="check"
                onClick={() => intentAcceptM.mutate(intentProposal.proposal_id)}
                disabled={intentAcceptM.isPending}
              >
                {intentAcceptM.isPending
                  ? '正在创建 + 入队…'
                  : `接受拆解（hub + ${intentProposal.atomics.length} atomic）`}
              </Btn>
              <Btn
                variant="ghost"
                icon="close"
                onClick={() => setIntentProposal(null)}
                disabled={intentAcceptM.isPending}
              >
                忽略
              </Btn>
            </div>
            {intentAcceptM.isError && (
              <p className="meta" style={{ color: 'var(--again-ink)', marginTop: 'var(--s-2)' }}>
                Accept 失败：{(intentAcceptM.error as Error).message}
              </p>
            )}
          </div>
        )}
      </LoomCard>

      {/* manual create form — collapsed by default, opened via 新增 CTA */}
      {createOpen && (
        <LoomCard pad className="fade-key" style={{ marginBottom: 'var(--s-5)' }}>
          <div className="field-label">新增学习项</div>
          <input
            type="text"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder="例：FSRS 间隔重复算法"
            maxLength={200}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && newTitle.trim() && !createM.isPending) {
                createM.mutate({ title: newTitle.trim(), knowledge_ids: newKnowledgeIds });
              }
            }}
            className="field-input"
          />
          <p className="field-label" style={{ marginTop: 'var(--s-3)' }}>
            知识点（可选，已选 {newKnowledgeIds.length}）
          </p>
          <input
            type="text"
            value={knowledgeFilter}
            onChange={(e) => setKnowledgeFilter(e.target.value)}
            placeholder="搜索知识点"
            className="field-input"
          />
          <div className="chip-set" style={{ marginTop: 'var(--s-2)' }}>
            {(knowledgeQ.data?.rows ?? [])
              .filter((n) => matchesKnowledgeFilter(n, knowledgeFilter))
              .slice(0, 30)
              .map((n) => {
                const selected = newKnowledgeIds.includes(n.id);
                return (
                  <button
                    type="button"
                    key={n.id}
                    onClick={() =>
                      setNewKnowledgeIds((cur) =>
                        cur.includes(n.id) ? cur.filter((x) => x !== n.id) : [...cur, n.id],
                      )
                    }
                    className={`chip${selected ? ' is-on' : ''}`}
                    title={n.effective_domain ?? ''}
                  >
                    {n.name}
                  </button>
                );
              })}
          </div>
          <div className="hero-cta" style={{ justifyContent: 'flex-end', marginTop: 'var(--s-3)' }}>
            <Btn
              variant="primary"
              onClick={() =>
                newTitle.trim() &&
                createM.mutate({ title: newTitle.trim(), knowledge_ids: newKnowledgeIds })
              }
              disabled={!newTitle.trim() || createM.isPending}
            >
              {createM.isPending ? '创建中…' : '创建'}
            </Btn>
          </div>
          {createM.isError && (
            <p className="meta" style={{ color: 'var(--again-ink)', marginTop: 'var(--s-2)' }}>
              创建失败：{(createM.error as Error).message}
            </p>
          )}
        </LoomCard>
      )}

      <SectionLabel>学习项</SectionLabel>
      <div className="status-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={filter === 'all'}
          className={`status-tab${filter === 'all' ? ' on' : ''}`}
          onClick={() => setFilter('all')}
        >
          全部
          <span className="mono status-tab-n">{live.length}</span>
        </button>
        {TAB_STATUSES.map((s) => {
          const n = live.filter((i) => i.status === s).length;
          const m = STATUS_META[s];
          return (
            <button
              type="button"
              key={s}
              role="tab"
              aria-selected={filter === s}
              className={`status-tab${filter === s ? ' on' : ''}`}
              onClick={() => setFilter(s)}
            >
              <span className="status-glyph" aria-hidden="true">
                <LoomIcon name={m.icon} size={13} />
              </span>
              {m.label}
              <span className="mono status-tab-n">{n}</span>
            </button>
          );
        })}
      </div>

      <Stateful
        status={dataState}
        onRetry={() => itemsQ.refetch()}
        errorText={
          itemsQ.error instanceof ApiAuthError
            ? `${itemsQ.error.message} — 请重新进入页面输入 token`
            : '学习项加载失败。'
        }
        skeleton={
          <div className="items-grid">
            {[1, 2].map((i) => (
              <LoomCard key={i} pad>
                <SkLines rows={2} />
              </LoomCard>
            ))}
          </div>
        }
        empty={
          <EmptyState
            icon="items"
            title="还没有学习项"
            text="在上方输入一个学习意图，让 AI 拆解成可执行的子项。"
          />
        }
      >
        {filtered.length === 0 ? (
          <EmptyState
            icon="items"
            title={`没有「${filter === 'all' ? '全部' : STATUS_META[filter as ItemStatus].label}」的学习项`}
            text="切换其它状态，或新建一个学习意图。"
          />
        ) : (
          <div className="items-grid stagger">
            {filtered.map((item) => (
              <ItemCard
                key={item.id}
                item={item}
                health={aggregateHealth(
                  item.knowledge_ids,
                  knowledgeById,
                  dueSummaryQ.data?.summary,
                )}
                knowledgeById={knowledgeById}
                editingKnowledgeId={editingKnowledgeId}
                draftKnowledgeIds={draftKnowledgeIds}
                knowledgeFilter={knowledgeFilter}
                knowledgeRows={knowledgeQ.data?.rows ?? []}
                pendingDeleteId={pendingDeleteId}
                updatePending={updateM.isPending}
                deletePending={deleteM.isPending}
                onTransition={(status) =>
                  updateM.mutate({ id: item.id, version: item.version, status })
                }
                onStartEditKnowledge={() => {
                  setEditingKnowledgeId(item.id);
                  setDraftKnowledgeIds(item.knowledge_ids);
                  setKnowledgeFilter('');
                }}
                onToggleDraftKnowledge={(kid) =>
                  setDraftKnowledgeIds((cur) =>
                    cur.includes(kid) ? cur.filter((x) => x !== kid) : [...cur, kid],
                  )
                }
                onSaveKnowledge={() =>
                  updateM.mutate({
                    id: item.id,
                    version: item.version,
                    knowledge_ids: draftKnowledgeIds,
                  })
                }
                onCancelEditKnowledge={() => setEditingKnowledgeId(null)}
                onKnowledgeFilterChange={setKnowledgeFilter}
                onRequestDelete={() => setPendingDeleteId(item.id)}
                onConfirmDelete={() => deleteM.mutate(item.id)}
                onCancelDelete={() => setPendingDeleteId(null)}
              />
            ))}
          </div>
        )}
      </Stateful>

      {/* archived — collapsed by default, explicit open (TDM 决策3) */}
      {archived.length > 0 && (
        <div className="archive-zone">
          <button
            type="button"
            className="archive-toggle"
            aria-expanded={archiveOpen}
            onClick={() => setArchiveOpen((o) => !o)}
          >
            <LoomIcon name="archive" size={15} />
            <span>归档项</span>
            <span className="mono archive-n">{archived.length}</span>
            <LoomIcon
              name="arrow"
              size={14}
              className="archive-caret"
              style={{ transform: archiveOpen ? 'rotate(90deg)' : 'rotate(0deg)' }}
            />
          </button>
          {archiveOpen && (
            <div className="archive-list fade-key">
              {archived.map((item) => (
                <div key={item.id} className="archive-row">
                  <span className="item-ic info" style={{ width: 34, height: 34 }}>
                    <LoomIcon name="items" size={16} />
                  </span>
                  <Link href={`/learning-items/${item.id}`} className="archive-main">
                    <div className="archive-title">{item.title}</div>
                    {item.knowledge_ids.length > 0 && (
                      <div className="item-sub mono">{item.knowledge_ids.length} 知识点</div>
                    )}
                  </Link>
                  <Btn
                    size="sm"
                    variant="secondary"
                    icon="undo"
                    onClick={() =>
                      updateM.mutate({ id: item.id, version: item.version, status: 'pending' })
                    }
                    disabled={updateM.isPending}
                  >
                    取出归档
                  </Btn>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </main>
  );
}

function ItemCard({
  item,
  health,
  knowledgeById,
  editingKnowledgeId,
  draftKnowledgeIds,
  knowledgeFilter,
  knowledgeRows,
  pendingDeleteId,
  updatePending,
  deletePending,
  onTransition,
  onStartEditKnowledge,
  onToggleDraftKnowledge,
  onSaveKnowledge,
  onCancelEditKnowledge,
  onKnowledgeFilterChange,
  onRequestDelete,
  onConfirmDelete,
  onCancelDelete,
}: {
  item: LearningItem;
  health: { nodeCount: number; dueCount: number; avgMastery: number | null; lowEvidence: boolean };
  knowledgeById: Map<string, KnowledgeNode>;
  editingKnowledgeId: string | null;
  draftKnowledgeIds: string[];
  knowledgeFilter: string;
  knowledgeRows: KnowledgeNode[];
  pendingDeleteId: string | null;
  updatePending: boolean;
  deletePending: boolean;
  onTransition: (status: ItemStatus) => void;
  onStartEditKnowledge: () => void;
  onToggleDraftKnowledge: (kid: string) => void;
  onSaveKnowledge: () => void;
  onCancelEditKnowledge: () => void;
  onKnowledgeFilterChange: (v: string) => void;
  onRequestDelete: () => void;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
}) {
  const isEditing = editingKnowledgeId === item.id;
  return (
    <LoomCard pad hover className="item-card">
      <div className="item-head">
        <span className="item-ic coral">
          <LoomIcon name="items" size={22} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="item-title">
            <Link href={`/learning-items/${item.id}`}>{item.title}</Link>
          </div>
          {item.source_event && (
            <div className="item-sub mono">
              source event{' '}
              <Link href={`/events/${item.source_event.id}`} style={{ color: 'var(--coral)' }}>
                {item.source_event.id.slice(0, 8)}…
              </Link>{' '}
              <CorrectionStateRenderer state={item.source_event.correction_state} compact />
            </div>
          )}
        </div>
        <StatusBadge status={item.status} />
      </div>

      {item.content && <p className="item-sub">{item.content}</p>}

      <ItemHealthBar health={health} />

      {/* knowledge_ids display + inline editor (wiring preserved) */}
      {isEditing ? (
        <div>
          <div className="field-label">编辑知识点（已选 {draftKnowledgeIds.length}）</div>
          <input
            type="text"
            value={knowledgeFilter}
            onChange={(e) => onKnowledgeFilterChange(e.target.value)}
            placeholder="搜索"
            className="field-input"
          />
          <div className="chip-set" style={{ marginTop: 'var(--s-2)' }}>
            {knowledgeRows
              .filter((n) => matchesKnowledgeFilter(n, knowledgeFilter))
              .slice(0, 30)
              .map((n) => {
                const selected = draftKnowledgeIds.includes(n.id);
                return (
                  <button
                    type="button"
                    key={n.id}
                    onClick={() => onToggleDraftKnowledge(n.id)}
                    className={`chip${selected ? ' is-on' : ''}`}
                  >
                    {n.name}
                  </button>
                );
              })}
          </div>
          <div className="hero-cta" style={{ justifyContent: 'flex-end', marginTop: 'var(--s-2)' }}>
            <Btn size="sm" variant="ghost" onClick={onCancelEditKnowledge} disabled={updatePending}>
              取消
            </Btn>
            <Btn size="sm" variant="primary" onClick={onSaveKnowledge} disabled={updatePending}>
              {updatePending ? '保存中…' : '保存'}
            </Btn>
          </div>
        </div>
      ) : (
        item.knowledge_ids.length > 0 && (
          <div className="chip-set">
            {item.knowledge_ids.map((kid) => {
              const node = knowledgeById.get(kid);
              return (
                <Link
                  key={kid}
                  href={`/knowledge/${kid}`}
                  className="chip chip-k mono"
                  title={node?.effective_domain ?? kid}
                >
                  #{node?.name ?? kid}
                </Link>
              );
            })}
          </div>
        )
      )}

      <div className="item-tags item-foot-acts" style={{ marginLeft: 0 }}>
        {item.status === 'pending' && (
          <>
            <Btn
              size="sm"
              variant="hard"
              icon="review"
              onClick={() => onTransition('in_progress')}
              disabled={updatePending}
            >
              开始学
            </Btn>
            <Btn
              size="sm"
              variant="good"
              icon="check"
              onClick={() => onTransition('done')}
              disabled={updatePending}
            >
              我学完了
            </Btn>
          </>
        )}
        {item.status === 'in_progress' && (
          <>
            <Btn
              size="sm"
              variant="good"
              icon="check"
              onClick={() => onTransition('done')}
              disabled={updatePending}
            >
              我学完了
            </Btn>
            <Btn
              size="sm"
              variant="secondary"
              onClick={() => onTransition('pending')}
              disabled={updatePending}
            >
              改回待办
            </Btn>
          </>
        )}
        {item.status === 'done' && (
          <>
            <Btn
              size="sm"
              variant="secondary"
              icon="review"
              onClick={() => onTransition('in_progress')}
              disabled={updatePending}
            >
              重学
            </Btn>
            <Btn
              size="sm"
              variant="ghost"
              icon="moon"
              onClick={() => onTransition('resting')}
              disabled={updatePending}
            >
              去养护
            </Btn>
          </>
        )}
        {item.status === 'resting' && (
          <Btn
            size="sm"
            variant="secondary"
            icon="review"
            onClick={() => onTransition('in_progress')}
            disabled={updatePending}
          >
            复学
          </Btn>
        )}
        {item.status === 'dismissed' && (
          <Btn
            size="sm"
            variant="secondary"
            icon="undo"
            onClick={() => onTransition('pending')}
            disabled={updatePending}
          >
            恢复
          </Btn>
        )}
        <span style={{ flex: 1 }} />
        {!isEditing && (
          <Btn size="sm" variant="quiet" icon="tag" onClick={onStartEditKnowledge}>
            改知识点
          </Btn>
        )}
        <Btn
          size="sm"
          variant="ghost"
          icon="archive"
          onClick={() => onTransition('archived')}
          disabled={updatePending}
        >
          归档
        </Btn>
        {pendingDeleteId === item.id ? (
          <>
            <span className="meta" style={{ color: 'var(--again-ink)' }}>
              确认删除？
            </span>
            <Btn size="sm" variant="again" onClick={onConfirmDelete} disabled={deletePending}>
              确认
            </Btn>
            <Btn size="sm" variant="quiet" onClick={onCancelDelete} disabled={deletePending}>
              取消
            </Btn>
          </>
        ) : (
          <Btn size="sm" variant="quiet" icon="trash" onClick={onRequestDelete} aria-label="删除" />
        )}
      </div>
    </LoomCard>
  );
}
