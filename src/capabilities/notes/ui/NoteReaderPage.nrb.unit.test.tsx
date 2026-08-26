// @vitest-environment jsdom
// YUK-339 — read-state Notion-style structure（设计源 NoteReaderBody，
// docs/design/loom-refresh/project/screen-note-reader.jsx:32-71）：
// (a) 每块 .nrb-block 28px gutter 网格 + hover 手柄；
// (b) 块锚点 id + 深链（hash）→ 锚点滚动 seam；
// (c) section 折叠语义（标题常驻、体随折叠隐现）；
// (d) 路由级入口 param 链路（?entry= → banner/is-here）+ 深链锚点滚动的
//     端到端验证——生产侧 live 生产者（KnowledgeDetailPage noteHref /
//     knowledgeBacklinkHref）已带 ?entry=，这里在消费 seam 上钉住行为。

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import NoteReaderPage, { NoteDocBody } from './NoteReaderPage';
import type { BodyBlock, NotePage } from './notes-api';

// Hoisted so the vi.mock factory can reference them (same pattern as
// NoteReaderPage.unit.test.tsx).
const mocks = vi.hoisted(() => ({
  editingHeartbeat: vi.fn(),
  editingBlur: vi.fn(),
  getNotePage: vi.fn(),
  getAiChanges: vi.fn(),
}));
vi.mock('./notes-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./notes-api')>();
  return {
    ...actual,
    editingHeartbeat: (...a: unknown[]) => mocks.editingHeartbeat(...a),
    editingBlur: (...a: unknown[]) => mocks.editingBlur(...a),
    getNotePage: (...a: unknown[]) => mocks.getNotePage(...a),
    getAiChanges: (...a: unknown[]) => mocks.getAiChanges(...a),
  };
});

const noop = () => {};

// jsdom does not implement scrollIntoView at all — install a no-op before any
// spy so both component calls and vi.spyOn(Element.prototype, ...) work.
Element.prototype.scrollIntoView =
  Element.prototype.scrollIntoView ?? function scrollIntoViewNoop() {};

// vitest globals:false → RTL auto-cleanup 不注册；逐 describe 手动清（同仓内
// NoteEditor.a11y.unit.test.tsx 惯例），否则跨 test 的残留挂截互相污染。
afterEach(cleanup);

function renderDocBody(blocks: BodyBlock[]) {
  return render(
    <NoteDocBody
      type="note_atomic"
      title="导数"
      interactive={null}
      blocks={blocks}
      navigate={vi.fn()}
      onOpenQuestion={noop}
    />,
  );
}

const READ_BLOCKS: BodyBlock[] = [
  {
    type: 'semanticBlock',
    attrs: { id: 'sec-def', semantic_kind: 'definition', source_markdown: '导数的极限式定义。' },
  },
  {
    type: 'semanticBlock',
    attrs: { id: 'sec-mech', semantic_kind: 'mechanism', source_markdown: '几何意义：切线斜率。' },
  },
  {
    type: 'crossLinkBlock',
    attrs: { id: 'xlink-1', artifact_id: 'note_target', title: '相关笔记' },
  },
  {
    type: 'questionRefBlock',
    attrs: { id: 'qref-1', question_id: 'q1', prompt_preview: '切线斜率题面' },
  },
];

// ── (a) gutter / handle rendering per .nrb-block ─────────────────────────────

