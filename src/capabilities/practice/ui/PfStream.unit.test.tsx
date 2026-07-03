// YUK-551 — PfStream source-badge crash hardening. Pins that the frontier StreamSource
// (produced by softmax-selection.ts sourceForRole,走 DEFAULT softmax 路径) renders instead
// of crashing, AND that an unknown/未同步 source falls back defensively instead of throwing
// `TypeError: Cannot read properties of undefined (reading 'label')` at either bare access
// site (PfSrcBadge body + the done-row :128 doneAnchor). Static-HTML coverage (renderToString,
// no jsdom), mirroring BandChip.unit.test.tsx.
//
// Render-surface matrix (spec §测试 slice-1): PfSrcBadge is consumed by PfStream (rows) AND
// PfSolo.tsx:317 (散题作答顶栏, live). The done-row anchor at PfStream :128 is an INDEPENDENT
// second bare-index site (not routed through PfSrcBadge) — both must be covered.

import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PfSrcBadge, PfStream } from './PfStream';
import type { StreamItem, StreamView } from './practice-api';

function doneItem(overrides: Partial<StreamItem> = {}): StreamItem {
  return {
    id: 'si_1',
    position: 0,
    item_kind: 'question',
    ref_id: 'q_frontier_001',
    source: 'frontier',
    // NO 「」 anchor in the reasoning → anchorFromReasoning returns null → the done-row anchor
    // (PfStream :128) is FORCED to fall through to srcMeta(source).label. This is exactly the
    // path the pre-YUK-551 code crashed on for an unknown source.
    reasoning: '前置你都拿下了，可以开这块新内容了。',
    status: 'done',
    ...overrides,
  };
}

function streamOf(items: StreamItem[]): StreamView {
  return {
    date: '2026-07-03',
    opening_line: '今天的线。',
    items,
    progress: { done: items.filter((i) => i.status === 'done').length, total: items.length },
  };
}

const noopProps = {
  loading: false,
  error: null,
  openItem: () => {},
  refresh: () => {},
  addToast: () => {},
};

describe('PfSrcBadge (source badge — YUK-551)', () => {
  it('(a) renders the frontier source: 下一步 label, tone-hard, target icon', () => {
    const html = renderToString(<PfSrcBadge source="frontier" />);
    expect(html).toContain('下一步');
    expect(html).toContain('tone-hard');
    // target icon path is present (LoomIcon renders the svg path for the named icon).
    expect(html).toContain('svg');
  });

  it('(b) unknown/未同步 source → defensive fallback (其它 / tone-neutral), never throws', () => {
    // The failure mode YUK-551 hardens: a backend-produced source the FE union does not know.
    expect(() =>
      renderToString(<PfSrcBadge source={'some-future-source' as never} />),
    ).not.toThrow();
    const html = renderToString(<PfSrcBadge source={'some-future-source' as never} />);
    expect(html).toContain('其它');
    expect(html).toContain('tone-neutral');
  });

  it('(e) PfSolo consumption path — PfSrcBadge accepts the exact call PfSolo.tsx:317 makes', () => {
    // PfSolo renders `<PfSrcBadge source={item.source} />` in the 散题作答 topbar (live). The
    // widened `string` param + fallback mean a frontier (or any) item.source there is safe.
    expect(() => renderToString(<PfSrcBadge source="frontier" />)).not.toThrow();
  });
});

describe('PfStream done-row anchor (:128, second bare-index site — YUK-551)', () => {
  it('(c) done frontier row without a 「」 anchor → doneAnchor falls back to srcMeta(frontier).label, no throw', () => {
    const html = renderToString(<PfStream stream={streamOf([doneItem()])} {...noopProps} />);
    // pf-done-kp carries the anchor; with no 「」 it must be the source label 下一步 (not a crash).
    expect(html).toContain('pf-done-kp');
    expect(html).toContain('下一步');
  });

  it('(d) done row with an unknown source → :128 anchor falls back to 其它, no throw', () => {
    const item = doneItem({ source: 'mystery-source' as never });
    expect(() =>
      renderToString(<PfStream stream={streamOf([item])} {...noopProps} />),
    ).not.toThrow();
    const html = renderToString(<PfStream stream={streamOf([item])} {...noopProps} />);
    expect(html).toContain('pf-done-kp');
    expect(html).toContain('其它');
  });
});
