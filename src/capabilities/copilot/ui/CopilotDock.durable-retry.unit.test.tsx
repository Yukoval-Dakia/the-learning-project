// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { apiFetchMock, consumeDurableMock } = vi.hoisted(() => ({
  apiFetchMock: vi.fn(),
  consumeDurableMock: vi.fn(),
}));

vi.mock('@/ui/lib/api', () => ({
  ApiError: class ApiError extends Error {
    status = 500;
    details: Record<string, unknown> | undefined;
  },
  apiFetch: apiFetchMock,
  apiJson: vi.fn(async (input: string) => {
    if (input.startsWith('/api/copilot/turns')) return { turns: [] };
    throw new Error(`unexpected apiJson call: ${input}`);
  }),
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: null, isLoading: false }),
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
  }: {
    children: ReactNode;
    footer: ReactNode;
  }) => (
    <section>
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

import { CopilotDock } from './CopilotDock';
import { DURABLE_COPILOT_RECONNECT_STORAGE_KEY } from './durable-reconnect-storage';
import { type CopilotRunView, DurablePickupStalledError } from './subtask-events';

const partialView = {
  phase: 'running' as const,
  lastEventId: 412,
  replyText: '我已核对 27 次分式方程作答，正在用未教学探针排除偶然失误。',
  checkpointEventId: 'ask_transfer_audit',
  subtasks: [
    {
      id: 'audit-transfer-evidence',
      label: '核对 27 次作答、5 次延迟复习与 3 个未教学探针',
      status: 'running' as const,
      lastEventId: 411,
    },
  ],
  frames: [
    {
      event_id: 409,
      event_type: 'copilot_run.queued',
      payload: { session_id: 'copilot-session-transfer-audit' },
    },
    { event_id: 410, event_type: 'copilot_run.started', payload: {} },
    {
      event_id: 411,
      event_type: 'copilot_run.step',
      payload: {
        step_kind: 'subtask',
        subtask_id: 'audit-transfer-evidence',
        label: '核对 27 次作答、5 次延迟复习与 3 个未教学探针',
        status: 'running',
      },
    },
    {
      event_id: 412,
      event_type: 'copilot_run.delta',
      payload: { text: '我已核对 27 次分式方程作答，正在用未教学探针排除偶然失误。' },
    },
  ],
} satisfies CopilotRunView;

const completedView = {
  phase: 'completed' as const,
  lastEventId: 416,
  replyText: '证据核对完成：错误集中在含参题的定义域前置检查。下一组练习先固定定义域，再处理通分。',
  checkpointEventId: 'ask_transfer_audit',
  subtasks: [
    {
      ...partialView.subtasks[0],
      status: 'completed' as const,
      summary: '三个独立探针复现同一错误，已排除偶然失误。',
      lastEventId: 413,
    },
  ],
  frames: [
    ...partialView.frames,
    {
      event_id: 413,
      event_type: 'copilot_run.step',
      payload: {
        step_kind: 'subtask',
        subtask_id: 'audit-transfer-evidence',
        label: '核对 27 次作答、5 次延迟复习与 3 个未教学探针',
        status: 'completed',
        summary: '三个独立探针复现同一错误，已排除偶然失误。',
      },
    },
    {
      event_id: 415,
      event_type: 'copilot_run.reply',
      payload: {
        reply_md:
          '证据核对完成：错误集中在含参题的定义域前置检查。下一组练习先固定定义域，再处理通分。',
      },
    },
    { event_id: 416, event_type: 'copilot_run.done', payload: {} },
  ],
} satisfies CopilotRunView;

const queuedView = {
  phase: 'queued' as const,
  lastEventId: 601,
  replyText: '',
  checkpointEventId: 'ask_queued_gradient_rebuild',
  subtasks: [],
  frames: [
    {
      event_id: 601,
      event_type: 'copilot_run.queued',
      payload: {
        session_id: 'copilot-session-queued-gradient-rebuild',
        pickup_deadline_ms: 1_000_000,
        dispatch: {
          source: 'model_triage',
          reason_code: 'multi_artifact_work',
          task_run_id: 'copilot_dispatch_queued_gradient_rebuild',
        },
      },
    },
  ],
} satisfies CopilotRunView;

const queuedRecoveryView = {
  phase: 'completed' as const,
  lastEventId: 608,
  replyText: '后台核对完成：36 道题分成定义域、增根与迁移三类；下一轮按两次延迟复习结果调梯度。',
  checkpointEventId: 'ask_queued_gradient_rebuild',
  subtasks: [
    {
      id: 'audit-delayed-review',
      label: '核对 36 道跨章节练习与两轮延迟复习',
      status: 'completed' as const,
      summary: '定位 7 道定义域遗漏与 3 道增根误判。',
      lastEventId: 604,
    },
    {
      id: 'validate-transfer-gradient',
      label: '用四个未教学探针验证三档迁移梯度',
      status: 'completed' as const,
      summary: '三档题目均通过确定性 validator，最高档保留一个增根陷阱。',
      lastEventId: 605,
    },
  ],
  frames: [
    ...queuedView.frames,
    { event_id: 602, event_type: 'copilot_run.started', payload: {} },
    {
      event_id: 604,
      event_type: 'copilot_run.step',
      payload: {
        step_kind: 'subtask',
        subtask_id: 'audit-delayed-review',
        label: '核对 36 道跨章节练习与两轮延迟复习',
        status: 'completed',
        summary: '定位 7 道定义域遗漏与 3 道增根误判。',
      },
    },
    {
      event_id: 605,
      event_type: 'copilot_run.step',
      payload: {
        step_kind: 'subtask',
        subtask_id: 'validate-transfer-gradient',
        label: '用四个未教学探针验证三档迁移梯度',
        status: 'completed',
        summary: '三档题目均通过确定性 validator，最高档保留一个增根陷阱。',
      },
    },
    {
      event_id: 607,
      event_type: 'copilot_run.reply',
      payload: {
        reply_md:
          '后台核对完成：36 道题分成定义域、增根与迁移三类；下一轮按两次延迟复习结果调梯度。',
      },
    },
    { event_id: 608, event_type: 'copilot_run.done', payload: {} },
  ],
} satisfies CopilotRunView;

describe('CopilotDock accepted durable reconnect', () => {
  beforeEach(() => window.sessionStorage.clear());

  afterEach(() => {
    cleanup();
    window.sessionStorage.clear();
    apiFetchMock.mockReset();
    consumeDurableMock.mockReset();
  });

  it('reconnects the same run after network progress loss without a second chat POST or duplicate rows', async () => {
    const location = '/api/jobs/copilot_run/ask_transfer_audit/events';
    apiFetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          run_id: 'ask_transfer_audit',
          session_id: 'copilot-session-transfer-audit',
          checkpoint_event_id: 'ask_transfer_audit',
        }),
        { status: 202, headers: { Location: location, 'Content-Type': 'application/json' } },
      ),
    );
    consumeDurableMock
      .mockImplementationOnce(
        async (options: { onUpdate?: (view: typeof partialView) => void }) => {
          options.onUpdate?.(partialView);
          throw new Error('proxy closed the SSE after automatic reconnects');
        },
      )
      .mockImplementationOnce(
        async (options: {
          location: string;
          initialState?: typeof partialView;
          onUpdate?: (view: typeof completedView) => void;
        }) => {
          options.onUpdate?.(completedView);
          return completedView;
        },
      );

    render(<CopilotDock pathname="/practice" navigate={vi.fn()} />);
    const user = userEvent.setup();
    await user.type(
      screen.getByTestId('copilot-composer-input'),
      '请核对近两周分式方程错因，结合延迟复习和未教学探针，再生成三档迁移练习。',
    );
    await user.click(screen.getByTestId('copilot-composer-send'));

    expect(await screen.findByRole('button', { name: '重新连接' })).toBeTruthy();
    expect(screen.getByText('后台进度连接仍未恢复；任务可能仍在运行，可以再次连接。')).toBeTruthy();
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(apiFetchMock).toHaveBeenCalledWith(
      '/api/copilot/chat',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(screen.getAllByTestId('copilot-msg-user')).toHaveLength(1);
    expect(screen.getAllByTestId('copilot-msg-ai')).toHaveLength(1);
    expect(screen.getAllByTestId('copilot-subtask-card')).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: '重新连接' }));
    await screen.findByText(completedView.replyText);
    await waitFor(() => expect(screen.queryByTestId('copilot-error')).toBeNull());

    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(consumeDurableMock).toHaveBeenCalledTimes(2);
    expect(consumeDurableMock.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ location }));
    expect(consumeDurableMock.mock.calls[0]?.[0].signal).toBeInstanceOf(AbortSignal);
    expect(consumeDurableMock.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ location, initialState: partialView }),
    );
    expect(consumeDurableMock.mock.calls[1]?.[0].signal).toBeInstanceOf(AbortSignal);
    expect(consumeDurableMock.mock.calls[1]?.[0].signal).not.toBe(
      consumeDurableMock.mock.calls[0]?.[0].signal,
    );
    expect(screen.getAllByTestId('copilot-msg-user')).toHaveLength(1);
    expect(screen.getAllByTestId('copilot-msg-ai')).toHaveLength(1);
    expect(screen.getAllByTestId('copilot-subtask-card')).toHaveLength(1);
    expect(screen.getByText('三个独立探针复现同一错误，已排除偶然失误。')).toBeTruthy();
  });

  it('unlocks a queued pickup stall and later resumes the accepted Location in the same row', async () => {
    const location = '/api/jobs/copilot_run/ask_queued_gradient_rebuild/events';
    apiFetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          run_id: 'ask_queued_gradient_rebuild',
          session_id: 'copilot-session-queued-gradient-rebuild',
          checkpoint_event_id: 'ask_queued_gradient_rebuild',
        }),
        { status: 202, headers: { Location: location, 'Content-Type': 'application/json' } },
      ),
    );
    consumeDurableMock
      .mockImplementationOnce(async (options: { onUpdate?: (view: CopilotRunView) => void }) => {
        options.onUpdate?.(queuedView);
        throw new DurablePickupStalledError(1_000_000);
      })
      .mockImplementationOnce(
        async (options: {
          location: string;
          initialState?: CopilotRunView;
          onUpdate?: (view: CopilotRunView) => void;
        }) => {
          options.onUpdate?.(queuedRecoveryView);
          return queuedRecoveryView;
        },
      );

    render(<CopilotDock pathname="/practice" navigate={vi.fn()} />);
    const user = userEvent.setup();
    await user.type(
      screen.getByTestId('copilot-composer-input'),
      '请后台核对 36 道跨章节练习、两轮延迟复习和四个未教学探针，再生成三档迁移梯度。',
    );
    await user.click(screen.getByTestId('copilot-composer-send'));

    expect(await screen.findByRole('button', { name: '重新连接' })).toBeTruthy();
    expect(
      screen.getByText('后台任务还在等待开始，可能正在排队；本次任务已保留，可以稍后重新连接。'),
    ).toBeTruthy();
    expect((screen.getByTestId('copilot-composer-input') as HTMLTextAreaElement).disabled).toBe(
      false,
    );
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getAllByTestId('copilot-msg-user')).toHaveLength(1);
    expect(screen.getAllByTestId('copilot-msg-ai')).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: '重新连接' }));
    await screen.findByText(queuedRecoveryView.replyText);

    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(consumeDurableMock).toHaveBeenCalledTimes(2);
    expect(consumeDurableMock.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ location }));
    expect(consumeDurableMock.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ location, initialState: queuedView }),
    );
    expect(screen.getAllByTestId('copilot-msg-user')).toHaveLength(1);
    expect(screen.getAllByTestId('copilot-msg-ai')).toHaveLength(1);
    expect(screen.getAllByTestId('copilot-subtask-card')).toHaveLength(2);
    expect(screen.getByText('定位 7 道定义域遗漏与 3 道增根误判。')).toBeTruthy();
  });

  it('keeps an accepted-without-Location error actionable without rendering a no-op retry', async () => {
    apiFetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          run_id: 'ask_proxy_stripped_location',
          session_id: 'copilot-session-proxy-stripped-location',
          checkpoint_event_id: 'ask_proxy_stripped_location',
        }),
        { status: 202, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    render(<CopilotDock pathname="/practice" navigate={vi.fn()} />);
    const user = userEvent.setup();
    await user.type(
      screen.getByTestId('copilot-composer-input'),
      '请后台核对 24 道含参方程、三轮延迟复习与四个迁移探针。',
    );
    await user.click(screen.getByTestId('copilot-composer-send'));

    expect(
      await screen.findByText('后台任务已受理，但没有返回进度地址；请稍后重新打开对话。'),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull();
    expect(screen.queryByRole('button', { name: '重新连接' })).toBeNull();
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(consumeDurableMock).not.toHaveBeenCalled();
    expect(screen.getAllByTestId('copilot-msg-user')).toHaveLength(1);
    expect(screen.getAllByTestId('copilot-msg-ai')).toHaveLength(1);
    expect((screen.getByTestId('copilot-composer-input') as HTMLTextAreaElement).disabled).toBe(
      false,
    );
  });

  it('keeps the composer honestly disabled while an inline subtask is still running', async () => {
    let releaseTerminalReply: (() => void) | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            `event: subtask\ndata: ${JSON.stringify({
              step_kind: 'subtask',
              subtask_id: 'audit-inline-transfer-evidence',
              label: '核对 36 道跨章节练习、两轮延迟复习与四个未教学探针',
              status: 'running',
            })}\n\n`,
          ),
        );
        releaseTerminalReply = () => {
          controller.enqueue(
            new TextEncoder().encode(
              `event: reply\ndata: ${JSON.stringify({
                reply: '核对完成：定义域遗漏与增根误判是两类稳定错因，下一轮分别安排迁移题。',
                session_id: 'copilot-session-inline-transfer-audit',
                reply_event_id: 'copilot_reply_inline_transfer_audit',
                checkpoint_event_id: 'copilot_user_ask_inline_transfer_audit',
              })}\n\n`,
            ),
          );
          controller.close();
        };
      },
    });
    apiFetchMock.mockResolvedValue(
      new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    );

    render(<CopilotDock pathname="/practice" navigate={vi.fn()} />);
    const user = userEvent.setup();
    await user.type(
      screen.getByTestId('copilot-composer-input'),
      '核对我的跨章节练习与延迟复习证据，再区分定义域遗漏和增根误判。',
    );
    await user.click(screen.getByTestId('copilot-composer-send'));

    expect(
      await screen.findByText('核对 36 道跨章节练习、两轮延迟复习与四个未教学探针'),
    ).toBeTruthy();
    expect(screen.queryByTestId('copilot-thinking')).toBeNull();
    expect((screen.getByTestId('copilot-composer-input') as HTMLTextAreaElement).disabled).toBe(
      true,
    );
    expect((screen.getByTestId('copilot-composer-send') as HTMLButtonElement).disabled).toBe(true);

    await act(async () => releaseTerminalReply?.());
    await screen.findByText('核对完成：定义域遗漏与增根误判是两类稳定错因，下一轮分别安排迁移题。');
    expect((screen.getByTestId('copilot-composer-input') as HTMLTextAreaElement).disabled).toBe(
      false,
    );
    await user.type(screen.getByTestId('copilot-composer-input'), '继续生成下一档迁移题');
    expect((screen.getByTestId('copilot-composer-send') as HTMLButtonElement).disabled).toBe(false);
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(consumeDurableMock).not.toHaveBeenCalled();
  });

  it('persists an accepted handle across unmount and resumes it without posting the turn again', async () => {
    const location = '/api/jobs/copilot_run/ask_unmount_transfer_audit/events';
    apiFetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          run_id: 'ask_unmount_transfer_audit',
          session_id: 'copilot-session-unmount-transfer-audit',
          checkpoint_event_id: 'ask_unmount_transfer_audit',
        }),
        { status: 202, headers: { Location: location, 'Content-Type': 'application/json' } },
      ),
    );
    let transportSignal: AbortSignal | undefined;
    consumeDurableMock
      .mockImplementationOnce(
        async (options: { signal?: AbortSignal }): Promise<typeof completedView> => {
          transportSignal = options.signal;
          return await new Promise((_resolve, reject) => {
            options.signal?.addEventListener(
              'abort',
              () => reject(new DOMException('dock unmounted', 'AbortError')),
              { once: true },
            );
          });
        },
      )
      .mockImplementationOnce(
        async (options: {
          location: string;
          initialState?: CopilotRunView;
          onUpdate?: (view: CopilotRunView) => void;
        }) => {
          options.onUpdate?.(completedView);
          return completedView;
        },
      );

    const rendered = render(<CopilotDock pathname="/practice" navigate={vi.fn()} />);
    const user = userEvent.setup();
    await user.type(
      screen.getByTestId('copilot-composer-input'),
      '请后台核对 36 道跨章节练习、两轮延迟复习与四个未教学探针，并保留每档 validator 证据。',
    );
    await user.click(screen.getByTestId('copilot-composer-send'));
    await waitFor(() => expect(transportSignal).toBeDefined());

    rendered.unmount();

    expect(transportSignal?.aborted).toBe(true);
    expect(window.sessionStorage.getItem(DURABLE_COPILOT_RECONNECT_STORAGE_KEY)).not.toBeNull();

    render(<CopilotDock pathname="/practice" navigate={vi.fn()} />);
    await screen.findByText(completedView.replyText);

    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(apiFetchMock).toHaveBeenCalledWith(
      '/api/copilot/chat',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(consumeDurableMock).toHaveBeenCalledTimes(2);
    expect(consumeDurableMock.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        location,
        initialState: expect.objectContaining({ lastEventId: 0, frames: [] }),
      }),
    );
    expect(screen.getAllByTestId('copilot-msg-user')).toHaveLength(1);
    expect(screen.getAllByTestId('copilot-msg-ai')).toHaveLength(1);
    expect(screen.getAllByTestId('copilot-subtask-card')).toHaveLength(1);
    expect(window.sessionStorage.getItem(DURABLE_COPILOT_RECONNECT_STORAGE_KEY)).toBeNull();
  });

  it('aborts a pending dispatch on unmount before a durable consumer can start', async () => {
    let dispatchSignal: AbortSignal | undefined;
    apiFetchMock.mockImplementationOnce(
      async (_input: string, init?: RequestInit): Promise<Response> => {
        dispatchSignal = init?.signal ?? undefined;
        return await new Promise((_resolve, reject) => {
          dispatchSignal?.addEventListener(
            'abort',
            () => reject(new DOMException('dock unmounted before 202', 'AbortError')),
            { once: true },
          );
        });
      },
    );

    const rendered = render(<CopilotDock pathname="/practice" navigate={vi.fn()} />);
    const user = userEvent.setup();
    await user.type(
      screen.getByTestId('copilot-composer-input'),
      '请在后台交叉核对 48 道真实作答、三轮延迟复习与六个未教学探针，再生成完整迁移题组。',
    );
    await user.click(screen.getByTestId('copilot-composer-send'));
    await waitFor(() => expect(dispatchSignal).toBeDefined());

    rendered.unmount();

    expect(dispatchSignal?.aborted).toBe(true);
    await Promise.resolve();
    expect(consumeDurableMock).not.toHaveBeenCalled();
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
  });

  it('treats 202 Location as accepted even when the informational JSON body is unreadable', async () => {
    const location = '/api/jobs/copilot_run/ask_truncated_acceptance/events';
    const accepted = new Response('{"run_id":"ask_truncated_acceptance"', {
      status: 202,
      headers: { Location: location, 'Content-Type': 'application/json' },
    });
    const jsonMock = vi.fn(async () => {
      throw new SyntaxError('truncated JSON after 202 headers');
    });
    Object.defineProperty(accepted, 'json', { value: jsonMock });
    apiFetchMock.mockResolvedValue(accepted);
    consumeDurableMock.mockImplementationOnce(
      async (options: { onUpdate?: (view: typeof completedView) => void }) => {
        options.onUpdate?.(completedView);
        return completedView;
      },
    );

    render(<CopilotDock pathname="/practice" navigate={vi.fn()} />);
    const user = userEvent.setup();
    await user.type(
      screen.getByTestId('copilot-composer-input'),
      '请后台核验 32 道真实作答与四组未教学探针，并按 validator 证据重建迁移梯度。',
    );
    await user.click(screen.getByTestId('copilot-composer-send'));
    await screen.findByText(completedView.replyText);

    expect(jsonMock).not.toHaveBeenCalled();
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(consumeDurableMock).toHaveBeenCalledTimes(1);
    expect(consumeDurableMock.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ location }));
    expect(screen.getAllByTestId('copilot-msg-user')).toHaveLength(1);
    expect(screen.getAllByTestId('copilot-msg-ai')).toHaveLength(1);
    expect(screen.getAllByTestId('copilot-subtask-card')).toHaveLength(1);
  });
});
