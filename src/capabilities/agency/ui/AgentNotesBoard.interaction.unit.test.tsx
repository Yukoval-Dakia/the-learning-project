// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentNotesBoard } from './AgentNotesBoard';
import type { BoardAgentNote } from './types';

afterEach(cleanup);
beforeEach(() => {
  const store = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      get length() {
        return store.size;
      },
      clear: () => store.clear(),
      getItem: (key: string) => store.get(key) ?? null,
      key: (index: number) => [...store.keys()][index] ?? null,
      removeItem: (key: string) => void store.delete(key),
      setItem: (key: string, value: string) => void store.set(key, value),
    } satisfies Storage,
  });
});

const NOW = new Date('2026-07-13T10:00:00Z');

function boardNote(): BoardAgentNote {
  return {
    id: 'note_1',
    created_at: '2026-07-13T09:00:00Z',
    target_agents: ['coach'],
    source_task_kind: 'quiz_verify',
    source_task_run_id: 'run_1',
    refs: [
      {
        kind: 'knowledge',
        id: 'spike:math:erci-tuxiang',
        label: '二次函数·图像与性质',
        resolution_state: 'resolved',
        usable_question_count: 3,
      },
    ],
    summary_md: 'Generated question internal_id (verification needs_review).',
    signal_kind: 'question_pool_gap',
    caused_by_event_id: 'evt_1',
  };
}

describe('AgentNotesBoard states', () => {
  it('keeps loading/error safe with no rows and renders grouped data after success', async () => {
    const retry = vi.fn();
    const navigate = vi.fn();
    const view = render(
      <AgentNotesBoard
        notes={[]}
        status="loading"
        now={NOW}
        onRetry={retry}
        onNavigate={navigate}
      />,
    );
    expect(screen.getByText('AI 之间的观察')).toBeTruthy();

    view.rerender(
      <AgentNotesBoard notes={[]} status="error" now={NOW} onRetry={retry} onNavigate={navigate} />,
    );
    expect(screen.getByText('无法读取 AI 观察信号。')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(retry).toHaveBeenCalledOnce();

    view.rerender(
      <AgentNotesBoard
        notes={[boardNote()]}
        status="ok"
        now={NOW}
        onRetry={retry}
        onNavigate={navigate}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: '展开' }));
    expect(screen.getByRole('heading', { name: '二次函数·图像与性质' })).toBeTruthy();
    expect(screen.queryByText(/Generated|needs_review|spike:/)).toBeNull();
  });
});
