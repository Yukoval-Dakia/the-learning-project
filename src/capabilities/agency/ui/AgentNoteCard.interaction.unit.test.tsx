// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentNoteCard } from './AgentNoteCard';
import type { BoardAgentNote } from './types';

afterEach(cleanup);

describe('AgentNoteCard event evidence navigation', () => {
  it('shows a human label and sends the event route to the shell navigator', async () => {
    const navigate = vi.fn();
    const note: BoardAgentNote = {
      id: 'note_1',
      created_at: '2026-07-13T08:00:00Z',
      target_agents: ['CoachTask'],
      source_task_kind: 'QuestionAuthorTask',
      refs: [{ kind: 'event', id: 'evt_evidence_1' }],
      summary_md: '发现一条需要复核的证据。',
      signal_kind: 'warning',
    };

    render(
      <AgentNoteCard
        note={note}
        unread={false}
        now={new Date('2026-07-13T09:00:00Z')}
        onNavigate={navigate}
      />,
    );

    const button = screen.getByRole('button', { name: '查看事件证据 →' });
    expect(screen.queryByText('evt_evidence_1')).toBeNull();
    await userEvent.click(button);
    expect(navigate).toHaveBeenCalledWith('/events/evt_evidence_1');
  });
});
