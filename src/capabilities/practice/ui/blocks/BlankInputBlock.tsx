// YUK-1497 — blank_input input block (presentation spec §1.2): one single-line blank. The text goes
// out exactly as typed: no trimming, case or width folding, and no browser autocorrect or
// autocapitalise rewriting it on the way in. `width` only sizes the field; it never limits input.
import { useId } from 'react';

import { type BlockStateProps, blockMode, shownOutcome } from './shared';

export interface BlankInputBlockProps extends BlockStateProps {
  /** Accessible name, e.g. 「第 2 题 第 1 空」. */
  label: string;
  /** Raw text as typed. */
  value: string;
  onChange: (text: string) => void;
  width?: 'sm' | 'md' | 'lg';
  /** Unit printed after the field (BlankSlot.unit_hint), display only. */
  unitHint?: string;
  /** Numeric-looking blanks may ask for a decimal keypad; the raw text is still kept. */
  inputMode?: 'text' | 'decimal';
  placeholder?: string;
  className?: string;
}

export function BlankInputBlock({
  label,
  value,
  onChange,
  width = 'md',
  unitHint,
  inputMode = 'text',
  placeholder,
  className,
  ...state
}: BlankInputBlockProps) {
  const mode = blockMode(state);
  const outcome = shownOutcome(state);
  const id = useId();
  return (
    <span
      className={['un-blk-blank', className].filter(Boolean).join(' ')}
      data-width={width}
      data-mode={mode}
      data-outcome={outcome}
    >
      <input
        id={id}
        className="un-blk-blank-input"
        type="text"
        value={value}
        aria-label={label}
        aria-describedby={
          [unitHint ? `${id}-unit` : '', outcome ? `${id}-outcome` : '']
            .filter(Boolean)
            .join(' ') || undefined
        }
        placeholder={placeholder}
        disabled={mode === 'disabled'}
        readOnly={mode === 'submitted'}
        inputMode={inputMode}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
      />
      {unitHint ? (
        <span id={`${id}-unit`} className="un-blk-blank-unit">
          {unitHint}
        </span>
      ) : null}
      {outcome ? (
        <span id={`${id}-outcome`} className="un-blk-blank-outcome" data-outcome={outcome}>
          {outcome === 'correct' ? '一致' : '不一致'}
          <span className="un-sr-only">（与参考答案，确定性核对）</span>
        </span>
      ) : null}
    </span>
  );
}
