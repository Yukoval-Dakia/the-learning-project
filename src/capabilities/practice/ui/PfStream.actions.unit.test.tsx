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
