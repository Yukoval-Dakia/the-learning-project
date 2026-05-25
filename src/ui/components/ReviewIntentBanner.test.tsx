import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ReviewIntentBanner } from './ReviewIntentBanner';

const noop = vi.fn();

describe('ReviewIntentBanner', () => {
  it('renders intent text and icon actions', () => {
    const html = renderToString(
      <ReviewIntentBanner
        intent="今天重点看概念错因。"
        updatedAtMs={1_000}
        nowMs={2_000}
        onDismiss={noop}
        onRefresh={noop}
      />,
    );
    expect(html).toContain('今天重点看概念错因。');
    expect(html).toContain('aria-label="刷新 session intent"');
    expect(html).toContain('aria-label="隐藏 session intent"');
    expect(html).not.toContain('已超过 24h');
  });

  it('marks old intent data as stale', () => {
    const html = renderToString(
      <ReviewIntentBanner
        intent="今天重点看逾期题。"
        updatedAtMs={1_000}
        nowMs={1_000 + 25 * 60 * 60 * 1000}
        onDismiss={noop}
        onRefresh={noop}
      />,
    );
    expect(html).toContain('已超过 24h');
  });

  it('disables refresh while refetching', () => {
    const html = renderToString(
      <ReviewIntentBanner
        intent="今天重点看表达错因。"
        updatedAtMs={1_000}
        nowMs={2_000}
        refreshing
        onDismiss={noop}
        onRefresh={noop}
      />,
    );
    expect(html).toContain('disabled=""');
  });
});
