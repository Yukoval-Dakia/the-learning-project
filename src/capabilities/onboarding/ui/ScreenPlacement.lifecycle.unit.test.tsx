// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { placementStartFixture } from './placement-fixtures';
import ScreenPlacement from './ScreenPlacement';

const mocks = vi.hoisted(() => ({
  placementEnd: vi.fn(),
  placementNext: vi.fn(),
  startPlacement: vi.fn(),
  submitProbeAnswer: vi.fn(),
  getQuestion: vi.fn(),
  getPlacementSession: vi.fn(),
  saveResponseDraft: vi.fn(),
}));

vi.mock('./placement-api', () => mocks);

vi.mock('@/capabilities/practice/ui/practice-api', async (importActual) => {
  const actual = await importActual<typeof import('@/capabilities/practice/ui/practice-api')>();
  return { ...actual, getQuestion: mocks.getQuestion, saveResponseDraft: mocks.saveResponseDraft };
});

function renderPlacement(navigate = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ScreenPlacement navigate={navigate} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState({}, '', '/placement?goal=goal_1');
  mocks.startPlacement.mockResolvedValue({
    sessionId: 'placement_1',
    knowledgeIds: [],
    question: null,
    sourcingNeeded: true,
  });
  mocks.placementEnd.mockResolvedValue({ ok: true });
  mocks.saveResponseDraft.mockResolvedValue({ save_epoch: 1 });
});

afterEach(cleanup);

describe('ScreenPlacement session lifecycle (YUK-211)', () => {
  it('retains the active probe on ordinary pagehide for refresh recovery', async () => {
    render(<ScreenPlacement navigate={vi.fn()} />);
    expect(await screen.findByText('备题中 · 子图还冷')).toBeDefined();

    act(() => {
      window.dispatchEvent(new Event('pagehide'));
      window.dispatchEvent(new Event('pagehide'));
    });

    expect(mocks.placementEnd).not.toHaveBeenCalled();
    expect(window.location.search).toContain('session=placement_1');
  });

  it('keeps a probe active while the page is only suspended in bfcache', async () => {
    render(<ScreenPlacement navigate={vi.fn()} />);
    expect(await screen.findByText('备题中 · 子图还冷')).toBeDefined();
    const pagehide = new Event('pagehide');
    Object.defineProperty(pagehide, 'persisted', { value: true });

    act(() => window.dispatchEvent(pagehide));

    expect(mocks.placementEnd).not.toHaveBeenCalled();
  });

  it('abandons before the explicit in-app exit and navigates once', async () => {
    const navigate = vi.fn();
    render(<ScreenPlacement navigate={navigate} />);
    expect(await screen.findByText('备题中 · 子图还冷')).toBeDefined();

    await userEvent.click(screen.getByRole('button', { name: '退出' }));

    expect(mocks.placementEnd).toHaveBeenCalledWith('placement_1', 'abandoned', {
      keepalive: false,
    });
    expect(navigate).toHaveBeenCalledWith('/today');
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it('abandons the cold probe before switching to the upload route', async () => {
    const navigate = vi.fn();
    render(<ScreenPlacement navigate={navigate} />);
    expect(await screen.findByText('备题中 · 子图还冷')).toBeDefined();

    await userEvent.click(screen.getByRole('button', { name: '改为上传材料' }));

    expect(mocks.placementEnd).toHaveBeenCalledWith('placement_1', 'abandoned', {
      keepalive: false,
    });
    expect(navigate).toHaveBeenCalledWith('/onboarding/upload');
  });

  it('waits for a successful completion transition before profile navigation', async () => {
    mocks.startPlacement.mockResolvedValue(placementStartFixture());
    mocks.submitProbeAnswer.mockResolvedValue({ status: 'effective' });
    mocks.placementNext.mockResolvedValue({ done: true, answeredCount: 1, reason: 'cap' });
    let finish: (() => void) | undefined;
    mocks.placementEnd.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    const navigate = vi.fn();
    renderPlacement(navigate);
    const user = userEvent.setup();
    await screen.findByText('用一句话解释导数。');
    await user.type(screen.getByRole('textbox', { name: '作答' }), '导数表示变化率');
    await user.click(screen.getByRole('button', { name: '下一题' }));
    await screen.findByText('正在收紧你的画像…');
    expect(mocks.placementEnd).toHaveBeenCalledWith('placement_1', 'completed', {
      keepalive: false,
    });
    expect(navigate).not.toHaveBeenCalled();
    await act(async () => finish?.());
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/profile?goal=goal_1'));
  });

  it('retains the session and offers recovery when completion fails', async () => {
    mocks.startPlacement.mockResolvedValue(placementStartFixture());
    mocks.submitProbeAnswer.mockResolvedValue({ status: 'effective' });
    mocks.placementNext.mockResolvedValue({ done: true, answeredCount: 1, reason: 'cap' });
    mocks.placementEnd.mockRejectedValue(new Error('completion unavailable'));
    const navigate = vi.fn();
    renderPlacement(navigate);
    const user = userEvent.setup();
    await screen.findByText('用一句话解释导数。');
    await user.type(screen.getByRole('textbox', { name: '作答' }), '导数表示变化率');
    await user.click(screen.getByRole('button', { name: '下一题' }));
    await screen.findByText('completion unavailable');
    expect(navigate).not.toHaveBeenCalled();
    expect(window.location.search).toContain('session=placement_1');
    expect(screen.getByRole('button', { name: '重试' })).toBeDefined();
  });

  it('retains an accepted answer when next fails and queries again without duplicate submit', async () => {
    mocks.startPlacement.mockResolvedValue(placementStartFixture());
    mocks.submitProbeAnswer.mockResolvedValue({ status: 'effective' });
    mocks.placementNext
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({ done: true, answeredCount: 1, reason: 'cap' });
    const user = userEvent.setup();
    renderPlacement();
    await screen.findByText('用一句话解释导数。');
    await user.type(screen.getByRole('textbox', { name: '作答' }), '导数表示变化率');
    await user.click(screen.getByRole('button', { name: '下一题' }));
    await screen.findByText('等待确认作答状态');
    expect(mocks.submitProbeAnswer).toHaveBeenCalledTimes(1);
    expect(mocks.placementEnd).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '重新查询状态' }));
    await waitFor(() =>
      expect(mocks.placementEnd).toHaveBeenCalledWith('placement_1', 'completed', {
        keepalive: false,
      }),
    );
    expect(mocks.submitProbeAnswer).toHaveBeenCalledTimes(1);
  });
});
