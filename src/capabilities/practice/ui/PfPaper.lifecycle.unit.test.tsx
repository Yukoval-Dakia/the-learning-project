// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PfPaper } from './PfPaper';

const mocks = vi.hoisted(() => ({
  endPaperSession: vi.fn(),
  getPaperDetail: vi.fn(),
  pausePaperSession: vi.fn(),
  savePaperAnswer: vi.fn(),
  startPaperSession: vi.fn(),
  submitPaperSlot: vi.fn(),
}));

vi.mock('./practice-api', () => mocks);

const activeDetail = {
  artifact_id: 'paper_1',
  title: '生命周期测试卷',
  generation_status: 'ready',
  intent_source: 'test',
  session: { id: 'review_1', status: 'started', pos: 0, right: 0, wrong: 0 },
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
            kind: 'choice',
            prompt_md: '请选择',
            choices_md: ['甲', '乙'],
            difficulty: 1,
          },
          slot_state: {
            draft: { content_md: '甲' },
            submission: null,
          },
        },
      ],
    },
  ],
};

function renderPaper(overrides: Partial<Parameters<typeof PfPaper>[0]> = {}) {
  const props = {
    artifactId: 'paper_1',
    onExit: vi.fn(),
    onSubmitted: vi.fn(),
    addToast: vi.fn(),
    ...overrides,
  };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <PfPaper {...props} />
    </QueryClientProvider>,
  );
  return props;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getPaperDetail.mockResolvedValue(activeDetail);
  mocks.pausePaperSession.mockResolvedValue({ ok: true });
  mocks.endPaperSession.mockResolvedValue({ ok: true });
  mocks.submitPaperSlot.mockResolvedValue({ ok: true });
});

afterEach(cleanup);

describe('PfPaper session lifecycle (YUK-211)', () => {
  it('pauses an active review with keepalive on pagehide, without duplicate PATCHes', async () => {
    renderPaper();
    expect(await screen.findByText('生命周期测试卷')).toBeDefined();

    act(() => {
      window.dispatchEvent(new Event('pagehide'));
      window.dispatchEvent(new Event('pagehide'));
    });

    await waitFor(() =>
      expect(mocks.pausePaperSession).toHaveBeenCalledWith('review_1', { keepalive: true }),
    );
    expect(mocks.pausePaperSession).toHaveBeenCalledTimes(1);
  });

  it('pauses before the explicit in-app exit and preserves the existing navigation callback', async () => {
    const props = renderPaper();
    await userEvent.click(await screen.findByRole('button', { name: '退出 · 进度保留' }));

    expect(mocks.pausePaperSession).toHaveBeenCalledWith('review_1', { keepalive: false });
    expect(props.onExit).toHaveBeenCalledTimes(1);
  });

  it('does not pause again after a successful completion transition', async () => {
    mocks.getPaperDetail.mockResolvedValueOnce(activeDetail).mockResolvedValue({
      ...activeDetail,
      session: { ...activeDetail.session, status: 'completed' },
    });
    const props = renderPaper();
    await userEvent.click(await screen.findByRole('button', { name: '交卷 · 统一判分' }));

    await waitFor(() => expect(props.onSubmitted).toHaveBeenCalledTimes(1));
    act(() => window.dispatchEvent(new Event('pagehide')));

    expect(mocks.endPaperSession).toHaveBeenCalledWith('review_1');
    expect(mocks.pausePaperSession).not.toHaveBeenCalled();
  });

  it('claims the completion transition before submitting slots so pagehide cannot pause it', async () => {
    let resolveSubmission: ((value: { ok: boolean }) => void) | undefined;
    mocks.submitPaperSlot.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSubmission = resolve;
        }),
    );
    const props = renderPaper();

    await userEvent.click(await screen.findByRole('button', { name: '交卷 · 统一判分' }));
    await waitFor(() => expect(mocks.submitPaperSlot).toHaveBeenCalledTimes(1));
    act(() => window.dispatchEvent(new Event('pagehide')));

    expect(mocks.pausePaperSession).not.toHaveBeenCalled();

    resolveSubmission?.({ ok: true });
    await waitFor(() => expect(props.onSubmitted).toHaveBeenCalledTimes(1));
  });
});
