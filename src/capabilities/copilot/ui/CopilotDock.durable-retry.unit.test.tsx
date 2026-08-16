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
  CopilotDrawer: ({ children, footer }: { children: ReactNode; footer: ReactNode }) => (
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

import { ApiError } from '@/ui/lib/api';
import { CopilotDock } from './CopilotDock';
import {
  DURABLE_COPILOT_RECONNECT_STORAGE_KEY,
  PENDING_COPILOT_TURN_STORAGE_KEY,
} from './durable-reconnect-storage';
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

const failedView = {
  phase: 'failed' as const,
  lastEventId: 705,
  replyText: '',
  subtasks: [
    {
      id: 'validate-parametric-transfer',
      label: '用五个未教学探针验证含参分式方程迁移题',
      status: 'failed' as const,
      error: '子任务未完成',
      lastEventId: 704,
    },
  ],
  frames: [
    {
      event_id: 701,
      event_type: 'copilot_run.queued',
      payload: { session_id: 'copilot-session-failed-transfer' },
    },
    { event_id: 702, event_type: 'copilot_run.started', payload: {} },
    {
      event_id: 703,
      event_type: 'copilot_run.step',
      payload: {
        step_kind: 'subtask',
        subtask_id: 'validate-parametric-transfer',
        label: '用五个未教学探针验证含参分式方程迁移题',
        status: 'running',
      },
    },
    {
      event_id: 704,
      event_type: 'copilot_run.step',
      payload: {
        step_kind: 'subtask',
        subtask_id: 'validate-parametric-transfer',
        label: '用五个未教学探针验证含参分式方程迁移题',
        status: 'failed',
        error: '子任务未完成',
      },
    },
    {
      event_id: 705,
      event_type: 'copilot_run.failed',
      payload: { reason: 'exhausted', error: 'provider budget exhausted' },
    },
  ],
} satisfies CopilotRunView;

const ambiguousWarning =
  '这次后台运行已经开始，但结果没有可靠保存。为避免重复执行可能已经发生的操作，我没有自动重跑；请先确认现有结果，再决定是否重新发起。';
const ambiguousFailedView = {
  phase: 'failed' as const,
  lastEventId: 805,
  replyText: ambiguousWarning,
  failureReason: 'ambiguous_execution',
  subtasks: [],
  frames: [
    {
      event_id: 801,
      event_type: 'copilot_run.queued',
      payload: { session_id: 'copilot-session-ambiguous-materialization' },
    },
    { event_id: 802, event_type: 'copilot_run.started', payload: {} },
    { event_id: 803, event_type: 'copilot_run.execution_started', payload: {} },
    {
      event_id: 805,
      event_type: 'copilot_run.failed',
      payload: {
        reason: 'ambiguous_execution',
        error: 'execution outcome could not be confirmed after worker recovery',
        reply_md: ambiguousWarning,
      },
    },
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

  it('reuses one Idempotency-Key for pre-202 retry and mints a new key for the next turn', async () => {
    const location = '/api/jobs/copilot_run/ask_lost_202_recovered/events';
    const inlineReply = new Response(
      `event: reply\ndata: ${JSON.stringify({
        reply: '补充核对完成：极端参数下仍需先固定定义域，再检查增根。',
        session_id: 'copilot-session-after-recovery',
        reply_event_id: 'copilot_reply_after_recovery',
        checkpoint_event_id: 'copilot_user_ask_after_recovery',
      })}\n\n`,
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    );
    apiFetchMock
      .mockRejectedValueOnce(new Error('proxy reset before response headers'))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ run_id: 'ask_lost_202_recovered' }), {
          status: 202,
          headers: { Location: location, 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(inlineReply);
    consumeDurableMock.mockImplementationOnce(
      async (options: { onUpdate?: (view: typeof completedView) => void }) => {
        options.onUpdate?.(completedView);
        return completedView;
      },
    );

    const rendered = render(<CopilotDock pathname="/practice" navigate={vi.fn()} />);
    const user = userEvent.setup();
    const firstQuestion =
      '交叉核对近 45 天 36 道含参函数与电磁感应错题、三轮延迟复习和五个未教学探针，再逐题保留 validator 证据。';
    await user.type(screen.getByTestId('copilot-composer-input'), firstQuestion);
    await user.click(screen.getByTestId('copilot-composer-send'));
    expect(await screen.findByRole('button', { name: '恢复' })).toBeTruthy();

    // Navigation changed after the ambiguous POST. Retry must preserve the
    // original /practice ambient body, otherwise the server correctly returns
    // idempotency_conflict instead of recovering the lost 202.
    rendered.rerender(<CopilotDock pathname="/subjects/math/mistakes" navigate={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: '恢复' }));
    await screen.findByText(completedView.replyText);

    const firstHeaders = new Headers(apiFetchMock.mock.calls[0]?.[1]?.headers);
    const retryHeaders = new Headers(apiFetchMock.mock.calls[1]?.[1]?.headers);
    const firstKey = firstHeaders.get('Idempotency-Key');
    expect(firstKey).toMatch(/^[0-9a-f-]{36}$/i);
    expect(retryHeaders.get('Idempotency-Key')).toBe(firstKey);
    expect(apiFetchMock.mock.calls[1]?.[1]?.body).toBe(apiFetchMock.mock.calls[0]?.[1]?.body);
    expect(String(apiFetchMock.mock.calls[1]?.[1]?.body)).toContain('"route":"/practice"');
    expect(screen.getAllByTestId('copilot-msg-user')).toHaveLength(1);

    await user.type(
      screen.getByTestId('copilot-composer-input'),
      '再单独核对极端参数下的定义域与增根分支。',
    );
    await user.click(screen.getByTestId('copilot-composer-send'));
    await screen.findByText('补充核对完成：极端参数下仍需先固定定义域，再检查增根。');

    const nextHeaders = new Headers(apiFetchMock.mock.calls[2]?.[1]?.headers);
    expect(nextHeaders.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/i);
    expect(nextHeaders.get('Idempotency-Key')).not.toBe(firstKey);
  });

  it('keeps the exact pending turn after explicit 503 enqueue ambiguity', async () => {
    const location = '/api/jobs/copilot_run/ask_structured_503_recovered/events';
    apiFetchMock
      .mockRejectedValueOnce(
        new ApiError(
          'durable run accepted but queue state is unknown',
          503,
          'copilot_enqueue_ambiguous',
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ run_id: 'ask_structured_503_recovered' }), {
          status: 202,
          headers: { Location: location, 'Content-Type': 'application/json' },
        }),
      );
    consumeDurableMock.mockImplementationOnce(
      async (options: { onUpdate?: (view: CopilotRunView) => void }) => {
        options.onUpdate?.(completedView);
        return completedView;
      },
    );

    render(<CopilotDock pathname="/practice" navigate={vi.fn()} />);
    const user = userEvent.setup();
    await user.type(
      screen.getByTestId('copilot-composer-input'),
      '交叉核对 38 道含参作答、两轮延迟复习和四个未教学探针，再按 validator 证据生成三档迁移题。',
    );
    await user.click(screen.getByTestId('copilot-composer-send'));

    expect(await screen.findByRole('button', { name: '恢复' })).toBeTruthy();
    expect(window.sessionStorage.getItem(PENDING_COPILOT_TURN_STORAGE_KEY)).not.toBeNull();
    const firstHeaders = new Headers(apiFetchMock.mock.calls[0]?.[1]?.headers);
    const firstBody = apiFetchMock.mock.calls[0]?.[1]?.body;

    await user.click(screen.getByRole('button', { name: '恢复' }));
    await screen.findByText(completedView.replyText);

    const retryHeaders = new Headers(apiFetchMock.mock.calls[1]?.[1]?.headers);
    expect(retryHeaders.get('Idempotency-Key')).toBe(firstHeaders.get('Idempotency-Key'));
    expect(apiFetchMock.mock.calls[1]?.[1]?.body).toBe(firstBody);
    expect(window.sessionStorage.getItem(PENDING_COPILOT_TURN_STORAGE_KEY)).toBeNull();
  });

  it('replaces stale progress and retries a terminal FAILED run as a new keyed attempt', async () => {
    const runId = 'ask_failed_transfer';
    const location = `/api/jobs/copilot_run/${runId}/events`;
    const retryRunId = 'ask_failed_transfer_retry';
    const retryLocation = `/api/jobs/copilot_run/${retryRunId}/events`;
    apiFetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ run_id: runId }), {
          status: 202,
          headers: { Location: location, 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ run_id: retryRunId }), {
          status: 202,
          headers: { Location: retryLocation, 'Content-Type': 'application/json' },
        }),
      );
    consumeDurableMock
      .mockImplementationOnce(async (options: { onUpdate?: (view: typeof failedView) => void }) => {
        options.onUpdate?.(failedView);
        return failedView;
      })
      .mockImplementationOnce(
        async (options: { onUpdate?: (view: typeof completedView) => void }) => {
          options.onUpdate?.(completedView);
          return completedView;
        },
      );

    render(<CopilotDock pathname="/practice" navigate={vi.fn()} />);
    const user = userEvent.setup();
    await user.type(
      screen.getByTestId('copilot-composer-input'),
      '用五个未教学探针验证含参分式方程迁移题，并把无法收敛的证据明确保留下来。',
    );
    await user.click(screen.getByTestId('copilot-composer-send'));

    expect(
      await screen.findByText('这次后台运行没有完成。可以换个更聚焦的问法再试。'),
    ).toBeTruthy();
    expect(
      screen.queryByText('这件事需要多步处理，我已转到后台；进度会在这里持续更新。'),
    ).toBeNull();
    expect(screen.getByText('用五个未教学探针验证含参分式方程迁移题')).toBeTruthy();
    expect(screen.queryByTestId('copilot-msg-streaming')).toBeNull();
    expect((screen.getByTestId('copilot-composer-input') as HTMLTextAreaElement).disabled).toBe(
      false,
    );
    expect(apiFetchMock).toHaveBeenCalledTimes(1);

    const failedKey = new Headers(apiFetchMock.mock.calls[0]?.[1]?.headers).get('Idempotency-Key');
    await user.click(screen.getByRole('button', { name: '重试' }));
    await screen.findByText(completedView.replyText);

    const retryKey = new Headers(apiFetchMock.mock.calls[1]?.[1]?.headers).get('Idempotency-Key');
    expect(retryKey).toMatch(/^[0-9a-f-]{36}$/i);
    expect(retryKey).not.toBe(failedKey);
    expect(apiFetchMock.mock.calls[1]?.[1]?.body).toBe(apiFetchMock.mock.calls[0]?.[1]?.body);
    expect(consumeDurableMock.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ location: retryLocation }),
    );
    expect(screen.getAllByTestId('copilot-msg-user')).toHaveLength(2);
  });

  it('shows the ambiguous-execution safety warning live without a blind one-click retry', async () => {
    const runId = 'ask_ambiguous_materialization';
    apiFetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ run_id: runId }), {
        status: 202,
        headers: {
          Location: `/api/jobs/copilot_run/${runId}/events`,
          'Content-Type': 'application/json',
        },
      }),
    );
    consumeDurableMock.mockImplementationOnce(
      async (options: { onUpdate?: (view: CopilotRunView) => void }) => {
        // A prior live update exposed a checkpoint. The ambiguous terminal
        // must actively remove it instead of Dock's row merge reviving it.
        options.onUpdate?.(partialView);
        options.onUpdate?.(ambiguousFailedView);
        return ambiguousFailedView;
      },
    );

    render(<CopilotDock pathname="/practice" navigate={vi.fn()} />);
    const user = userEvent.setup();
    await user.type(
      screen.getByTestId('copilot-composer-input'),
      '读取 42 次真实作答和五个未教学探针，再物化九道含参迁移题并逐题验证。',
    );
    await user.click(screen.getByTestId('copilot-composer-send'));

    expect(await screen.findByText(ambiguousWarning)).toBeTruthy();
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull();
    expect(screen.queryByRole('button', { name: '重新连接' })).toBeNull();
    expect(screen.queryByTestId('copilot-revert-button')).toBeNull();
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getAllByTestId('copilot-msg-user')).toHaveLength(1);
    expect((screen.getByTestId('copilot-composer-input') as HTMLTextAreaElement).disabled).toBe(
      false,
    );
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

  it('reconstructs an accepted durable handle from the 202 JSON when a proxy strips Location', async () => {
    const runId = 'ask_proxy_stripped_location';
    const reconstructedLocation = `/api/jobs/copilot_run/${runId}/events`;
    apiFetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          run_id: runId,
          session_id: 'copilot-session-proxy-stripped-location',
          checkpoint_event_id: runId,
        }),
        { status: 202, headers: { 'Content-Type': 'application/json' } },
      ),
    );
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
      '请后台核对 24 道含参方程、三轮延迟复习与四个迁移探针。',
    );
    await user.click(screen.getByTestId('copilot-composer-send'));

    await screen.findByText(completedView.replyText);
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(consumeDurableMock).toHaveBeenCalledWith(
      expect.objectContaining({ location: reconstructedLocation }),
    );
    expect(screen.getAllByTestId('copilot-msg-user')).toHaveLength(1);
    expect(screen.getAllByTestId('copilot-msg-ai')).toHaveLength(1);
    expect(window.sessionStorage.getItem(PENDING_COPILOT_TURN_STORAGE_KEY)).toBeNull();
  });

  it('preserves the exact key and rich body for human recovery when 202 has no usable handle', async () => {
    const recoveredRunId = 'ask_proxy_stripped_and_truncated_recovered';
    const recoveredLocation = `/api/jobs/copilot_run/${recoveredRunId}/events`;
    const acceptedWithoutHandle = new Response('{"run_id":"truncated-after-headers"', {
      status: 202,
      headers: { 'Content-Type': 'application/json' },
    });
    apiFetchMock.mockResolvedValueOnce(acceptedWithoutHandle).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          run_id: recoveredRunId,
          session_id: 'copilot-session-proxy-recovery',
          checkpoint_event_id: recoveredRunId,
        }),
        {
          status: 202,
          headers: { Location: recoveredLocation, 'Content-Type': 'application/json' },
        },
      ),
    );
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
      '请后台交叉核对 48 道含参方程、六个未教学探针和九道迁移题；逐题验证定义域、退化分支与唯一解。',
    );
    await user.click(screen.getByTestId('copilot-composer-send'));

    expect(
      await screen.findByText('后台任务已受理，但没有返回进度地址；请用原请求恢复进度。'),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: '恢复' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '不再恢复' })).toBeTruthy();
    const pending = window.sessionStorage.getItem(PENDING_COPILOT_TURN_STORAGE_KEY);
    expect(pending).not.toBeNull();
    expect(pending).toContain('48 道含参方程');

    const originalHeaders = new Headers(apiFetchMock.mock.calls[0]?.[1]?.headers);
    const originalBody = apiFetchMock.mock.calls[0]?.[1]?.body;
    await user.click(screen.getByRole('button', { name: '恢复' }));
    await screen.findByText(completedView.replyText);

    expect(apiFetchMock).toHaveBeenCalledTimes(2);
    const recoveredHeaders = new Headers(apiFetchMock.mock.calls[1]?.[1]?.headers);
    expect(recoveredHeaders.get('Idempotency-Key')).toBe(originalHeaders.get('Idempotency-Key'));
    expect(apiFetchMock.mock.calls[1]?.[1]?.body).toBe(originalBody);
    expect(String(originalBody)).toContain('六个未教学探针');
    expect(consumeDurableMock).toHaveBeenCalledWith(
      expect.objectContaining({ location: recoveredLocation }),
    );
    expect(window.sessionStorage.getItem(PENDING_COPILOT_TURN_STORAGE_KEY)).toBeNull();
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

  it('persists a pre-202 unmount and restores it only after an explicit same-key human retry', async () => {
    let dispatchSignal: AbortSignal | undefined;
    const recoveredLocation = '/api/jobs/copilot_run/ask_pre_202_unmount_recovered/events';
    apiFetchMock
      .mockImplementationOnce(async (_input: string, init?: RequestInit): Promise<Response> => {
        dispatchSignal = init?.signal ?? undefined;
        return await new Promise((_resolve, reject) => {
          dispatchSignal?.addEventListener(
            'abort',
            () => reject(new DOMException('dock unmounted before 202', 'AbortError')),
            { once: true },
          );
        });
      })
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ run_id: 'ask_pre_202_unmount_recovered' }), {
          status: 202,
          headers: { Location: recoveredLocation, 'Content-Type': 'application/json' },
        }),
      );
    consumeDurableMock.mockImplementationOnce(
      async (options: { onUpdate?: (view: CopilotRunView) => void }) => {
        options.onUpdate?.(completedView);
        return completedView;
      },
    );

    const rendered = render(<CopilotDock pathname="/practice" navigate={vi.fn()} />);
    const user = userEvent.setup();
    const originalQuestion =
      '请在后台交叉核对 48 道真实作答、三轮延迟复习与六个未教学探针，再生成完整迁移题组。';
    await user.type(screen.getByTestId('copilot-composer-input'), originalQuestion);
    await user.click(screen.getByTestId('copilot-composer-send'));
    await waitFor(() => expect(dispatchSignal).toBeDefined());
    const originalHeaders = new Headers(apiFetchMock.mock.calls[0]?.[1]?.headers);
    const originalBody = apiFetchMock.mock.calls[0]?.[1]?.body;

    rendered.unmount();

    expect(dispatchSignal?.aborted).toBe(true);
    await Promise.resolve();
    expect(consumeDurableMock).not.toHaveBeenCalled();
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(window.sessionStorage.getItem(PENDING_COPILOT_TURN_STORAGE_KEY)).not.toBeNull();

    render(<CopilotDock pathname="/subjects/math/mistakes" navigate={vi.fn()} />);
    expect(await screen.findByText(originalQuestion)).toBeTruthy();
    expect(
      screen.getByText(
        '上次请求的受理状态未知：它可能尚未执行，也可能已经完成。请先查看现有结果，再决定是否恢复这次请求。',
      ),
    ).toBeTruthy();
    // Remount is observational. It must not silently replay a possibly-complete
    // inline turn; the user explicitly chooses whether to resume.
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getAllByTestId('copilot-msg-user')).toHaveLength(1);
    expect(screen.getByRole('button', { name: '不再恢复' })).toBeTruthy();

    const recoveryUser = userEvent.setup();
    await recoveryUser.click(screen.getByRole('button', { name: '恢复' }));
    await screen.findByText(completedView.replyText);

    expect(apiFetchMock).toHaveBeenCalledTimes(2);
    const recoveredHeaders = new Headers(apiFetchMock.mock.calls[1]?.[1]?.headers);
    expect(recoveredHeaders.get('Idempotency-Key')).toBe(originalHeaders.get('Idempotency-Key'));
    expect(apiFetchMock.mock.calls[1]?.[1]?.body).toBe(originalBody);
    expect(String(originalBody)).toContain('"route":"/practice"');
    expect(consumeDurableMock).toHaveBeenCalledWith(
      expect.objectContaining({ location: recoveredLocation }),
    );
    expect(screen.getAllByTestId('copilot-msg-user')).toHaveLength(1);
    expect(window.sessionStorage.getItem(PENDING_COPILOT_TURN_STORAGE_KEY)).toBeNull();
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
