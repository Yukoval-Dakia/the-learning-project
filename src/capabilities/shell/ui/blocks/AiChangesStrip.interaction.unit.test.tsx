// @vitest-environment jsdom
// YUK-713 — the 「可回滚」undo mutation had no onError, so a failed undo left the UI
// silently claiming the change was still reversible. A failed undo must be visible.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiChangesStrip } from './AiChangesStrip';

const mocks = vi.hoisted(() => ({
  getRecentAiChanges: vi.fn(),
  undoAiChange: vi.fn(),
}));

vi.mock('../workbench-api', () => mocks);

const ROW = {
  event_id: 'ev_1',
  artifact_id: 'art_1',
  created_at: '2026-07-19T00:00:00Z',
  actor_ref: 'ai',
  ops_count: 2,
  new_blocks: 1,
  previous_artifact_version: 1,
  next_artifact_version: 2,
  undone: false,
};

function renderStrip() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <AiChangesStrip now={new Date('2026-07-19T01:00:00Z')} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getRecentAiChanges.mockResolvedValue({ window_hours: 24, rows: [ROW] });
});

afterEach(cleanup);

describe('AiChangesStrip undo failure (YUK-713)', () => {
  it('surfaces a retryable failure when undo rejects, without claiming success', async () => {
    mocks.undoAiChange.mockRejectedValue(new Error('500'));
    const user = userEvent.setup();
    renderStrip();

    await user.click(await screen.findByRole('button', { name: '撤销' }));

    expect(await screen.findByText('撤销失败，请重试。')).toBeTruthy();
    // the change is NOT falsely marked reverted.
    expect(screen.queryByText('已撤销')).toBeNull();
    // the undo button stays available for a retry.
    expect(screen.getByRole('button', { name: '撤销' })).toBeTruthy();
  });
});