describe('NoteDocBody .nrb-block structure (YUK-339)', () => {
  it('wraps every block in .nrb-block with a .nrb-gutter + .nrb-content grid', () => {
    const { container } = renderDocBody(READ_BLOCKS);
    const blocks = container.querySelectorAll('.nrb-block');
    expect(blocks.length).toBe(READ_BLOCKS.length);
    for (const el of blocks) {
      expect(el.querySelector('.nrb-gutter')).toBeTruthy();
      expect(el.querySelector('.nrb-content')).toBeTruthy();
    }
  });

  it('anchors every block with a stable nb-<id> anchor id (outline shares the scheme)', () => {
    const { container } = renderDocBody(READ_BLOCKS);
    for (const id of ['nb-sec-def', 'nb-sec-mech', 'nb-xlink-1', 'nb-qref-1']) {
      expect(container.querySelector(`#${id}`)).toBeTruthy();
    }
  });

  it('semantic sections get the persistent .nrb-collapse handle + h2.nrb-h heading', () => {
    const { container } = renderDocBody(READ_BLOCKS);
    const sections = container.querySelectorAll('.nrb-block.nrb-h-block');
    expect(sections.length).toBe(2);
    const [def, mech] = sections;
    // section heading = semantic kind label, serif .nrb-h（设计 :63）
    expect(def.querySelector('h2.nrb-h')?.textContent).toBe('定义');
    expect(mech.querySelector('h2.nrb-h')?.textContent).toBe('机制');
    for (const el of sections) {
      expect(el.querySelector('.nrb-collapse')).toBeTruthy();
      expect(el.querySelector('.nrb-anchor-btn')).toBeNull();
      expect(el.querySelector('.nrb-collapse')?.getAttribute('aria-expanded')).toBe('true');
    }
  });

  it('non-section blocks get the .nrb-anchor-btn handle, no collapse', () => {
    const { container } = renderDocBody(READ_BLOCKS);
    const plain = [container.querySelector('#nb-xlink-1'), container.querySelector('#nb-qref-1')];
    for (const el of plain) {
      expect(el?.querySelector('.nrb-anchor-btn')).toBeTruthy();
      expect(el?.querySelector('.nrb-collapse')).toBeNull();
    }
  });
});

// ── (c) section collapse toggle semantics ────────────────────────────────────

describe('NoteDocBody section collapse (YUK-339)', () => {
  it('toggling collapse hides the section body but keeps heading + handle, and is reversible', async () => {
    const user = userEvent.setup();
    const { container } = renderDocBody(READ_BLOCKS);
    const def = container.querySelector('#nb-sec-def');
    expect(def).toBeTruthy();
    expect(screen.getByText('导数的极限式定义。')).toBeTruthy();

    const btn = () => def?.querySelector('.nrb-collapse') as HTMLButtonElement;
    expect(btn().getAttribute('aria-expanded')).toBe('true');
    // 展开态箭头右旋（设计 :56 rotate(90deg)）。
    expect(btn().querySelector('.ico')?.getAttribute('style')).toContain('rotate(90deg)');

    await user.click(btn());
    expect(screen.queryByText('导数的极限式定义。')).toBeNull();
    // 折叠后标题仍常驻（Notion toggle-heading 语义），手柄可再展开。
    expect(def?.querySelector('h2.nrb-h')?.textContent).toBe('定义');
    expect(btn().getAttribute('aria-expanded')).toBe('false');
    expect(btn().querySelector('.ico')?.getAttribute('style')).toContain('rotate(0deg)');

    await user.click(btn());
    expect(screen.getByText('导数的极限式定义。')).toBeTruthy();
    expect(btn().getAttribute('aria-expanded')).toBe('true');
  });

  it('collapsing one section leaves sibling sections expanded', async () => {
    const user = userEvent.setup();
    const { container } = renderDocBody(READ_BLOCKS);
    await user.click(container.querySelector('#nb-sec-def .nrb-collapse') as HTMLButtonElement);
    expect(screen.queryByText('导数的极限式定义。')).toBeNull();
    expect(screen.getByText('几何意义：切线斜率。')).toBeTruthy();
  });
});

// ── (b) anchor deep-link seam ────────────────────────────────────────────────

