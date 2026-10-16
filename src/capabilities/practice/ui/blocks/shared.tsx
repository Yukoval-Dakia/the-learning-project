// YUK-1497 — shared frame for the input blocks (presentation spec §1.2). View-level only: every
// block takes plain props (items, current value, onChange, state); a later adapter maps the frozen
// presentation and slot data onto them. Rendered inside <UiNextRoot>, styled by blocks.css.
// Tokens first: blocks render inside <UiNextRoot> and read its --un-* variables.
import '@/ui-next/tokens.css';
import './blocks.css';
import type { ReactNode } from 'react';

/** Slot-level result after feedback is released. Never per item: the grader only compares sets. */
export type BlockOutcome = 'correct' | 'not_correct';

export interface BlockStateProps {
  /** Not interactive for now (e.g. while submitting); the answer stays visible. */
  disabled?: boolean;
  /** Submitted: the learner's answer, read-only. */
  submitted?: boolean;
  /**
   * Only after the result is released, and only with `submitted`. Leave it out to show no result
   * at all (R10: tap blocks show no right/wrong after submitting unless a result is released).
   */
  outcome?: BlockOutcome | null;
}

export type BlockMode = 'edit' | 'disabled' | 'submitted';

export function blockMode({ disabled, submitted }: BlockStateProps): BlockMode {
  if (submitted) return 'submitted';
  if (disabled) return 'disabled';
  return 'edit';
}

export function shownOutcome(state: BlockStateProps): BlockOutcome | undefined {
  return state.submitted && state.outcome ? state.outcome : undefined;
}

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Display-only marker for the item at `index`. Never feeds an item_id. */
export function markerText(marker: 'letter' | 'number' | 'none', index: number): string | null {
  if (marker === 'none') return null;
  if (marker === 'number') return String(index + 1);
  if (index < LETTERS.length) return LETTERS[index] ?? null;
  return `${LETTERS[Math.floor(index / LETTERS.length) - 1] ?? ''}${LETTERS[index % LETTERS.length]}`;
}

/** The meta line under the instruction: how to answer while editing, what it is otherwise. */
export function BlockHead({
  mode,
  hint,
  count,
  outcome,
}: {
  mode: BlockMode;
  hint: string;
  count?: ReactNode;
  outcome?: BlockOutcome;
}) {
  return (
    <header className="un-blk-head">
      <p className="un-blk-meta">
        {mode === 'edit' ? hint : mode === 'submitted' ? '你的作答（已提交）' : '暂不可修改'}
        {outcome ? (
          <span className="un-blk-outcome" data-outcome={outcome}>
            {outcome === 'correct' ? '与参考答案一致' : '与参考答案不一致'}
            <span className="un-blk-outcome-src">（确定性核对）</span>
          </span>
        ) : null}
      </p>
      {count != null ? <span className="un-blk-count un-num">{count}</span> : null}
    </header>
  );
}

export interface BlockStatus {
  text: string;
  tone?: 'caution';
  action?: { label: string; run: () => void };
}

/** Polite live line for what the last tap did; the optional action is a real button. */
export function StatusLine({ status, mode }: { status: BlockStatus | null; mode: BlockMode }) {
  const live = mode === 'edit' ? status : null;
  return (
    <div className="un-blk-status" data-tone={live?.tone} data-empty={!live || undefined}>
      <span role="status" aria-live="polite">
        {live?.text ?? ''}
      </span>
      {live?.action ? (
        <button type="button" className="un-blk-link un-hit" onClick={live.action.run}>
          {live.action.label}
        </button>
      ) : null}
    </div>
  );
}

/** Moves a roving index for list keys; returns null when the key is not a move. */
export function rovingMove(key: string, index: number, length: number): number | null {
  if (length === 0) return null;
  switch (key) {
    case 'ArrowDown':
    case 'ArrowRight':
      return Math.min(length - 1, index + 1);
    case 'ArrowUp':
    case 'ArrowLeft':
      return Math.max(0, index - 1);
    case 'Home':
      return 0;
    case 'End':
      return length - 1;
    default:
      return null;
  }
}
