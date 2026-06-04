'use client';

import type { AiProposalKindT } from '@/core/schema/proposal';
import { apiJson } from '@/ui/lib/api';
import { Btn } from '@/ui/primitives/Btn';
import { LoomBadge } from '@/ui/primitives/LoomBadge';
import type { LoomBadgeProps } from '@/ui/primitives/LoomBadge';
import { LoomCard } from '@/ui/primitives/LoomCard';
import { LoomIcon } from '@/ui/primitives/LoomIcon';
import { SectionLabel } from '@/ui/primitives/SectionLabel';
import { SkLines } from '@/ui/primitives/SkLines';
import { Stateful } from '@/ui/primitives/Stateful';
import type { StatefulStatus } from '@/ui/primitives/Stateful';
import { useCountUp } from '@/ui/primitives/useCountUp';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

interface DueRow {
  question_id: string;
}
interface MistakeRow {
  cause: { source?: 'user' | 'agent'; primary_category: string } | null;
}
interface LearningItem {
  id: string;
  status: 'pending' | 'in_progress' | 'done';
}
interface KnowledgeNode {
  id: string;
}
interface LearningSessionRow {
  id: string;
  type: string;
  status: 'started' | 'completed' | 'abandoned' | string;
  summary_md: string | null;
  started_at: number;
  ended_at: number | null;
  duration_ms: number | null;
  reviewed_count: number;
  rating_counts: { again: number; hard: number; good: number };
  knowledge_touched: string[];
}

interface CostSummary {
  window: { from: number; to: number; label: string };
  today: {
    spend: number;
    tokens_in: number;
    tokens_out: number;
    ledger_rows: number;
    tool_calls: number;
    by_task: Array<{ task_kind: string; spend: number; calls: number }>;
  };
}

interface AiChangeRow {
  event_id: string;
  artifact_id: string;
  created_at: string;
  actor_ref: string;
  ops_count: number;
  new_blocks: number;
  previous_artifact_version: number;
  next_artifact_version: number;
  undone: boolean;
}

// Derived from `aiProposalKinds` in src/core/schema/proposal — adding a new
// kind there forces a TS error in `KIND_TO_GROUP` below, preventing silent
// breakdown drift when the server emits a previously-unseen `by_kind` key.
type ProposalKindCounts = Record<AiProposalKindT, number>;

interface TodayProposalKpi {
  total: number;
  by_kind: ProposalKindCounts;
  has_more: boolean;
  limit: number;
  status: 'pending';
}

