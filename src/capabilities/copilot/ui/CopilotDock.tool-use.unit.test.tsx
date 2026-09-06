// @vitest-environment jsdom
//
// YUK-913 — one logical tool call renders ONE compact card whose state evolves
// in place (调用中 → 已完成/失败). Pins two layers:
//   1. the live-SSE merge: tool_use frames carry RAW SDK block names
//      (`mcp__loom__query_mistakes`) while tool_result frames carry DOMAIN
//      names (`query_mistakes`) — the client must correlate them so a result
//      never appends a second card next to the still-running one;
//   2. the compact render: single-line row (label + status + one-line
//      summary), details collapsed behind an expandable toggle.

import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { apiFetchMock, apiJsonMock } = vi.hoisted(() => ({
  apiFetchMock: vi.fn(),
  apiJsonMock: vi.fn(),
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
  apiJson: apiJsonMock,
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: ({ queryKey }: { queryKey: string[] }) =>
    queryKey[0] === 'copilot-sessions'
      ? {
          data: {
            sessions: [
              {
                id: 'copilot-session-tools',
                status: 'active',
                title: '错题整理对话',
                created_at: '2026-08-20T08:00:00.000Z',
                updated_at: '2026-08-20T08:00:00.000Z',
              },
            ],
          },
          isLoading: false,
          refetch: vi.fn(),
        }
      : { data: null, isLoading: false, refetch: vi.fn() },
}));

vi.mock('@/ui/lib/use-copilot-dwell', () => ({
  openCopilotForNudge: vi.fn(),
  useCopilotDwell: () => ({ open: true, openDrawer: vi.fn(), closeDrawer: vi.fn() }),
  useCopilotOpenSignal: () => undefined,
}));

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
  }: {
    children: ReactNode;
    footer: ReactNode;
    headActions: ReactNode;
    summary: ReactNode;
  }) => (
    <section>
      {headActions}
      {summary}
      {children}
      {footer}
    </section>
  ),
}));
vi.mock('./CopilotHeroCard', () => ({ CopilotHeroCard: () => null }));

import { type ChatMessage, MessageRow } from './CopilotDock';
import { projectDurableCopilotMessage } from './message-projection';
import { createCopilotRunView, foldCopilotRunFrames } from './subtask-events';

const noopNavigate = (_to: string) => {};
const noopAccept = (_sessionId: string, _questionId: string, _replyEventId?: string) => {};

function renderRow(message: ChatMessage) {
  return render(
    <MessageRow
      message={message}
      navigate={noopNavigate}
      onAcceptCorrective={noopAccept}
      chipPending={false}
      chipAcked={false}
      revertPending={false}
    />,
  );
}

