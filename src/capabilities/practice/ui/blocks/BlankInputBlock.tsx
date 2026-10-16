// YUK-1497 — blank_input input block (presentation spec §1.2, §1.2.2): one single-line blank. The
// text goes out exactly as typed, '' included: no trimming, case or width folding, and no browser
// autocorrect or autocapitalise rewriting it on the way in. `width` only sizes the field.
// `maxChars` only shows a counter; going over is marked, never blocked. `format: 'math'` adds a
// live preview through the same lazy KaTeX MathMarkdown the practice page uses; the preview is
// derived, the raw text stays the answer.
import { useId } from 'react';

import { MathMarkdown } from '@/ui/lib/math-markdown';

import { type BlockStateProps, blockMode, shownOutcome } from './shared';

export interface BlankInputBlockProps extends BlockStateProps {
  /** Accessible name, e.g. 「第 2 题 第 1 空 填空」. */
  label: string;
  /** Raw text as typed. */
  value: string;
  onChange: (text: string) => void;
  width?: 'sm' | 'md' | 'lg';
  /** Unit printed after the field (BlankSlot.unit_hint), display only. */
  unitHint?: string;
  /** BlankSlot.max_chars: a counter only; input and submit are never blocked. */
  maxChars?: number;
  /** BlankSlot.format; 'math' shows a rendered preview under the field. */
  format?: 'text' | 'math';
  /** Notation for the math preview (server-resolved); defaults to KaTeX. */
  notation?: string | null;
  /** Numeric-looking blanks may ask for a decimal keypad; the raw text is still kept. */
  inputMode?: 'text' | 'decimal';
  placeholder?: string;
  className?: string;
}

/** What the learner sees as characters: graphemes, so an emoji or é counts once. */
function visibleLength(text: string): number {
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    let count = 0;
    for (const _ of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)) {
      count += 1;
    }
    return count;
  }
  return Array.from(text).length;
}

export function BlankInputBlock({
  label,
  value,
  onChange,
  width = 'md',
  unitHint,
  maxChars,
  format = 'text',
  notation,
  inputMode = 'text',
  placeholder,
  className,
  ...state
}: BlankInputBlockProps) {
  const mode = blockMode(state);
  const outcome = shownOutcome(state);
  const id = useId();
  const length = maxChars !== undefined ? visibleLength(value) : 0;
  const over = maxChars !== undefined && length > maxChars;
  const preview = format === 'math' && value.trim().length > 0;
  const describedBy = [
    unitHint ? `${id}-unit` : '',
    maxChars !== undefined ? `${id}-count` : '',
    outcome ? `${id}-outcome` : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <span
      className={['un-blk-blank', className].filter(Boolean).join(' ')}
      data-width={width}
      data-mode={mode}
      data-outcome={outcome}
      data-over={over || undefined}
    >
      <input
        id={id}
        className="un-blk-blank-input"
        type="text"
        value={value}
        aria-label={label}
        aria-describedby={describedBy || undefined}
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
      {maxChars !== undefined ? (
        <span id={`${id}-count`} className="un-blk-blank-count un-num">
          {length}/{maxChars}
          <span className="un-sr-only">{over ? '，超过建议字数' : ' 字'}</span>
        </span>
      ) : null}
      {outcome ? (
        <span id={`${id}-outcome`} className="un-blk-blank-outcome" data-outcome={outcome}>
          {outcome === 'correct' ? '一致' : '不一致'}
          <span className="un-sr-only">（与参考答案，确定性核对）</span>
        </span>
      ) : null}
      {preview ? (
        <span className="un-blk-blank-preview">
          <span className="un-blk-blank-preview-label">预览 · 只是显示，作答以你输入的为准</span>
          {/* A math blank holds a bare formula; wrap it for the renderer unless it is delimited. */}
          <MathMarkdown notation={notation ?? 'katex'}>
            {value.includes('$') ? value : `$${value}$`}
          </MathMarkdown>
        </span>
      ) : null}
    </span>
  );
}
