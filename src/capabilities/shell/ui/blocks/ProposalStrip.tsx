// M4-T6 (YUK-319)：提议收件箱摘要条（设计稿 screen-today.jsx ProposalStrip）。
// 数据源 workbench summary proposals（total + by_kind 全 kind 零值映射）；
// 全部 pending 都显示（YUK-1768）：先待你裁决、再仅作观察，每档用文字说明，档内按数量降序。
// YUK-1713 — M3E presentation (today-m3e.css .td-card / .td-kind; kind tones through
// inbox-look.ts like the inbox).

import { ArrowRight, Inbox } from 'lucide-react';
import { Button } from '@/ui-next/public';

import { kindMeta } from '../inbox-api';
import { inboxTone } from '../inbox-look';
import { TIER_META, kindCountsByTier } from '../inbox-tier';
import type { WorkbenchSummary } from '../workbench-api';

// Exact count, a lower bound (≥N) when the scan hit its cap, or '?' when the capped scan found
// none it could count (early returns instead of a nested ternary; same order).
function countText(total: number, hasMore: boolean): number | string {
  if (!hasMore) return total;
  if (total > 0) return `≥${total}`;
  return '?';
}

function TierRow({ tier, rows }: { tier: 'B' | 'C'; rows: Array<[kind: string, count: number]> }) {
  if (rows.length === 0) return null;
  const words = TIER_META[tier];
  return (
    <div className="td-props-tier">
      <p className="td-props-tier-head">
        <b>{words.label}</b>
        <span>{words.sub}</span>
      </p>
      <div className="td-props-kinds">
        {rows.map(([k, n]) => {
          const meta = kindMeta(k);
          return (
            <span key={k} className="td-kind" data-tone={inboxTone(meta.tone)}>
              {meta.label} <b className="un-num">{n}</b>
            </span>
          );
        })}
      </div>
    </div>
  );
}

export function ProposalStrip({
  proposals,
  navigate,
}: {
  proposals: WorkbenchSummary['proposals'];
  navigate: (to: string) => void;
}) {
  const tiers = kindCountsByTier(proposals.by_kind);
  return (
    <section className="td-card">
      <div className="td-card-head">
        <span className="td-card-ic" aria-hidden="true">
          <Inbox size={18} />
        </span>
        <h3 className="td-card-title">提议收件箱</h3>
        <Button
          size="sm"
          variant="ghost"
          className="td-card-aside"
          onClick={() => navigate('/inbox')}
        >
          去收件箱
          <ArrowRight size={16} aria-hidden="true" />
        </Button>
      </div>
      {proposals.total === 0 && !proposals.has_more ? (
        <p className="td-quiet">没有待审提议。</p>
      ) : (
        <div className="td-props">
          <p className="td-props-n un-num">{countText(proposals.total, proposals.has_more)}</p>
          <div className="td-props-tiers">
            {proposals.has_more && <p className="td-quiet">计数已达扫描上限，可能还有待审提议。</p>}
            <TierRow tier="B" rows={tiers.decide} />
            <TierRow tier="C" rows={tiers.observe} />
          </div>
        </div>
      )}
    </section>
  );
}
