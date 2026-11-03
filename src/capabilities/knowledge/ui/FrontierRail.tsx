// A5 S2 (YUK-354) — FrontierRail:「下一步，你学得动这些」learnable_frontier 横幅。
// 前置都满足了 · 这是建议不是必经路，随时忽略。
//
// PORT 自设计源 docs/design/loom-refresh/project/screen-knowledge-a5.jsx 的 FrontierRail。
// 偏离 mock：① 复用 S1 的 BandChip（真 mastery_lo/hi/low_confidence，非 mock 估算）；
// ② 不强制 .wenyan serif（rail 跨科目，古文不当主角）；③ 空 frontier 显式诚实空态。
//
// 措辞红线（YUK-551 spec §Q6；Cosyn et al. 2021 JMP 实证 outer-fringe 首答正确率仅 ~27%）:
// 「下一步/学得动」是**结构可达性**信号（前置已掌握）,不是「容易/该会/正确率高」信号——rail
// 文案（标题「下一步,你学得动这些」/ frontier-sub / reason）不得引入难度或正确率承诺措辞。
// 详见 docs/design/2026-07-03-frontier-gate-spec.md §Q6。

import { Target } from 'lucide-react';
import { RetryLine } from '@/ui-next/primitives/RetryLine';
import { SkeletonLines } from '@/ui-next/primitives/SkeletonLines';
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
// 红线核心句(YUK-551 §Q6):frontier=「结构可达」,非「容易/该会/正确率高」——tag/reason/标题文案勿引入难度承诺(完整版见文件头)。
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
    if (onRetry) return <RetryLine message="下一步建议暂不可用。" onRetry={onRetry} />;
    return <p className="kn-quiet">下一步建议暂不可用。</p>;
  }
  if (isLoading) {
    return <SkeletonLines rows={2} label="正在看你学得动什么" />;
  }
  if (items.length === 0) {
    return <p className="kn-quiet">暂无明确下一步——多录入 / 练习后会逐步浮现。</p>;
  }
  return (
    <ul className="kn-frontier-list">
      {items.map((f) => (
        <li key={f.kid}>
          <button
            type="button"
            className="kn-frontier-card"
            onClick={() => navigate(`/knowledge/${encodeURIComponent(f.kid)}`)}
          >
            <span className="kn-frontier-top">
              <span className="kn-frontier-name">{f.name}</span>
              {f.propose ? (
                <span className="kn-tag kn-tag-dashed">建议 · 低置信</span>
              ) : (
                <span className="kn-tag kn-tag-accent">下一步</span>
              )}
            </span>
            <span className="kn-frontier-reason">{f.reason}</span>
            <span className="kn-frontier-note">
              {f.propose ? <span className="kn-tag">待确认建议</span> : <BandChip input={f} />}
            </span>
          </button>
        </li>
      ))}
    </ul>
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
    <section className="kn-frontier" aria-labelledby="kn-frontier-title">
      <div className="kn-frontier-head">
        <span className="kn-frontier-ic" aria-hidden="true">
          <Target size={18} />
        </span>
        <div>
          <h2 id="kn-frontier-title" className="kn-frontier-title">
            下一步，你学得动这些
          </h2>
          <p className="kn-frontier-sub">
            所需基础已经具备 · 这是<b>建议</b>，不是必经路，随时可以忽略
          </p>
        </div>
      </div>
      {renderFrontierBody({ items, isLoading, isError, onRetry, navigate })}
    </section>
  );
}
