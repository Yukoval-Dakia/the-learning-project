// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import NotesPage from '@/capabilities/notes/ui/NotesPage';
import { getNotePage } from '@/capabilities/notes/ui/notes-api';
import { TOKEN_STORAGE_KEY } from '@/ui/lib/api';
import { startNoteListClient } from '../../../server/start/notes-list-client';
import { noteList } from '../../../server/start/notes-list-test-fixtures';

const rpc = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../../../server/start/notes-list-function', () => ({ getStartNoteList: rpc.call }));
const clients: QueryClient[] = [];
function mount(list?: NonNullable<Parameters<typeof NotesPage>[0]['list']>) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  clients.push(qc);
  const navigate = vi.fn();
  return {
    ...render(
      <QueryClientProvider client={qc}>
        <NotesPage list={list} navigate={navigate} />
      </QueryClientProvider>,
    ),
    navigate,
    qc,
  };
}
beforeEach(() => {
  window.localStorage.setItem(TOKEN_STORAGE_KEY, 'notes-token');
  rpc.call.mockImplementation(async (options) => {
    const response = await options.fetch('/_serverFn/notes-list', { method: 'GET' });
    return response.json();
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://fixture.test');
      if (url.pathname === '/api/subjects')
        return Response.json({
          subjects: [
            { id: 'math', displayName: '数学', aliases: [] },
            { id: 'custom-science', displayName: '自建科学', aliases: ['science'] },
          ],
        });
      if (url.pathname === '/api/notes' || url.pathname === '/_serverFn/notes-list')
        return Response.json(noteList);
      if (url.pathname === '/api/notes/detail-id')
        return Response.json({ id: 'detail-id', retained: true });
      throw new Error(`Unexpected request ${url}`);
    }),
  );
});
afterEach(() => {
  cleanup();
  for (const qc of clients.splice(0)) qc.clear();
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe('original NotesPage with native Start list consumer', () => {
  it('wires the real native route and only hands off the list document', () => {
    const route = readFileSync('server/start/routes/notes.tsx', 'utf8');
    expect(route).toContain("createFileRoute('/notes')");
    expect(route).toContain('ssr: false');
    expect(route).toContain('list={startNoteListClient}');
    expect(route).toContain('StartWorkbenchShell');
    const router = readFileSync('web/src/router.tsx', 'utf8');
    expect(router).toMatch(/const NotesRoute = import\.meta\.env\.PROD\s*\? StartPageEntry/);
    expect(router).toContain('const NoteReaderRouteC = lazyRouteComponent');
    expect(readFileSync('server/start/routeTree.gen.ts', 'utf8')).toContain("'/notes'");
    expect(readFileSync('server/start/routeTree.gen.ts', 'utf8')).not.toContain("'/notes/$id'");
    const fn = readFileSync('server/start/notes-list-function.ts', 'utf8');
    expect(fn).toContain("createServerFn({ method: 'GET' })");
    expect(fn).toContain('.inputValidator((input: NoteListQuery) => input)');
  });
  it('keeps exact settled markup, subjects, links, and the legacy note-detail HTTP API', async () => {
    const legacy = mount();
    await screen.findByText(noteList.rows[0].title);
    await screen.findByRole('button', { name: '自建科学' });
    const markup = legacy.container.innerHTML;
    cleanup();
    legacy.qc.clear();
    vi.mocked(fetch).mockClear();
    const start = mount(startNoteListClient);
    await screen.findByText(noteList.rows[0].title);
    await waitFor(() => expect(start.container.innerHTML).toBe(markup));
    expect(rpc.call).toHaveBeenCalledOnce();
    expect(rpc.call.mock.calls[0][0].data).toEqual({ subject: undefined, query: undefined });
    expect(
      vi
        .mocked(fetch)
        .mock.calls.map(([url]) => String(url))
        .sort(),
    ).toEqual(['/api/subjects', '/_serverFn/notes-list'].sort());
    fireEvent.click(screen.getByRole('button', { name: /从知识点浏览/ }));
    expect(start.navigate).toHaveBeenLastCalledWith('/knowledge');
    fireEvent.click(screen.getByText(noteList.rows[0].title));
    expect(start.navigate).toHaveBeenLastCalledWith('/notes/note-0');
    expect(start.container.querySelector('script')).toBeNull();
    expect(await getNotePage('detail-id')).toEqual({ id: 'detail-id', retained: true });
    expect(vi.mocked(fetch).mock.calls.at(-1)?.[0]).toBe('/api/notes/detail-id');
  });
  it('uses native list for subjects and exactly250ms debounced trimmed text, clears search and shows search-empty copy', async () => {
    mount(startNoteListClient);
    await screen.findByText(noteList.rows[0].title);
    fireEvent.click(await screen.findByRole('button', { name: '自建科学' }));
    await waitFor(() =>
      expect(rpc.call.mock.calls.at(-1)?.[0].data).toEqual({
        subject: 'custom-science',
        query: undefined,
      }),
    );
    vi.useFakeTimers();
    fireEvent.change(screen.getByRole('textbox', { name: '搜索笔记' }), {
      target: { value: '  %_\\ α🙂  ' },
    });
    const before = rpc.call.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(249);
    });
    expect(rpc.call).toHaveBeenCalledTimes(before);
    rpc.call.mockResolvedValueOnce({ rows: [] });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(rpc.call.mock.calls.at(-1)?.[0].data).toEqual({
      subject: 'custom-science',
      query: '%_\\ α🙂',
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(screen.getByText('没有找到匹配的笔记')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '清除搜索' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    vi.useRealTimers();
    await screen.findByText(noteList.rows[0].title);
    fireEvent.click(screen.getByRole('button', { name: '全部' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '全部' }).getAttribute('aria-pressed')).toBe(
        'true',
      ),
    );
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).startsWith('/api/notes'))).toBe(
      false,
    );
  });
  it('keeps loading, error/retry, and subject-specific empty states', async () => {
    let finish: ((value: typeof noteList) => void) | undefined;
    rpc.call.mockImplementationOnce(
      () =>
        new Promise<typeof noteList>((resolve) => {
          finish = resolve;
        }),
    );
    mount(startNoteListClient);
    expect(screen.getByText('取笔记…')).toBeTruthy();
    await act(async () => {
      finish?.(noteList);
    });
    await screen.findByText(noteList.rows[0].title);
    rpc.call
      .mockRejectedValueOnce(new Error('temporarily fenced'))
      .mockResolvedValueOnce({ rows: [] });
    fireEvent.click(await screen.findByRole('button', { name: '自建科学' }));
    await screen.findByText('笔记加载失败。');
    expect(screen.queryByText('还没有匹配的笔记')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await screen.findByText('换一个科目筛选试试。');
    expect(rpc.call.mock.calls.at(-1)?.[0].data).toEqual({
      subject: 'custom-science',
      query: undefined,
    });
    expect(rpc.call).toHaveBeenCalledTimes(3);
  });
});
