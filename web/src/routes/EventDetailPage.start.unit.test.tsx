// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import EventDetailPage from '@/capabilities/observability/ui/EventDetailPage';
import { ApiError, TOKEN_STORAGE_KEY } from '@/ui/lib/api';
import { startEventDetailClient } from '../../../server/start/event-client';
import { eventDetail } from '../../../server/start/event-test-fixtures';

const rpc = vi.hoisted(() => ({ getStartEventDetail: vi.fn(), postStartEventCorrection: vi.fn() }));
vi.mock('../../../server/start/event-function', () => rpc);
const clients: QueryClient[] = [];
const active = () => ({
  ...eventDetail,
  event: {
    ...eventDetail.event,
    correction_status: {
      state: 'active' as const,
      correction_event_id: null,
      replacement_event_id: null,
    },
  },
});
function mount(start = true, id = eventDetail.event.id) {
  // Explicit page retry:false must override a caller's retry policy for writes.
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 60_000 },
      mutations: { retry: 2, retryDelay: 1 },
    },
  });
  clients.push(qc);
  const navigate = vi.fn();
  const onBack = vi.fn();
  return {
    ...render(
      <QueryClientProvider client={qc}>
        <EventDetailPage
          id={id}
          navigate={navigate}
          onBack={onBack}
          {...(start ? { client: startEventDetailClient } : {})}
        />
      </QueryClientProvider>,
    ),
    qc,
    navigate,
    onBack,
    user: userEvent.setup(),
  };
}
beforeEach(() => {
  window.localStorage.setItem(TOKEN_STORAGE_KEY, 'event-page-token');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('Unexpected HTTP fallback');
    }),
  );
  rpc.getStartEventDetail.mockResolvedValue(JSON.stringify(active()));
  rpc.postStartEventCorrection.mockResolvedValue({
    correction_event_id: 'created',
    status: 201,
    canonicalLocation: '/api/events/created',
  });
});
afterEach(() => {
  cleanup();
  for (const qc of clients.splice(0)) qc.clear();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe('original event page through the injected Start transport', () => {
  it('keeps identical markup, cold read query key, raw details and chain/back navigation', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json(active()));
    const legacy = mount(false);
    await screen.findByText('作答 · 失败');
    const markup = legacy.container.innerHTML;
    cleanup();
    legacy.qc.clear();
    vi.mocked(fetch).mockClear();
    const start = mount();
    await screen.findByText('作答 · 失败');
    expect(start.container.innerHTML).toBe(markup);
    expect(start.qc.getQueryData(['event-detail', eventDetail.event.id])).toEqual(active());
    expect(rpc.getStartEventDetail).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ data: { id: eventDetail.event.id } }),
    );
    expect(start.container.querySelector('details')?.open).toBe(false);
    await start.user.click(screen.getByRole('button', { name: /查看相关题目/ }));
    expect(start.navigate).toHaveBeenCalledWith('/questions/q1');
    await start.user.click(screen.getAllByRole('button', { name: /你.*作答.*题目.*失败/ })[1]);
    expect(start.navigate).toHaveBeenCalledWith('/events/effect1');
    await start.user.click(screen.getAllByRole('button', { name: /纠正记录.*你/ })[0]);
    expect(start.navigate).toHaveBeenCalledWith('/events/correction2');
    await start.user.click(screen.getAllByRole('button', { name: /返回来源/ })[0]);
    expect(start.onBack).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['retract', 'mark_wrong', 'restore'] as const)(
    'keeps the existing %s control, trims reasons, guards busy state and invalidates only its event',
    async (kind) => {
      if (kind === 'restore')
        rpc.getStartEventDetail.mockResolvedValue(JSON.stringify(eventDetail));
      let finish: ((value: unknown) => void) | undefined;
      rpc.postStartEventCorrection.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const view = mount();
      view.qc.setQueryData(['event-detail', 'unrelated'], { untouched: true });
      await screen.findByText('作答 · 失败');
      const reason = screen.getByRole('textbox', { name: '说明原因' });
      const name =
        kind === 'retract' ? '撤回记录' : kind === 'mark_wrong' ? '标记为错误' : '恢复为有效记录';
      expect(screen.getByRole('button', { name }).hasAttribute('disabled')).toBe(true);
      await view.user.type(reason, '  保留原件与歧义  ');
      await view.user.click(screen.getByRole('button', { name }));
      expect(await screen.findByText('正在记录纠正…')).toBeTruthy();
      expect(reason.hasAttribute('disabled')).toBe(true);
      await view.user.click(screen.getByRole('button', { name }));
      expect(rpc.postStartEventCorrection).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          data: {
            id: eventDetail.event.id,
            input: {
              correction_kind: kind,
              reason_md: '保留原件与歧义',
              affected_refs: [{ kind: 'question', id: 'q1' }],
            },
          },
        }),
      );
      if (!finish) throw new Error('Pending command required');
      finish({
        correction_event_id: 'created',
        status: 201,
        canonicalLocation: '/api/events/created',
      });
      await screen.findByText('纠正已记录。');
      await waitFor(() => expect(rpc.getStartEventDetail).toHaveBeenCalledTimes(2));
      expect(view.qc.getQueryData(['event-detail', 'unrelated'])).toEqual({ untouched: true });
      expect(screen.getByRole('textbox', { name: '说明原因' })).toHaveProperty('value', '');
      expect(rpc.postStartEventCorrection).toHaveBeenCalledOnce();
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it('keeps affected refs/read-only guard and adds no supersede UI', async () => {
    rpc.getStartEventDetail.mockResolvedValue(
      JSON.stringify({ ...active(), event: { ...active().event, subject_kind: 'unrecognized' } }),
    );
    mount();
    await screen.findByText('这类记录暂时只能查看，不能在这里直接纠正。');
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(rpc.postStartEventCorrection).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /替代/ })).toBeNull();
  });
  it.each([404, 403, 500, 503])(
    'uses the original error/empty state for status %i and retries only a read',
    async (status) => {
      rpc.getStartEventDetail.mockRejectedValueOnce(
        new ApiError('visible failure', status, 'fixture'),
      );
      const view = mount();
      await screen.findByText(
        status === 404
          ? '这条证据不存在'
          : status === 403
            ? '无法查看这条证据'
            : '事件证据暂时加载失败。',
      );
      if (status === 500 || status === 503) {
        expect(screen.queryByText('这条证据不存在')).toBeNull();
        await view.user.click(screen.getByRole('button', { name: /重试/ }));
        await screen.findByText('作答 · 失败');
        expect(rpc.getStartEventDetail).toHaveBeenCalledTimes(2);
      }
      expect(rpc.postStartEventCorrection).not.toHaveBeenCalled();
    },
  );
  it('retains the draft on unknown write outcome, never retries, and permits a new explicit call', async () => {
    rpc.postStartEventCorrection.mockRejectedValueOnce(new TypeError('network lost after commit'));
    const view = mount();
    await screen.findByText('作答 · 失败');
    await view.user.type(screen.getByRole('textbox', { name: '说明原因' }), '保留草稿');
    await view.user.click(screen.getByRole('button', { name: '撤回记录' }));
    await screen.findByRole('alert');
    expect(screen.getByRole('textbox', { name: '说明原因' })).toHaveProperty('value', '保留草稿');
    expect(rpc.getStartEventDetail).toHaveBeenCalledOnce();
    expect(rpc.postStartEventCorrection).toHaveBeenCalledOnce();
    await view.user.click(screen.getByRole('button', { name: '标记为错误' }));
    await screen.findByText('纠正已记录。');
    expect(rpc.postStartEventCorrection).toHaveBeenCalledTimes(2);
  });
  it('failed post-success refresh and its read retry never replay a correction', async () => {
    const view = mount();
    await screen.findByText('作答 · 失败');
    await view.user.type(screen.getByRole('textbox', { name: '说明原因' }), '保留原件');
    rpc.getStartEventDetail.mockRejectedValueOnce(new ApiError('refresh corrupt', 500));
    await view.user.click(screen.getByRole('button', { name: '撤回记录' }));
    await screen.findByText('事件证据暂时加载失败。');
    expect(screen.getByRole('textbox', { name: '说明原因' })).toHaveProperty('value', '');
    await view.user.click(screen.getByRole('button', { name: /重试/ }));
    await waitFor(() => expect(rpc.getStartEventDetail).toHaveBeenCalledTimes(3));
    expect(rpc.postStartEventCorrection).toHaveBeenCalledOnce();
  });
  it('a new mounted page cold/deep refresh reads again without replaying writes', async () => {
    const first = mount();
    await screen.findByText('作答 · 失败');
    first.unmount();
    first.qc.clear();
    mount();
    await screen.findByText('作答 · 失败');
    expect(rpc.getStartEventDetail).toHaveBeenCalledTimes(2);
    expect(rpc.postStartEventCorrection).not.toHaveBeenCalled();
  });
  it('traces production handoff, real route and both transport consumers with14 named migrated entries', () => {
    const route = readFileSync('server/start/routes/events.$id.tsx', 'utf8');
    expect(route).toContain("createFileRoute('/events/$id')");
    expect(route).toContain('ssr: false');
    expect(route).toContain('Route.useParams()');
    expect(route).toContain('client={startEventDetailClient}');
    expect(route).toContain('window.history.back()');
    expect(route).toContain('navigate={startNavigate}');
    expect(route).toContain('StartWorkbenchShell');
    expect(readFileSync('server/start/routeTree.gen.ts', 'utf8')).toContain("'/events/$id'");
    const router = readFileSync('web/src/router.tsx', 'utf8');
    const entries = [
      ...router.matchAll(/const (\w+) = import\.meta\.env\.PROD\s*\? StartPageEntry/g),
    ].map((match) => match[1]);
    expect(entries.sort()).toEqual(
      [
        'TodayRoute',
        'InboxRoute',
        'MistakesRoute',
        'AgentNotesRoute',
        'NotesRoute',
        'EventDetailRouteC',
        'AdminConfigRoute',
        'AdminRunsRoute',
        'AdminCostRoute',
        'AdminFailuresRoute',
        'AdminSubjectsRoute',
        'AdminSubjectTraitsRoute',
        'AdminCoverageLatticeRoute',
        'AdminConjectureScoresRoute',
      ].sort(),
    );
    expect(router).toContain('component: EventDetailRouteC');
    expect(router).toContain('await loadEventDetailPage()');
    const source = readFileSync('src/capabilities/observability/ui/EventDetailPage.tsx', 'utf8');
    expect(source).toContain('client.getEventDetail(id)');
    expect(source).toContain('client.createEventCorrection(event.id');
    expect(source).not.toContain('@tanstack/react-router');
    expect(source).not.toContain('apiJson');
    expect(readFileSync('server/start/event-function.ts', 'utf8')).toContain(
      "createServerFn({ method: 'POST' })",
    );
  });
});
