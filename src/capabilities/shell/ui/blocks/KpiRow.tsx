// Today's four count cards (M3E: today.css .un-today-metric; YUK-1713 swapped the last old icon).
import { ArrowRight } from 'lucide-react';
import { kindCountsByTier } from '../inbox-tier';
import type { WorkbenchSummary } from '../workbench-api';

interface Kpi {
  key: string;
  label: string;
  icon: 'review' | 'mistakes' | 'knowledge' | 'inbox';
  value: number | string;
  sub: string;
  onGo: () => void;
}

function KpiCard({ kpi }: { kpi: Kpi }) {
  return (
    <button type="button" className="un-today-metric" onClick={kpi.onGo}>
      <span>{kpi.label}</span>
      <strong>{kpi.value}</strong>
      <span className="un-today-meta">{kpi.sub}</span>
      <ArrowRight size={18} aria-hidden="true" />
    </button>
  );
}

// The proposals card's number: exact, a lower bound (≥N) when the scan hit its cap, or '?' when
// the capped scan found none it could count (early returns instead of a nested ternary).
function proposalsValue(total: number, hasMore: boolean): number | string {
  if (!hasMore) return total;
  if (total > 0) return `≥${total}`;
  return '?';
}

function proposalsSub(proposals: WorkbenchSummary['proposals']): string {
  if (proposals.has_more) return '扫描已达上限，可能仍有待审';
  const { decideTotal, observeTotal } = kindCountsByTier(proposals.by_kind);
  if (observeTotal === 0) return '等待裁决的提议';
  if (decideTotal === 0) return '都是仅作观察，不需要你裁决';
  return `${decideTotal} 项待你裁决，${observeTotal} 项仅作观察`;
}

export function KpiRow({
  kpi,
  proposals,
  navigate,
}: {
  kpi: WorkbenchSummary['kpi'];
  proposals: WorkbenchSummary['proposals'];
  navigate: (to: string) => void;
}) {
  const cards: Kpi[] = [
    {
      key: 'due',
      label: kpi.due_count_scope === 'actionable_queue_sample' ? '本批可复习' : '今日到期',
      icon: 'review',
      value: kpi.due_count,
      sub:
        kpi.due_count_scope === 'actionable_queue_sample'
          ? '当前这批可以开始复习'
          : '按复习间隔排入的项目',
      onGo: () => navigate('/practice'),
    },
    {
      key: 'attribution',
      label: '待归因',
      icon: 'mistakes',
      value: kpi.pending_attribution_count,
      sub: '等待归因的学习记录',
      onGo: () => navigate('/mistakes'),
    },
    {
      key: 'knowledge',
      label: '知识节点',
      icon: 'knowledge',
      value: kpi.knowledge_count,
      sub: '知识网中的活跃节点',
      onGo: () => navigate('/knowledge'),
    },
    {
      key: 'proposals',
      label: 'AI 提议',
      icon: 'inbox',
      value: proposalsValue(proposals.total, proposals.has_more),
      sub: proposalsSub(proposals),
      onGo: () => navigate('/inbox'),
    },
  ];
  return (
    <section className="un-today-metrics" aria-label="工作台计数与入口">
      {cards.map((k) => (
        <KpiCard key={k.key} kpi={k} />
      ))}
    </section>
  );
}
