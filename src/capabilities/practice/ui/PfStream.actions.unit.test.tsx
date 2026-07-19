// @vitest-environment jsdom

import { openCopilot } from '@/ui/lib/use-copilot-dwell';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PfStream } from './PfStream';
import type { StreamView } from './practice-api';

vi.mock('@/ui/lib/use-copilot-dwell', () => ({ openCopilot: vi.fn() }));

const openCopilotMock = vi.mocked(openCopilot);

const stream: StreamView = {
  date: '2026-07-13',
  opening_line: '今天的流。',
  items: [],
  budget: { pace: 'medium', minutes: 20 },
  progress: {
    done: 0,
    total: 0,
    estimated_total_minutes: 0,
    estimated_remaining_minutes: 0,
  },
};

const pendingStream: StreamView = {
  ...stream,
  items: [
    {
      id: 'stream_item_1',
      position: 0,
      item_kind: 'question',
      ref_id: 'question_1',
      source: 'new_check',
      reasoning: '检查今天的掌握情况。',
      status: 'pending',
      estimated_minutes: 2,
      knowledge_name: '判断句',
      paper_title: null,
      verdict: null,
      completed_at: null,
      total_slots: null,
    },
  ],
  progress: {
    done: 0,
    total: 1,
    estimated_total_minutes: 2,
    estimated_remaining_minutes: 2,
  },
};

const completedStream: StreamView = {
  ...pendingStream,
  items: [{ ...pendingStream.items[0], status: 'done' }],
  progress: {
    done: 1,
    total: 1,
    estimated_total_minutes: 2,
    estimated_remaining_minutes: 0,
  },
};

const scopedEmptyStream: StreamView = {
  ...stream,
  scope: {
    kind: 'knowledge',
    id: 'kc-judgement',
    label: '判断句',
    session_id: 'review_scope_1',
  },
  opening_line: '「判断句」暂时没有可练的已发布题目。',
  budget: { pace: 'medium', minutes: 10 },
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('PfStream on-demand handoff (YUK-626)', () => {
  it('hands the exact request to real Copilot and clears the local composer without a fake toast', async () => {
    const addToast = vi.fn();
    render(
      <PfStream
        stream={stream}
        loading={false}
        error={null}
        openItem={() => {}}
        refresh={async () => null}
        updateItem={() => {}}
        addToast={addToast}
      />,
    );

    const input = screen.getByRole('textbox', { name: '向 AI 点播' });
    await userEvent.type(input, '  来份判断句专项卷  ');
    await userEvent.click(screen.getByRole('button', { name: '交给 Copilot 点播' }));

    expect(openCopilotMock).toHaveBeenCalledWith('来份判断句专项卷');
    expect((input as HTMLTextAreaElement).value).toBe('');
    expect(addToast).not.toHaveBeenCalled();
  });
});

describe('PfStream item semantics', () => {
  it('YUK-535: explains an empty KC scope and hides unrelated daily-flow controls', () => {
    render(
      <PfStream
        stream={scopedEmptyStream}
        loading={false}
        error={null}
        openItem={() => {}}
        refresh={async () => null}
        updateItem={() => {}}
        addToast={() => {}}
      />,
    );

    expect(screen.getByText('「判断句」暂无可练题目')).toBeTruthy();
    expect(screen.getByText(/知识点专项 · 判断句 · 2026-07-13/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: '按当前信号重排' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: '向 AI 点播' })).toBeNull();
  });

  it('keeps the card static and exposes its actions as native buttons', async () => {
    const openItem = vi.fn();
    const { container } = render(
      <PfStream
        stream={pendingStream}
        loading={false}
        error={null}
        openItem={openItem}
        refresh={async () => null}
        updateItem={() => {}}
        addToast={() => {}}
      />,
    );

    const card = container.querySelector('.pf-item');
    expect(card?.getAttribute('role')).toBeNull();
    expect(card?.getAttribute('tabindex')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: '开始作答' }));
    expect(openItem).toHaveBeenCalledWith(pendingStream.items[0]);
    expect(screen.getByRole('button', { name: /跳过/ })).toBeTruthy();
    expect(card?.textContent).toContain('单题练习');
    expect(card?.textContent).not.toContain('question_1');
    expect(card?.textContent).not.toMatch(/\bquestion\b/i);
    expect(screen.getByText(/今日练习 · 2026-07-13 · 预算 20 分钟/)).toBeTruthy();
  });

  it('uses learner-facing copy for the completed-stream summary', () => {
    render(
      <PfStream
        stream={completedStream}
        loading={false}
        error={null}
        openItem={() => {}}
        refresh={async () => null}
        updateItem={() => {}}
        addToast={() => {}}
      />,
    );

    expect(screen.getByText('今日小结 · 已完成')).toBeTruthy();
    expect(screen.queryByText(/\b(?:composer|coach)\b/i)).toBeNull();
  });
});
