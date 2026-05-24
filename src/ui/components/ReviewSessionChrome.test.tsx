import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SessionEndSummary } from './ReviewSessionChrome';

const baseProps = {
  session: {
    id: 'sess_123',
    status: 'completed',
    started_at: Date.now() - 180_000,
  },
  reviewedCount: 8,
  ratings: { again: 1, hard: 2, good: 5 },
  durationSec: 185,
  knowledgeTouched: ['k1', 'k2'],
};

describe('SessionEndSummary', () => {
  it('renders next-step CTA links after review completion', () => {
    const html = renderToString(
      <SessionEndSummary {...baseProps} aiSummary="本次主要卡在条件概率。" />,
    );

    expect(html).toContain('ses-cta-grid');
    expect(html).toContain('href="/learning-sessions/sess_123"');
    expect(html).toContain('href="/coach"');
    expect(html).toContain('href="/learning-items"');
    expect(html).toContain('href="/knowledge"');
    expect(html.match(/class="ses-cta-link/g)).toHaveLength(4);
    expect(html).toContain('看本次 session summary');
  });

  it('keeps the summary CTA visible while the async summary is loading', () => {
    const html = renderToString(<SessionEndSummary {...baseProps} aiSummary={null} />);

    expect(html).toContain('summary 生成中');
    expect(html).toContain('href="/learning-sessions/sess_123"');
  });
});
