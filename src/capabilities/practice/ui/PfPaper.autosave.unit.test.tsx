// @vitest-environment jsdom
// YUK-713 — a failed draft autosave must stop the page from promising 「草稿自动保存」/
// 「进度保留」and offer a retry, instead of the old silent `.catch(() => {})`.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
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

const textDetail = {
  artifact_id: 'paper_1',
  title: '自动保存测试卷',
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
            kind: 'short',
            prompt_md: '简答这道题',
            choices_md: [],
            difficulty: 1,
          },
          slot_state: { draft: { content_md: '' }, submission: null },
        },
      ],
    },
  ],
};

function textSlot(id: string, prompt: string) {
  return {
    question_id: id,
    part_ref: null,
    section_index: 0,
    question: { id, kind: 'short', prompt_md: prompt, choices_md: [], difficulty: 1 },
    slot_state: { draft: { content_md: '' }, submission: null },
  };
}

const twoSlotDetail = {
  ...textDetail,
  sections: [
    {
      section_index: 0,
      knowledge_focus_names: [],
      slots: [textSlot('question_1', '第一题'), textSlot('question_2', '第二题')],
    },
  ],
};

function renderPaper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <PfPaper artifactId="paper_1" onExit={vi.fn()} onSubmitted={vi.fn()} addToast={vi.fn()} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getPaperDetail.mockResolvedValue(textDetail);
  mocks.pausePaperSession.mockResolvedValue({ ok: true });
});

afterEach(cleanup);

describe('PfPaper autosave failure (YUK-713)', () => {
  it('surfaces a retry and drops the 进度保留 promise when a draft save fails', async () => {
    mocks.savePaperAnswer.mockRejectedValue(new Error('500'));
    const user = userEvent.setup();
    renderPaper();

    await screen.findByText('自动保存测试卷');
    await user.type(screen.getByLabelText('作答'), '答');

    // After the debounced PUT rejects, the honest failure chip replaces the
    // 「草稿自动保存」claim and offers a retry.
    const retry = await screen.findByRole('button', { name: '保存失败 · 重试' }, { timeout: 2500 });
    expect(retry).toBeTruthy();
    expect(screen.queryByText('草稿自动保存')).toBeNull();
    // The exit affordance stops promising 进度保留 while a save is broken.
    expect(screen.getByRole('button', { name: '退出' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '退出 · 进度保留' })).toBeNull();
  });

  it('clears the failure once a retried save succeeds', async () => {
    mocks.savePaperAnswer.mockRejectedValueOnce(new Error('500')).mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    renderPaper();

    await screen.findByText('自动保存测试卷');
    await user.type(screen.getByLabelText('作答'), '答');

    const retry = await screen.findByRole('button', { name: '保存失败 · 重试' }, { timeout: 2500 });
    await user.click(retry);

    expect(await screen.findByText('草稿自动保存')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '保存失败 · 重试' })).toBeNull();
    expect(mocks.savePaperAnswer).toHaveBeenCalledTimes(2);
  });

  it('an older save settling later cannot clear a newer failed save', async () => {
    let resolveOld: (value: unknown) => void = () => {};
    mocks.savePaperAnswer
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOld = resolve;
          }),
      )
      .mockRejectedValueOnce(new Error('500'));
    const user = userEvent.setup();
    renderPaper();

    await screen.findByText('自动保存测试卷');
    await user.type(screen.getByLabelText('作答'), '一');
    await waitFor(() => expect(mocks.savePaperAnswer).toHaveBeenCalledTimes(1), {
      timeout: 2500,
    });
    await user.type(screen.getByLabelText('作答'), '二');

    await screen.findByRole('button', { name: '保存失败 · 重试' }, { timeout: 2500 });

    // The stale first PUT resolving now must not clear the newer failure.
    resolveOld({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getByRole('button', { name: '保存失败 · 重试' })).toBeTruthy();
    expect(screen.queryByText('草稿自动保存')).toBeNull();
  });

  it('does not drop slot A pending save when switching to slot B (per-slot debounce)', async () => {
    mocks.getPaperDetail.mockResolvedValue(twoSlotDetail);
    mocks.savePaperAnswer.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    renderPaper();

    await screen.findByText('自动保存测试卷');
    // Type in slot A, then switch to slot B within the debounce window and type there.
    await user.type(screen.getByLabelText('作答'), 'A答');
    await user.click(screen.getByRole('tab', { name: '2' }));
    await user.type(screen.getByLabelText('作答'), 'B答');

    // With a shared timer, slot B's keystroke cancelled slot A's pending save entirely.
    // Per-slot timers keep both — both drafts must reach the server.
    await waitFor(
      () => {
        const ids = mocks.savePaperAnswer.mock.calls.map((c) => c[1].question_id);
        expect(ids).toContain('question_1');
        expect(ids).toContain('question_2');
      },
      { timeout: 2500 },
    );
  });
});
