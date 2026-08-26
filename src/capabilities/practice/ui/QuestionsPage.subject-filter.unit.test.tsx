// @vitest-environment jsdom
//
// YUK-915 — 题库页科目筛选迁移到共享 SubjectFilterTabs（YUK-289）后的行为锚：
// 科目筛选以共享组件渲染（fieldset/legend 分组 + chip 按钮），且选中语义不变
// （'all' → 不带 subject 查询；具体科目 → server-side subject 过滤后整页换数据）。

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getQuestionsList: vi.fn() }));

vi.mock('./practice-api', async (importOriginal) => {
  const original = await importOriginal<typeof import('./practice-api')>();
  return { ...original, getQuestionsList: (...args: unknown[]) => mocks.getQuestionsList(...args) };
});

vi.mock('@/ui/hooks/useSubjects', () => ({
  useSubjects: () => ({
    subjects: [
      { id: 'yuwen', displayName: '语文', aliases: [], configurationStatus: 'configured' },
      { id: 'math', displayName: '数学', aliases: [], configurationStatus: 'configured' },
    ],
    isLoading: false,
    isError: false,
  }),
}));

import type { QBankListResult, QBankQuestion } from './practice-api';

import QuestionsPage from './QuestionsPage';

function makeQuestion(id: string, prompt: string, subject: string): QBankQuestion {
  return {
    id,
    kind: 'choice',
    prompt_md: prompt,
    source: 'manual',
    source_tier: { tier: 1, name: '人工' },
    difficulty: 2,
    visual_complexity: null,
    knowledge_ids: [],
    root_question_id: null,
    variant_depth: 0,
    parent_question_id: null,
    part_index: null,
    draft_status: null,
    created_at_sec: 1_784_000_000,
    subject,
    notation: null,
    knowledge_labels: [],
    is_composite: false,
    children: [],
  };
}

function listResult(items: QBankQuestion[]): QBankListResult {
  return {
    items,
    families: null,
    total: items.length,
    truncated: false,
    page: { limit: 20, offset: 0, has_more: false },
    computed_at_sec: 1_784_000_000,
  };
}

const YUWEN_ITEM = makeQuestion('q-yuwen', '语文题题面', 'yuwen');
const MATH_ITEM = makeQuestion('q-math', '数学题题面', 'math');

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <QuestionsPage navigate={vi.fn()} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('QuestionsPage subject filter via shared SubjectFilterTabs (YUK-915)', () => {
  it('renders the subject filter as the shared fieldset group with chips', async () => {
    mocks.getQuestionsList.mockResolvedValue(listResult([YUWEN_ITEM]));
    renderPage();

    // 共享组件语义：fieldset(role=group) + legend「科目」命名 + chip 按钮。
    const group = await screen.findByRole('group', { name: '科目' });
    expect(within(group).getByRole('button', { name: '全部' })).toBeTruthy();
    expect(within(group).getByRole('button', { name: '语文' })).toBeTruthy();
    expect(within(group).getByRole('button', { name: '数学' })).toBeTruthy();

    // 初始选中态：全部 is-on（aria-pressed），具体科目未选。
    expect(within(group).getByRole('button', { name: '全部' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(within(group).getByRole('button', { name: '数学' }).getAttribute('aria-pressed')).toBe(
      'false',
    );
  });

  it('keeps server-side subject filtering semantics when tabs change', async () => {
    mocks.getQuestionsList.mockImplementation(async (params: { subject?: string } | undefined) =>
      listResult([params?.subject === 'math' ? MATH_ITEM : YUWEN_ITEM]),
    );
    renderPage();

    expect(await screen.findByText('语文题题面')).toBeTruthy();
    expect(mocks.getQuestionsList).toHaveBeenLastCalledWith(
      expect.objectContaining({ subject: undefined }),
    );

    await userEvent.click(screen.getByRole('button', { name: '数学' }));
    await waitFor(() =>
      expect(mocks.getQuestionsList).toHaveBeenLastCalledWith(
        expect.objectContaining({ subject: 'math' }),
      ),
    );
    expect(await screen.findByText('数学题题面')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: '全部' }));
    await waitFor(() =>
      expect(mocks.getQuestionsList).toHaveBeenLastCalledWith(
        expect.objectContaining({ subject: undefined }),
      ),
    );
    expect(await screen.findByText('语文题题面')).toBeTruthy();
  });
});
