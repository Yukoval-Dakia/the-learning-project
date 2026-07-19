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

// Cold open: no session on the detail → the page starts one via startPaperSession.
const noSessionDetail = { ...textDetail, session: null };

// A single-slot detail whose one slot carries the given draft (same slot key across
// papers, to exercise the cross-paper answer bleed).
function draftDetail(content: string) {
  return {
    ...textDetail,
    sections: [
      {
        section_index: 0,
        knowledge_focus_names: [],
        slots: [
          {
            ...textSlot('question_1', '简答这道题'),
            slot_state: { draft: { content_md: content }, submission: null },
          },
        ],
      },
    ],
  };
}

function renderPaper(artifactId = 'paper_1') {
  const onExit = vi.fn();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui = (id: string) => (
    <QueryClientProvider client={queryClient}>
      <PfPaper artifactId={id} onExit={onExit} onSubmitted={vi.fn()} addToast={vi.fn()} />
    </QueryClientProvider>
  );
  const utils = render(ui(artifactId));
  return { ...utils, onExit, rerenderWith: (id: string) => utils.rerender(ui(id)) };
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

  it('flags the slot (not a silent drop) when the session is not ready, then retry succeeds once it lands', async () => {
    mocks.getPaperDetail.mockResolvedValue(noSessionDetail);
    let resolveStart: (value: { session_id: string }) => void = () => {};
    mocks.startPaperSession.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveStart = resolve;
        }),
    );
    mocks.savePaperAnswer.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    renderPaper();

    await screen.findByText('自动保存测试卷');
    // Type before the session lands — the debounced save must NOT silently drop.
    await user.type(screen.getByLabelText('作答'), '答');
    const retry = await screen.findByRole('button', { name: '保存失败 · 重试' }, { timeout: 2500 });
    expect(retry).toBeTruthy();
    // No PUT was attempted while the session was missing.
    expect(mocks.savePaperAnswer).not.toHaveBeenCalled();

    // Session lands, then the learner retries — now the draft goes through.
    resolveStart({ session_id: 'review_1' });
    await user.click(retry);

    expect(await screen.findByText('草稿自动保存')).toBeTruthy();
    expect(mocks.savePaperAnswer).toHaveBeenCalledTimes(1);
    expect(mocks.savePaperAnswer.mock.calls[0][1]).toMatchObject({
      session_id: 'review_1',
      question_id: 'question_1',
    });
  });

  it('clears the retry chip once the failed slot is submitted (not stuck)', async () => {
    mocks.savePaperAnswer.mockRejectedValue(new Error('500'));
    const user = userEvent.setup();
    renderPaper();

    await screen.findByText('自动保存测试卷');
    await user.type(screen.getByLabelText('作答'), '答');
    await screen.findByRole('button', { name: '保存失败 · 重试' }, { timeout: 2500 });

    // Submitting captures the answer regardless of the failed draft PUT — the retry chip
    // must not stay stuck with nothing left to save.
    await user.click(screen.getByRole('button', { name: '交卷 · 统一判分' }));

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: '保存失败 · 重试' })).toBeNull(),
    );
    expect(screen.getByText('草稿自动保存')).toBeTruthy();
  });

  it('clears answers and reloads the draft when the paper (artifactId) changes', async () => {
    // Both papers share the slot key question_1:: but carry different server drafts.
    mocks.getPaperDetail.mockImplementation((id: string) =>
      Promise.resolve(id === 'paper_B' ? draftDetail('答案B') : draftDetail('答案A')),
    );
    const { rerenderWith } = renderPaper('paper_A');

    expect(((await screen.findByLabelText('作答')) as HTMLTextAreaElement).value).toBe('答案A');

    rerenderWith('paper_B');

    // Without the answers reset the shared slot key kept 答案A and skipped paper B's draft.
    await waitFor(() =>
      expect((screen.getByLabelText('作答') as HTMLTextAreaElement).value).toBe('答案B'),
    );
  });

  it('a paper-A save settling after switching to paper B does not pollute B', async () => {
    // Both papers share slot key question_1::. Paper A's save is left in flight; paper B's
    // save fails. When A's stale save finally succeeds it must NOT clear B's failure.
    let resolveA: (value: unknown) => void = () => {};
    mocks.savePaperAnswer
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveA = resolve;
          }),
      )
      .mockRejectedValue(new Error('500'));
    mocks.getPaperDetail.mockImplementation(() => Promise.resolve(draftDetail('')));
    const user = userEvent.setup();
    const { rerenderWith } = renderPaper('paper_A');

    await screen.findByText('自动保存测试卷');
    await user.type(screen.getByLabelText('作答'), 'A');
    // Paper A's save is dispatched and left pending.
    await waitFor(() => expect(mocks.savePaperAnswer).toHaveBeenCalledTimes(1), { timeout: 2500 });

    // Switch to paper B (bumps the generation, resets saveSeq), then fail B's save.
    rerenderWith('paper_B');
    await screen.findByLabelText('作答');
    await user.type(screen.getByLabelText('作答'), 'B');
    await screen.findByRole('button', { name: '保存失败 · 重试' }, { timeout: 2500 });

    // A's stale save (older generation) now succeeds — B's failure must survive.
    resolveA({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getByRole('button', { name: '保存失败 · 重试' })).toBeTruthy();
    expect(screen.queryByText('草稿自动保存')).toBeNull();
  });

  it('reports unsaved failures to the host on exit (no false 进度保留)', async () => {
    mocks.savePaperAnswer.mockRejectedValue(new Error('500'));
    const user = userEvent.setup();
    const { onExit } = renderPaper();

    await screen.findByText('自动保存测试卷');
    await user.type(screen.getByLabelText('作答'), '答');
    await screen.findByRole('button', { name: '保存失败 · 重试' }, { timeout: 2500 });

    // Exit while a draft is unsaved — the host must be told, so it can drop 「进度保留」.
    await user.click(screen.getByRole('button', { name: '退出' }));
    expect(onExit).toHaveBeenCalledWith({ unsavedFailures: 1 });
  });

  it('discards a stale startPaperSession resolve after switching papers', async () => {
    let resolveStartA: (value: { session_id: string }) => void = () => {};
    mocks.startPaperSession.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveStartA = resolve;
        }),
    );
    // Paper A opens via startPaperSession (no session on the detail); paper B already has a
    // session. Both share the slot key.
    mocks.getPaperDetail.mockImplementation((id: string) =>
      Promise.resolve(
        id === 'paper_B'
          ? { ...draftDetail(''), session: { id: 'review_B', status: 'started' } }
          : { ...draftDetail(''), session: null },
      ),
    );
    mocks.savePaperAnswer.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    const { rerenderWith } = renderPaper('paper_A');

    await screen.findByText('自动保存测试卷');
    await waitFor(() => expect(mocks.startPaperSession).toHaveBeenCalled());

    rerenderWith('paper_B');
    await screen.findByLabelText('作答');
    // Paper A's open resolves AFTER the switch — the stale session id must be discarded.
    resolveStartA({ session_id: 'review_A_stale' });
    await new Promise((resolve) => setTimeout(resolve, 20));

    await user.type(screen.getByLabelText('作答'), 'B');
    await waitFor(() => expect(mocks.savePaperAnswer).toHaveBeenCalled(), { timeout: 2500 });
    // B's autosave carries B's session, never A's stale one.
    expect(mocks.savePaperAnswer.mock.calls.at(-1)?.[1].session_id).toBe('review_B');
  });
});

