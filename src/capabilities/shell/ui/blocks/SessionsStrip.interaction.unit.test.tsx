// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionsStrip } from './SessionsStrip';

afterEach(cleanup);

describe('SessionsStrip learner labels', () => {
  it('uses a human label for the empty review-session surface', () => {
    render(<SessionsStrip sessions={[]} now={new Date()} navigate={vi.fn()} />);
    expect(screen.getByText('复习安排')).toBeTruthy();
    expect(screen.queryByText('review_session')).toBeNull();
  });

  it('shows a real session count without exposing the internal session kind', () => {
    render(
      <SessionsStrip
        sessions={[
          {
            id: 'session_1',
            status: 'started',
            summary_md: null,
            started_at: 1_784_000_000,
            ended_at: null,
            duration_ms: 120_000,
            reviewed_count: 2,
          },
        ]}
        now={new Date(1_784_000_300_000)}
        navigate={vi.fn()}
      />,
    );
    expect(screen.getByText('共 1 个')).toBeTruthy();
    expect(screen.queryByText('review_session')).toBeNull();
  });
});
