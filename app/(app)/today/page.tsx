'use client';

import type { AiProposalKindT } from '@/core/schema/proposal';
import { apiJson } from '@/ui/lib/api';
import { Badge } from '@/ui/primitives/Badge';
import { Btn } from '@/ui/primitives/Btn';
import { Button } from '@/ui/primitives/Button';
import { LoomBadge } from '@/ui/primitives/LoomBadge';
import { LoomCard } from '@/ui/primitives/LoomCard';
import { LoomIcon } from '@/ui/primitives/LoomIcon';
import { SectionLabel } from '@/ui/primitives/SectionLabel';
import { useCountUp } from '@/ui/primitives/useCountUp';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
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
  const hour = new Date().getHours();
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
            <span className="dot-sep">●</span>TODAY · {new Date().toISOString().slice(0, 10)} ·
            phase 1c
          </div>
          <h1 className="page-title serif hero-title">{greet}。</h1>
          <p className="page-lead">
            昨晚 Dreaming agent 跑过；下面是它想让你看的几件事，再加你自己排的复习队列。
          </p>
          <div className="hero-cta">
            <Link href="/review" style={{ textDecoration: 'none' }}>
              <Btn variant="primary" icon="review">
                开始今日复习
              </Btn>
            </Link>
            <Link href="/record" style={{ textDecoration: 'none' }}>
              <Btn variant="secondary" icon="record">
                录入
              </Btn>
            </Link>
            <Btn variant="ghost" icon="refresh" onClick={() => queryClient.invalidateQueries()}>
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

      <SessionStrip sessions={sessionsQ.data?.rows ?? []} loading={sessionsQ.isLoading} />

      <AiChangeActivityStrip
        rows={aiChangesQ.data?.rows ?? []}
        loading={aiChangesQ.isLoading}
        undoingIds={undoingAiChangeIds}
        onUndo={undoAiChanges}
      />

      <InboxStrip
        total={pendingAiCount}
        groups={proposalGroups}
        hasMore={proposalKpi?.has_more ?? false}
      />

      <CostRibbon
        cost={costQ.data ?? null}
        loading={costQ.isLoading}
        error={costQ.error as Error | null}
      />
    </main>
  );
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

