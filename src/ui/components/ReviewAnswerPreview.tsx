'use client';

import { MathMarkdown } from '@/ui/lib/math-markdown';
import { Button } from '@/ui/primitives/Button';
import { useEffect, useState } from 'react';

export const ANSWER_PREVIEW_DEBOUNCE_MS = 180;

export function shouldShowAnswerPreview(notation?: string | null) {
  return notation === 'latex';
}

export function ReviewAnswerPreview({
  value,
  notation,
}: {
  value: string;
  notation?: string | null;
}) {
  const [previewValue, setPreviewValue] = useState(value);
  const [expanded, setExpanded] = useState(true);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setPreviewValue(value);
    }, ANSWER_PREVIEW_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [value]);

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
          notation="latex"
          className={`review-answer-preview__body${text ? '' : ' is-empty'}`}
        >
          {text || '输入后在这里预览 Markdown / LaTeX'}
        </MathMarkdown>
      )}
    </aside>
  );
}
