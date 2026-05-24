import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  ANSWER_PREVIEW_DEBOUNCE_MS,
  ReviewAnswerPreview,
  shouldShowAnswerPreview,
} from './ReviewAnswerPreview';

describe('ReviewAnswerPreview', () => {
  it('renders math markdown preview for latex notation', () => {
    const html = renderToString(<ReviewAnswerPreview value="答案是 $x^2$" notation="latex" />);

    expect(html).toContain('review-answer-preview');
    expect(html).toContain('答案是');
    expect(html).toContain('class="katex"');
    expect(html).toContain('隐藏预览');
  });

  it('does not render for non-math notation', () => {
    const html = renderToString(<ReviewAnswerPreview value="文言答案" notation="wenyan" />);

    expect(html).toBe('');
    expect(shouldShowAnswerPreview('wenyan')).toBe(false);
  });

  it('keeps the preview gate and debounce explicit', () => {
    expect(shouldShowAnswerPreview('latex')).toBe(true);
    expect(shouldShowAnswerPreview(null)).toBe(false);
    expect(ANSWER_PREVIEW_DEBOUNCE_MS).toBeGreaterThanOrEqual(100);
  });
});
