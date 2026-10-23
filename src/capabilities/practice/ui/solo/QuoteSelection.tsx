// YUK-1473 — 「引用到学习伙伴」 for selected question text (design doc R6, R7, M6). Selecting text
// inside a `[data-quotable]` region raises a small glass bubble (T3, bubble layer per T7);
// pressing it hands the selection, with formulas turned back into their TeX source, to the page,
// which puts it into the companion's composer. The keyboard path is the page's quote
// buttons beside each block of question text; this bubble is the pointer path (A4).
//
// No effect: the document listeners belong to the quotable root element. They are attached by
// its ref callback and removed by the callback's cleanup when the element goes away.

import { MessageSquareQuote } from 'lucide-react';
import { useCallback, useState } from 'react';
import { openCopilot, setCompanionFocus } from '@/ui/lib/use-copilot-dwell';
import type { StreamItem } from '../practice-api';

/** A quote is a handful of sentences, not the whole page. */
export const QUOTE_MAX_CHARS = 600;

export interface QuotedPassage {
  text: string;
  rect: DOMRect | null;
}

/** Selected text with KaTeX turned back into `$TeX$`, so a quote keeps its math (R7). */
function selectionText(range: Range): string {
  const holder = document.createElement('div');
  holder.append(range.cloneContents());
  for (const math of holder.querySelectorAll('.katex')) {
    const tex = math.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
    if (tex) math.replaceWith(`$${tex.trim()}$`);
  }
  // Display-math blocks also carry the MathML copy; anything left over is visible text.
  for (const extra of holder.querySelectorAll('.katex-mathml')) extra.remove();
  return (holder.textContent ?? '').replace(/\s+/g, ' ').trim();
}

export function clipQuote(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > QUOTE_MAX_CHARS ? `${flat.slice(0, QUOTE_MAX_CHARS)}…` : flat;
}

/**
 * Put an already clipped quote into the companion's composer (never sent on its own). For a
 * question the companion also shows 「正在看：题目 · …」 and offers 讲讲这题 / 出一道类似的.
 */
export function quoteToCompanion(item: StreamItem, clipped: string): void {
  if (item.item_kind === 'question') {
    const title = clipped.length > 28 ? `${clipped.slice(0, 27)}…` : clipped;
    setCompanionFocus({ kind: 'question', id: item.ref_id, title });
  }
  openCopilot(`「${clipped}」\n`, { send: false });
}

/**
 * Tracks a finished selection inside the `[data-quotable]` regions of one root element.
 * Put `attach` on that root as its ref; it is stable, so it attaches once per element.
 */
export function useQuotableSelection(): {
  selection: QuotedPassage | null;
  clear: () => void;
  attach: (root: HTMLElement | null) => (() => void) | undefined;
} {
  const [selection, setSelection] = useState<QuotedPassage | null>(null);

  const clear = useCallback(() => {
    setSelection(null);
    window.getSelection()?.removeAllRanges();
  }, []);

  const attach = useCallback((root: HTMLElement | null) => {
    if (!root) return undefined;
    let frame = 0;
    const read = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
        setSelection(null);
        return;
      }
      const range = sel.getRangeAt(0);
      const common = range.commonAncestorContainer;
      const host = common instanceof Element ? common : common.parentElement;
      const region = host?.closest('[data-quotable]');
      if (!region || !root.contains(region)) {
        setSelection(null);
        return;
      }
      const text = clipQuote(selectionText(range));
      setSelection(text ? { text, rect: range.getBoundingClientRect() } : null);
    };
    // Read once the gesture ends, so the bubble does not chase a selection being dragged.
    const settle = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(read);
    };
    const onChange = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) setSelection(null);
    };
    const onScroll = () => setSelection((current) => (current ? null : current));
    document.addEventListener('pointerup', settle);
    document.addEventListener('keyup', settle);
    document.addEventListener('selectionchange', onChange);
    window.addEventListener('scroll', onScroll, { passive: true, capture: true });
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('pointerup', settle);
      document.removeEventListener('keyup', settle);
      document.removeEventListener('selectionchange', onChange);
      window.removeEventListener('scroll', onScroll, { capture: true });
      setSelection(null);
    };
  }, []);

  return { selection, clear, attach };
}

/** The glass bubble over a selection. Pressing it keeps the selection until the quote is taken. */
export function QuoteBubble({
  selection,
  onQuote,
}: {
  selection: QuotedPassage | null;
  onQuote: (passage: QuotedPassage) => void;
}) {
  if (!selection?.rect) return null;
  const { rect } = selection;
  // Above the selection; below it when the selection sits right under the top of the screen.
  const below = rect.top < 96;
  const style = {
    left: `${Math.round(rect.left + rect.width / 2)}px`,
    top: `${Math.round(below ? rect.bottom + 8 : rect.top - 8)}px`,
  };
  return (
    <button
      type="button"
      className="un-ps-quote-bubble un-glass"
      data-below={below || undefined}
      style={style}
      // Keep the selection alive while the button is pressed.
      onPointerDown={(e) => e.preventDefault()}
      onClick={() => onQuote(selection)}
    >
      <MessageSquareQuote size={14} aria-hidden="true" />
      引用到学习伙伴
    </button>
  );
}