describe('NoteDocBody block anchors (YUK-339)', () => {
  it('anchor button deep-links: hash-only URL update + smooth scroll to that block', async () => {
    const user = userEvent.setup();
    window.history.pushState({}, '', '/notes/note-1?entry=k-1');
    const scrolled: Element[] = [];
    const scrollSpy = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function (
      this: Element,
    ) {
      scrolled.push(this);
    });
    try {
      const { container } = renderDocBody(READ_BLOCKS);
      const target = container.querySelector('#nb-xlink-1');
      await user.click(target?.querySelector('.nrb-anchor-btn') as HTMLButtonElement);
      // 深链：URL 变为可分享的 #nb-xlink-1，且 ?entry= 入口上下文保留。
      expect(window.location.hash).toBe('#nb-xlink-1');
      expect(window.location.search).toBe('?entry=k-1');
      expect(scrolled).toEqual([target]);
      expect(scrollSpy.mock.calls[0]?.[0]).toEqual({ behavior: 'smooth' });
    } finally {
      scrollSpy.mockRestore();
    }
  });
});

// ── (d) route-level entry param chain + deep-link anchor scroll ──────────────

const NOTE_FIXTURE: NotePage = {
  id: 'note-1',
  type: 'note_atomic',
  title: '导数',
  knowledge_ids: ['k-1'],
  labels: [{ id: 'k-1', name: '虚词' }],
  body_blocks: { type: 'doc', content: READ_BLOCKS },
  interactive: null,
  generation_status: 'ready',
  verification_status: 'verified',
  version: 1,
  history: [],
  backlinks: [],
  related_learning_items: [],
  created_at: '2026-07-21T00:00:00Z',
};

function renderReaderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <NoteReaderPage id="note-1" navigate={vi.fn()} />
    </QueryClientProvider>,
  );
}

describe('NoteReaderPage entry-param + anchor deep-link chain (YUK-339)', () => {
  let scrolled: Element[];
  let scrollSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    scrolled = [];
    scrollSpy = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function (
      this: Element,
    ) {
      scrolled.push(this);
    });
    mocks.editingHeartbeat.mockReset().mockResolvedValue(undefined);
    mocks.editingBlur.mockReset().mockResolvedValue(undefined);
    mocks.getNotePage.mockReset().mockResolvedValue(NOTE_FIXTURE);
    mocks.getAiChanges.mockReset().mockResolvedValue({ artifact_id: 'note-1', rows: [] });
  });

  afterEach(() => {
    cleanup();
    scrollSpy.mockRestore();
    vi.restoreAllMocks();
    window.history.pushState({}, '', '/');
  });

  it('?entry=<label> fires the entry banner + is-here pill (annotation chain consumer seam)', async () => {
    window.history.pushState({}, '', '/notes/note-1?entry=k-1');
    renderReaderPage();
    // banner 文案被 <b> 拆段——断在 banner 容器上。
    await waitFor(() =>
      expect(document.querySelector('.note-entry-banner')?.textContent).toContain(
        '你从「虚词」进入这篇笔记',
      ),
    );
    // strip 高亮 + 右栏入口 tag 同源 entryMatch。
    expect(document.querySelector('.entry-pill.is-here')?.textContent).toContain('虚词');
    expect(screen.getByText('入口')).toBeTruthy();
  });

  it('?entry mismatch does NOT fire the banner (no false entry context)', async () => {
    window.history.pushState({}, '', '/notes/note-1?entry=k-other');
    renderReaderPage();
    await screen.findAllByText('相关笔记');
    expect(document.querySelector('.note-entry-banner')).toBeNull();
    expect(document.querySelector('.entry-pill.is-here')).toBeNull();
  });

  it('deep-link #nb-<blockId> scrolls to that block once the note body renders', async () => {
    window.history.pushState({}, '', '/notes/note-1?entry=k-1#nb-xlink-1');
    renderReaderPage();
    await screen.findAllByText('相关笔记');
    await waitFor(() => expect(scrolled.length).toBeGreaterThan(0));
    expect(scrolled[0]?.id).toBe('nb-xlink-1');
  });

  it('no hash → no anchor scroll on load (outline-driven scroll stays the only other path)', async () => {
    window.history.pushState({}, '', '/notes/note-1');
    renderReaderPage();
    await screen.findAllByText('相关笔记');
    // 留一拍让潜在 effect 暴露（不该有任何滚动）。
    await new Promise((r) => setTimeout(r, 30));
    expect(scrolled).toEqual([]);
  });
});
