'use client';

import { useCallback, useState, useSyncExternalStore } from 'react';
import { MathMarkdown, isKatexNotation } from '@/ui/lib/math-markdown';
import { Button } from '@/ui/primitives/Button';

export const ANSWER_PREVIEW_DEBOUNCE_MS = 180;

const noop = () => {};

export function shouldShowAnswerPreview(notation?: string | null) {
  return isKatexNotation(notation);
}

export function ReviewAnswerPreview({
  value,
  notation,
}: {
  value: string;
  notation?: string | null;
}) {
  // Debounced preview: the shown value catches up with `value` after the debounce delay.
  // The pending timer is attached per value through useSyncExternalStore; a newer value
  // replaces it and unmount clears it.
  const [preview] = useState(() => ({ shown: value }));
  const subscribe = useCallback(
    (notify: () => void) => {
      if (preview.shown === value) return noop;
      const timer = window.setTimeout(() => {
        preview.shown = value;
        notify();
      }, ANSWER_PREVIEW_DEBOUNCE_MS);
      return () => window.clearTimeout(timer);
    },
    [preview, value],
  );
  const previewValue = useSyncExternalStore(
    subscribe,
    () => preview.shown,
    () => preview.shown,
  );
  const [expanded, setExpanded] = useState(true);

  if (!shouldShowAnswerPreview(notation)) return null;

  const text = previewValue.trim();

  return (
    <aside className={`review-answer-preview${expanded ? ' is-open' : ' is-collapsed'}`}>
      <div className="review-answer-preview__head">
        <span>markdown / math preview</span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setExpanded((prev) => !prev)}
          aria-expanded={expanded}
        >
          {expanded ? '隐藏预览' : '显示预览'}
        </Button>
      </div>
      {expanded && (
        <MathMarkdown
          notation={notation}
          className={`review-answer-preview__body${text ? '' : ' is-empty'}`}
        >
          {text || '输入后在这里预览 Markdown / LaTeX'}
        </MathMarkdown>
      )}
    </aside>
  );
}
