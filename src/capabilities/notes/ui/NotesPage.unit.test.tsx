// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import NotesPage from './NotesPage';
import type { NoteListRow } from './notes-api';

const mocks = vi.hoisted(() => ({ listNotes: vi.fn() }));

vi.mock('./notes-api', () => ({
  listNotes: (...args: unknown[]) => mocks.listNotes(...args),
}));

vi.mock('@/ui/hooks/useSubjects', () => ({
  useSubjects: () => ({
    subjects: [
      {
        id: 'yuwen',
        displayName: '语文',
        aliases: [],
        renderConfig: { font_family: 'serif-cjk', notation: null, code_highlight: null },
        causeCategories: [],
        isGeneralFallback: false,
        configurationStatus: 'configured',
      },
      {
        id: 'math',
        displayName: '数学',
        aliases: [],
        renderConfig: { font_family: 'system', notation: null, code_highlight: null },
        causeCategories: [],
        isGeneralFallback: false,
        configurationStatus: 'configured',
      },
    ],
    isLoading: false,
    isError: false,
  }),
}));

const yuwenNote: NoteListRow = {
  id: 'note-yuwen',
  type: 'note_atomic',
  title: '虚词用法',
  knowledge_ids: ['kc-yuwen'],
  generation_status: 'ready',
  verification_status: 'verified',
  version: 3,
  updated_at: '2026-08-20T00:00:00.000Z',
};

const mathNote: NoteListRow = {
  ...yuwenNote,
  id: 'note-math',
  title: '函数图像',
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderNotes(navigate = vi.fn()) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return {
    navigate,
    ...render(
      <QueryClientProvider client={queryClient}>
        <NotesPage navigate={navigate} />
      </QueryClientProvider>,
    ),
  };
}

describe('NotesPage', () => {
  it('renders note rows and navigates to knowledge browsing', async () => {
    mocks.listNotes.mockResolvedValue({ rows: [yuwenNote] });
    const navigate = vi.fn();
    renderNotes(navigate);

    expect(await screen.findByRole('button', { name: /虚词用法/ })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '从知识点浏览' }));

    expect(navigate).toHaveBeenCalledWith('/knowledge');
  });

  it('reloads the list when the subject tab changes', async () => {
    mocks.listNotes.mockImplementation(async (subject?: string) => ({
      rows: [subject === 'math' ? mathNote : yuwenNote],
    }));
    renderNotes();

    expect(await screen.findByRole('button', { name: /虚词用法/ })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '数学' }));

    await waitFor(() => expect(mocks.listNotes).toHaveBeenLastCalledWith('math', undefined));
    expect(await screen.findByRole('button', { name: /函数图像/ })).toBeTruthy();
  });

  it('renders the search input and leaves the unfiltered list when the query is empty', async () => {
    mocks.listNotes.mockResolvedValue({ rows: [yuwenNote] });
    renderNotes();

    const input = screen.getByLabelText('搜索笔记');
    expect((input as HTMLInputElement).placeholder).toBe('搜索笔记标题或正文…');

    expect(await screen.findByRole('button', { name: /虚词用法/ })).toBeTruthy();
    // 空查询不发 query 参数（现有行为不变）。
    await waitFor(() => expect(mocks.listNotes).toHaveBeenLastCalledWith(undefined, undefined));
  });

  it('sends the debounced query to listNotes and renders matched rows', async () => {
    mocks.listNotes.mockImplementation(async (_subject?: string, query?: string) => ({
      rows: query === '函数' ? [mathNote] : [yuwenNote],
    }));
    renderNotes();

    expect(await screen.findByRole('button', { name: /虚词用法/ })).toBeTruthy();
    await userEvent.type(screen.getByLabelText('搜索笔记'), '函数');

    await waitFor(() => expect(mocks.listNotes).toHaveBeenLastCalledWith(undefined, '函数'), {
      timeout: 2000,
    });
    expect(await screen.findByRole('button', { name: /函数图像/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /虚词用法/ })).toBeNull();
  });

  it('composes the query with the selected subject tab', async () => {
    mocks.listNotes.mockResolvedValue({ rows: [] });
    renderNotes();

    await userEvent.click(screen.getByRole('button', { name: '数学' }));
    await waitFor(() => expect(mocks.listNotes).toHaveBeenLastCalledWith('math', undefined));

    await userEvent.type(screen.getByLabelText('搜索笔记'), '导数');
    await waitFor(() => expect(mocks.listNotes).toHaveBeenLastCalledWith('math', '导数'), {
      timeout: 2000,
    });
  });

  it('shows the no-match empty state while searching', async () => {
    mocks.listNotes.mockResolvedValue({ rows: [] });
    renderNotes();

    await userEvent.type(screen.getByLabelText('搜索笔记'), '不存在关键词');
    await waitFor(
      () => expect(mocks.listNotes).toHaveBeenLastCalledWith(undefined, '不存在关键词'),
      { timeout: 2000 },
    );

    expect(await screen.findByText('没有找到匹配的笔记')).toBeTruthy();
  });
});
