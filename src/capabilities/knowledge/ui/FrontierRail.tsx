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
  /** 读模型加载中 → loading 态（别折叠成「暂无下一步」业务空态，CodeRabbit）。 */
  isLoading?: boolean;
  /** 读模型失败 → 错误 + 重试（别误显示成空态）。 */
  isError?: boolean;
  onRetry?: () => void;
  navigate: (to: string) => void;
}

// 内容区分态（早返，避嵌套三元）：错误 → 错误+重试；加载 → loading；空 → 诚实空态；否则 list。
// CodeRabbit minor：frontierQ 的 loading/error 绝不能被折叠成「暂无下一步」（把接口异常误显示
// 成业务空态）。head 恒显，body 按态分。render helper（小写、内联调用而非 <Component/>），让
// body element 直接嵌进 FrontierRail tree——单测以浅遍历 onClick 验导航，子组件会挡住遍历。
function renderFrontierBody({
  items,
  isLoading,
  isError,
  onRetry,
  navigate,
}: {
  items: FrontierRailItem[];
  isLoading: boolean;
  isError: boolean;
  onRetry?: () => void;
  navigate: (to: string) => void;
}) {
  if (isError) {
    return (
      <p className="quiet-empty">
        下一步建议暂不可用。
        {onRetry && (
          <button type="button" className="frontier-retry" onClick={onRetry}>
            <LoomIcon name="refresh" size={13} />
            重试
          </button>
        )}
      </p>
    );
  }
  if (isLoading) {
    return <p className="quiet-empty">正在看你学得动什么…</p>;
  }
  if (items.length === 0) {
    return <p className="quiet-empty">暂无明确下一步——多录入 / 练习后会逐步浮现。</p>;
  }
  return (
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
  );
}

export function FrontierRail({
  items,
  isLoading = false,
  isError = false,
  onRetry,
  navigate,
}: FrontierRailProps) {
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
      {renderFrontierBody({ items, isLoading, isError, onRetry, navigate })}
    </div>
  );
}
