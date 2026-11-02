import { LoomIcon, type LoomIconName } from '@/ui/primitives/LoomIcon';
import type { WorkbenchSummary } from '../workbench-api';

interface Kpi {
  key: string;
  label: string;
  icon: LoomIconName;
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
      <LoomIcon name="arrow" size={18} />
    </button>
  );
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
      value: proposalsHasMore
        ? proposalsDecisionTotal > 0
          ? `≥${proposalsDecisionTotal}`
          : '?'
        : proposalsDecisionTotal,
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
