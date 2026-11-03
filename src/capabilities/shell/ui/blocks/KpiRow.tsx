// Today's four count cards (M3E: today.css .un-today-metric; YUK-1713 swapped the last old icon).
import { ArrowRight } from 'lucide-react';
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

export function KpiRow({
  kpi,
  proposalsDecisionTotal,
  proposalsHasMore,
  navigate,
}: {
  kpi: WorkbenchSummary['kpi'];
  // 第 4 卡只展示真正需要用户裁决的数量；C-strength pending 记录属于旁观事实，
  // 不得制造虚假的待办积压。
  proposalsDecisionTotal: number;
  /** true 时 decision total 只是扫描窗口内下界，不能渲染成精确零。 */
  proposalsHasMore: boolean;
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
      value: proposalsValue(proposalsDecisionTotal, proposalsHasMore),
      sub: proposalsHasMore ? '扫描已达上限，可能仍有待审' : '等待裁决的提议',
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
