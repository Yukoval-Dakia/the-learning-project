'use client';

import { apiJson } from '@/ui/lib/api';
import { Badge } from '@/ui/primitives/Badge';
import { Button } from '@/ui/primitives/Button';
import { Card } from '@/ui/primitives/Card';
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
    <main
      style={{
        minHeight: '100vh',
        background: 'var(--paper)',
        padding: '36px 28px',
        maxWidth: 'var(--cap-prose, 900px)',
        margin: '0 auto',
        width: '100%',
        boxSizing: 'border-box',
      }}
    >
      <PageHeader title="Today" eyebrow="/today" sub="学习控制面" />

      <div style={kpiStripStyle}>
        <KpiCell label="FSRS 到期" value={dueCount} loading={dueQ.isLoading} href="/review" />
        <KpiCell
          label="归因中"
          value={pendingAttrCount}
          loading={mistakesQ.isLoading}
          href="/mistakes"
        />
        <KpiCell
          label="学习项"
          value={activeItemsCount}
          loading={itemsQ.isLoading}
          href="/learning-items"
        />
        <KpiCell
          label="知识点"
          value={knowledgeCount}
          loading={knowledgeQ.isLoading}
          href="/knowledge"
        />
      </div>

      <Card pad="lg" style={{ marginTop: 'var(--s-5)' }}>
        <SectionLabel>今日学习安排</SectionLabel>
        <ol style={laneListStyle}>
          <LaneItem
            phase="Phase 2A"
            name="Review"
            active
            description={dueCount > 0 ? `复习 ${dueCount} 道错题` : '没有到期的复习任务'}
            reason={
              topCauses.length === 0
                ? '尚无归因数据'
                : `按 cause 分布：${topCauses.map(([k, v]) => `${k} ${v}`).join(' · ')}`
            }
            action={
              <Link href="/review" style={{ textDecoration: 'none' }}>
                <Button variant="coral" disabled={dueCount === 0}>
                  开始 review_session →
                </Button>
              </Link>
            }
          />
          <LaneItem
            phase="Phase 2B · spec"
            name="Learning Intent"
            description="我想学…（未实现）"
            disabled
          />
          <LaneItem
            phase="Phase 3 · spec"
            name="Coach"
            description="查看本周报告（未实现）"
            disabled
          />
        </ol>
      </Card>

      <details style={dispatcherStyle}>
        <summary style={dispatcherSummaryStyle}>Task Dispatcher</summary>
        <p style={dispatcherBodyStyle}>
          已注册 task：AttributionTask、KnowledgeProposeTask、KnowledgeReviewTask、
          OCRExtractTask、IngestionImportTask。状态详见 <code>/api/_/logs/jobs</code>。
        </p>
      </details>

      <p style={costRibbonStyle}>
        Cost guard · CostLedger 今日（Phase 1d 接入） · ToolCallLog 详见{' '}
        <a href="/api/_/logs/jobs" style={{ color: 'var(--coral)' }}>
          /api/_/logs/jobs
        </a>
      </p>
    </main>
  );
}

interface KpiCellProps {
  label: string;
  value: number;
  loading: boolean;
  href: string;
}

function KpiCell({ label, value, loading, href }: KpiCellProps) {
  return (
    <Link href={href} style={{ textDecoration: 'none', display: 'block' }}>
      <Card pad="lg" elevated style={{ cursor: 'pointer' }}>
        <span style={kpiLabelStyle}>{label}</span>
        <span style={kpiValueStyle}>{loading ? '—' : value}</span>
      </Card>
    </Link>
  );
}

interface LaneItemProps {
  phase: string;
  name: string;
  description: string;
  reason?: string;
  active?: boolean;
  disabled?: boolean;
  action?: React.ReactNode;
}

function LaneItem({ phase, name, description, reason, active, disabled, action }: LaneItemProps) {
  return (
    <li style={{ ...laneItemStyle, opacity: disabled ? 0.55 : 1 }}>
      <div style={laneHeadStyle}>
        <Badge tone={active ? 'coral' : 'neutral'}>{phase}</Badge>
        <span style={laneNameStyle}>{name}</span>
      </div>
      <p style={laneDescStyle}>{description}</p>
      {reason && <p style={laneReasonStyle}>{reason}</p>}
      {action && <div style={{ marginTop: 'var(--s-2)' }}>{action}</div>}
    </li>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 'var(--fs-meta)',
        color: 'var(--ink-4)',
        letterSpacing: 'var(--ls-wide)',
        display: 'block',
        marginBottom: 'var(--s-3)',
      }}
    >
      {children}
    </span>
  );
}

const kpiStripStyle: React.CSSProperties = {
  marginTop: 'var(--s-4)',
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
  gap: 'var(--s-3)',
};

const kpiLabelStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-meta)',
  color: 'var(--ink-4)',
  letterSpacing: 'var(--ls-wide)',
  display: 'block',
};

const kpiValueStyle: React.CSSProperties = {
  marginTop: 'var(--s-2)',
  fontFamily: 'var(--font-serif)',
  fontSize: 32,
  fontWeight: 500,
  color: 'var(--ink)',
  letterSpacing: 'var(--ls-tight)',
};

const laneListStyle: React.CSSProperties = {
  listStyle: 'none',
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--s-3)',
};

const laneItemStyle: React.CSSProperties = {
  padding: 'var(--s-3) var(--s-4)',
  background: 'var(--paper)',
  border: '1px solid var(--line-soft)',
  borderRadius: 'var(--r-2)',
};

const laneHeadStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--s-2)',
  marginBottom: 'var(--s-2)',
};

const laneNameStyle: React.CSSProperties = {
  fontFamily: 'var(--font-serif)',
  fontSize: 'var(--fs-h4)',
  color: 'var(--ink)',
};

const laneDescStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 'var(--fs-body)',
  color: 'var(--ink-2)',
};

const laneReasonStyle: React.CSSProperties = {
  margin: '4px 0 0',
  fontSize: 'var(--fs-caption)',
  color: 'var(--ink-3)',
  fontFamily: 'var(--font-mono)',
  letterSpacing: 'var(--ls-wide)',
};

const dispatcherStyle: React.CSSProperties = {
  marginTop: 'var(--s-5)',
};

const dispatcherSummaryStyle: React.CSSProperties = {
  cursor: 'pointer',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-meta)',
  color: 'var(--ink-3)',
  letterSpacing: 'var(--ls-wide)',
};

const dispatcherBodyStyle: React.CSSProperties = {
  marginTop: 'var(--s-2)',
  fontSize: 'var(--fs-caption)',
  color: 'var(--ink-3)',
  lineHeight: 'var(--lh-prose)',
};

const costRibbonStyle: React.CSSProperties = {
  marginTop: 'var(--s-5)',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-meta)',
  color: 'var(--ink-4)',
  letterSpacing: 'var(--ls-wide)',
};
