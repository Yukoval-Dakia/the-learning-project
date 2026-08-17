// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ScreenPlacement from './ScreenPlacement';

const mocks = vi.hoisted(() => ({
  placementEnd: vi.fn(),
  placementNext: vi.fn(),
  startPlacement: vi.fn(),
  submitProbeAnswer: vi.fn(),
  getQuestion: vi.fn(),
}));

vi.mock('./placement-api', () => mocks);

vi.mock('@/capabilities/practice/ui/practice-api', async (importActual) => {
  const actual = await importActual<typeof import('@/capabilities/practice/ui/practice-api')>();
  return { ...actual, getQuestion: mocks.getQuestion };
});

const TEXT_QUESTION = {
  id: 'q1',
  kind: 'short',
  prompt_md: '用一句话解释导数。',
  choices_md: [],
  labels: [{ id: 'kn_1', name: '导数' }],
};

function renderPlacement() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ScreenPlacement navigate={vi.fn()} />
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
});

afterEach(cleanup);

describe('ScreenPlacement session lifecycle (YUK-211)', () => {
  it('abandons the active probe with keepalive on pagehide, without duplicate PATCHes', async () => {
    render(<ScreenPlacement navigate={vi.fn()} />);
    expect(await screen.findByText('备题中 · 子图还冷')).toBeDefined();

    act(() => {
      window.dispatchEvent(new Event('pagehide'));
      window.dispatchEvent(new Event('pagehide'));
    });

    await waitFor(() =>
      expect(mocks.placementEnd).toHaveBeenCalledWith('placement_1', 'abandoned', {
        keepalive: true,
      }),
    );
    expect(mocks.placementEnd).toHaveBeenCalledTimes(1);
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

  it('abandons the probe when submit succeeds but next fails — no duplicate submit (YUK-895 quality lane)', async () => {
    mocks.startPlacement.mockResolvedValue({
      sessionId: 'placement_1',
      knowledgeIds: ['kn_1'],
      question: { questionId: 'q1' },
      sourcingNeeded: false,
    });
    mocks.getQuestion.mockResolvedValue(TEXT_QUESTION);
    mocks.submitProbeAnswer.mockResolvedValue({ ok: true });
    mocks.placementNext.mockRejectedValueOnce(new Error('network down'));
    const user = userEvent.setup();
    renderPlacement();

    await screen.findByText('用一句话解释导数。');
    const answer = screen.getByRole('textbox', { name: '作答' });
    await user.type(answer, '导数表示变化率');
    await user.click(screen.getByRole('button', { name: '下一题' }));

    // Partial-success window: the attempt WAS recorded, but the probe is abandoned
    // (judgefail, no retry path) — the same question can never be re-submitted.
    expect(await screen.findByText(/评分管道暂时不可用/)).toBeTruthy();
    expect(mocks.submitProbeAnswer).toHaveBeenCalledTimes(1);
    expect(mocks.placementNext).toHaveBeenCalledTimes(1);
    expect(mocks.placementEnd).toHaveBeenCalledWith('placement_1', 'abandoned', {
      keepalive: false,
    });
  });
});
