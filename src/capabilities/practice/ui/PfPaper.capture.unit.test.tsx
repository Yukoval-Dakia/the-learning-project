// @vitest-environment jsdom
// YUK-784 — PfPaper（组卷面）过程框采集的交互级单测（镜像 PfSolo 采集先例：判据复用
// shouldOfferProcessBox，装配复用 buildCaptureFields，本文件只钉 PfPaper 专属的挂载 /
// per-slot 持久 / 交卷 wire 行为）。
//
// 信心自评（self_confidence）不在本文件：卷路径落 AttemptOnQuestion 事件，而该 payload
// 没有 self_confidence 槽位（只在 ReviewOnQuestion 上）——补槽位是事件 schema 变更，
// YUK-784 非目标（「不改后端契约」），见 PR 描述与 Linear follow-up。

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REASONING_TRACE_MAX_LEN } from '@/kernel/limits';
import { PfPaper } from './PfPaper';

const mocks = vi.hoisted(() => ({
  endPaperSession: vi.fn(),
  getPaperDetail: vi.fn(),
  pausePaperSession: vi.fn(),
  savePaperAnswer: vi.fn(),
  startPaperSession: vi.fn(),
  submitPaperSlot: vi.fn(),
}));

// 与 autosave 测试同款：只 mock 网络函数，纯 helper（buildPaperSubmissionBody 等）保持真实。
vi.mock('./practice-api', async () => {
  const actual = await vi.importActual<typeof import('./practice-api')>('./practice-api');
  return { ...actual, ...mocks };
});

function textSlot(id: string, prompt: string) {
  return {
    question_id: id,
    part_ref: null,
    section_index: 0,
    question: { id, kind: 'short', prompt_md: prompt, choices_md: [], difficulty: 1 },
    slot_state: { draft: { content_md: '' }, submission: null },
  };
}

function choiceSlot(id: string, prompt: string) {
  return {
    question_id: id,
    part_ref: null,
    section_index: 0,
    question: {
      id,
      kind: 'choice',
      prompt_md: prompt,
      choices_md: ['选项甲', '选项乙'],
      difficulty: 1,
    },
    slot_state: { draft: { content_md: '' }, submission: null },
  };
}

function paperDetail(slots: object[]) {
  return {
    artifact_id: 'paper_1',
    title: '过程框测试卷',
    generation_status: 'ready',
    intent_source: 'test',
    session: { id: 'review_1', status: 'started', pos: 0, right: 0, wrong: 0 },
    sections: [{ section_index: 0, knowledge_focus_names: [], slots }],
  };
}

function renderPaper(detail?: object) {
  mocks.getPaperDetail.mockResolvedValue(detail ?? paperDetail([textSlot('question_1', '第一题')]));
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <PfPaper artifactId="paper_1" onExit={vi.fn()} onSubmitted={vi.fn()} addToast={vi.fn()} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // autosave 防抖加速（与 autosave 测试同款），避免 800ms 真等待。
  const realSetTimeout = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) =>
    realSetTimeout(callback, delay === 800 ? 10 : delay, ...args),
  );
  mocks.pausePaperSession.mockResolvedValue({ ok: true });
  mocks.savePaperAnswer.mockResolvedValue({ ok: true });
  mocks.submitPaperSlot.mockResolvedValue({
    attempt_event_id: 'ev_1',
    judge_event_id: 'ev_1',
    answer_id: 'ans_1',
    visible_to_user: false,
    feedback_buffered: true,
  });
  mocks.endPaperSession.mockResolvedValue({ ok: true });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('PfPaper 过程框 — 挂载判据与零强制形态 (YUK-784)', () => {
  it('开放/文本作答题显示折叠的过程框入口（复用 shouldOfferProcessBox 判据）', async () => {
    renderPaper();
    await screen.findByText('第一题');
    expect(screen.getByRole('button', { name: '＋ 记下你的思路（可选）' })).toBeTruthy();
  });

  it('客观（选择）题隐藏过程框（判据同 PfSolo：作答面形态 isChoice）', async () => {
    renderPaper(paperDetail([choiceSlot('question_1', '选择题')]));
    await screen.findByText('选择题');
    expect(screen.queryByRole('button', { name: '＋ 记下你的思路（可选）' })).toBeNull();
  });

  it('展开后是 maxLength 封顶的可选 textarea（placeholder / aria-label 与 PfSolo 逐字一致）', async () => {
    const user = userEvent.setup();
    renderPaper();
    await screen.findByText('第一题');
    await user.click(screen.getByRole('button', { name: '＋ 记下你的思路（可选）' }));
    const box = screen.getByRole('textbox', { name: '解题思路（可选）' });
    expect((box as HTMLTextAreaElement).maxLength).toBe(REASONING_TRACE_MAX_LEN);
    expect(box.getAttribute('placeholder')).toBe('随手记下你是怎么想的——不评分，也可以留空。');
  });

  it('已提交的 slot 不再显示过程框（作答面已冻结，无处可挂）', async () => {
    renderPaper(
      paperDetail([
        {
          ...textSlot('question_1', '已交题'),
          slot_state: {
            draft: null,
            submission: {
              submitted: true,
              visible_to_user: false,
              feedback_buffered: true,
              answer_md: '旧答案',
            },
          },
        },
      ]),
    );
    await screen.findByText('已交题');
    expect(screen.queryByRole('button', { name: '＋ 记下你的思路（可选）' })).toBeNull();
  });

  it('过程文本 per-slot 持久：换题再回来不丢（组卷面多题连续作答的节奏约束）', async () => {
    const user = userEvent.setup();
    renderPaper(paperDetail([textSlot('question_1', '第一题'), textSlot('question_2', '第二题')]));
    await screen.findByText('第一题');
    await user.click(screen.getByRole('button', { name: '＋ 记下你的思路（可选）' }));
    await user.type(screen.getByRole('textbox', { name: '解题思路（可选）' }), '先列方程');
    await user.click(screen.getByRole('tab', { name: '2' }));
    await screen.findByText('第二题');
    await user.click(screen.getByRole('tab', { name: '1' }));
    await screen.findByText('第一题');
    expect(
      (screen.getByRole('textbox', { name: '解题思路（可选）' }) as HTMLTextAreaElement).value,
    ).toBe('先列方程');
  });
});

