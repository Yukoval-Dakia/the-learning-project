// @vitest-environment jsdom
// YUK-713 — the 「可回滚」undo mutation had no onError, so a failed undo left the UI
// silently claiming the change was still reversible. A failed undo must be visible.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
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
  return render(
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

  it('anchors the failure to its row and keeps it when a different row is undone', async () => {
    const ROW2 = { ...ROW, event_id: 'ev_2', artifact_id: 'art_2', actor_ref: 'zeta' };
    mocks.getRecentAiChanges.mockResolvedValue({ window_hours: 24, rows: [ROW, ROW2] });
    // Row 1 (ai) undo fails; row 2 (zeta) undo succeeds.
    mocks.undoAiChange.mockImplementation(async (_artifactId: string, eventId: string) => {
      if (eventId === 'ev_1') throw new Error('500');
      return { status: 'undone' };
    });
    const user = userEvent.setup();
    renderStrip();

    const buttons = await screen.findAllByRole('button', { name: '撤销' });
    await user.click(buttons[0]); // fail the ai row

    const err = await screen.findByText('撤销失败，请重试。');
    // The error is anchored directly to the ai row, not the zeta row.
    expect(err.previousElementSibling).toBe(screen.getByText('ai').closest('.strip'));
    expect(screen.getAllByText('撤销失败，请重试。')).toHaveLength(1);

    // Undo the OTHER row (succeeds) — the ai row's error must NOT be silently dismissed.
    await user.click(screen.getAllByRole('button', { name: '撤销' })[1]);
    await waitFor(() => expect(mocks.undoAiChange).toHaveBeenCalledTimes(2));
    expect(screen.getByText('撤销失败，请重试。')).toBeTruthy();
    expect(screen.getByText('撤销失败，请重试。').previousElementSibling).toBe(
      screen.getByText('ai').closest('.strip'),
    );
  });

  it('keeps a per-row error for every failed row when multiple rows fail', async () => {
    const ROW2 = { ...ROW, event_id: 'ev_2', artifact_id: 'art_2', actor_ref: 'zeta' };
    mocks.getRecentAiChanges.mockResolvedValue({ window_hours: 24, rows: [ROW, ROW2] });
    mocks.undoAiChange.mockRejectedValue(new Error('500')); // both rows fail
    const user = userEvent.setup();
    renderStrip();

    const buttons = await screen.findAllByRole('button', { name: '撤销' });
    await user.click(buttons[0]); // fail the ai row
    await screen.findByText('撤销失败，请重试。');
    await user.click(screen.getAllByRole('button', { name: '撤销' })[1]); // fail the zeta row
    await waitFor(() => expect(mocks.undoAiChange).toHaveBeenCalledTimes(2));

    // Both rows keep their own inline error — the second failure did not swallow the first.
    const errs = await screen.findAllByText('撤销失败，请重试。');
    expect(errs).toHaveLength(2);
    const anchors = errs.map((e) => e.previousElementSibling);
    expect(anchors).toContain(screen.getByText('ai').closest('.strip'));
    expect(anchors).toContain(screen.getByText('zeta').closest('.strip'));
  });
});