describe('PfPaper exit/pagehide draft flush (YUK-732)', () => {
  it('flushes a pending debounced draft on exit (no lost last-800ms input)', async () => {
    mocks.savePaperAnswer.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    const { onExit } = renderPaper();

    await screen.findByText('自动保存测试卷');
    // Type, then exit immediately — well within the 800ms debounce, so the save timer is
    // still pending. The exit must flush it, not let it die with the unmount.
    await user.type(screen.getByLabelText('作答'), '末尾');
    await user.click(screen.getByRole('button', { name: '退出 · 进度保留' }));

    await waitFor(() => expect(mocks.savePaperAnswer).toHaveBeenCalled());
    expect(mocks.savePaperAnswer.mock.calls.at(-1)?.[1]).toMatchObject({
      question_id: 'question_1',
      answer_md: '末尾',
    });
    // The flush landed → the host hears an honest 「进度保留」(zero unsaved failures).
    await waitFor(() => expect(onExit).toHaveBeenCalledWith({ unsavedFailures: 0 }));
  });

  it('does not re-save an already-autosaved slot on exit (no phantom unsaved failure)', async () => {
    mocks.savePaperAnswer.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    const { onExit } = renderPaper();

    await screen.findByText('自动保存测试卷');
    await user.type(screen.getByLabelText('作答'), '答');
    // Let the 800ms debounce fire and the autosave land.
    await waitFor(() => expect(mocks.savePaperAnswer).toHaveBeenCalledTimes(1), { timeout: 2500 });

    // Exit AFTER the autosave already succeeded: the fired timer's key must be gone, so the
    // exit flush must NOT re-issue a duplicate save (a redundant PUT whose transient failure
    // would otherwise falsely report unsavedFailures=1).
    await user.click(screen.getByRole('button', { name: '退出 · 进度保留' }));

    await waitFor(() => expect(onExit).toHaveBeenCalledWith({ unsavedFailures: 0 }));
    expect(mocks.savePaperAnswer).toHaveBeenCalledTimes(1);
  });

  it('reports an unsaved failure when the exit flush itself fails', async () => {
    mocks.savePaperAnswer.mockRejectedValue(new Error('500'));
    const user = userEvent.setup();
    const { onExit } = renderPaper();

    await screen.findByText('自动保存测试卷');
    await user.type(screen.getByLabelText('作答'), '末尾');
    await user.click(screen.getByRole('button', { name: '退出 · 进度保留' }));

    // The flush is attempted, and because it fails the host is told the truth instead of a
    // false 「进度保留」.
    await waitFor(() => expect(mocks.savePaperAnswer).toHaveBeenCalled());
    await waitFor(() => expect(onExit).toHaveBeenCalledWith({ unsavedFailures: 1 }));
  });

  it('flushes pending drafts with keepalive on pagehide (tab close)', async () => {
    mocks.savePaperAnswer.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    renderPaper();

    await screen.findByText('自动保存测试卷');
    await user.type(screen.getByLabelText('作答'), '末尾');
    // Simulate a hard tab-close before the debounce fires: the pending draft must be sent
    // with keepalive so the request survives page teardown.
    window.dispatchEvent(new Event('pagehide'));

    await waitFor(() => expect(mocks.savePaperAnswer).toHaveBeenCalled());
    expect(mocks.savePaperAnswer.mock.calls.at(-1)?.[2]).toMatchObject({ keepalive: true });
  });
});
