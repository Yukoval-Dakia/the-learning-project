// @vitest-environment jsdom
// YUK-713 — pickImage used to swallow uploadAsset failures, letting a learner submit the
// placement probe without the handwriting they thought they attached. A failed upload must
// surface (mirrors the ProbeAnswers 「部分图片上传失败」precedent).

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ScreenPlacement from './ScreenPlacement';

const mocks = vi.hoisted(() => ({
  placementEnd: vi.fn(),
  placementNext: vi.fn(),
  startPlacement: vi.fn(),
  submitProbeAnswer: vi.fn(),
  getQuestion: vi.fn(),
  uploadAsset: vi.fn(),
}));

vi.mock('./placement-api', () => ({
  placementEnd: mocks.placementEnd,
  placementNext: mocks.placementNext,
  startPlacement: mocks.startPlacement,
  submitProbeAnswer: mocks.submitProbeAnswer,
}));

vi.mock('@/capabilities/practice/ui/practice-api', async (importActual) => {
  const actual = await importActual<typeof import('@/capabilities/practice/ui/practice-api')>();
  return { ...actual, getQuestion: mocks.getQuestion };
});

vi.mock('@/ui/lib/assets', async (importActual) => {
  const actual = await importActual<typeof import('@/ui/lib/assets')>();
  return { ...actual, uploadAsset: mocks.uploadAsset };
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
    knowledgeIds: ['kn_1'],
    question: { questionId: 'q1' },
    sourcingNeeded: false,
  });
  mocks.getQuestion.mockResolvedValue(TEXT_QUESTION);
  mocks.placementEnd.mockResolvedValue({ ok: true });
});

afterEach(cleanup);

describe('ScreenPlacement handwriting upload failure (YUK-713)', () => {
  it('surfaces a retry when the handwriting upload fails, instead of silently dropping it', async () => {
    mocks.uploadAsset.mockRejectedValue(new Error('500'));
    const user = userEvent.setup();
    const { container } = renderPlacement();

    await screen.findByText('用一句话解释导数。');
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(fileInput, new File(['bytes'], 'handwriting.png', { type: 'image/png' }));

    expect(await screen.findByText('图片上传失败，请重试')).toBeTruthy();
    // the upload did NOT falsely report an attached image.
    expect(screen.queryByText(/已附 \d+ 张手写稿/)).toBeNull();
  });
});
