// @vitest-environment jsdom
// ADR-0033 D5 (YUK-203) — static-HTML tests for the NoteReader doc body, plus the
// YUK-384 editor-session-id transport test. The doc-body tests renderToString the
// PURE `NoteDocBody` (env-agnostic); the session-id test mounts the full
// NoteReaderPage under jsdom + @testing-library, so the file opts into the jsdom
// environment. Pins the three doc-body render modes and the stable-per-mount
// editor session id.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { questionDetailHref } from './NoteBlocks';
import NoteReaderPage, { NoteDocBody } from './NoteReaderPage';
import type { BodyBlock, NotePage } from './notes-api';

// Hoisted so the vi.mock factory can reference them (vi.mock is hoisted above imports).
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

describe('NoteDocBody (NoteReader interactive wiring)', () => {
  it('type=interactive + html → mounts the sandboxed renderer (no empty-note copy)', () => {
    const html = renderToString(
      <NoteDocBody
        type="interactive"
        title="函数图像"
        interactive={{ html: '<p>plot</p>' }}
        blocks={[]}
        navigate={vi.fn()}
        onOpenQuestion={noop}
      />,
    );
    // the renderer's load-bearing iframe sandbox + a11y title.
    expect(html).toContain('sandbox="allow-scripts"');
    expect(html).toContain('class="note-interactive-frame"');
    expect(html).toContain('title="函数图像"');
    // the interactive body is NOT mistaken for an empty note.
    expect(html).not.toContain('空笔记');
  });

  it('type=interactive + null → degraded notice, no renderer (parse-fail signal)', () => {
    const html = renderToString(
      <NoteDocBody
        type="interactive"
        title="坏产物"
        interactive={null}
        blocks={[]}
        navigate={vi.fn()}
        onOpenQuestion={noop}
      />,
    );
    expect(html).not.toContain('sandbox="allow-scripts"');
    expect(html).not.toContain('note-interactive-frame');
    expect(html).toContain('互动内容暂时无法渲染');
    expect(html).toContain('quiet-empty');
  });

  it('note type + empty blocks → empty-note prompt (not the interactive renderer)', () => {
    const html = renderToString(
      <NoteDocBody
        type="note_atomic"
        title="空"
        interactive={null}
        blocks={[]}
        navigate={vi.fn()}
        onOpenQuestion={noop}
      />,
    );
    expect(html).toContain('空笔记');
    expect(html).not.toContain('note-interactive-frame');
    expect(html).not.toContain('互动内容暂时无法渲染');
  });

  it('note type + blocks → renders block content (not interactive / not empty)', () => {
    const blocks: BodyBlock[] = [
      {
        type: 'semanticBlock',
        attrs: { id: 'b1', semantic_kind: 'definition', source_markdown: '导数的定义' },
      },
    ];
    const html = renderToString(
      <NoteDocBody
        type="note_atomic"
        title="导数"
        interactive={null}
        blocks={blocks}
        navigate={vi.fn()}
        onOpenQuestion={noop}
      />,
    );
    expect(html).toContain('导数的定义');
    expect(html).not.toContain('空笔记');
    expect(html).not.toContain('note-interactive-frame');
  });
});

describe('note surface action inventory', () => {
  it('maps a question reference to the shipped question detail route', () => {
    expect(questionDetailHref('q/with space')).toBe('/questions/q%2Fwith%20space');
  });

  it('renders question references as real actions without exposing raw ids', () => {
    const html = renderToString(
      <NoteDocBody
        type="note_atomic"
        title="判断句"
        interactive={null}
        blocks={[
          {
            type: 'questionRefBlock',
            attrs: {
              id: 'bq',
              question_id: 'question_internal_123',
              prompt_preview: '判断下列句式',
            },
          },
        ]}
        navigate={vi.fn()}
        onOpenQuestion={vi.fn()}
      />,
    );
    expect(html).toContain('<button');
    expect(html).toContain('题目引用');
    expect(html).not.toContain('question_internal_123');
    expect(html).not.toContain('旧栈');
  });
});

// ── YUK-384: stable per-mount editor session id ───────────────────────────────

const NOTE_FIXTURE: NotePage = {
  id: 'note-1',
  type: 'note_atomic',
  title: '导数',
  knowledge_ids: [],
  labels: [],
  body_blocks: { type: 'doc', content: [] },
  interactive: null,
  generation_status: 'ready',
  verification_status: 'verified',
  version: 1,
  history: [],
  backlinks: [],
  related_learning_items: [],
  created_at: '2026-07-21T00:00:00Z',
};

describe('NoteReaderPage editor session id (YUK-384 transport)', () => {
  let uuidCounter = 0;

  beforeEach(() => {
    uuidCounter = 0;
    mocks.editingHeartbeat.mockReset().mockResolvedValue(undefined);
    mocks.editingBlur.mockReset().mockResolvedValue(undefined);
    mocks.getNotePage.mockReset().mockResolvedValue(NOTE_FIXTURE);
    mocks.getAiChanges.mockReset().mockResolvedValue({ artifact_id: 'note-1', rows: [] });
    // Deterministic ids so the assertions can compare across mounts.
    vi.spyOn(crypto, 'randomUUID').mockImplementation(
      () => `session-${++uuidCounter}` as ReturnType<typeof crypto.randomUUID>,
    );
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  function renderPage() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={qc}>
        <NoteReaderPage id="note-1" navigate={vi.fn()} />
      </QueryClientProvider>,
    );
  }

  it('keeps one editor session id for a mounted edit session and creates a new id after remount', async () => {
    const user = userEvent.setup();

    const first = renderPage();
    await user.click(await screen.findByRole('tab', { name: '编辑' }));
    await waitFor(() => expect(mocks.editingHeartbeat).toHaveBeenCalled());
    const firstId = mocks.editingHeartbeat.mock.calls[0][1];
    expect(firstId).toEqual(expect.any(String));

    // Leaving the mounted edit session (unmount) blurs with the SAME session id —
    // proving the id is stable across the session, not regenerated per call.
    first.unmount();
    await waitFor(() => expect(mocks.editingBlur).toHaveBeenCalled());
    expect(mocks.editingBlur.mock.calls[0]).toEqual(['note-1', firstId]);

    // A fresh mount is a new edit session → a new session id.
    renderPage();
    await user.click(await screen.findByRole('tab', { name: '编辑' }));
    await waitFor(() => expect(mocks.editingHeartbeat).toHaveBeenCalledTimes(2));
    expect(mocks.editingHeartbeat.mock.calls[1][1]).not.toBe(firstId);
  });
});
