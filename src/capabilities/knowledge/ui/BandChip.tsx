// A5 S1 (YUK-354) — BandChip: compact 「档 + 区间 + 来源 + 低置信」reading that
// replaces the bare mastery% on knowledge tree/graph rows + the focal-node detail /
// drawer. ⑥治理首个载体——绝不渲染裸概率/裸%，只档/区间/来源/低置信定性。
//
// PORT 自设计源 docs/design/loom-refresh/project/screen-knowledge-a5.jsx 的 BandChip,
// 但消费 masteryBandView（真 mastery_lo / mastery_hi + low_confidence），不照搬设计
// mock 的 evidence-估-区间。冷启未知态显式渲（不显 0%）。
//
// A5 S3 (YUK-354) — BandChipView 抽出：渲染一个已算好的 MasteryBandView + 可换 label 串
// （NodeComposite 三维卡复用——difficulty 轴用难度档名而非掌握档名，结构 chrome 不变）。

import {
  A5_BANDS,
  type MasteryBandInput,
  type MasteryBandView,
  UNKNOWN_BAND_LABEL,
  masteryBandView,
} from './mastery-band';

// 渲染一个已算好的 band 视图。labels = 该轴的 4 档名（默认 p(L)/R 的 A5_BANDS；
// difficulty 轴传 DIFFICULTY_BANDS）。unknownLabel = 冷启未知态档名。
export function BandChipView({
  view,
  labels = A5_BANDS,
  unknownLabel = UNKNOWN_BAND_LABEL,
}: {
  view: MasteryBandView;
  labels?: readonly string[];
  unknownLabel?: string;
}) {
  const sourceLabel = view.source === 'soft' ? '软轨先验' : '硬轨校准';
  const lowSuffix = view.lowConf ? ' · 低置信' : '';
  const bandLabel = view.unknown ? unknownLabel : labels[view.band];

  // 冷启未知态：title 显式「未知 · 来源 · 低置信」，不报区间也不报 0%（一等态）。
  let title: string;
  if (view.unknown) {
    title = `${bandLabel} · ${sourceLabel}${lowSuffix}`;
  } else {
    title = `${bandLabel} · 区间 ${labels[view.loBand]}–${labels[view.hiBand]} · ${sourceLabel}${lowSuffix}`;
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

export function BandChip({ input }: { input: MasteryBandInput }) {
  return <BandChipView view={masteryBandView(input)} />;
}
