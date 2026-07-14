// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentNoteGroupCard } from './AgentNoteGroupCard';
import { groupAgentNotes } from './derive';
import type { BoardAgentNote } from './types';

afterEach(cleanup);

function note(id: string, createdAt: string, eventId: string): BoardAgentNote {
  return {
    id,
    created_at: createdAt,
    target_agents: ['coach'],
    source_task_kind: 'quiz_verify',
    source_task_run_id: `run_${id}`,
    refs: [
      {
        kind: 'knowledge',
        id: 'spike:math:erci-tuxiang',
        label: '二次函数·图像与性质',
        resolution_state: 'resolved',
        usable_question_count: 4,
      },
    ],
    summary_md: `Generated question ${id}abcdefghijklmnop did not enter the review pool (verification needs_review).`,
    signal_kind: 'question_pool_gap',
    confidence: 0.9,
    caused_by_event_id: eventId,
  };
}

describe('AgentNoteGroupCard', () => {
  it('shows one human-readable topic and keeps every run evidence expandable', async () => {
    const navigate = vi.fn();
    const group = groupAgentNotes([
      note('first', '2026-07-13T08:00:00Z', 'evt_first'),
      note('second', '2026-07-13T09:00:00Z', 'evt_second'),
    ])[0];

    render(
      <AgentNoteGroupCard
        group={group}
        unread={false}
        now={new Date('2026-07-13T10:00:00Z')}
        onNavigate={navigate}
      />,
    );

    expect(screen.getByRole('heading', { name: '二次函数·图像与性质' })).toBeTruthy();
    expect(screen.getByText('2 次运行')).toBeTruthy();
    expect(screen.getByText('已解决')).toBeTruthy();
    expect(
      screen.queryByText(/Generated question|needs_review|spike:|firstabcdefghijkl/),
    ).toBeNull();

    await userEvent.click(screen.getByText('查看 2 次运行与证据'));
    const evidenceButtons = screen.getAllByRole('button', { name: '查看事件证据 →' });
    expect(evidenceButtons).toHaveLength(2);
    await userEvent.click(evidenceButtons[0]);
    expect(navigate).toHaveBeenCalledWith('/events/evt_second');
  });
});
