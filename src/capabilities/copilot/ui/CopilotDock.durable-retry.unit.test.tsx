// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
};

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
};

describe('CopilotDock accepted durable reconnect', () => {
  afterEach(() => {
    cleanup();
    apiFetchMock.mockReset();
    consumeDurableMock.mockReset();
  });

  it('reconnects the same run after progress loss without a second chat POST or duplicate rows', async () => {
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
    expect(consumeDurableMock.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ location, initialState: partialView }),
    );
    expect(screen.getAllByTestId('copilot-msg-user')).toHaveLength(1);
    expect(screen.getAllByTestId('copilot-msg-ai')).toHaveLength(1);
    expect(screen.getAllByTestId('copilot-subtask-card')).toHaveLength(1);
    expect(screen.getByText('三个独立探针复现同一错误，已排除偶然失误。')).toBeTruthy();
  });
});
