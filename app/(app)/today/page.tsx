'use client';

import { apiJson } from '@/ui/lib/api';
import { Badge } from '@/ui/primitives/Badge';
import { Button } from '@/ui/primitives/Button';
import { PageHeader } from '@/ui/primitives/PageHeader';
import { useQuery } from '@tanstack/react-query';
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
  const costQ = useQuery({
    queryKey: ['today-cost'],
    queryFn: () => apiJson<CostSummary>('/api/cost/today'),
    refetchInterval: 60_000,
  });

  const dueCount = dueQ.data?.rows.length ?? 0;
  const mistakeRows = mistakesQ.data?.rows ?? [];
  const pendingAttrCount = mistakeRows.filter((m) => m.cause === null).length;
  const activeItemsCount = itemsQ.data?.rows.filter((i) => i.status !== 'done').length ?? 0;
  const knowledgeCount = knowledgeQ.data?.rows.length ?? 0;

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
    <main className="page wide">
      <PageHeader
        title="今日"
        eyebrow="/today"
        sub="学习控制面 · 错题归因 + FSRS 复习 + AI 提议汇集"
      />

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
          label="学习项 · 在途"
          value={activeItemsCount}
          loading={itemsQ.isLoading}
          href="/learning-items"
          trend="pending + in_progress"
        />
        <Kpi
          label="知识点"
          value={knowledgeCount}
          loading={knowledgeQ.isLoading}
          href="/knowledge"
          trend="tree + mesh"
        />
      </div>

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

        <Lane
          eyebrow="LANE C"
          title="Coach · 周度报表"
          badge={
            <Badge tone="neutral" dot dotStatic>
              stub
            </Badge>
          }
          stub
        >
          <p className="lane-empty">
            周度 review 报表（Phase 1d 计划项）尚未落地；下次会话或专门会话补。
          </p>
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