describe('PfPaper 交卷 wire — 空值不发字段（byte-identical 缺省）(YUK-784)', () => {
  it('填了过程文本 → 该 slot 的 submitPaperSlot 输入带 reasoning_trace；没填的 slot 不带键', async () => {
    const user = userEvent.setup();
    renderPaper(paperDetail([textSlot('question_1', '第一题'), textSlot('question_2', '第二题')]));
    await screen.findByText('第一题');
    await user.type(screen.getByLabelText('作答'), '答案一');
    await user.click(screen.getByRole('button', { name: '＋ 记下你的思路（可选）' }));
    await user.type(screen.getByRole('textbox', { name: '解题思路（可选）' }), '先列方程再消元');
    await user.click(screen.getByRole('tab', { name: '2' }));
    await screen.findByText('第二题');
    await user.type(screen.getByLabelText('作答'), '答案二');
    await user.click(screen.getByRole('button', { name: '交卷 · 统一判分' }));

    await waitFor(() => expect(mocks.submitPaperSlot).toHaveBeenCalledTimes(2));
    const first = mocks.submitPaperSlot.mock.calls.find(
      (c) => c[1].question_id === 'question_1',
    )?.[1];
    const second = mocks.submitPaperSlot.mock.calls.find(
      (c) => c[1].question_id === 'question_2',
    )?.[1];
    expect(first).toMatchObject({ reasoning_trace: '先列方程再消元' });
    // 没填的 slot 不带键（缺省 absent，不是空串）。
    expect(Object.hasOwn(second ?? {}, 'reasoning_trace')).toBe(false);
  });

  it('只敲了空白 → 交卷输入无 reasoning_trace 键（trim 判空，挡空白噪声）', async () => {
    const user = userEvent.setup();
    renderPaper();
    await screen.findByText('第一题');
    await user.type(screen.getByLabelText('作答'), '答案');
    await user.click(screen.getByRole('button', { name: '＋ 记下你的思路（可选）' }));
    await user.type(screen.getByRole('textbox', { name: '解题思路（可选）' }), '   ');
    await user.click(screen.getByRole('button', { name: '交卷 · 统一判分' }));

    await waitFor(() => expect(mocks.submitPaperSlot).toHaveBeenCalledTimes(1));
    const input = mocks.submitPaperSlot.mock.calls[0][1];
    expect(Object.hasOwn(input, 'reasoning_trace')).toBe(false);
  });

  it('过程框不挡交卷：折叠未展开时交卷流照常走完（零强制红线）', async () => {
    const user = userEvent.setup();
    mocks.getPaperDetail.mockResolvedValue(paperDetail([textSlot('question_1', '第一题')]));
    const onSubmitted = vi.fn();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <PfPaper
          artifactId="paper_1"
          onExit={vi.fn()}
          onSubmitted={onSubmitted}
          addToast={vi.fn()}
        />
      </QueryClientProvider>,
    );
    await screen.findByText('第一题');
    await user.type(screen.getByLabelText('作答'), '答案');
    await user.click(screen.getByRole('button', { name: '交卷 · 统一判分' }));
    await waitFor(() => expect(onSubmitted).toHaveBeenCalled());
  });
});

describe('buildPaperSubmissionBody — reasoning_trace wire 装配 (YUK-784)', () => {
  it('未带过程文本 → body 无 reasoning_trace 键（既有提交逐字不变）', async () => {
    const { buildPaperSubmissionBody } = await import('./practice-api');
    const body = buildPaperSubmissionBody('paper_1', {
      session_id: 'review_1',
      question_id: 'q1',
      part_ref: null,
      answer_md: '答',
    });
    expect(Object.hasOwn(body, 'reasoning_trace')).toBe(false);
  });

  it('带了过程文本 → body 原样带出（截断责任在 buildCaptureFields，装配处不重复）', async () => {
    const { buildPaperSubmissionBody } = await import('./practice-api');
    const body = buildPaperSubmissionBody('paper_1', {
      session_id: 'review_1',
      question_id: 'q1',
      part_ref: null,
      answer_md: '答',
      reasoning_trace: '先列方程',
    });
    expect(body.reasoning_trace).toBe('先列方程');
  });
});
