// @vitest-environment jsdom
// YUK-732 — 复盘三态分离：loading / error(带重试) / empty(真空态)，error ≠ empty。
// 瞬时加载失败落带重试的错误态，而非把学习者困在「复盘加载失败」死胡同。

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PfRetro } from './PfRetro';

const mocks = vi.hoisted(() => ({ getPaperDetail: vi.fn() }));
vi.mock('./practice-api', () => mocks);

const retroDetail = {
  artifact_id: 'paper_1',
  title: '复盘卷',
  generation_status: 'ready',
  intent_source: 'test',
  session: { id: 'review_1', status: 'completed', pos: 0, right: 1, wrong: 0 },
  sections: [
    {
      section_index: 0,
      knowledge_focus_names: [],
      slots: [
        {
          question_id: 'question_1',
          part_ref: null,
          section_index: 0,
          question: {
            id: 'question_1',
            kind: 'short',
            prompt_md: '简答这道题',
            choices_md: [],
            difficulty: 1,
          },
          slot_state: {
            draft: null,
            submission: {
              submitted: true,
              visible_to_user: true,
              outcome: 'correct',
              score: 1,
              feedback_md: '好',
              answer_md: '答',
              reference_md: '参考',
            },
          },
        },
      ],
    },
  ],
};

function renderRetro() {
  const onBack = vi.fn();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <PfRetro artifactId="paper_1" onBack={onBack} />
    </QueryClientProvider>,
  );
  return { ...utils, onBack };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(cleanup);

describe('PfRetro load states (YUK-732)', () => {
  it('shows the loading copy while the retro is still fetching', async () => {
    // A never-settling fetch keeps the query in its loading state.
    mocks.getPaperDetail.mockReturnValue(new Promise(() => {}));
    renderRetro();
    expect(await screen.findByText('取卷中…')).toBeTruthy();
  });

  it('shows an error state with a working retry on transient load failure', async () => {
    mocks.getPaperDetail.mockRejectedValueOnce(new Error('500')).mockResolvedValue(retroDetail);
    const user = userEvent.setup();
    renderRetro();

    // Error, not empty: distinct copy + a retry affordance (the old code merged both into
    // 「复盘加载失败」with only a back button).
    const retry = await screen.findByRole('button', { name: '重试' });
    expect(screen.getByText('复盘加载失败。')).toBeTruthy();
    expect(screen.queryByText('还没有复盘')).toBeNull();

    // Retry refetches and the real retro renders.
    await user.click(retry);
    expect(await screen.findByText('复盘卷 · 复盘')).toBeTruthy();
    expect(mocks.getPaperDetail).toHaveBeenCalledTimes(2);
  });

  it('shows a distinct empty state (not an error, no retry) when there is no retro detail', async () => {
    mocks.getPaperDetail.mockResolvedValue(null);
    renderRetro();

    expect(await screen.findByText('还没有复盘')).toBeTruthy();
    expect(screen.queryByText('复盘加载失败。')).toBeNull();
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull();
  });
});
