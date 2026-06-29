// A5 S1 (YUK-354) — BandChip: compact 「档 + 区间 + 来源 + 低置信」reading that
// replaces the bare mastery% on knowledge tree/graph rows + the focal-node detail /
// drawer. ⑥治理首个载体——绝不渲染裸概率/裸%，只档/区间/来源/低置信定性。
//
// PORT 自设计源 docs/design/loom-refresh/project/screen-knowledge-a5.jsx 的 BandChip,
// 但消费 masteryBandView（真 mastery_lo / mastery_hi + low_confidence），不照搬设计
// mock 的 evidence-估-区间。冷启未知态显式渲（不显 0%）。

import {
  A5_BANDS,
  type MasteryBandInput,
  UNKNOWN_BAND_LABEL,
  masteryBandView,
} from './mastery-band';

export function BandChip({ input }: { input: MasteryBandInput }) {
  const view = masteryBandView(input);
  const sourceLabel = view.source === 'soft' ? '软轨先验' : '硬轨校准';
  const lowSuffix = view.lowConf ? ' · 低置信' : '';
  const bandLabel = view.unknown ? UNKNOWN_BAND_LABEL : A5_BANDS[view.band];

  // 冷启未知态：title 显式「未知 · 来源 · 低置信」，不报区间也不报 0%（一等态）。
  let title: string;
  if (view.unknown) {
    title = `${UNKNOWN_BAND_LABEL} · ${sourceLabel}${lowSuffix}`;
  } else {
    title = `${bandLabel} · 区间 ${A5_BANDS[view.loBand]}–${A5_BANDS[view.hiBand]} · ${sourceLabel}${lowSuffix}`;
  }

  const className = `band-chip src-${view.source}${view.lowConf ? ' is-low' : ''}`;
  return (
    <span className={className} title={title}>
      <span className="bc-dot" />
      {bandLabel}
      {view.lowConf && <span className="bc-low">低置信</span>}
    </span>
  );
}
