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
    },
  ],
  progress: {
    done: 0,
    total: 1,
    estimated_total_minutes: 2,
    estimated_remaining_minutes: 2,
  },
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
  });
});
