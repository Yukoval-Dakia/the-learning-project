// 断句 tap-answer block (ADR-0074 D3a). Controlled: the learner taps between two characters of the
// frozen text to place or remove a break; the answer goes out as gap positions. Every gap carries an
// invisible hit area reaching to the middle of both neighbouring characters, so a finger, an Apple
// Pencil or a mouse lands on it without precision. Each character travels with the gap after it,
// so a gap at a line end stays at that line end and stays tappable. Keyboard: one tab stop, arrows
// move a caret between gaps, Space toggles. It never knows how many breaks are expected unless the
// question chooses to say so (`expectedCount`).
import { type KeyboardEvent, useEffect, useId, useMemo, useState } from 'react';
import type { SentenceBreaksResponse } from './types';

export interface SentenceBreaksBlockProps {
  /** Accessible name of the whole block, e.g. 「第 5 题 断句」. */
  label: string;
  /** The frozen question text. Positions index its code points (`Array.from(text)`). */
  text: string;
  /** The question's own instruction and scoring rule, shown as written. */
  instruction?: string;
  /**
   * How many breaks the question expects. Pass it only when the question's `show_count` flag is
   * on; otherwise the count is never shown.
   */
  expectedCount?: number;
  value: SentenceBreaksResponse;
  onChange: (next: SentenceBreaksResponse) => void;
  /** Not interactive for now (e.g. while submitting); the answer stays visible. */
  disabled?: boolean;
  /** Submitted: shows the learner's answer read-only. Never shows correctness. */
  submitted?: boolean;
  className?: string;
}

const isSpace = (ch: string | undefined) => ch === undefined || /\s/u.test(ch);

export function SentenceBreaksBlock({
  label,
  text,
  instruction,
  expectedCount,
  value,
  onChange,
  disabled,
  submitted,
  className,
}: SentenceBreaksBlockProps) {
  const readOnly = Boolean(disabled || submitted);
  const uid = useId();
  const chars = useMemo(() => Array.from(text), [text]);
  // A gap is offered only between two visible characters; the text's own edges are not gaps.
  const gaps = useMemo(() => {
    const out: number[] = [];
    for (let i = 1; i < chars.length; i += 1) {
      if (!isSpace(chars[i - 1]) && !isSpace(chars[i])) out.push(i);
    }
    return out;
  }, [chars]);
  const gapSet = useMemo(() => new Set(gaps), [gaps]);
  const placed = useMemo(() => new Set(value.positions), [value.positions]);
  const [caret, setCaret] = useState<number>(() => gaps[0] ?? 1);
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!gapSet.has(caret) && gaps[0] !== undefined) setCaret(gaps[0]);
  }, [caret, gapSet, gaps]);

  const around = (i: number) => {
    const before = chars.slice(Math.max(0, i - 4), i).join('');
    const after = chars.slice(i, i + 4).join('');
    return `「${before}」与「${after}」之间`;
  };

  const toggle = (i: number) => {
    if (readOnly || !gapSet.has(i)) return;
    const next = new Set(placed);
    const on = !next.has(i);
    if (on) next.add(i);
    else next.delete(i);
    onChange({ kind: 'sentence_breaks', positions: [...next].sort((a, b) => a - b) });
    setCaret(i);
    setMessage(`${on ? '已断' : '已取消'}：${around(i)}`);
  };

  const moveCaret = (to: number) => {
    const at = gaps.indexOf(caret);
    const next = gaps[Math.max(0, Math.min(gaps.length - 1, at + to))];
    if (next !== undefined) setCaret(next);
  };

  const onKey = (event: KeyboardEvent) => {
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        moveCaret(1);
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        moveCaret(-1);
        break;
      case 'Home':
        if (gaps[0] !== undefined) setCaret(gaps[0]);
        break;
      case 'End':
        if (gaps.length) setCaret(gaps[gaps.length - 1] as number);
        break;
      case ' ':
      case 'Enter':
        toggle(caret);
        break;
      case 'Delete':
      case 'Backspace':
        if (placed.has(caret)) toggle(caret);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  // What a screen reader hears for the whole answer: the text cut where the learner cut it.
  const segmented = useMemo(() => {
    let out = '';
    chars.forEach((ch, i) => {
      if (placed.has(i)) out += '／';
      out += ch;
    });
    return out;
  }, [chars, placed]);

  const count = value.positions.length;
  const caretText = `第 ${caret} 字后，${around(caret)}，${placed.has(caret) ? '已断' : '未断'}`;

  const passage = (
    <span className="un-sb-flow" lang="zh">
      {chars.map((ch, i) => {
        // biome-ignore lint/suspicious/noArrayIndexKey: the frozen text never reorders; position is identity
        if (ch === '\n') return <br key={i} />;
        const gap = i + 1;
        const hasGap = gapSet.has(gap);
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: the frozen text never reorders; position is identity
          <span key={i} className="un-sb-unit">
            <span className="un-sb-ch">{ch}</span>
            {hasGap ? (
              <span
                className="un-sb-gap"
                data-on={placed.has(gap) || undefined}
                data-caret={(!readOnly && caret === gap) || undefined}
              >
                {readOnly ? null : (
                  <span className="un-sb-hit" aria-hidden="true" onClick={() => toggle(gap)} />
                )}
                <span className="un-sb-mark" aria-hidden="true" />
              </span>
            ) : null}
          </span>
        );
      })}
    </span>
  );

  return (
    <section
      className={['un-answer', 'un-sb', className].filter(Boolean).join(' ')}
      aria-label={label}
      data-mode={submitted ? 'submitted' : disabled ? 'disabled' : 'edit'}
    >
      <header className="un-answer-head">
        <p className="un-answer-instruction">
          {instruction ? <span>{instruction}</span> : null}
          <span className="un-answer-meta">
            {readOnly
              ? submitted
                ? '你的作答（已提交）'
                : '暂不可修改'
              : '在两个字之间点一下放断句，再点一下取消'}
          </span>
        </p>
        <span className="un-answer-count un-num">
          已断 {count} 处
          {expectedCount !== undefined ? (
            <span className="un-answer-count-of"> · 本题共 {expectedCount} 处</span>
          ) : null}
        </span>
      </header>

      {readOnly ? (
        <div className="un-sb-text">
          {passage}
          <span className="un-sr-only">你的断句：{segmented}</span>
        </div>
      ) : (
        <div
          className="un-sb-text"
          role="slider"
          tabIndex={0}
          aria-roledescription="断句位置"
          aria-label={`${label}：用左右方向键移到两个字之间，空格放下或取消断句`}
          aria-valuemin={gaps[0] ?? 0}
          aria-valuemax={gaps[gaps.length - 1] ?? 0}
          aria-valuenow={caret}
          aria-valuetext={caretText}
          aria-describedby={`${uid}-msg`}
          onKeyDown={onKey}
        >
          {passage}
        </div>
      )}

      <footer className="un-answer-foot">
        <span id={`${uid}-msg`} className="un-sr-only" role="status" aria-live="polite">
          {message}
        </span>
        {readOnly ? null : (
          <button
            type="button"
            className="un-answer-link un-hit"
            disabled={count === 0}
            onClick={() => {
              onChange({ kind: 'sentence_breaks', positions: [] });
              setMessage('已清除全部断句。');
            }}
          >
            全部清除
          </button>
        )}
      </footer>
    </section>
  );
}
