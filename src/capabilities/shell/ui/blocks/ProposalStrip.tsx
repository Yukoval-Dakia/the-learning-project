// M4-T6 (YUK-319)：提议收件箱摘要条（设计稿 screen-today.jsx ProposalStrip）。
// 数据源 workbench summary proposals（total + by_kind 全 kind 零值映射）；
// chips 只渲非零 kind，降序。

import { Btn } from '@/ui/primitives/Btn';
import { LoomCard } from '@/ui/primitives/LoomCard';
import { LoomIcon } from '@/ui/primitives/LoomIcon';

import { kindMeta } from '../inbox-api';
import type { WorkbenchSummary } from '../workbench-api';

export function ProposalStrip({
  proposals,
  navigate,
}: {
  proposals: WorkbenchSummary['proposals'];
  navigate: (to: string) => void;
}) {
  const breakdown = Object.entries(proposals.by_kind)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
  return (
    <LoomCard pad>
      <div className="card-head">
        <span className="card-icon">
          <LoomIcon name="inbox" size={18} />
        </span>
        <div className="card-title">提议收件箱</div>
        <Btn
          size="sm"
          variant="ghost"
          iconEnd="arrow"
          style={{ marginLeft: 'auto' }}
          onClick={() => navigate('/inbox')}
        >
          去裁决
        </Btn>
      </div>
      {proposals.total === 0 ? (
        <div className="quiet-empty">没有待审提议。</div>
      ) : (
        <div className="prop-summary">
          <div className="prop-summary-n serif tnum">{proposals.total}</div>
          <div className="prop-summary-kinds">
            {breakdown.map(([k, n]) => {
              const meta = kindMeta(k);
              return (
                <span key={k} className={`chip tone-chip-${meta.tone}`}>
                  {meta.label} <b className="mono">{n}</b>
                </span>
              );
            })}
          </div>
        </div>
      )}
    </LoomCard>
  );
}
