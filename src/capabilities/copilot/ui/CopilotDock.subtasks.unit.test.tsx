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

describe('CopilotDock inline subtask cards', () => {
  afterEach(cleanup);

  it('keeps one Copilot voice while showing one ToolUseCard per public subtask', () => {
    const message: ChatMessage = {
      id: 'durable:ask_weekly_rebuild',
      role: 'ai',
      text: '我已核对错题证据链，并保留可复核的练习结果。',
      subtasks: [
        {
          id: 'cluster-week-errors',
          label: '扫描近 7 天的 42 次作答并聚类错因',
          status: 'completed',
          summary: '定位到分数通分与文言虚词「之」两个稳定薄弱点。',
          lastEventId: 107,
        },
        {
          id: 'build-gradient-set',
          label: '为两个薄弱点生成 3 档梯度练习',
          status: 'failed',
          error: '第二档图文题缺少可核验示意；第一、三档结果已保留。',
          lastEventId: 108,
        },
        {
          id: 'validate-transfer-set',
          label: '用含参分式方程检验通分策略能否迁移',
          status: 'running',
          lastEventId: 109,
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

    expect(screen.getAllByTestId('copilot-subtask-card')).toHaveLength(3);
    expect(screen.getByText('扫描近 7 天的 42 次作答并聚类错因')).toBeTruthy();
    expect(screen.getByText('为两个薄弱点生成 3 档梯度练习')).toBeTruthy();
    expect(screen.getByText('用含参分式方程检验通分策略能否迁移')).toBeTruthy();
    expect(screen.getByText('定位到分数通分与文言虚词「之」两个稳定薄弱点。')).toBeTruthy();
    expect(screen.getByText('第二档图文题缺少可核验示意；第一、三档结果已保留。')).toBeTruthy();
    expect(screen.getByText('正在处理…')).toBeTruthy();
    expect(screen.getByText('运行中')).toBeTruthy();
    expect(screen.getByText('完成')).toBeTruthy();
    expect(screen.getByText('失败')).toBeTruthy();
    expect(screen.getAllByText('Loom Copilot')).toHaveLength(1);
    expect(screen.queryByText(/subagent|子 agent|reasoning|transcript/i)).toBeNull();
  });
});