describe('CopilotDock tool-use merged cards (YUK-913)', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    apiJsonMock.mockImplementation(async (input: string) => {
      if (input.startsWith('/api/copilot/turns')) return { turns: [] };
      throw new Error(`unexpected apiJson call: ${input}`);
    });
  });

  afterEach(() => {
    cleanup();
    apiFetchMock.mockReset();
    apiJsonMock.mockReset();
  });

  it('evolves one durable STEP card in place from started to finished', () => {
    const running = foldCopilotRunFrames(createCopilotRunView(), [
      {
        event_id: 1,
        event_type: 'copilot_run.step',
        payload: {
          step_kind: 'tool_started',
          tool_name: 'mcp__loom__query_mistakes',
          input: { limit: 8 },
          tool_use_id: 'toolu_913_1',
        },
      },
    ]);
    const runningMessage = projectDurableCopilotMessage(
      { id: 'run-reply', role: 'ai', text: '' },
      running,
      '处理中',
    );
    if (!runningMessage) throw new Error('running projection missing');
    const rendered = renderRow(runningMessage);
    let cards = screen.getAllByTestId('copilot-tool-use-card');
    expect(cards).toHaveLength(1);
    expect(cards[0].getAttribute('data-status')).toBe('running');
    expect(screen.getByText('错题整理')).toBeTruthy();
    expect(screen.getByText('调用中')).toBeTruthy();

    const completed = foldCopilotRunFrames(running, [
      {
        event_id: 2,
        event_type: 'copilot_run.step',
        payload: {
          step_kind: 'tool_finished',
          tool_name: 'query_mistakes',
          input: { limit: 8 },
          summary: 'mistakes · 8 行 · 3 道过期',
        },
      },
      {
        event_id: 3,
        event_type: 'copilot_run.reply',
        payload: { reply_md: '我已核对完错题，建议先复习通假字。' },
      },
      { event_id: 4, event_type: 'copilot_run.done', payload: {} },
    ]);
    const completedMessage = projectDurableCopilotMessage(runningMessage, completed, '处理中');
    if (!completedMessage) throw new Error('completed projection missing');
    rendered.rerender(
      <MessageRow
        message={completedMessage}
        navigate={noopNavigate}
        onAcceptCorrective={noopAccept}
        chipPending={false}
        chipAcked={false}
        revertPending={false}
      />,
    );
    cards = screen.getAllByTestId('copilot-tool-use-card');
    expect(cards).toHaveLength(1);
    expect(cards[0].getAttribute('data-status')).toBe('done');
    expect(screen.getByText('mistakes · 8 行 · 3 道过期')).toBeTruthy();
    expect(screen.queryByText('调用中')).toBeNull();
    expect(screen.getByText('我已核对完错题，建议先复习通假字。')).toBeTruthy();
  });

  it('dedupes repeated starts and keeps same-name calls separately correlated', () => {
    const view = foldCopilotRunFrames(createCopilotRunView(), [
      {
        event_id: 1,
        event_type: 'copilot_run.step',
        payload: {
          step_kind: 'tool_started',
          tool_name: 'mcp__loom__query_mistakes',
          input: { limit: 8 },
          tool_use_id: 'toolu_913_a',
        },
      },
      {
        event_id: 2,
        event_type: 'copilot_run.step',
        payload: {
          step_kind: 'tool_started',
          tool_name: 'mcp__loom__query_mistakes',
          input: { limit: 8 },
          tool_use_id: 'toolu_913_a',
        },
      },
      {
        event_id: 3,
        event_type: 'copilot_run.step',
        payload: {
          step_kind: 'tool_started',
          tool_name: 'mcp__loom__query_mistakes',
          input: { limit: 12 },
          tool_use_id: 'toolu_913_b',
        },
      },
      {
        event_id: 4,
        event_type: 'copilot_run.step',
        payload: {
          step_kind: 'tool_finished',
          tool_name: 'query_mistakes',
          input: { limit: 8 },
          summary: '第一次核对：8 行',
        },
      },
      {
        event_id: 5,
        event_type: 'copilot_run.step',
        payload: {
          step_kind: 'tool_finished',
          tool_name: 'query_mistakes',
          input: { limit: 12 },
          summary: '第二次核对：12 行',
        },
      },
    ]);
    const message = projectDurableCopilotMessage(
      { id: 'run-twice', role: 'ai', text: '' },
      view,
      '处理中',
    );
    if (!message) throw new Error('tool projection missing');
    renderRow(message);
    const cards = screen.getAllByTestId('copilot-tool-use-card');
    expect(cards).toHaveLength(2);
    expect(cards[0].getAttribute('data-status')).toBe('done');
    expect(cards[1].getAttribute('data-status')).toBe('done');
    expect(within(cards[0]).getByText('第一次核对：8 行')).toBeTruthy();
    expect(within(cards[1]).getByText('第二次核对：12 行')).toBeTruthy();
  });

  it('renders compact done rows with the summary line before the reply text', () => {
    const message: ChatMessage = {
      id: 'reply_tools',
      role: 'ai',
      text: '我已核对完错题，建议先复习通假字。',
      tool_calls: [
        {
          toolName: 'query_mistakes',
          input: { limit: 8 },
          summary: 'mistakes · 8 行 · 3 道过期',
          status: 'done',
        },
        {
          toolName: 'get_review_due',
          input: {},
          summary: 'review · 12 due 今日 · 4 due 明日',
          status: 'done',
        },
      ],
    };

    renderRow(message);

    const cards = screen.getAllByTestId('copilot-tool-use-card');
    expect(cards).toHaveLength(2);
    expect(cards[0].getAttribute('data-status')).toBe('done');
    expect(screen.getByText('错题整理')).toBeTruthy();
    expect(screen.getByText('复习安排')).toBeTruthy();
    expect(screen.getAllByText('已完成')).toHaveLength(2);
    expect(screen.getByText('mistakes · 8 行 · 3 道过期')).toBeTruthy();
    expect(screen.getByText('review · 12 due 今日 · 4 due 明日')).toBeTruthy();

    const list = screen.getByTestId('copilot-tool-use-list');
    const reply = screen.getByText('我已核对完错题，建议先复习通假字。');
    expect(list.compareDocumentPosition(reply) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('keeps per-call running status independent of the turn streaming flag', () => {
    const message: ChatMessage = {
      id: 'reply_streaming_tools',
      role: 'ai',
      text: '正在整理证据…',
      streaming: true,
      tool_calls: [
        {
          toolName: 'query_mistakes',
          input: { limit: 8 },
          status: 'running',
        },
        {
          toolName: 'get_review_due',
          input: {},
          summary: 'review · 12 due 今日',
          status: 'done',
        },
      ],
    };

    renderRow(message);

    expect(screen.getByText('调用中')).toBeTruthy();
    expect(screen.getByText('已完成')).toBeTruthy();
    expect(screen.getByText('review · 12 due 今日')).toBeTruthy();
  });

  it('renders failed status pill and learner error line for failed tool calls', () => {
    const message: ChatMessage = {
      id: 'reply_failed_tool',
      role: 'ai',
      text: '这一步没查成，稍后再试。',
      tool_calls: [
        {
          toolName: 'query_mistakes',
          input: { limit: 8 },
          errorReason: 'connection reset while reading mistakes',
          status: 'failed',
        },
      ],
    };

    renderRow(message);

    const cards = screen.getAllByTestId('copilot-tool-use-card');
    expect(cards).toHaveLength(1);
    expect(cards[0].getAttribute('data-status')).toBe('failed');
    expect(screen.getByText('失败')).toBeTruthy();
    expect(screen.getByText('错题整理暂时未完成，请稍后再试。')).toBeTruthy();
    // A failed card never falls back to the done-state status.
    expect(screen.queryByText('已完成')).toBeNull();
  });

  it('keeps internal tool details and event identities out of learner-visible Copilot rows', () => {
    const eventId = 'copilot_user_ask_4f5e6d7c-8a9b-4012-83d4-5e6f7a8b9c0d';
    const message: ChatMessage = {
      id: eventId,
      role: 'ai',
      text: '我会把这项建议整理成你可以确认的内容。',
      tool_calls: [
        {
          toolName: 'knowledge_mutation',
          input: { knowledge_id: '4f5e6d7c-8a9b-4012-83d4-5e6f7a8b9c0d' },
          summary: 'pending proposal: update node 4f5e6d7c',
          errorReason: 'proposal rejected because the internal review is pending',
          status: 'failed',
        },
      ],
      subtasks: [
        {
          id: eventId,
          label: '校验这项建议',
          status: 'completed',
          lastEventId: 109,
        },
      ],
    };

    const { container } = renderRow(message);

    expect(screen.getByText('学习内容建议')).toBeTruthy();
    expect(screen.getByText(/学习内容建议\s*暂时未完成，请稍后再试。/)).toBeTruthy();
    expect(container.innerHTML).not.toContain('knowledge_mutation');
    expect(container.innerHTML).not.toContain('copilot_user_ask_');
    expect(container.innerHTML).not.toContain('4f5e6d7c-8a9b-4012-83d4-5e6f7a8b9c0d');
    expect(container.innerHTML).not.toContain('pending proposal');
    expect(container.innerHTML).not.toContain('proposal rejected');
  });

  it('expands and collapses details from the row itself, keyboard-reachable', async () => {
    const message: ChatMessage = {
      id: 'reply_expand_tool',
      role: 'ai',
      text: '核对完成。',
      tool_calls: [
        {
          toolName: 'query_mistakes',
          input: { limit: 8 },
          summary: 'mistakes · 8 行 · 3 道过期',
          status: 'done',
        },
      ],
    };

    renderRow(message);
    const user = userEvent.setup();

    const toggle = screen.getByRole('button', { name: '展开错题整理详情' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId('copilot-tool-use-detail')).toBeNull();

    await user.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const detail = screen.getByTestId('copilot-tool-use-detail');
    expect(detail.textContent).toContain('mistakes · 8 行 · 3 道过期');

    await user.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId('copilot-tool-use-detail')).toBeNull();
  });

  it('keeps running rows non-interactive (nothing to expand yet)', () => {
    const message: ChatMessage = {
      id: 'reply_running_no_toggle',
      role: 'ai',
      text: '正在整理…',
      streaming: true,
      tool_calls: [
        {
          toolName: 'query_mistakes',
          input: { limit: 8 },
          status: 'running',
        },
      ],
    };

    renderRow(message);

    expect(screen.queryByTestId('copilot-tool-use-toggle')).toBeNull();
    expect(screen.getByTestId('copilot-tool-use-card').getAttribute('data-status')).toBe('running');
  });
});
