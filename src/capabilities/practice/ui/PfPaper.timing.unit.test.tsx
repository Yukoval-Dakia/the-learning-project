// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PfPaper } from './PfPaper';

const mocks = vi.hoisted(() => ({
  allocateKeepaliveBudget: vi.fn((sizes: number[]) => sizes.map(() => true)),
  paperAnswerDraftBodyBytes: vi.fn(() => 0),
  endPaperSession: vi.fn(),
  getPaperDetail: vi.fn(),
  pausePaperSession: vi.fn(),
  savePaperAnswer: vi.fn(),
  startPaperSession: vi.fn(),
  submitPaperSlot: vi.fn(),
}));

vi.mock('./practice-api', () => mocks);

const detail = {
  artifact_id: 'paper_1',
  title: '计时测试卷',
  generation_status: 'ready',
  intent_source: 'test',
  session: { id: 'review_1', status: 'started', pos: 0, right: 0, wrong: 0 },
  sections: [
    {
      section_index: 0,
      knowledge_focus_names: [],
      slots: ['question_1', 'question_2'].map((question_id) => ({
        question_id,
        part_ref: null,
        section_index: 0,
        question: {
          id: question_id,
          kind: 'choice',
          prompt_md: question_id,
          choices_md: ['甲', '乙'],
          difficulty: 1,
        },
        slot_state: { draft: { content_md: '甲' }, submission: null },
      })),
    },
  ],
};

const storageKey = 'pf-paper-timing:v1:review_1:paper_1';
const memory = new Map<string, string>();
const storage: Storage = {
  get length() {
    return memory.size;
  },
  clear: () => memory.clear(),
  getItem: (key) => memory.get(key) ?? null,
  key: (index) => [...memory.keys()][index] ?? null,
  removeItem: (key) => {
    memory.delete(key);
  },
  setItem: (key, value) => {
    memory.set(key, value);
  },
};
Object.defineProperty(window, 'localStorage', { value: storage, configurable: true });
let now = 0;

function renderPaper(strict = false) {
  const props = { artifactId: 'paper_1', onExit: vi.fn(), onSubmitted: vi.fn(), addToast: vi.fn() };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const node = (
    <QueryClientProvider client={client}>
      <PfPaper {...props} />
    </QueryClientProvider>
  );
  const view = render(strict ? <StrictMode>{node}</StrictMode> : node);
  return { ...view, props };
}

