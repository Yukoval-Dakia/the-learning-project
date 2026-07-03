// YUK-551 — PfStream source-badge crash hardening. Pins that the frontier StreamSource
// (produced by softmax-selection.ts sourceForRole,走 DEFAULT softmax 路径) renders instead
// of crashing, AND that an unknown/未同步 source falls back defensively instead of throwing
// `TypeError: Cannot read properties of undefined (reading 'label')` at either bare access
// site (PfSrcBadge body + the done-row doneAnchor). Static-HTML coverage (renderToString,
// no jsdom), mirroring BandChip.unit.test.tsx.
//
// Render-surface matrix (spec §测试 slice-1): PfSrcBadge is consumed by PfStream (rows) AND
// PfSolo.tsx:317 (散题作答顶栏, live) — PfSolo renders `<PfSrcBadge source={item.source} />`
// through the SAME centralized srcMeta accessor exercised here (review finder C verified the
// call site), so badge-level coverage here covers that surface too; PfSolo itself is not
// statically renderable (TanStack Query hooks). The done-row anchor (doneAnchor in PfStream)
// is an INDEPENDENT second access site (not routed through PfSrcBadge) — covered separately.

import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PfSrcBadge, PfStream } from './PfStream';
import type { StreamItem, StreamView } from './practice-api';

// LoomIcon 独有 path 片段（勿断 'svg'——任何 icon 都含）:target=三同心圆（r="8"/r="4"/r="1"）,
// doc=文档折角（M14 3v5h5）。断片段=断「渲染的是这个 icon」而非「渲染了某个 icon」。
const TARGET_ICON_FRAGMENT = 'r="8"';
const DOC_ICON_FRAGMENT = 'M14 3v5h5';

function doneItem(overrides: Partial<StreamItem> = {}): StreamItem {
  return {
    id: 'si_1',
    position: 0,
    item_kind: 'question',
    ref_id: 'q_frontier_001',
    source: 'frontier',
    // NO 「」 anchor in the reasoning → anchorFromReasoning returns null → the done-row anchor
    // is FORCED to fall through to srcMeta(source).label. This is exactly the path the
    // pre-YUK-551 code crashed on for an unknown source.
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

// srcMeta 的 dev-only 未知源 warn（F2）会在 fallback 用例里 fire——spy 住保持测试输出干净,
// 并在 (b) 顺带断言 once-per-source 语义。
let warnSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('PfSrcBadge (source badge — YUK-551)', () => {
  it('(a) renders the frontier source: 下一步 label, tone-neutral (owner 2026-07-03 重裁), target icon', () => {
    // tone 两轮裁决:初裁 hard(「唯一未占用」前提被 review 证伪)→ owner 重裁 neutral(唯一
    // 不断言难度/掌握的 tone;与 on_demand/import 共用有先例)。见 PfStream SRC_META 注释。
    // PfSolo.tsx:317 顶栏经同一 PfSrcBadge/srcMeta 路径消费——本断言同时覆盖该 surface。
    const html = renderToString(<PfSrcBadge source="frontier" />);
    expect(html).toContain('下一步');
    expect(html).toContain('tone-neutral');
    expect(html).toContain(TARGET_ICON_FRAGMENT);
    expect(warnSpy).not.toHaveBeenCalled(); // 已知源绝不触发未知源 warn。
  });

  it('(b) unknown/未同步 source → fallback（其它来源/neutral/doc icon）+ dev warn 恰一次', () => {
    // The failure mode YUK-551 hardens: a backend-produced source the FE union does not know.
    // renderToString 本身即「不 throw」断言（异常会直接 fail）——不裹 .not.toThrow()。
    const html = renderToString(<PfSrcBadge source={'some-future-source' as never} />);
    expect(html).toContain('其它来源');
    expect(html).toContain('tone-neutral');
    expect(html).toContain(DOC_ICON_FRAGMENT);
    // F2 once-per-source: 同一未知值重复渲染只 warn 一次（模块级 Set 去重,消息指引同步点）。
    renderToString(<PfSrcBadge source={'some-future-source' as never} />);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('some-future-source'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('SRC_META'));
  });
});

describe('PfStream done-row anchor (second bare-index site — YUK-551)', () => {
  it('(c) done frontier row without a 「」 anchor → doneAnchor falls back to srcMeta(frontier).label', () => {
    const html = renderToString(<PfStream stream={streamOf([doneItem()])} {...noopProps} />);
    // pf-done-kp carries the anchor; with no 「」 it must be the source label 下一步 (not a crash).
    expect(html).toContain('pf-done-kp');
    expect(html).toContain('下一步');
  });

  it('(d) done row with an unknown source → anchor falls back to 其它来源, no crash', () => {
    const item = doneItem({ source: 'mystery-source' as never });
    const html = renderToString(<PfStream stream={streamOf([item])} {...noopProps} />);
    expect(html).toContain('pf-done-kp');
    expect(html).toContain('其它来源');
  });
});
