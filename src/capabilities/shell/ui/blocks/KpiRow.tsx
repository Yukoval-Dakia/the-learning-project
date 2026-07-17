// M4-T6 (YUK-319)：KPI 三卡（设计稿 screen-today.jsx KpiCard + DATA.kpis）。
// 真数据源 /api/workbench/summary kpi：due_count → 练习页；knowledge_count →
// 知识图；pending_attribution_count 的错题本未迁 SPA（M5），点击走宿主占位。

import { LoomCard } from '@/ui/primitives/LoomCard';
import { LoomIcon, type LoomIconName } from '@/ui/primitives/LoomIcon';

interface Kpi {
  key: string;
  label: string;
  icon: LoomIconName;
  value: number;
  sub: string;
  onGo: () => void;
}

function KpiCard({ kpi }: { kpi: Kpi }) {
  return (
    <LoomCard
      pad
      hover
      className="kpi"
      onClick={kpi.onGo}
      // biome-ignore lint/a11y/useSemanticElements: 设计稿 KPI 整卡可点（LoomCard
      // 渲染 div）；role=button + tabIndex + Enter 是卡片化入口的正确 ARIA（PfStream 同例）
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter') kpi.onGo();
      }}
    >
      <div className="kpi-label">
        <LoomIcon name={kpi.icon} size={14} />
        {kpi.label}
      </div>
      <div className="kpi-val tnum">{kpi.value}</div>
      <div className="kpi-foot kpi-sub">{kpi.sub}</div>
      <LoomIcon name="arrow" size={15} className="kpi-go" />
    </LoomCard>
  );
}

export function KpiRow({
  kpi,
  proposalsDecisionTotal,
  navigate,
}: {
  kpi: { due_count: number; pending_attribution_count: number; knowledge_count: number };
  // 第 4 卡只展示真正需要用户裁决的数量；C-strength pending 记录属于旁观事实，
  // 不得制造虚假的待办积压。
  proposalsDecisionTotal: number;
  navigate: (to: string) => void;
}) {
  const cards: Kpi[] = [
    {
      key: 'due',
      label: '今日到期',
      icon: 'review',
      value: kpi.due_count,
      sub: '按复习间隔排入的项目',
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
      value: proposalsDecisionTotal,
      sub: '等待裁决的提议',
      onGo: () => navigate('/inbox'),
    },
  ];
  return (
    <div className="kpi-row stagger" style={{ marginTop: 'var(--s-5)' }}>
      {cards.map((k) => (
        <KpiCard key={k.key} kpi={k} />
      ))}
    </div>
  );
}
