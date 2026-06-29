// A5 S2 (YUK-354) — static-HTML coverage for FrontierRail. Pure presentational
// (renderToString, no jsdom). Pins: the head banner, the propose vs dense tag, the reason,
// the reused S1 BandChip, navigate targeting (encodeURIComponent), and the honest empty
// state. ⑥ red line: no bare probability / % leaks through the card.

import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { FrontierRail } from './FrontierRail';
import type { FrontierRailItem } from './knowledge-api';

/** Recursively collect every onClick handler in a React element tree (renderToString
 *  drops events, so we walk the element tree directly — robust to wrapper changes). */
function findOnClicks(node: unknown, acc: Array<() => void> = []): Array<() => void> {
  if (node == null || typeof node !== 'object') return acc;
  if (Array.isArray(node)) {
    for (const child of node) findOnClicks(child, acc);
    return acc;
  }
  const el = node as { props?: { onClick?: () => void; children?: unknown } };
  if (typeof el.props?.onClick === 'function') acc.push(el.props.onClick);
  if (el.props?.children !== undefined) findOnClicks(el.props.children, acc);
  return acc;
}

function item(overrides: Partial<FrontierRailItem> = {}): FrontierRailItem {
  return {
    kid: 'kc1',
    name: '目标知识点',
    reason: '已掌握全部 2 个前置',
    propose: false,
    lowConf: false,
    mastery: 0.6,
    mastery_lo: 0.45,
    mastery_hi: 0.75,
    low_confidence: false,
    evidence_count: 3,
    ...overrides,
  };
}

describe('FrontierRail', () => {
  it('renders the learnable-frontier head banner', () => {
    const html = renderToString(<FrontierRail items={[item()]} navigate={vi.fn()} />);
    expect(html).toContain('下一步，你学得动这些');
    expect(html).toContain('learnable_frontier');
    expect(html).toContain('frontier-card');
  });

  it('tags a dense (live) item「下一步」and shows its reason + reused BandChip', () => {
    const html = renderToString(<FrontierRail items={[item()]} navigate={vi.fn()} />);
    expect(html).toContain('frontier-tag-next');
    expect(html).toContain('下一步');
    expect(html).toContain('已掌握全部 2 个前置');
    expect(html).toContain('band-chip'); // S1 BandChip reused
  });

  it('tags a propose (cold-start) item「建议·低置信」', () => {
    const html = renderToString(
      <FrontierRail
        items={[
          item({
            kid: 'kc2',
            propose: true,
            lowConf: true,
            reason: 'AI 提议前置：基础 · 待确认',
            mastery: null,
            mastery_lo: null,
            mastery_hi: null,
            evidence_count: 0,
          }),
        ]}
        navigate={vi.fn()}
      />,
    );
    expect(html).toContain('frontier-tag-propose');
    expect(html).toContain('建议');
    expect(html).toContain('低置信');
    expect(html).toContain('AI 提议前置：基础 · 待确认');
    // cold-start band → 未知, never a bare probability / %.
    expect(html).toContain('未知');
    expect(html).not.toContain('%');
  });

  it('navigates to the encoded node route on card click', () => {
    const navigate = vi.fn();
    const clicks = findOnClicks(FrontierRail({ items: [item({ kid: 'a/b c' })], navigate }));
    expect(clicks).toHaveLength(1);
    clicks[0]();
    expect(navigate).toHaveBeenCalledWith('/knowledge/a%2Fb%20c');
  });

  it('shows an honest empty state when there is no learnable frontier', () => {
    const html = renderToString(<FrontierRail items={[]} navigate={vi.fn()} />);
    expect(html).toContain('暂无明确下一步');
    expect(html).not.toContain('frontier-card');
  });
});
