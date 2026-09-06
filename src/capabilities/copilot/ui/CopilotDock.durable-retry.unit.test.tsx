// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { apiFetchMock, apiJsonMock, consumeDurableMock } = vi.hoisted(() => ({
  apiFetchMock: vi.fn(),
  apiJsonMock: vi.fn(),
  consumeDurableMock: vi.fn(),
}));

vi.mock('@/ui/lib/api', () => ({
  ApiAuthError: class ApiAuthError extends Error {},
  ApiError: class ApiError extends Error {
    details: Record<string, unknown>;
    constructor(
      message: string,
      public status: number,
      public code?: string,
      details: Record<string, unknown> = {},
    ) {
      super(message);
      this.details = details;
    }
  },
  apiFetch: apiFetchMock,
  apiJson: apiJsonMock,
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: ({ queryKey }: { queryKey: string[] }) =>
    queryKey[0] === 'copilot-sessions'
      ? {
          data: {
            sessions: [
              {
                id: 'copilot-session-test',
                status: 'active',
                title: '跨章节迁移核对',
                created_at: '2026-09-07T08:00:00.000Z',
                updated_at: '2026-09-07T08:00:00.000Z',
              },
              {
                id: 'copilot-session-old',
                status: 'active',
                title: '旧对话：定义域复盘',
                created_at: '2026-09-06T08:00:00.000Z',
                updated_at: '2026-09-06T08:00:00.000Z',
              },
            ],
          },
          isLoading: false,
          refetch: vi.fn(),
        }
      : { data: null, isLoading: false, refetch: vi.fn() },
}));

vi.mock('@/ui/lib/use-copilot-dwell', () => {
  const signalState = { request: null, clearRequest: vi.fn() };
  return {
    openCopilotForNudge: vi.fn(),
    useCopilotDwell: () => ({ open: true, openDrawer: vi.fn(), closeDrawer: vi.fn() }),
    useCopilotOpenSignal: (selector: (state: typeof signalState) => unknown) =>
      selector(signalState),
  };
});

vi.mock('./useCopilotNudges', () => ({
  useCopilotNudges: () => ({
    nudges: [],
    dismiss: vi.fn(),
    markOpened: vi.fn(),
    isMutating: false,
  }),
}));

vi.mock('@/ui/lib/deferred-markdown-renderer', () => ({
  DeferredMarkdownRenderer: ({ children }: { children: string }) => <span>{children}</span>,
  preloadMarkdownRenderer: vi.fn(),
}));

