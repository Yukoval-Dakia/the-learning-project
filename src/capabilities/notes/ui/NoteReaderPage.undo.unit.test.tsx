// @vitest-environment jsdom
// YUK-713 — the undo (还原) mutation had onSuccess but no onError, so a failed undo of
// an AI revision silently did nothing while the row still offered 还原. A failure must
// surface a toast (mirrors the sibling saveM.onError).

import { ApiError } from '@/ui/lib/api';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import NoteReaderPage from './NoteReaderPage';

const mocks = vi.hoisted(() => ({
  getNotePage: vi.fn(),
  getAiChanges: vi.fn(),
  undoAiChange: vi.fn(),
}));

vi.mock('./notes-api', async (importActual) => {
  const actual = await importActual<typeof import('./notes-api')>();
  return {
    ...actual,
    getNotePage: mocks.getNotePage,
    getAiChanges: mocks.getAiChanges,
    undoAiChange: mocks.undoAiChange,
    editingHeartbeat: vi.fn().mockResolvedValue(undefined),
    editingBlur: vi.fn().mockResolvedValue(undefined),
  };
});

const NOTE = {
  id: 'note_1',
  type: 'note_atomic',
  title: '测试笔记',
  knowledge_ids: ['kn_1'],
  labels: [{ id: 'kn_1', name: '知识点甲' }],
  body_blocks: { type: 'doc', content: [] },
  interactive: null,
  generation_status: 'ready',
  verification_status: 'draft',
  version: 3,
  history: [],
  backlinks: [],
  related_learning_items: [],
  created_at: '2026-07-19T00:00:00Z',
};

const CHANGE = {
  event_id: 'ev_1',
  artifact_id: 'note_1',
  created_at: '2026-07-19T00:00:00Z',
  actor_ref: 'ai',
  ops_count: 2,
  new_blocks: 1,
  previous_artifact_version: 2,
  next_artifact_version: 3,
  undone: false,
};

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <NoteReaderPage id="note_1" navigate={vi.fn()} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState({}, '', '/notes/note_1');
  mocks.getNotePage.mockResolvedValue(NOTE);
  mocks.getAiChanges.mockResolvedValue({ artifact_id: 'note_1', rows: [CHANGE] });
});

afterEach(cleanup);

describe('NoteReaderPage undo failure (YUK-713)', () => {
  it('surfaces a failure toast when undo rejects, not a false success', async () => {
    mocks.undoAiChange.mockRejectedValue(new Error('500'));
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: /还原/ }));

    expect(await screen.findByText(/还原失败/)).toBeTruthy();
    expect(screen.queryByText('已还原该次 AI 修订。')).toBeNull();
  });

  it('shows the version-conflict copy when undo raises a 409 (concurrent drift)', async () => {
    // undoAiChange turns the 200 'skipped:version_conflict' into a 409 ApiError.
    mocks.undoAiChange.mockRejectedValue(new ApiError('undo skipped: version_conflict', 409));
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: /还原/ }));

    expect(await screen.findByText(/版本冲突/)).toBeTruthy();
    expect(screen.queryByText('已还原该次 AI 修订。')).toBeNull();
  });
});
