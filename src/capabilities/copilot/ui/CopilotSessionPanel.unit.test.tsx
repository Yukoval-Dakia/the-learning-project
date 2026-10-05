// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CopilotSessionPanel } from './CopilotSessionPanel';

afterEach(cleanup);

describe('CopilotSessionPanel', () => {
  const sessions = [
    {
      id: 'session-new',
      status: 'active',
      title: '解释「之」的用法',
      updated_at: '2026-06-04T11:00:00.000Z',
    },
    {
      id: 'session-old',
      status: 'active',
      title: '今天该复习哪些？',
      updated_at: '2026-06-04T10:00:00.000Z',
    },
  ];

  it('selects an old session and exposes a separate new-conversation action', () => {
    const onSelect = vi.fn();
    const onCreate = vi.fn();
    render(
      <CopilotSessionPanel
        sessions={sessions}
        currentSessionId="session-new"
        creating={false}
        onSelect={onSelect}
        onCreate={onCreate}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /今天该复习哪些/ }));
    expect(onSelect).toHaveBeenCalledWith('session-old');

    fireEvent.click(screen.getByRole('button', { name: '新对话' }));
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole('button', { name: /解释「之」的用法/ }).getAttribute('aria-current'),
    ).toBe('true');
  });
});