function SessionStrip({
  sessions,
  loading,
}: {
  sessions: LearningSessionRow[];
  loading: boolean;
}) {
  const active = sessions.find((s) => s.status === 'started');
  // YUK-57 — paused session row. Picked separately from started so the user
  // can resume an explicit pause from /today.
  const paused = sessions.find((s) => s.status === 'paused');
  const completed = sessions.find((s) => s.status === 'completed');
  if (!active && !paused && !completed) {
    if (!loading) return null;
    return (
      <div className="session-strip">
        <div className="ss-row">
          <div className="ss-line">
            <Badge tone="neutral">sessions</Badge>
            <span className="ss-stat">正在加载 review session…</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="session-strip">
      {completed && (
        <div className="ss-row ss-completed">
          <div className="ss-line">
            <Badge tone="good" dot dotStatic>
              completed
            </Badge>
            <span className="ss-id">
              <code>{completed.id.slice(0, 12)}</code>
            </span>
            <span className="ss-stat">
              {completed.reviewed_count} 卡 · {formatDuration(completed.duration_ms)} ·{' '}
              {formatDay(completed.ended_at ?? completed.started_at)}
            </span>
            <span style={{ flex: 1 }} />
            <Link href="/review" style={{ textDecoration: 'none' }}>
              <Button variant="quiet" size="sm" iconRight="arrowR">
                开新 session
              </Button>
            </Link>
          </div>
          <p className="ss-summary">
            {completed.summary_md ??
              `不会 ${completed.rating_counts.again} · 模糊 ${completed.rating_counts.hard} · 会了 ${completed.rating_counts.good}`}
          </p>
        </div>
      )}

      {active && (
        <div className="ss-row ss-active">
          <div className="ss-line">
            <Badge tone="info" dot>
              started
            </Badge>
            <span className="ss-id">
              <code>{active.id.slice(0, 12)}</code>
            </span>
            <span className="ss-stat">
              eager 创建 · 已复习 {active.reviewed_count} · 退出 sendBeacon → completed · cron 6h
              兜底 abandoned
            </span>
            <span style={{ flex: 1 }} />
            <Link href="/review" style={{ textDecoration: 'none' }}>
              <Button variant="quiet" size="sm" iconRight="arrowR">
                回到当前 session
              </Button>
            </Link>
          </div>
        </div>
      )}

      {/* YUK-57 — paused session entry. Resume via ?session=<id> on /review. */}
      {paused && (
        <div className="ss-row ss-active">
          <div className="ss-line">
            <Badge tone="info" dot dotStatic>
              paused
            </Badge>
            <span className="ss-id">
              <code>{paused.id.slice(0, 12)}</code>
            </span>
            <span className="ss-stat">
              已暂停 · 已复习 {paused.reviewed_count} · 6h 不恢复则 cron 兜底 abandoned
            </span>
            <span style={{ flex: 1 }} />
            <Link href={`/review?session=${paused.id}`} style={{ textDecoration: 'none' }}>
              <Button variant="quiet" size="sm" iconRight="arrowR">
                恢复 session
              </Button>
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}

function AiChangeActivityStrip({
  rows,
  loading,
  undoingIds,
  onUndo,
}: {
  rows: AiChangeRow[];
  loading: boolean;
  undoingIds: string[];
  onUndo: (eventIds: string[]) => Promise<void>;
}) {
  const activeRows = rows.filter((row) => !row.undone);
  const undoingSet = new Set(undoingIds);
  if (!loading && rows.length === 0) return null;

  return (
    <div className="ai-change-strip">
      <div className="ai-change-strip-head">
        <div>
          <Badge tone="info">Living Note</Badge>
          <h3>过去 24 小时 AI 改过 {loading ? '...' : rows.length} 处笔记</h3>
        </div>
        <Button
          variant="danger"
          size="sm"
          icon="refresh"
          disabled={activeRows.length === 0 || undoingIds.length > 0}
          onClick={() => onUndo(activeRows.map((row) => row.event_id))}
        >
          全部撤销
        </Button>
      </div>
      {rows.slice(0, 6).map((row) => (
        <div key={row.event_id} className="ai-change-strip-row">
          <Link href={`/events/${row.event_id}`}>
            <code>{row.artifact_id.slice(0, 12)}</code>
          </Link>
          <span>
            {row.ops_count} ops · 新增 {row.new_blocks} block · {formatDateTime(row.created_at)}
          </span>
          <Button
            variant={row.undone ? 'quiet' : 'danger'}
            size="sm"
            icon={row.undone ? 'check' : 'refresh'}
            disabled={row.undone || undoingSet.has(row.event_id)}
            onClick={() => onUndo([row.event_id])}
          >
            {row.undone ? '已撤销' : undoingSet.has(row.event_id) ? '撤销中...' : '撤销'}
          </Button>
        </div>
      ))}
    </div>
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

function InboxStrip({
  total,
  groups,
  hasMore,
}: {
  total: number;
  groups: ProposalGroups;
  hasMore: boolean;
}) {
  if (total === 0) return null;
  const totalLabel = hasMore ? `${total}+` : String(total);

  return (
    <div className="inbox-strip">
      <div className="inbox-text">
        <div className="src">
          <Badge tone="coral">agent</Badge> · pending only · unified inbox
        </div>
        <h3>昨晚 AI 提议了 {totalLabel} 条，要看吗？</h3>
        <div className="breakdown">
          {groups.content > 0 && (
            <div>
              <b>{groups.content}</b>
              <span>内容生成</span>
            </div>
          )}
          {groups.learning > 0 && (
            <div>
              <b>{groups.learning}</b>
              <span>学习项</span>
            </div>
          )}
          {groups.nodes > 0 && (
            <div>
              <b>{groups.nodes}</b>
              <span>新知识点</span>
            </div>
          )}
          {groups.edges > 0 && (
            <div>
              <b>{groups.edges}</b>
              <span>关系建议</span>
            </div>
          )}
          {groups.review > 0 && (
            <div>
              <b>{groups.review}</b>
              <span>复核</span>
            </div>
          )}
        </div>
      </div>
      <div className="inbox-strip-actions">
        {groups.nodes + groups.edges > 0 && (
          <Link href="/knowledge" style={{ textDecoration: 'none' }}>
            <Button variant="secondary">知识图谱</Button>
          </Link>
        )}
        <Link href="/inbox" style={{ textDecoration: 'none' }}>
          <Button variant="primary" iconRight="arrowR">
            集中审批 (全部 {totalLabel})
          </Button>
        </Link>
      </div>
    </div>
  );
}

function CostRibbon({
  cost,
  loading,
  error,
}: {
  cost: CostSummary | null;
  loading: boolean;
  error: Error | null;
}) {
  if (loading) {
    return <div className="cost-ribbon">Cost guard · 加载中…</div>;
  }
  if (error) {
    return <div className="cost-ribbon">Cost guard · 暂时不可用 ({error.message})</div>;
  }
  if (!cost) return null;

  const fmtUsd = (n: number) => `$${n.toFixed(n < 0.01 ? 5 : 3)}`;
  const top = cost.today.by_task
    .slice()
    .sort((a, b) => b.spend - a.spend)
    .slice(0, 3);
  const budget = 5;
  const pct = Math.min(100, Math.round((cost.today.spend / budget) * 100));

  return (
    <div className="cost-ribbon">
      <span>
        <b>${cost.today.spend.toFixed(3)}</b> / ${budget.toFixed(2)} 今日
      </span>
      <span className="bar" aria-label={`成本 ${pct}%`}>
        <span style={{ width: `${pct}%` }} />
      </span>
      <span>
        {cost.today.ledger_rows} ledger · {cost.today.tool_calls} tool calls · tokens{' '}
        {cost.today.tokens_in}/{cost.today.tokens_out}
      </span>
      {top.length > 0 && (
        <span>
          top: {top.map((t) => `${t.task_kind} ${fmtUsd(t.spend)} (${t.calls})`).join(' · ')}
        </span>
      )}
    </div>
  );
}
