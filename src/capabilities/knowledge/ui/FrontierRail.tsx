// A5 S2 (YUK-354) — FrontierRail:「下一步，你学得动这些」learnable_frontier 横幅。
// 前置都满足了 · 这是建议不是必经路，随时忽略。
//
// PORT 自设计源 docs/design/loom-refresh/project/screen-knowledge-a5.jsx 的 FrontierRail。
// 偏离 mock：① 复用 S1 的 BandChip（真 mastery_lo/hi/low_confidence，非 mock 估算）；
// ② 不强制 .wenyan serif（rail 跨科目，古文不当主角）；③ 空 frontier 显式诚实空态。

import { LoomIcon } from '@/ui/primitives/LoomIcon';
import { BandChip } from './BandChip';
import type { FrontierRailItem } from './knowledge-api';

export interface FrontierRailProps {
  items: FrontierRailItem[];
  navigate: (to: string) => void;
}

export function FrontierRail({ items, navigate }: FrontierRailProps) {
  return (
    <div className="frontier">
      <div className="frontier-head">
        <span className="frontier-ic">
          <LoomIcon name="target" size={19} />
        </span>
        <div>
          <h3 className="frontier-title">下一步，你学得动这些</h3>
          <div className="frontier-sub">
            learnable_frontier · 前置都满足了 · 这是<b>建议</b>不是必经路，随时忽略
          </div>
        </div>
      </div>
      {items.length === 0 ? (
        <p className="quiet-empty">暂无明确下一步——多录入 / 练习后会逐步浮现。</p>
      ) : (
        <div className="frontier-list">
          {items.map((f) => (
            <button
              type="button"
              key={f.kid}
              className="frontier-card"
              onClick={() => navigate(`/knowledge/${encodeURIComponent(f.kid)}`)}
            >
              <div className="frontier-card-top">
                <span className="frontier-card-name">{f.name}</span>
                {f.propose ? (
                  <span className="frontier-tag-propose">建议 · 低置信</span>
                ) : (
                  <span className="frontier-tag-next">下一步</span>
                )}
              </div>
              <div className="frontier-reason">{f.reason}</div>
              <div className="frontier-note">
                <BandChip input={f} />
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
