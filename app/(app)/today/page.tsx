'use client';

import { apiJson } from '@/ui/lib/api';
import { Badge } from '@/ui/primitives/Badge';
import { Button } from '@/ui/primitives/Button';
import { PageHeader } from '@/ui/primitives/PageHeader';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';

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
interface KnowledgeProposal {
  id: string;
}
interface EventRow {
  id: string;
  outcome?: string;
  caused_by_event_id?: string | null;
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

export default function TodayPage() {
  const queryClient = useQueryClient();

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
  const nodeProposalsQ = useQuery({
    queryKey: ['today-knowledge-proposals', 'pending'],
    queryFn: () =>
      apiJson<{ rows: KnowledgeProposal[] }>('/api/knowledge/proposals?status=pending'),
  });
  const edgeProposalsQ = useQuery({
    queryKey: ['today-knowledge-edge-proposals'],
    queryFn: () =>
      apiJson<{ rows: EventRow[] }>(
        '/api/events?action=propose&subject_kind=knowledge_edge&limit=200',
      ),
  });
  const edgeRatesQ = useQuery({
    queryKey: ['today-knowledge-edge-rates'],
    queryFn: () =>
      apiJson<{ rows: EventRow[] }>(
        '/api/events?action=rate&subject_kind=knowledge_edge&limit=200',
      ),
  });
  const artifactEventsQ = useQuery({
    queryKey: ['today-artifact-generations'],
    queryFn: () =>
      apiJson<{ rows: EventRow[] }>(
        '/api/events?action=generate&subject_kind=artifact&actor_kind=agent&limit=200',
      ),
  });
  const eventRatesQ = useQuery({
    queryKey: ['today-event-rates'],
    queryFn: () =>
      apiJson<{ rows: EventRow[] }>('/api/events?action=rate&subject_kind=event&limit=200'),
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

  const dueCount = dueQ.data?.rows.length ?? 0;
  const mistakeRows = mistakesQ.data?.rows ?? [];
  const pendingAttrCount = mistakeRows.filter((m) => m.cause === null).length;
  const activeItemsCount = itemsQ.data?.rows.filter((i) => i.status !== 'done').length ?? 0;
  const knowledgeCount = knowledgeQ.data?.rows.length ?? 0;
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
  const pendingEdgeCount = (edgeProposalsQ.data?.rows ?? []).filter(
    (row) => !edgeRatedIds.has(row.id),
  ).length;
  const pendingNodeCount = nodeProposalsQ.data?.rows.length ?? 0;
  const pendingArtifactCount = (artifactEventsQ.data?.rows ?? []).filter(
    (row) => row.outcome === 'success' && !eventRatedIds.has(row.id),
  ).length;
  const pendingAiCount = pendingEdgeCount + pendingNodeCount + pendingArtifactCount;
  const pendingAiLoading =
    nodeProposalsQ.isLoading ||
    edgeProposalsQ.isLoading ||
    edgeRatesQ.isLoading ||
    artifactEventsQ.isLoading ||
    eventRatesQ.isLoading;

  const causeCounts = new Map<string, number>();
  for (const m of mistakeRows) {
    if (m.cause) {
      causeCounts.set(
        m.cause.primary_category,
        (causeCounts.get(m.cause.primary_category) ?? 0) + 1,
      );
    }
  }
  const topCauses = [...causeCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);

  return (
    <main className="page wide today-page">
      <PageHeader
        title="今日"
        eyebrow={`TODAY · ${new Date().toISOString().slice(0, 10)} · phase 1c`}
        sub="昨晚 Dreaming agent 跑过；下面是它想让你看的几件事，再加你自己排的复习队列。"
      >
        <Button variant="secondary" icon="refresh" onClick={() => queryClient.invalidateQueries()}>
          刷新
        </Button>
        <Link href="/record" style={{ textDecoration: 'none' }}>
          <Button variant="primary" icon="pen">
            录入
          </Button>
        </Link>
      </PageHeader>

      <div className="kpi-strip">
        <Kpi
          label="FSRS · 到期"
          value={dueCount}
          loading={dueQ.isLoading}
          href="/review"
          trendUp={dueCount > 0}
        />
        <Kpi
          label="错题 · 待归因"
          value={pendingAttrCount}
          loading={mistakesQ.isLoading}
          href="/mistakes"
          trend={pendingAttrCount > 0 ? 'attempt:failure 无 judge' : '全部已归因'}
        />
        <Kpi
          label="AI 提议 · 待审"
          value={pendingAiCount}
          loading={pendingAiLoading}
          href="/inbox"
          trend={
            pendingAiCount > 0
              ? `关系 ${pendingEdgeCount} · 新节点 ${pendingNodeCount} · 内容 ${pendingArtifactCount}`
              : '全部清空'
          }
          trendUp={pendingAiCount > 0}
        />
        <Kpi
          label="知识点"
          value={knowledgeCount}
          loading={knowledgeQ.isLoading}
          href="/knowledge"
          trend="tree + mesh"
        />
      </div>

      <SessionStrip sessions={sessionsQ.data?.rows ?? []} loading={sessionsQ.isLoading} />

      <InboxStrip
        total={pendingAiCount}
        edges={pendingEdgeCount}
        nodes={pendingNodeCount}
        artifacts={pendingArtifactCount}
      />

      <div className="lanes">
        <Lane
          eyebrow="LANE A"
          title="复习队列 · FSRS"
          badge={<Badge tone="coral">{dueCount} 到期</Badge>}
        >
          <p className="lane-empty" hidden={dueCount > 0}>
            没有到期的复习任务。
          </p>
          {dueCount > 0 && (
            <div className="lane-body">
              <div className="lane-item">
                <div className="top">
                  <span>共 {dueCount} 题待复习</span>
                </div>
                <div className="body">
                  {topCauses.length === 0
                    ? '尚无归因数据 — 先去 /mistakes 归因，FSRS 复习权重会更准。'
                    : `按 cause 分布：${topCauses.map(([k, v]) => `${k} ${v}`).join(' · ')}`}
                </div>
              </div>
            </div>
          )}
          <div className="lane-cta">
            <Link href="/review" style={{ textDecoration: 'none' }}>
              <Button variant="coral" disabled={dueCount === 0}>
                开始 review_session →
              </Button>
            </Link>
          </div>
        </Lane>

        <Lane
          eyebrow="LANE B"
          title="学习意图"
          badge={<Badge tone="neutral">{activeItemsCount} 在途</Badge>}
        >
          {activeItemsCount === 0 ? (
            <p className="lane-empty">没有在途学习项 — 去 /learning-items 加。</p>
          ) : (
            <div className="lane-body">
              <div className="lane-item">
                <div className="top">
                  <span>{activeItemsCount} 个 pending + in_progress</span>
                </div>
                <div className="body muted">挂在 /learning-items；hub 与子项已通。</div>
              </div>
            </div>
          )}
          <div className="lane-cta">
            <Link href="/learning-items" style={{ textDecoration: 'none' }}>
              <Button variant="secondary">打开 →</Button>
            </Link>
          </div>
        </Lane>

        <Lane eyebrow="LANE C" title="Coach · 周度报表" badge={<Badge tone="info">7d</Badge>}>
          <div className="lane-body">
            <div className="lane-item">
              <div className="top">
                <span>过去 7 天的 FSRS / 错题 / 归因 / 成本</span>
              </div>
              <div className="body muted">正确率趋势、易错知识点、cause 分布。</div>
            </div>
          </div>
          <div className="lane-cta">
            <Link href="/coach" style={{ textDecoration: 'none' }}>
              <Button variant="secondary">查看 →</Button>
            </Link>
          </div>
        </Lane>
      </div>

      <CostRibbon
        cost={costQ.data ?? null}
        loading={costQ.isLoading}
        error={costQ.error as Error | null}
      />
    </main>
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
  const completed = sessions.find((s) => s.status === 'completed');
  if (!active && !completed) {
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

function InboxStrip({
  total,
  edges,
  nodes,
  artifacts,
}: {
  total: number;
  edges: number;
  nodes: number;
  artifacts: number;
}) {
  if (total === 0) return null;

  return (
    <div className="inbox-strip">
      <div className="inbox-text">
        <div className="src">
          <Badge tone="coral">agent</Badge> · pending only · event stream
        </div>
        <h3>昨晚 AI 提议了 {total} 条，要看吗？</h3>
        <div className="breakdown">
          {artifacts > 0 && (
            <div>
              <b>{artifacts}</b>
              <span>内容生成</span>
            </div>
          )}
          {nodes > 0 && (
            <div>
              <b>{nodes}</b>
              <span>新知识点</span>
            </div>
          )}
          {edges > 0 && (
            <div>
              <b>{edges}</b>
              <span>关系建议</span>
            </div>
          )}
        </div>
      </div>
      <div className="inbox-strip-actions">
        <Link href="/knowledge" style={{ textDecoration: 'none' }}>
          <Button variant="secondary">分散审批</Button>
        </Link>
        <Link href="/inbox" style={{ textDecoration: 'none' }}>
          <Button variant="primary" iconRight="arrowR">
            集中审批 (全部 {total})
          </Button>
        </Link>
      </div>
    </div>
  );
}

interface KpiProps {
  label: string;
  value: number;
  loading: boolean;
  href: string;
  trend?: string;
  trendUp?: boolean;
}

function Kpi({ label, value, loading, href, trend, trendUp }: KpiProps) {
  return (
    <Link href={href} className="kpi kpi-clickable">
      <div className="kpi-label">{label}</div>
      <div className="kpi-num">
        {loading ? '—' : value}
        <small> 条</small>
      </div>
      {trend && <div className={`kpi-trend${trendUp ? ' up' : ''}`}>{trend}</div>}
    </Link>
  );
}

interface LaneProps {
  eyebrow: string;
  title: string;
  badge?: React.ReactNode;
  stub?: boolean;
  children?: React.ReactNode;
}

function Lane({ eyebrow, title, badge, stub, children }: LaneProps) {
  return (
    <section className={`lane${stub ? ' is-stub' : ''}`}>
      <div className="lane-head">
        <div>
          <div className="lane-eyebrow">{eyebrow}</div>
          <h3>{title}</h3>
        </div>
        {badge}
      </div>
      {children}
    </section>
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