function storedSlots() {
  return JSON.parse(window.localStorage.getItem(storageKey) ?? '{}').slots ?? {};
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  mocks.getPaperDetail.mockResolvedValue(detail);
  mocks.pausePaperSession.mockResolvedValue({ ok: true });
  mocks.endPaperSession.mockResolvedValue({ ok: true });
  mocks.submitPaperSlot.mockResolvedValue({ ok: true });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('PfPaper cumulative foreground-visible slot timing (YUK-448)', () => {
  it('starts timing after a fresh paper session is created', async () => {
    mocks.getPaperDetail.mockResolvedValue({ ...detail, session: null });
    mocks.startPaperSession.mockResolvedValue({ session_id: 'review_1' });
    renderPaper();
    await screen.findByText('计时测试卷');
    await waitFor(() => expect(mocks.startPaperSession).toHaveBeenCalledWith('paper_1'));
    now = 125;
    await userEvent.click(screen.getByRole('button', { name: '交卷 · 统一判分' }));
    await waitFor(() => expect(mocks.submitPaperSlot).toHaveBeenCalled());
    expect(mocks.submitPaperSlot.mock.calls[0][1].latency_ms).toBe(125);
  });

  it('isolates slots and accumulates revisits', async () => {
    renderPaper();
    await screen.findByText('计时测试卷');
    now = 100;
    await userEvent.click(screen.getByRole('tab', { name: '2' }));
    now = 350;
    await userEvent.click(screen.getByRole('tab', { name: '1' }));
    now = 500;
    await userEvent.click(screen.getByRole('button', { name: '交卷 · 统一判分' }));

    await waitFor(() => expect(mocks.submitPaperSlot).toHaveBeenCalledTimes(2));
    expect(mocks.submitPaperSlot.mock.calls.map((call) => call[1].latency_ms)).toEqual([250, 250]);
  });

  it('pauses while hidden and resumes on visibility return', async () => {
    renderPaper();
    await screen.findByText('计时测试卷');
    now = 100;
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    now = 1_000;
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    now = 1_100;
    await userEvent.click(screen.getByRole('button', { name: '交卷 · 统一判分' }));
    await waitFor(() => expect(mocks.submitPaperSlot).toHaveBeenCalled());
    expect(mocks.submitPaperSlot.mock.calls[0][1].latency_ms).toBe(200);
  });

  it.each(['pagehide', 'unmount'] as const)('persists the active segment on %s', async (kind) => {
    const view = renderPaper();
    await screen.findByText('计时测试卷');
    now = 125;
    act(() => (kind === 'pagehide' ? window.dispatchEvent(new Event('pagehide')) : view.unmount()));
    expect(storedSlots()['question_1::']).toBe(125);
  });

  it('persists on explicit exit and does not count time outside the paper', async () => {
    const { props } = renderPaper();
    await screen.findByText('计时测试卷');
    now = 75;
    await userEvent.click(screen.getByRole('button', { name: '退出 · 进度保留' }));
    expect(props.onExit).toHaveBeenCalled();
    expect(storedSlots()['question_1::']).toBe(75);
  });

  it('restores same-session timing after reload and reconciles by max', async () => {
    window.localStorage.setItem(
      storageKey,
      JSON.stringify({
        version: 1,
        session_id: 'review_1',
        paper_id: 'paper_1',
        slots: { 'question_1::': 400 },
      }),
    );
    renderPaper();
    await screen.findByText('计时测试卷');
    now = 100;
    await userEvent.click(screen.getByRole('button', { name: '交卷 · 统一判分' }));
    await waitFor(() => expect(mocks.submitPaperSlot).toHaveBeenCalled());
    expect(mocks.submitPaperSlot.mock.calls[0][1].latency_ms).toBe(500);
  });

  it.each([
    '{bad json',
    JSON.stringify({
      version: 2,
      session_id: 'review_1',
      paper_id: 'paper_1',
      slots: { 'question_1::': 999 },
    }),
    JSON.stringify({
      version: 1,
      session_id: 'foreign',
      paper_id: 'paper_1',
      slots: { 'question_1::': 999 },
    }),
  ])('ignores malformed or foreign persisted data', async (stored) => {
    window.localStorage.setItem(storageKey, stored);
    renderPaper();
    await screen.findByText('计时测试卷');
    now = 50;
    await userEvent.click(screen.getByRole('button', { name: '交卷 · 统一判分' }));
    await waitFor(() => expect(mocks.submitPaperSlot).toHaveBeenCalled());
    expect(mocks.submitPaperSlot.mock.calls[0][1].latency_ms).toBe(50);
  });

  it('keeps timing capture non-blocking when storage throws', async () => {
    vi.spyOn(storage, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(storage, 'setItem').mockImplementation(() => {
      throw new Error('full');
    });
    renderPaper();
    await screen.findByText('计时测试卷');
    now = 60;
    await userEvent.click(screen.getByRole('button', { name: '交卷 · 统一判分' }));
    await waitFor(() => expect(mocks.submitPaperSlot).toHaveBeenCalled());
    expect(mocks.submitPaperSlot.mock.calls[0][1].latency_ms).toBe(60);
  });

  it('resumes the active unsubmitted slot after a partial submit failure', async () => {
    mocks.submitPaperSlot
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(new Error('fail'));
    renderPaper();
    await screen.findByText('计时测试卷');
    now = 100;
    await userEvent.click(screen.getByRole('tab', { name: '2' }));
    now = 200;
    await userEvent.click(screen.getByRole('button', { name: '交卷 · 统一判分' }));
    await waitFor(() => expect(mocks.submitPaperSlot).toHaveBeenCalledTimes(2));

    mocks.submitPaperSlot.mockResolvedValue({ ok: true });
    now = 350;
    await userEvent.click(screen.getByRole('button', { name: '交卷 · 统一判分' }));
    await waitFor(() => expect(mocks.submitPaperSlot).toHaveBeenCalledTimes(3));
    expect(mocks.submitPaperSlot.mock.calls[0][1]).toMatchObject({
      question_id: 'question_1',
      latency_ms: 100,
    });
    expect(mocks.submitPaperSlot.mock.calls[2][1]).toMatchObject({
      question_id: 'question_2',
      latency_ms: 250,
    });
  });

  it('retains timing after partial submit failure and clears only after full completion', async () => {
    mocks.submitPaperSlot
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(new Error('fail'));
    renderPaper();
    await screen.findByText('计时测试卷');
    now = 100;
    await userEvent.click(screen.getByRole('button', { name: '交卷 · 统一判分' }));
    await waitFor(() => expect(mocks.submitPaperSlot).toHaveBeenCalledTimes(2));
    expect(window.localStorage.getItem(storageKey)).not.toBeNull();

    mocks.submitPaperSlot.mockResolvedValue({ ok: true });
    now = 150;
    await userEvent.click(screen.getByRole('button', { name: '交卷 · 统一判分' }));
    await waitFor(() => expect(mocks.endPaperSession).toHaveBeenCalled());
    expect(window.localStorage.getItem(storageKey)).toBeNull();
  });

  it('treats server-submitted slots as terminal and does not double-count in StrictMode', async () => {
    mocks.getPaperDetail.mockResolvedValue({
      ...detail,
      sections: [
        {
          ...detail.sections[0],
          slots: [
            {
              ...detail.sections[0].slots[0],
              slot_state: {
                draft: null,
                submission: {
                  submitted: true,
                  visible_to_user: false,
                  feedback_buffered: true,
                  answer_md: '甲',
                },
              },
            },
            detail.sections[0].slots[1],
          ],
        },
      ],
    });
    renderPaper(true);
    await screen.findByText('计时测试卷');
    now = 90;
    await userEvent.click(screen.getByRole('tab', { name: '2' }));
    now = 190;
    await userEvent.click(screen.getByRole('button', { name: '交卷 · 统一判分' }));
    await waitFor(() => expect(mocks.submitPaperSlot).toHaveBeenCalledTimes(1));
    expect(mocks.submitPaperSlot.mock.calls[0][1]).toMatchObject({
      question_id: 'question_2',
      latency_ms: 100,
    });
    expect(storedSlots()['question_1::']).toBeUndefined();
  });
});
