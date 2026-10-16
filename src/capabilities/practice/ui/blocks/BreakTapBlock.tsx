// YUK-1497 — break_tap input block (presentation spec §1.2, §1.2.1; R10 断句). The frozen text is
// split by code points and grouped into graphemes, so a combining mark or an emoji is never cut.
// Only gaps declared in the universe get a tap target (gap_after_codepoint counts code points, as
// position-gap.ts does). Each target reaches to the middle of both neighbouring characters and the
// full line height, and travels with the character before it, so a gap at a line end stays
// tappable there. Keyboard: one tab stop, arrows move a caret over the declared gaps, Space or
// Enter toggles. The expected count shows only when the question says so (`expectedCount`).
import { type KeyboardEvent, useId, useMemo, useState } from 'react';

import { BlockHead, type BlockStateProps, blockMode, rovingMove, shownOutcome } from './shared';

export interface BreakGap {
  /** Stable item_id that goes into the answer. */
  id: string;
  /** gap_after_codepoint: the gap after this many code points of `text`. */
  at: number;
}

export interface BreakTapBlockProps extends BlockStateProps {
  /** Accessible name, e.g. 「第 5 题 断句」. */
  label: string;
  /** The frozen text, rendered exactly as given. */
  text: string;
  /** Declared gaps (the universe). Gaps not on a grapheme boundary are not offered. */
  gaps: BreakGap[];
  /** Shown only when the question declares the count. */
  expectedCount?: number;
  /** item_ids of the gaps the learner broke. */
  value: string[];
  onChange: (next: string[]) => void;
  className?: string;
}

type Unit = { text: string; end: number };

/** Graphemes of `text`, each with the code point offset right after it. */
function graphemes(text: string): Unit[] {
  const units: Unit[] = [];
  let end = 0;
  const parts =
    typeof Intl !== 'undefined' && 'Segmenter' in Intl
      ? Array.from(
          new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text),
          (s) => s.segment,
        )
      : Array.from(text);
  for (const part of parts) {
    end += Array.from(part).length;
    units.push({ text: part, end });
  }
  return units;
}

export function BreakTapBlock({
  label,
  text,
  gaps,
  expectedCount,
  value,
  onChange,
  className,
  ...state
}: BreakTapBlockProps) {
  const mode = blockMode(state);
  const outcome = shownOutcome(state);
  const interactive = mode === 'edit';
  const uid = useId();
  const shown = useMemo(() => graphemes(text), [text]);
  const boundaries = new Set(shown.map((unit) => unit.end));
  const offered = gaps.filter((gap) => boundaries.has(gap.at)).sort((x, y) => x.at - y.at);
  const gapAt = new Map(offered.map((gap) => [gap.at, gap]));
  const placed = new Set(value);
  const [caretState, setCaret] = useState(0);
  const caret = Math.max(0, Math.min(offered.length - 1, caretState));
  const caretGap = offered[caret];
  const [message, setMessage] = useState('');

  // Spoken context counts visible characters (graphemes), not code points.
  const unitsBefore = (at: number) => shown.findIndex((unit) => unit.end === at) + 1;
  const around = (at: number) => {
    const n = unitsBefore(at);
    const before = shown.slice(Math.max(0, n - 4), n).map((unit) => unit.text);
    const after = shown.slice(n, n + 4).map((unit) => unit.text);
    return `「${before.join('')}」与「${after.join('')}」之间`;
  };

  const toggle = (gap: BreakGap) => {
    if (!interactive) return;
    const on = !placed.has(gap.id);
    const keep = new Set(value);
    if (on) keep.add(gap.id);
    else keep.delete(gap.id);
    // Answer order follows the text, so the same breaks always give the same envelope.
    onChange(offered.filter((g) => keep.has(g.id)).map((g) => g.id));
    setCaret(offered.indexOf(gap));
    setMessage(`${on ? '已断' : '已取消'}：${around(gap.at)}`);
  };

  const onKey = (event: KeyboardEvent) => {
    const move = rovingMove(event.key, caret, offered.length);
    if (move !== null) {
      setCaret(move);
    } else if (event.key === ' ' || event.key === 'Enter') {
      if (caretGap) toggle(caretGap);
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      if (caretGap && placed.has(caretGap.id)) toggle(caretGap);
    } else {
      return;
    }
    event.preventDefault();
  };

  const count = offered.filter((gap) => placed.has(gap.id)).length;
  const segmented = shown
    .map((unit) => {
      const gap = gapAt.get(unit.end);
      return gap && placed.has(gap.id) ? `${unit.text}／` : unit.text;
    })
    .join('');

  const passage = (
    <span className="un-blk-sb-flow">
      {shown.map((unit) => {
        if (unit.text.includes('\n')) return <br key={unit.end} />;
        const gap = gapAt.get(unit.end);
        const on = gap ? placed.has(gap.id) : false;
        return (
          <span key={unit.end} className="un-blk-sb-unit">
            <span className="un-blk-sb-ch">{unit.text}</span>
            {gap ? (
              <span
                className="un-blk-sb-gap"
                data-on={on || undefined}
                data-caret={(interactive && caretGap?.id === gap.id) || undefined}
                data-outcome={on && outcome ? outcome : undefined}
              >
                {interactive ? (
                  // Pointer hit area only; keyboard users toggle through the passage's slider role.
                  <span className="un-blk-sb-hit" aria-hidden="true" onClick={() => toggle(gap)} />
                ) : null}
                <span className="un-blk-sb-mark" aria-hidden="true" />
              </span>
            ) : null}
          </span>
        );
      })}
    </span>
  );

  return (
    <section
      className={['un-blk', 'un-blk-sb', className].filter(Boolean).join(' ')}
      aria-label={label}
      data-mode={mode}
    >
      <BlockHead
        mode={mode}
        hint="在两个字之间点一下放断句，再点一下取消"
        count={
          <>
            已断 {count} 处
            {expectedCount !== undefined ? (
              <span className="un-blk-count-of"> · 本题共 {expectedCount} 处</span>
            ) : null}
          </>
        }
        outcome={outcome}
      />

      {interactive ? (
        // A caret over text gaps has no native input; the slider pattern gives arrows a value to announce.
        <div
          className="un-blk-sb-text"
          role="slider"
          tabIndex={offered.length ? 0 : -1}
          aria-roledescription="断句位置"
          aria-label={`${label}：用方向键移到两个字之间，空格放下或取消断句`}
          aria-valuemin={1}
          aria-valuemax={Math.max(1, offered.length)}
          aria-valuenow={caret + 1}
          aria-valuetext={
            caretGap
              ? `第 ${unitsBefore(caretGap.at)} 字后，${around(caretGap.at)}，${placed.has(caretGap.id) ? '已断' : '未断'}`
              : '没有可断的位置'
          }
          aria-describedby={`${uid}-msg`}
          onKeyDown={onKey}
        >
          {passage}
        </div>
      ) : (
        <div className="un-blk-sb-text">
          {passage}
          <span className="un-sr-only">你的断句：{segmented}</span>
        </div>
      )}

      <footer className="un-blk-foot">
        <span id={`${uid}-msg`} className="un-sr-only" role="status" aria-live="polite">
          {interactive ? message : ''}
        </span>
        {interactive ? (
          <button
            type="button"
            className="un-blk-link un-hit"
            disabled={count === 0}
            onClick={() => {
              onChange([]);
              setMessage('已清除全部断句。');
            }}
          >
            全部清除
          </button>
        ) : null}
      </footer>
    </section>
  );
}