export default function TodayPage() {
  const queryClient = useQueryClient();
  const router = useRouter();
  const [undoingAiChangeIds, setUndoingAiChangeIds] = useState<string[]>([]);

  const dueQ = useQuery({
    queryKey: ['today-due'],
    queryFn: () => apiJson<{ rows: DueRow[] }>('/api/review/due?limit=200'),
  });
  const mistakesQ = useQuery({
    queryKey: ['today-mistakes'],
    queryFn: () => apiJson<{ rows: MistakeRow[] }>('/api/mistakes?limit=200'),
  });
  const itemsQ = useQuery({
    queryKey: ['today-items'],
    queryFn: () => apiJson<{ rows: LearningItem[] }>('/api/learning-items?limit=200'),
  });
  const knowledgeQ = useQuery({
    queryKey: ['today-knowledge'],
    queryFn: () => apiJson<{ rows: KnowledgeNode[] }>('/api/knowledge'),
  });
  const proposalKpiQ = useQuery({
    queryKey: ['today-proposal-kpi', 'pending'],
    queryFn: () => apiJson<TodayProposalKpi>('/api/today/proposals'),
    refetchInterval: 60_000,
  });
  const costQ = useQuery({
    queryKey: ['today-cost'],
    queryFn: () => apiJson<CostSummary>('/api/cost/today'),
    refetchInterval: 60_000,
  });
  const sessionsQ = useQuery({
    queryKey: ['today-review-sessions'],
    queryFn: () =>
      apiJson<{ rows: LearningSessionRow[] }>('/api/learning-sessions?type=review&limit=6'),
    refetchInterval: 60_000,
  });
  const aiChangesQ = useQuery({
    queryKey: ['today-ai-changes'],
    queryFn: () => apiJson<{ rows: AiChangeRow[] }>('/api/today/ai-changes'),
    refetchInterval: 60_000,
  });

  const dueCount = dueQ.data?.rows.length ?? 0;
  const mistakeRows = mistakesQ.data?.rows ?? [];
  const pendingAttrCount = mistakeRows.filter((m) => m.cause === null).length;
  const activeItemsCount = itemsQ.data?.rows.filter((i) => i.status !== 'done').length ?? 0;
  const knowledgeCount = knowledgeQ.data?.rows.length ?? 0;
  const proposalKpi = proposalKpiQ.data ?? null;
  const proposalGroups = proposalKpi
    ? proposalGroupCounts(proposalKpi.by_kind)
    : emptyProposalGroups;
  const pendingAiCount = proposalKpi?.total ?? 0;

  async function undoAiChanges(eventIds: string[]) {
    setUndoingAiChangeIds(eventIds);
    try {
      await apiJson('/api/today/ai-changes', {
        method: 'POST',
        body: JSON.stringify({ event_ids: eventIds }),
      });
      await queryClient.invalidateQueries({ queryKey: ['today-ai-changes'] });
    } finally {
      setUndoingAiChangeIds([]);
    }
  }

  // hero Copilot button — mirror app/(app)/layout.tsx openCopilot: the shell
  // mounts TodayCopilotDrawer globally with a hidden trigger; we drive it by
  // clicking that trigger instead of mounting a second drawer here.
  const openCopilot = () => {
    const trigger = document.querySelector<HTMLButtonElement>(
      '[data-testid="copilot-drawer-trigger"]',
    );
    trigger?.click();
  };

  // time-of-day greeting — loom screen-today.jsx LoomHero greet buckets
  // verbatim (hour thresholds 5 / 11 / 14 / 18). No user name (single-user
  // tool has no user model — gap §4); end with the 。full stop.
  // Single LOCAL Date instance for both the greeting hour and the eyebrow date —
  // toISOString() is UTC and would disagree with getHours() near local midnight.
  const now = new Date();
  const hour = now.getHours();
  const greet =
    hour < 5
      ? '夜深了'
      : hour < 11
        ? '早上好'
        : hour < 14
          ? '午安'
          : hour < 18
            ? '下午好'
            : '晚上好';
  const localDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate(),
  ).padStart(2, '0')}`;

  const kpis = [
    {
      key: 'due',
      icon: 'review' as const,
      label: 'FSRS · 到期',
      value: dueCount,
      foot: '到期复习',
      route: '/review',
    },
    {
      key: 'mistakes',
      icon: 'mistakes' as const,
      label: '错题 · 待归因',
      value: pendingAttrCount,
      foot: pendingAttrCount > 0 ? 'attempt:failure 无 judge' : '全部已归因',
      route: '/mistakes',
    },
    {
      key: 'proposals',
      icon: 'inbox' as const,
      label: 'AI 提议 · 待审',
      value: pendingAiCount,
      foot: proposalKpiSub(proposalGroups, proposalKpi?.has_more ?? false),
      route: '/inbox',
    },
    {
      key: 'knowledge',
      icon: 'knowledge' as const,
      label: '知识点',
      value: knowledgeCount,
      foot: 'tree + mesh',
      route: '/knowledge',
    },
  ];

  return (
    <main className="page wide today-page today-loom">
      <LoomCard padLg className="loom-hero">
        <svg
          className="hero-weave"
          viewBox="0 0 600 180"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <path className="wv wv1" d="M0 60 C 150 60, 150 100, 300 100 S 450 60, 600 60" />
          <path className="wv wv2" d="M0 90 C 150 90, 150 130, 300 130 S 450 90, 600 90" />
          <path className="wv wv3" d="M0 120 C 150 120, 150 160, 300 160 S 450 120, 600 120" />
        </svg>
        <div className="hero-inner">
          <div className="eyebrow">
            <span className="dot-sep">●</span>TODAY · {localDate} · phase 1c
          </div>
          <h1 className="page-title serif hero-title">{greet}。</h1>
          <p className="page-lead">
            昨晚 Dreaming agent 跑过；下面是它想让你看的几件事，再加你自己排的复习队列。
          </p>
          <div className="hero-cta">
            <Btn variant="primary" icon="review" onClick={() => router.push('/review')}>
              开始今日复习
            </Btn>
            <Btn variant="secondary" icon="record" onClick={() => router.push('/record')}>
              录入
            </Btn>
            <Btn
              variant="ghost"
              icon="refresh"
              onClick={() =>
                // Only this page's queries (all keyed 'today-*') — a bare
                // invalidateQueries() would mark every query app-wide stale.
                queryClient.invalidateQueries({
                  predicate: (q) =>
                    typeof q.queryKey[0] === 'string' && q.queryKey[0].startsWith('today-'),
                })
              }
            >
              刷新
            </Btn>
            <Btn variant="ghost" icon="copilot" onClick={openCopilot}>
              打开 Copilot
            </Btn>
          </div>
        </div>
      </LoomCard>

      <div className="kpi-row stagger" style={{ marginTop: 'var(--s-5)' }}>
        {kpis.map((kpi) => (
          <KpiCard key={kpi.key} kpi={kpi} />
        ))}
      </div>

      <SectionLabel count="3 缕">今日之线</SectionLabel>
      <div className="threads-grid stagger">
        <ThreadCard
          tone="coral"
          icon="review"
          label="LANE A · 复习"
          title={dueCount > 0 ? `${dueCount} 张卡片到期` : '队列已清空'}
          cta="开始复习"
          route="/review"
          badge={dueCount > 0 ? dueCount : null}
        />
        <ThreadCard
          tone="info"
          icon="items"
          label="LANE B · 意图"
          title={activeItemsCount > 0 ? `${activeItemsCount} 个意图在途` : '暂无在途意图'}
          cta="查看学习项"
          route="/learning-items"
        />
        <ThreadCard
          tone="good"
          icon="graph"
          label="LANE C · Coach"
          title="本周报表"
          cta="查看周报"
          route="/coach"
        />
      </div>

      <SectionLabel>进行中 · 待裁决</SectionLabel>
      <div className="dash-grid">
        <div className="dash-col">
          <SessionStrip
            sessions={sessionsQ.data?.rows ?? []}
            status={listStatus(
              sessionsQ.isLoading,
              sessionsQ.error,
              (sessionsQ.data?.rows ?? []).filter(
                (s) => s.status === 'started' || s.status === 'paused' || s.status === 'completed',
              ).length === 0,
            )}
            onRetry={() => sessionsQ.refetch()}
            onNavigate={(route) => router.push(route)}
          />
          <AiChangeActivityStrip
            rows={aiChangesQ.data?.rows ?? []}
            status={listStatus(
              aiChangesQ.isLoading,
              aiChangesQ.error,
              (aiChangesQ.data?.rows ?? []).length === 0,
            )}
            undoingIds={undoingAiChangeIds}
            onUndo={undoAiChanges}
            onRetry={() => aiChangesQ.refetch()}
          />
        </div>
        <div className="dash-col">
          <ProposalStrip
            total={pendingAiCount}
            groups={proposalGroups}
            hasMore={proposalKpi?.has_more ?? false}
            status={listStatus(proposalKpiQ.isLoading, proposalKpiQ.error, pendingAiCount === 0)}
            onRetry={() => proposalKpiQ.refetch()}
            onNavigate={(route) => router.push(route)}
          />
          <CostRibbon
            cost={costQ.data ?? null}
            status={costStatus(costQ.isLoading, costQ.error, costQ.data ?? null)}
            onRetry={() => costQ.refetch()}
          />
        </div>
      </div>

      {/*
        WeekHeat「本周编织」section OMITTED — pre-flight
        docs/design/2026-06-04-redraw-today-7b-preflight.md §4: no 7-day
        activity-aggregation endpoint exists yet, and the prototype's heat grid
        is hardcoded seed data. Per the no-mock policy this whole SectionLabel +
        Card + WeekHeat block is left out (not mocked). Restore once an activity
        aggregation endpoint lands.
      */}
    </main>
  );
}

// Derive a Stateful status for a list-backed card: loading wins, then error
// (never swallowed as empty), then empty when there are no rows, else ok.
function listStatus(isLoading: boolean, error: unknown, isEmpty: boolean): StatefulStatus {
  if (isLoading) return 'loading';
  if (error) return 'error';
  if (isEmpty) return 'empty';
  return 'ok';
}

// Cost card status: loading → error → empty (zero spend and no by_task rows) → ok.
function costStatus(isLoading: boolean, error: unknown, cost: CostSummary | null): StatefulStatus {
  if (isLoading) return 'loading';
  if (error) return 'error';
  if (!cost || (cost.today.spend === 0 && cost.today.by_task.length === 0)) {
    return 'empty';
  }
  return 'ok';
}

interface KpiCardData {
  key: string;
  icon: Parameters<typeof LoomIcon>[0]['name'];
  label: string;
  value: number;
  foot: string;
  route: string;
}

function KpiCard({ kpi }: { kpi: KpiCardData }) {
  const v = useCountUp(kpi.value, { dur: 1000 });
  return (
    <Link href={kpi.route} className="kpi-link" style={{ textDecoration: 'none' }}>
      <LoomCard pad hover className="kpi">
        <div className="kpi-label">
          <LoomIcon name={kpi.icon} size={14} />
          {kpi.label}
        </div>
        <div className="kpi-val tnum">{Math.round(v)}</div>
        <div className="kpi-foot kpi-sub">{kpi.foot}</div>
        <LoomIcon name="arrow" size={15} className="kpi-go" />
      </LoomCard>
    </Link>
  );
}

interface ThreadCardProps {
  tone: 'coral' | 'info' | 'good';
  icon: Parameters<typeof LoomIcon>[0]['name'];
  label: string;
  title: string;
  cta: string;
  route: string;
  badge?: number | null;
}

function ThreadCard({ tone, icon, label, title, cta, route, badge }: ThreadCardProps) {
  return (
    <Link href={route} className="thread-link" style={{ textDecoration: 'none' }}>
      <LoomCard hover pad className="thread-card">
        <div className="thread-top">
          <span className={`card-icon accent thread-ic tone-${tone}`}>
            <LoomIcon name={icon} size={18} />
          </span>
          {badge != null && badge > 0 && <LoomBadge tone={tone}>{badge}</LoomBadge>}
          <LoomIcon name="arrow" size={16} className="thread-arrow" />
        </div>
        <div className="thread-label meta">{label}</div>
        <div className="thread-title serif">{title}</div>
        <div className="thread-cta">
          {cta} <LoomIcon name="arrow" size={14} />
        </div>
      </LoomCard>
    </Link>
  );
}

// One session row in the loom strip. `tone` drives the strip-lead colour
// (good = active/completed, hard = paused). Buttons are Btn (never wrapped in a
// Link — button-in-anchor is invalid HTML); navigation goes through onNavigate
// (router.push). Labels + routes are kept EXACTLY as the legacy strip.
function SessionRow({
  row,
  tone,
  statusLabel,
  statusTone,
  buttonLabel,
  route,
  summary,
  onNavigate,
}: {
  row: LearningSessionRow;
  tone: 'good' | 'hard';
  statusLabel: string;
  statusTone: LoomBadgeProps['tone'];
  buttonLabel: string;
  route: string;
  summary?: string;
  onNavigate: (route: string) => void;
}) {
  const dist = `不会 ${row.rating_counts.again} · 模糊 ${row.rating_counts.hard} · 会了 ${row.rating_counts.good}`;
  const when =
    row.status === 'completed'
      ? formatDay(row.ended_at ?? row.started_at)
      : formatDuration(row.duration_ms);
  return (
    <div className="strip">
      <span className={`strip-lead tone-${tone}`}>
        <LoomIcon name={tone === 'good' ? 'review' : 'undo'} size={16} />
      </span>
      <div className="strip-body">
        <div className="strip-title">
          {row.type} · 已复习 {row.reviewed_count}
        </div>
        <div className="strip-sub nowrap-meta">
          <LoomBadge tone={statusTone}>{statusLabel}</LoomBadge>
          {dist} · {when}
        </div>
        {summary && <div className="strip-sub">{summary}</div>}
      </div>
      <div className="strip-end">
        <Btn size="sm" variant="ghost" iconEnd="arrow" onClick={() => onNavigate(route)}>
          {buttonLabel}
        </Btn>
      </div>
    </div>
  );
}

function SessionStrip({
  sessions,
  status,
  onRetry,
  onNavigate,
}: {
  sessions: LearningSessionRow[];
  status: StatefulStatus;
  onRetry: () => void;
  onNavigate: (route: string) => void;
}) {
  const active = sessions.find((s) => s.status === 'started');
  // YUK-57 — paused session row. Picked separately from started so the user
  // can resume an explicit pause from /today.
  const paused = sessions.find((s) => s.status === 'paused');
  const completed = sessions.find((s) => s.status === 'completed');

  return (
    <LoomCard pad>
      <div className="card-head">
        <span className="card-icon">
          <LoomIcon name="clock" size={18} />
        </span>
        <div className="card-title">进行中的会话</div>
        <span className="meta" style={{ marginLeft: 'auto' }}>
          review_session
        </span>
      </div>
      <Stateful
        status={status}
        onRetry={onRetry}
        errorText="无法读取会话状态。"
        skeleton={<SkLines rows={2} />}
        empty={<div className="quiet-empty">没有进行中的复习会话。</div>}
      >
        <div className="strip-list">
          {completed && (
            <SessionRow
              row={completed}
              tone="good"
              statusLabel="completed"
              statusTone="good"
              buttonLabel="开新 session"
              route="/review"
              summary={completed.summary_md ?? undefined}
              onNavigate={onNavigate}
            />
          )}
          {active && (
            <SessionRow
              row={active}
              tone="good"
              statusLabel="started"
              statusTone="info"
              buttonLabel="回到当前 session"
              route="/review"
              onNavigate={onNavigate}
            />
          )}
          {/* YUK-57 — paused session entry. Resume via ?session=<id> on /review. */}
          {paused && (
            <SessionRow
              row={paused}
              tone="hard"
              statusLabel="paused"
              statusTone="hard"
              buttonLabel="恢复 session"
              route={`/review?session=${paused.id}`}
              onNavigate={onNavigate}
            />
          )}
        </div>
      </Stateful>
    </LoomCard>
  );
}

function AiChangeActivityStrip({
  rows,
  status,
  undoingIds,
  onUndo,
  onRetry,
}: {
  rows: AiChangeRow[];
  status: StatefulStatus;
  undoingIds: string[];
  onUndo: (eventIds: string[]) => Promise<void>;
  onRetry: () => void;
}) {
  const activeRows = rows.filter((row) => !row.undone);
  const undoingSet = new Set(undoingIds);

  return (
    <LoomCard pad>
      <div className="card-head">
        <span className="card-icon accent">
          <LoomIcon name="undo" size={18} />
        </span>
        <div className="card-title">AI 改动 · 近 24h</div>
        <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 'var(--s-2)' }}>
          <LoomBadge tone="neutral">可回滚</LoomBadge>
          {/* KEEP — existing bulk "全部撤销" action (prototype has no bulk button;
              this is a real existing feature). undoAiChanges mutation unchanged. */}
          <Btn
            size="sm"
            variant="hard"
            icon="refresh"
            disabled={activeRows.length === 0 || undoingIds.length > 0}
            onClick={() => onUndo(activeRows.map((row) => row.event_id))}
          >
            全部撤销
          </Btn>
        </span>
      </div>
      <Stateful
        status={status}
        onRetry={onRetry}
        errorText="无法读取改动记录。"
        skeleton={<SkLines rows={2} />}
        empty={<div className="quiet-empty">过去 24 小时没有 AI 改动。</div>}
      >
        <div className="strip-list">
          {rows.slice(0, 6).map((row) => (
            <div key={row.event_id} className={`strip${row.undone ? ' is-undone' : ''}`}>
              <span className="strip-lead tone-coral">
                <LoomIcon name="sparkle" size={15} />
              </span>
              <div className="strip-body">
                <div className="strip-title">
                  <b className="mono">{row.actor_ref}</b> 改了{' '}
                  {/* plain text link (not a button) — keeps the existing
                      /events/{event_id} deep link on the artifact id */}
                  <Link href={`/events/${row.event_id}`}>
                    <code>{row.artifact_id.slice(0, 12)}</code>
                  </Link>
                </div>
                <div className="strip-sub nowrap-meta mono">
                  {row.ops_count} ops · 新增 {row.new_blocks} block · v
                  {row.previous_artifact_version}→v{row.next_artifact_version} ·{' '}
                  {formatDateTime(row.created_at)}
                </div>
              </div>
              <div className="strip-end">
                {row.undone ? (
                  <LoomBadge tone="good" dot>
                    <LoomIcon name="check" size={12} />
                    已撤销
                  </LoomBadge>
                ) : (
                  <Btn
                    size="sm"
                    variant="ghost"
                    icon="undo"
                    disabled={undoingSet.has(row.event_id)}
                    onClick={() => onUndo([row.event_id])}
                  >
                    {undoingSet.has(row.event_id) ? '撤销中...' : '撤销'}
                  </Btn>
                )}
              </div>
            </div>
          ))}
        </div>
      </Stateful>
    </LoomCard>
  );
}

function formatDuration(ms: number | null): string {
  if (!ms || ms < 0) return '0 分钟';
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return `${minutes} 分钟`;
}

function formatDay(seconds: number): string {
  const date = new Date(seconds * 1000);
  if (Number.isNaN(date.getTime())) return '未知';
  const today = new Date();
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const startOfDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const deltaDays = Math.round((startOfToday - startOfDay) / 86_400_000);
  if (deltaDays === 0) return '今天';
  if (deltaDays === 1) return '昨天';
  return `${deltaDays} 天前`;
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '未知';
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

interface ProposalGroups {
  nodes: number;
  edges: number;
  learning: number;
  content: number;
  review: number;
}

const emptyProposalGroups: ProposalGroups = {
  nodes: 0,
  edges: 0,
  learning: 0,
  content: 0,
  review: 0,
};

// Static map from every AiProposalKind to its UI group. TS enforces the
// Record's domain matches `aiProposalKinds` — a new kind without an entry
// fails typecheck, so breakdown stays in sync with the server-side enum.
const KIND_TO_GROUP: Record<AiProposalKindT, keyof ProposalGroups> = {
  knowledge_node: 'nodes',
  knowledge_edge: 'edges',
  knowledge_mutation: 'nodes',
  learning_item: 'learning',
  completion: 'learning',
  relearn: 'learning',
  defer: 'learning',
  record_links: 'learning',
  record_promotion: 'learning',
  archive: 'learning',
  note_update: 'content',
  variant_question: 'content',
  judge_retraction: 'review',
  // YUK-143 / ADR-0024 — North-Star goal_scope proposals bucket under
  // 'learning' for the W9 breakdown count. The dedicated /today goal card +
  // goal-lens UI is Wave-10; this entry only keeps the exhaustive Record in
  // sync with the server-side aiProposalKinds enum (no behavior change).
  goal_scope: 'learning',
  // YUK-202 / BlockAssembly path-B (design 2026-06-02 §1) — block_merge
  // proposals are inbox review items; bucket under 'review' for the breakdown
  // count. The dedicated inbox row (primary + merge-block preview, confidence,
  // continuity_signal badge) is the deferred UI redraw slice (design §6 UI);
  // this entry only keeps the exhaustive Record in sync with aiProposalKinds.
  block_merge: 'review',
};

function proposalGroupCounts(counts: ProposalKindCounts): ProposalGroups {
  const groups: ProposalGroups = { ...emptyProposalGroups };
  for (const [kind, count] of Object.entries(counts) as [AiProposalKindT, number][]) {
    groups[KIND_TO_GROUP[kind]] += count;
  }
  return groups;
}

// KPI foot sub for the AI-proposal card — derived from the existing 5-group
// breakdown (not raw kinds, per pre-flight §4 gap). Empty when nothing pending.
function proposalKpiSub(groups: ProposalGroups, hasMore: boolean): string {
  const parts = [
    groups.edges > 0 ? `关系 ${groups.edges}` : null,
    groups.nodes > 0 ? `新节点 ${groups.nodes}` : null,
    groups.learning > 0 ? `学习项 ${groups.learning}` : null,
    groups.content > 0 ? `内容 ${groups.content}` : null,
    groups.review > 0 ? `复核 ${groups.review}` : null,
  ].filter((part): part is string => Boolean(part));
  if (parts.length === 0) return '全部清空';
  return `${parts.join(' · ')}${hasMore ? ' · 还有更多' : ''}`;
}

// Proposal-group chip metadata: label + .tone-chip-<tone> class. Tones chosen
// to match the loom chip vocabulary (.tone-chip-info/coral/good/hard/neutral):
// content=info, learning=neutral, knowledge nodes/edges=coral (both touch the
// graph), review=hard. Order = the legacy InboxStrip breakdown order.
const PROPOSAL_GROUP_META: Array<{
  key: keyof ProposalGroups;
  label: string;
  // Union of the .tone-chip-* classes the 7B CSS layer defines — a typo here
  // would silently produce a nonexistent class, so let TS catch it.
  tone: 'info' | 'neutral' | 'coral' | 'good' | 'hard';
}> = [
  { key: 'content', label: '内容生成', tone: 'info' },
  { key: 'learning', label: '学习项', tone: 'neutral' },
  { key: 'nodes', label: '新知识点', tone: 'coral' },
  { key: 'edges', label: '关系建议', tone: 'coral' },
  { key: 'review', label: '复核', tone: 'hard' },
];

function ProposalStrip({
  total,
  groups,
  hasMore,
  status,
  onRetry,
  onNavigate,
}: {
  total: number;
  groups: ProposalGroups;
  hasMore: boolean;
  status: StatefulStatus;
  onRetry: () => void;
  onNavigate: (route: string) => void;
}) {
  const totalLabel = hasMore ? `${total}+` : String(total);

  return (
    <LoomCard pad>
      <div className="card-head">
        <span className="card-icon">
          <LoomIcon name="inbox" size={18} />
        </span>
        <div className="card-title">提议收件箱</div>
        <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 'var(--s-2)' }}>
          {/* KEEP — existing "知识图谱" shortcut (prototype has no such button);
              shown only when there are graph-touching proposals. */}
          {groups.nodes + groups.edges > 0 && (
            <Btn size="sm" variant="ghost" onClick={() => onNavigate('/knowledge')}>
              知识图谱
            </Btn>
          )}
          <Btn size="sm" variant="ghost" iconEnd="arrow" onClick={() => onNavigate('/inbox')}>
            去裁决
          </Btn>
        </span>
      </div>
      <Stateful
        status={status}
        onRetry={onRetry}
        errorText="无法读取提议。"
        skeleton={<SkLines rows={1} />}
        empty={<div className="quiet-empty">没有待审提议。</div>}
      >
        <div className="prop-summary">
          <div className="prop-summary-n serif tnum">{totalLabel}</div>
          <div className="prop-summary-kinds">
            {PROPOSAL_GROUP_META.filter((m) => groups[m.key] > 0).map((m) => (
              <span key={m.key} className={`chip tone-chip-${m.tone}`}>
                {m.label} <b className="mono">{groups[m.key]}</b>
              </span>
            ))}
          </div>
        </div>
      </Stateful>
    </LoomCard>
  );
}

function CostRibbon({
  cost,
  status,
  onRetry,
}: {
  cost: CostSummary | null;
  status: StatefulStatus;
  onRetry: () => void;
}) {
  // Budget stays hardcoded at 5 (existing behaviour, pre-flight §4 — no budget
  // config exists; this is not a new mock).
  const budget = 5;
  const fmtUsd = (n: number) => `$${n.toFixed(n < 0.01 ? 5 : 3)}`;
  const spend = cost?.today.spend ?? 0;
  const pct = Math.min(100, Math.round((spend / budget) * 100));
  const top = (cost?.today.by_task ?? [])
    .slice()
    .sort((a, b) => b.spend - a.spend)
    .slice(0, 3);

  return (
    <LoomCard pad>
      <div className="card-head">
        <span className="card-icon">
          <LoomIcon name="bolt" size={18} />
        </span>
        <div className="card-title">今日 AI 成本</div>
        <span className="meta" style={{ marginLeft: 'auto' }}>
          预算 ${budget.toFixed(2)}
        </span>
      </div>
      <Stateful
        status={status}
        onRetry={onRetry}
        errorText="成本服务暂不可用。"
        skeleton={<SkLines rows={1} />}
        empty={<div className="quiet-empty">今日尚无 AI 花费。</div>}
      >
        {cost && (
          <>
            <div className="cost-top">
              <div className="cost-amt serif tnum">
                ${spend.toFixed(3)}
                <span className="cost-budget"> / ${budget.toFixed(2)}</span>
              </div>
            </div>
            <div className="bar" aria-label={`成本 ${pct}%`} style={{ marginBottom: 'var(--s-3)' }}>
              <span style={{ width: `${pct}%` }} />
            </div>
            {top.length > 0 && (
              <div className="cost-tasks">
                {top.map((t) => (
                  <span key={t.task_kind} className="chip">
                    <span className="mono">{t.task_kind}</span>{' '}
                    <b className="mono">{fmtUsd(t.spend)}</b>
                  </span>
                ))}
              </div>
            )}
            <div className="cost-foot nowrap-meta mono">
              tokens {(cost.today.tokens_in / 1000).toFixed(1)}k in ·{' '}
              {(cost.today.tokens_out / 1000).toFixed(1)}k out · {cost.today.tool_calls} tool calls
              · {cost.today.ledger_rows} ledger
            </div>
          </>
        )}
      </Stateful>
    </LoomCard>
  );
}
