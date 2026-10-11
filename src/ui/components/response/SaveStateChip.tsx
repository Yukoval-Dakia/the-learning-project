// YUK-1051 (D11) — 自动保存状态 chip。
//
// 纪律（preflight §4）：「saved」只在 server ack 之后出现；keepalive 发出不是保存
// 证明；draft generation 可见；version conflict 单独成态。PfPaper 旧的「草稿自动
// 保存 / 保存失败·重试」chip 由本组件承载（同文案、同重试交互），新面统一用它。

import './response.css';
import { LoomIcon } from '@/ui/primitives/LoomIcon';

export type SaveState = 'idle' | 'saving' | 'saved' | 'error' | 'conflict';

export interface SaveStateChipProps {
  state: SaveState;
  /** 草稿代数（每次内容变更 +1）；generation 可见是 D11 的要求。 */
  generation?: number | null;
  /** error 态的重试回调；给了就以 button 渲（chip 即重试入口）。 */
  onRetry?: () => void;
  retrying?: boolean;
}

const STATE_COPY: Record<SaveState, string> = {
  idle: '草稿自动保存',
  saving: '保存中…',
  saved: '已保存',
  error: '保存失败 · 重试',
  conflict: '版本有更新 · 先刷新再改',
};

// The draft generation stays in the props for callers, but is no longer shown: the owner read
// 「已保存 · v5」 as noise (2026-10-11, YUK-1438), superseding the earlier D11 visibility rule.
export function SaveStateChip({ state, onRetry, retrying }: SaveStateChipProps) {
  if (state === 'error' && onRetry) {
    return (
      <button type="button" className="rs-save is-error" onClick={onRetry} disabled={retrying}>
        <LoomIcon name="alert" size={12} />
        {retrying ? '重试中…' : STATE_COPY.error}
      </button>
    );
  }
  return (
    <span
      className={`rs-save${state === 'saving' ? ' is-saving' : ''}${state === 'conflict' ? ' is-conflict' : ''}${state === 'error' ? ' is-error' : ''}`}
    >
      <LoomIcon
        name={
          state === 'saved' || state === 'idle' ? 'check' : state === 'saving' ? 'clock' : 'alert'
        }
        size={12}
      />
      {STATE_COPY[state]}
    </span>
  );
}
