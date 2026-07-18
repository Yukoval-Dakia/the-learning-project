// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ScreenPlacement from './ScreenPlacement';

const mocks = vi.hoisted(() => ({
  placementEnd: vi.fn(),
  placementNext: vi.fn(),
  startPlacement: vi.fn(),
  submitProbeAnswer: vi.fn(),
}));

vi.mock('./placement-api', () => mocks);

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
});
