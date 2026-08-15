// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/ui/lib/deferred-markdown-renderer', () => ({
  DeferredMarkdownRenderer: ({ children }: { children: string }) => <div>{children}</div>,
  preloadMarkdownRenderer: () => {},
}));

import { type ChatMessage, MessageRow } from './CopilotDock';

const noopNavigate = (_to: string) => {};
const noopAccept = (_sessionId: string, _questionId: string, _replyEventId?: string) => {};

describe('CopilotDock tool-use cards', () => {
  afterEach(cleanup);

  it('renders done-state body from summary and places cards before the reply text', () => {
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

    render(
      <MessageRow
        message={message}
        navigate={noopNavigate}
        onAcceptCorrective={noopAccept}
        chipPending={false}
        chipAcked={false}
        revertPending={false}
      />,
    );

    const cards = screen.getAllByTestId('copilot-tool-use-card');
    expect(cards).toHaveLength(2);
    expect(screen.getAllByText('mistakes · 8 行 · 3 道过期')).toHaveLength(2);
    expect(screen.getAllByText('review · 12 due 今日 · 4 due 明日')).toHaveLength(2);
    expect(screen.getByText('我已核对完错题，建议先复习通假字。')).toBeTruthy();

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

    render(
      <MessageRow
        message={message}
        navigate={noopNavigate}
        onAcceptCorrective={noopAccept}
        chipPending={false}
        chipAcked={false}
        revertPending={false}
      />,
    );

    expect(screen.getByText('运行中')).toBeTruthy();
    expect(screen.getByText('完成')).toBeTruthy();
    expect(screen.getByText('正在调用…')).toBeTruthy();
    expect(screen.getAllByText('review · 12 due 今日').length).toBeGreaterThan(0);
  });

  it('renders failed status pill and errorReason for failed tool calls', () => {
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

    render(
      <MessageRow
        message={message}
        navigate={noopNavigate}
        onAcceptCorrective={noopAccept}
        chipPending={false}
        chipAcked={false}
        revertPending={false}
      />,
    );

    const cards = screen.getAllByTestId('copilot-tool-use-card');
    expect(cards).toHaveLength(1);
    // StatusPill failed label.
    expect(screen.getByText('失败')).toBeTruthy();
    // Failed cards render errorView (the errorReason) in the result slot.
    expect(screen.getByText('connection reset while reading mistakes')).toBeTruthy();
    // A failed card never falls back to the done-state body.
    expect(screen.queryByText('已完成')).toBeNull();
  });
});