function PlainButton({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button {...props}>{children}</button>;
}

vi.mock('@/ui/primitives/Btn', () => ({ Btn: PlainButton }));
vi.mock('@/ui/primitives/Button', () => ({ Button: PlainButton }));
vi.mock('@/ui/primitives/IconBtn', () => ({ IconBtn: PlainButton }));
vi.mock('@/ui/primitives/LoomIcon', () => ({ LoomIcon: () => <span aria-hidden="true">◇</span> }));
vi.mock('@/ui/primitives/LoomBadge', () => ({
  LoomBadge: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock('@/ui/primitives/CopilotDrawer', () => ({
  CopilotDrawer: ({
    children,
    footer,
    headActions,
    summary,
    onClose,
  }: {
    children: ReactNode;
    footer: ReactNode;
    headActions: ReactNode;
    summary: ReactNode;
    onClose: () => void;
  }) => (
    <section>
      <button type="button" data-testid="drawer-close" onClick={onClose}>
        关闭
      </button>
      {headActions}
      {summary}
      {children}
      {footer}
    </section>
  ),
}));
vi.mock('@/ui/primitives/ToolUseCard', () => ({
  ToolUseCard: ({ summary, result }: { summary: string; result: ReactNode }) => (
    <article>
      <span>{summary}</span>
      {result}
    </article>
  ),
}));
vi.mock('./CopilotHeroCard', () => ({ CopilotHeroCard: () => null }));
vi.mock('./subtask-events', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./subtask-events')>();
  return { ...actual, consumeDurableCopilotRun: consumeDurableMock };
});

import { ApiAuthError, ApiError } from '@/ui/lib/api';
import { CopilotDock } from './CopilotDock';
import { PENDING_COPILOT_TURN_STORAGE_KEY } from './durable-reconnect-storage';
import { type CopilotRunView, createCopilotRunView, foldCopilotRunFrames } from './subtask-events';

interface Snapshot {
  session_id: string;
  turns: Array<Record<string, unknown>>;
  active_runs: Array<{
    run_id: string;
    session_id: string;
    status: 'queued' | 'started' | 'running' | 'cancel_requested';
    events_url: string;
  }>;
}

function snapshot(sessionId: string, activeRuns: Snapshot['active_runs'] = []): Snapshot {
  return { session_id: sessionId, turns: [], active_runs: activeRuns };
}

function activeRun(
  runId: string,
  status: 'queued' | 'started' | 'running' | 'cancel_requested' = 'queued',
  sessionId = 'copilot-session-test',
) {
  return {
    run_id: runId,
    session_id: sessionId,
    status,
    events_url: `/api/jobs/copilot_run/${runId}/events`,
  } as const;
}

function accepted(runId: string): Response {
  return new Response(JSON.stringify({ run_id: runId, session_id: 'copilot-session-test' }), {
    status: 202,
    headers: {
      Location: `/api/jobs/copilot_run/${runId}/events`,
      'Content-Type': 'application/json',
    },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function pendingSubscription(options: { signal?: AbortSignal }): Promise<CopilotRunView> {
  return new Promise((_resolve, reject) => {
    options.signal?.addEventListener(
      'abort',
      () => reject(new DOMException('Aborted', 'AbortError')),
      { once: true },
    );
  });
}

async function sendMessage(user: ReturnType<typeof userEvent.setup>, text: string) {
  const input = screen.getByTestId('copilot-composer-input');
  await user.clear(input);
  await user.type(input, text);
  await user.click(screen.getByTestId('copilot-composer-send'));
}

describe('CopilotDock unified durable conversation', () => {
  const snapshots = new Map<string, Snapshot>();

  beforeEach(() => {
    window.sessionStorage.clear();
    apiFetchMock.mockReset();
    apiJsonMock.mockReset();
    consumeDurableMock.mockReset();
    snapshots.clear();
    snapshots.set('copilot-session-test', snapshot('copilot-session-test'));
    snapshots.set('copilot-session-old', snapshot('copilot-session-old'));
    apiJsonMock.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/copilot/turns')) {
        const sessionId = new URL(url, 'http://local').searchParams.get('session_id') ?? '';
        return snapshots.get(sessionId) ?? snapshot(sessionId);
      }
      if (url.startsWith('/api/copilot/runs/')) {
        const runId = decodeURIComponent(url.split('/')[4] ?? '');
        return { ok: true, run_id: runId, status: 'cancel_requested' };
      }
      throw new Error(`unexpected apiJson call: ${url}`);
    });
    consumeDurableMock.mockImplementation(pendingSubscription);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('keeps two same-session sends distinct when their 202 responses arrive out of order', async () => {
    const user = userEvent.setup();
    const first = deferred<Response>();
    const second = deferred<Response>();
    apiFetchMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    render(<CopilotDock pathname="/practice" navigate={vi.fn()} />);
    await waitFor(() => expect(apiJsonMock).toHaveBeenCalled());

    await sendMessage(user, '先核对函数定义域。');
    await sendMessage(user, '再生成电磁感应迁移题。');
    expect((screen.getByTestId('copilot-composer-input') as HTMLTextAreaElement).disabled).toBe(
      false,
    );
    const firstHeaders = new Headers(apiFetchMock.mock.calls[0]?.[1]?.headers);
    const secondHeaders = new Headers(apiFetchMock.mock.calls[1]?.[1]?.headers);
    expect(firstHeaders.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/i);
    expect(secondHeaders.get('Idempotency-Key')).not.toBe(firstHeaders.get('Idempotency-Key'));

    await act(async () => second.resolve(accepted('run-second')));
    await waitFor(() =>
      expect(consumeDurableMock).toHaveBeenCalledWith(
        expect.objectContaining({ location: '/api/jobs/copilot_run/run-second/events' }),
      ),
    );
    await act(async () => first.resolve(accepted('run-first')));
    await waitFor(() => expect(consumeDurableMock).toHaveBeenCalledTimes(2));

    expect(screen.getAllByTestId('copilot-stop-run')).toHaveLength(2);
    expect(screen.getAllByTestId('copilot-msg-user').map((row) => row.textContent)).toEqual([
      expect.stringContaining('先核对函数定义域。'),
      expect.stringContaining('再生成电磁感应迁移题。'),
    ]);
    expect(window.sessionStorage.getItem(PENDING_COPILOT_TURN_STORAGE_KEY)).toBeNull();
  });

  it('retries an ambiguous POST with the exact same key and body while another turn remains usable', async () => {
    const user = userEvent.setup();
    apiFetchMock
      .mockRejectedValueOnce(new ApiError('ambiguous enqueue', 503, 'copilot_enqueue_ambiguous'))
      .mockResolvedValueOnce(accepted('run-recovered'))
      .mockResolvedValueOnce(accepted('run-new'));
    const rendered = render(<CopilotDock pathname="/subjects/math/mistakes" navigate={vi.fn()} />);
    await waitFor(() => expect(apiJsonMock).toHaveBeenCalled());

    await sendMessage(user, '核对 42 次含参函数作答。');
    await screen.findByTestId('copilot-pending-recovery');
    const firstHeaders = new Headers(apiFetchMock.mock.calls[0]?.[1]?.headers);
    const firstBody = apiFetchMock.mock.calls[0]?.[1]?.body;

    rendered.rerender(<CopilotDock pathname="/subjects/physics/review" navigate={vi.fn()} />);
    await user.click(within(screen.getByTestId('copilot-pending-recovery')).getByText('恢复'));
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(2));
    expect(new Headers(apiFetchMock.mock.calls[1]?.[1]?.headers).get('Idempotency-Key')).toBe(
      firstHeaders.get('Idempotency-Key'),
    );
    expect(apiFetchMock.mock.calls[1]?.[1]?.body).toBe(firstBody);

    await sendMessage(user, '继续检查退化分支。');
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(3));
    expect(new Headers(apiFetchMock.mock.calls[2]?.[1]?.headers).get('Idempotency-Key')).not.toBe(
      firstHeaders.get('Idempotency-Key'),
    );
  });

  it('dedupes an already-persisted answer when ambiguous recovery replays its 202', async () => {
    const user = userEvent.setup();
    const idempotencyKey = '97310f9e-cd35-4640-ad3b-6a3cc7b79188';
    const runId = 'run-ambiguous-already-complete';
    window.sessionStorage.setItem(
      PENDING_COPILOT_TURN_STORAGE_KEY,
      JSON.stringify({
        v: 2,
        turns: [
          {
            v: 2,
            idempotencyKey,
            userMessageId: 'optimistic-user-ambiguous',
            aiMessageId: 'optimistic-ai-ambiguous',
            userMessage: '恢复已经执行完成的歧义请求。',
            requestBody: {
              session_id: 'copilot-session-test',
              user_message: '恢复已经执行完成的歧义请求。',
              triggered_by: 'chat',
              ambient_context: { route: '/practice' },
            },
          },
        ],
      }),
    );
    snapshots.set('copilot-session-test', {
      session_id: 'copilot-session-test',
      turns: [
        {
          role: 'user',
          text: '恢复已经执行完成的歧义请求。',
          at: '2026-09-07T08:00:00.000Z',
          event_id: runId,
          session_id: 'copilot-session-test',
        },
        {
          role: 'ai',
          text: '服务端只执行并持久化了一次。',
          at: '2026-09-07T08:00:01.000Z',
          event_id: 'reply-ambiguous-already-complete',
          reply_event_id: 'reply-ambiguous-already-complete',
          session_id: 'copilot-session-test',
          run_id: runId,
        },
      ],
      active_runs: [],
    });
    apiFetchMock.mockResolvedValueOnce(accepted(runId));
    render(<CopilotDock pathname="/practice" navigate={vi.fn()} />);

    const recovery = await screen.findByTestId('copilot-pending-recovery');
    await user.click(within(recovery).getByText('恢复'));
    await waitFor(() =>
      expect(window.sessionStorage.getItem(PENDING_COPILOT_TURN_STORAGE_KEY)).toBeNull(),
    );

    expect(screen.getAllByTestId('copilot-msg-user')).toHaveLength(1);
    expect(screen.getAllByTestId('copilot-msg-ai')).toHaveLength(1);
    expect(screen.getByText('服务端只执行并持久化了一次。')).toBeTruthy();
    expect(screen.queryByText('正在等待处理这次请求。')).toBeNull();
  });

  it('treats authentication rejection as definitive and does not offer paid-run recovery', async () => {
    const user = userEvent.setup();
    apiFetchMock.mockRejectedValueOnce(new ApiAuthError('token expired'));
    render(<CopilotDock pathname="/practice" navigate={vi.fn()} />);
    await waitFor(() => expect(apiJsonMock).toHaveBeenCalled());

    await sendMessage(user, '检查权限失败不会创建恢复任务。');

    expect(await screen.findAllByText('访问令牌已失效，请重新输入。')).toHaveLength(2);
    expect(screen.queryByTestId('copilot-pending-recovery')).toBeNull();
    expect(window.sessionStorage.getItem(PENDING_COPILOT_TURN_STORAGE_KEY)).toBeNull();
    expect(screen.getAllByTestId('copilot-msg-user')).toHaveLength(1);
    expect(screen.getAllByTestId('copilot-msg-ai')).toHaveLength(1);
  });

  it('recovers every active run from one server snapshot with no accepted local cache', async () => {
    const runningId = 'run-running';
    const waitingId = 'run-waiting';
    window.sessionStorage.setItem(
      'loom:copilot:durable-reconnect:v1',
      JSON.stringify({ runId: 'obsolete-singleton' }),
    );
    snapshots.set('copilot-session-test', {
      session_id: 'copilot-session-test',
      turns: [
        {
          role: 'user',
          text: '运行中的证据核对',
          at: '2026-09-07T08:00:00.000Z',
          event_id: runningId,
          session_id: 'copilot-session-test',
        },
        {
          role: 'user',
          text: '排队中的迁移题生成',
          at: '2026-09-07T08:00:01.000Z',
          event_id: waitingId,
          session_id: 'copilot-session-test',
        },
      ],
      active_runs: [activeRun(runningId, 'running'), activeRun(waitingId, 'queued')],
    });

    render(<CopilotDock pathname="/practice" navigate={vi.fn()} />);
    await waitFor(() => expect(consumeDurableMock).toHaveBeenCalledTimes(2));

    expect(consumeDurableMock.mock.calls.map((call) => call[0].location).sort()).toEqual([
      `/api/jobs/copilot_run/${runningId}/events`,
      `/api/jobs/copilot_run/${waitingId}/events`,
    ]);
    expect(screen.getAllByTestId('copilot-stop-run')).toHaveLength(2);
    expect(screen.getByText('运行中的证据核对')).toBeTruthy();
    expect(screen.getByText('排队中的迁移题生成')).toBeTruthy();
    expect(window.sessionStorage.getItem('loom:copilot:durable-reconnect:v1')).toBeNull();
  });

  it('stops the selected waiting successor, not the running session head', async () => {
    const user = userEvent.setup();
    snapshots.set('copilot-session-test', {
      session_id: 'copilot-session-test',
      turns: [
        {
          role: 'user',
          text: '当前执行',
          at: '2026-09-07T08:00:00.000Z',
          event_id: 'run-head',
          session_id: 'copilot-session-test',
        },
        {
          role: 'user',
          text: '等待执行',
          at: '2026-09-07T08:00:01.000Z',
          event_id: 'run-waiting',
          session_id: 'copilot-session-test',
        },
      ],
      active_runs: [activeRun('run-head', 'running'), activeRun('run-waiting', 'queued')],
    });
    render(<CopilotDock pathname="/practice" navigate={vi.fn()} />);
    const stopButtons = await screen.findAllByTestId('copilot-stop-run');
    const waitingButton = stopButtons.find(
      (button) => button.closest('[data-run-id]')?.getAttribute('data-run-id') === 'run-waiting',
    );
    if (!waitingButton) throw new Error('waiting Stop button missing');
    expect(waitingButton.closest('[data-run-id]')?.getAttribute('data-run-status')).toBe('queued');

    await user.click(waitingButton);
    await waitFor(() =>
      expect(apiJsonMock).toHaveBeenCalledWith('/api/copilot/runs/run-waiting/cancel', {
        method: 'POST',
      }),
    );
    expect(apiJsonMock).not.toHaveBeenCalledWith('/api/copilot/runs/run-head/cancel', {
      method: 'POST',
    });
    expect(consumeDurableMock.mock.calls[0]?.[0]?.signal.aborted).toBe(false);
    expect(consumeDurableMock.mock.calls[1]?.[0]?.signal.aborted).toBe(false);
  });

  it('reconciles an optimistic ask with the same run from a later snapshot', async () => {
    const user = userEvent.setup();
    apiFetchMock.mockResolvedValueOnce(accepted('run-associated'));
    render(<CopilotDock pathname="/practice" navigate={vi.fn()} />);
    await waitFor(() => expect(apiJsonMock).toHaveBeenCalled());
    await sendMessage(user, '核对定义域并生成三档题。');
    await waitFor(() => expect(consumeDurableMock).toHaveBeenCalledTimes(1));

    const options = consumeDurableMock.mock.calls[0]?.[0] as {
      onUpdate: (view: CopilotRunView) => void;
    };
    act(() => {
      options.onUpdate(
        foldCopilotRunFrames(createCopilotRunView(), [
          { event_id: 1, event_type: 'copilot_run.started', payload: {} },
          { event_id: 2, event_type: 'copilot_run.delta', payload: { text: '正在核对。' } },
        ]),
      );
    });
    snapshots.set('copilot-session-test', {
      session_id: 'copilot-session-test',
      turns: [
        {
          role: 'user',
          text: '核对定义域并生成三档题。',
          at: '2026-09-07T08:00:00.000Z',
          event_id: 'run-associated',
          session_id: 'copilot-session-test',
        },
      ],
      active_runs: [activeRun('run-associated', 'running')],
    });
    await user.click(screen.getByTestId('copilot-session-list-toggle'));
    await user.click(screen.getByText('旧对话：定义域复盘'));
    await user.click(screen.getByText('跨章节迁移核对'));
    await waitFor(() => expect(consumeDurableMock).toHaveBeenCalledTimes(2));

    expect(screen.getAllByText('核对定义域并生成三档题。')).toHaveLength(1);
    expect(screen.getAllByText('正在核对。')).toHaveLength(1);
  });

  it('does not let a snapshot requested before 202 delete the newly accepted run', async () => {
    const user = userEvent.setup();
    const staleSnapshot = deferred<Snapshot>();
    apiJsonMock.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/copilot/turns')) return staleSnapshot.promise;
      throw new Error(`unexpected apiJson call: ${url}`);
    });
    apiFetchMock.mockResolvedValueOnce(accepted('run-after-snapshot-start'));
    render(<CopilotDock pathname="/practice" navigate={vi.fn()} />);

    await sendMessage(user, '在快照请求之后受理这轮。');
    await waitFor(() => expect(consumeDurableMock).toHaveBeenCalledTimes(1));
    const signal = consumeDurableMock.mock.calls[0]?.[0]?.signal as AbortSignal;
    await act(async () => staleSnapshot.resolve(snapshot('copilot-session-test')));

    expect(signal.aborted).toBe(false);
    expect(screen.getAllByTestId('copilot-stop-run')).toHaveLength(1);
    expect(screen.getByText('在快照请求之后受理这轮。')).toBeTruthy();
  });

  it('reuses a run already discovered by snapshot when its delayed 202 arrives', async () => {
    const user = userEvent.setup();
    const delayed202 = deferred<Response>();
    apiFetchMock.mockReturnValueOnce(delayed202.promise);
    render(<CopilotDock pathname="/practice" navigate={vi.fn()} />);
    await waitFor(() => expect(apiJsonMock).toHaveBeenCalled());

    await sendMessage(user, '响应迟到但服务端已经受理。');
    snapshots.set('copilot-session-test', {
      session_id: 'copilot-session-test',
      turns: [
        {
          role: 'user',
          text: '响应迟到但服务端已经受理。',
          at: '2026-09-07T08:00:00.000Z',
          event_id: 'run-delayed-202',
          session_id: 'copilot-session-test',
        },
      ],
      active_runs: [activeRun('run-delayed-202', 'running')],
    });
    await user.click(screen.getByTestId('copilot-session-list-toggle'));
    await user.click(screen.getByText('旧对话：定义域复盘'));
    await user.click(screen.getByText('跨章节迁移核对'));
    await waitFor(() => expect(consumeDurableMock).toHaveBeenCalledTimes(1));
    expect(consumeDurableMock).toHaveBeenCalledTimes(1);
    const firstSignal = consumeDurableMock.mock.calls[0]?.[0]?.signal as AbortSignal;

    await act(async () => delayed202.resolve(accepted('run-delayed-202')));
    await waitFor(() => expect(screen.getAllByTestId('copilot-stop-run')).toHaveLength(1));
    expect(consumeDurableMock).toHaveBeenCalledTimes(1);
    expect(firstSignal.aborted).toBe(false);
    expect(screen.getAllByText('响应迟到但服务端已经受理。')).toHaveLength(1);
  });

  it('keeps a delayed 202 in its original session when the user switches conversations', async () => {
    const user = userEvent.setup();
    const delayed202 = deferred<Response>();
    apiFetchMock.mockReturnValueOnce(delayed202.promise);
    render(<CopilotDock pathname="/practice" navigate={vi.fn()} />);
    await waitFor(() => expect(apiJsonMock).toHaveBeenCalled());

    await sendMessage(user, '只属于原对话的延迟受理。');
    await user.click(screen.getByTestId('copilot-session-list-toggle'));
    await user.click(screen.getByText('旧对话：定义域复盘'));
    expect(screen.queryByText('只属于原对话的延迟受理。')).toBeNull();

    await act(async () => delayed202.resolve(accepted('run-delayed-background')));
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('只属于原对话的延迟受理。')).toBeNull();
    expect(screen.queryByTestId('copilot-stop-run')).toBeNull();
    expect(consumeDurableMock).not.toHaveBeenCalled();

    snapshots.set('copilot-session-test', {
      session_id: 'copilot-session-test',
      turns: [
        {
          role: 'user',
          text: '只属于原对话的延迟受理。',
          at: '2026-09-07T08:00:00.000Z',
          event_id: 'run-delayed-background',
          session_id: 'copilot-session-test',
        },
      ],
      active_runs: [activeRun('run-delayed-background', 'queued')],
    });
    await user.click(screen.getByText('跨章节迁移核对'));
    await waitFor(() => expect(consumeDurableMock).toHaveBeenCalledTimes(1));
    expect(screen.getAllByText('只属于原对话的延迟受理。')).toHaveLength(1);
    expect(screen.getAllByTestId('copilot-stop-run')).toHaveLength(1);
  });

  it('session switching, drawer close, and unmount only unsubscribe transports', async () => {
    const user = userEvent.setup();
    snapshots.set('copilot-session-test', {
      ...snapshot('copilot-session-test'),
      active_runs: [activeRun('run-detach', 'running')],
      turns: [
        {
          role: 'user',
          text: '保持服务端运行',
          at: '2026-09-07T08:00:00.000Z',
          event_id: 'run-detach',
          session_id: 'copilot-session-test',
        },
      ],
    });
    const rendered = render(<CopilotDock pathname="/practice" navigate={vi.fn()} />);
    await waitFor(() => expect(consumeDurableMock).toHaveBeenCalledTimes(1));
    const firstSignal = consumeDurableMock.mock.calls[0]?.[0]?.signal as AbortSignal;

    await user.click(screen.getByTestId('copilot-session-list-toggle'));
    await user.click(screen.getByText('旧对话：定义域复盘'));
    await waitFor(() => expect(firstSignal.aborted).toBe(true));
    expect(apiJsonMock.mock.calls.some(([url]) => String(url).includes('/cancel'))).toBe(false);

    await user.click(screen.getByText('跨章节迁移核对'));
    await waitFor(() => expect(consumeDurableMock).toHaveBeenCalledTimes(2));
    const secondSignal = consumeDurableMock.mock.calls[1]?.[0]?.signal as AbortSignal;
    await user.click(screen.getByTestId('drawer-close'));
    expect(secondSignal.aborted).toBe(true);
    expect(apiJsonMock.mock.calls.some(([url]) => String(url).includes('/cancel'))).toBe(false);

    rendered.unmount();
    expect(apiJsonMock.mock.calls.some(([url]) => String(url).includes('/cancel'))).toBe(false);
  });

  it('reconnects one accepted run after network loss without another chat POST', async () => {
    const user = userEvent.setup();
    snapshots.set('copilot-session-test', {
      ...snapshot('copilot-session-test'),
      active_runs: [activeRun('run-network', 'running')],
      turns: [
        {
          role: 'user',
          text: '恢复网络连接',
          at: '2026-09-07T08:00:00.000Z',
          event_id: 'run-network',
          session_id: 'copilot-session-test',
        },
      ],
    });
    consumeDurableMock
      .mockRejectedValueOnce(new Error('network lost'))
      .mockImplementationOnce(pendingSubscription);
    render(<CopilotDock pathname="/practice" navigate={vi.fn()} />);

    const banner = await screen.findByTestId('copilot-run-reconnect');
    await user.click(within(banner).getByText('重新连接'));
    await waitFor(() => expect(consumeDurableMock).toHaveBeenCalledTimes(2));
    expect(consumeDurableMock.mock.calls[0]?.[0]?.location).toBe(
      '/api/jobs/copilot_run/run-network/events',
    );
    expect(consumeDurableMock.mock.calls[1]?.[0]?.location).toBe(
      '/api/jobs/copilot_run/run-network/events',
    );
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});
