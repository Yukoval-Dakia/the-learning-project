// @vitest-environment jsdom
//
// YUK-715 — render-count probe for QuestionsPage's memoized QRow. A search
// keystroke re-renders the whole page (setQuery) but leaves every already-loaded
// row's props referentially stable, so no memoized QRow — and therefore no
// MathMarkdown stem parse — should re-run until the debounced refetch actually
// swaps the data. We mock the (heavy) MathMarkdown renderer to count how often
// each row's stem is parsed and assert a keystroke adds zero parses.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted so the vi.mock factory (itself hoisted above imports) can push into it.
const { mathMarkdownRenders } = vi.hoisted(() => ({ mathMarkdownRenders: [] as string[] }));

// Stand in for the real (KaTeX + react-markdown) renderer and record every call.
// One call == one QRow stem render; a memoized row that skips re-rendering never
// re-invokes it.
vi.mock('@/ui/lib/math-markdown', () => ({
  MathMarkdown: ({ children }: { children: string }) => {
    mathMarkdownRenders.push(children);
    return <span data-testid="math-md">{children}</span>;
  },
}));

// Stable subjects reference — a fresh [] per call would itself break QRow.memo,
// which would mask the thing under test.
const STABLE_SUBJECTS: never[] = [];
vi.mock('@/ui/hooks/useSubjects', () => ({
  useSubjects: () => ({ subjects: STABLE_SUBJECTS, isLoading: false, isError: false }),
}));

import { type QBankListResult, type QBankQuestion, getQuestionsList } from './practice-api';

vi.mock('./practice-api', async (importOriginal) => {
  const original = await importOriginal<typeof import('./practice-api')>();
  return { ...original, getQuestionsList: vi.fn() };
});

import QuestionsPage from './QuestionsPage';

const getListMock = vi.mocked(getQuestionsList);

function makeQuestion(id: string, prompt: string): QBankQuestion {
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
    subject: 'yuwen',
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

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <QuestionsPage navigate={vi.fn()} />
    </QueryClientProvider>,
  );
}

describe('QuestionsPage QRow memoization (YUK-715)', () => {
  beforeEach(() => {
    mathMarkdownRenders.length = 0;
    getListMock.mockReset();
  });
  afterEach(cleanup);

  it('does not re-parse already-loaded rows on a search keystroke', async () => {
    getListMock.mockResolvedValue(
      listResult([makeQuestion('q1', '第一题题面'), makeQuestion('q2', '第二题题面')]),
    );
    renderPage();

    await waitFor(() => expect(screen.getByText('第一题题面')).toBeDefined());
    expect(screen.getByText('第二题题面')).toBeDefined();

    // Each stem parsed exactly once after load (no wasteful re-parse from the
    // page's own post-load effects).
    expect(mathMarkdownRenders.filter((t) => t === '第一题题面').length).toBe(1);
    expect(mathMarkdownRenders.filter((t) => t === '第二题题面').length).toBe(1);
    const afterLoad = mathMarkdownRenders.length;

    // Typing updates `query` state (re-render) but not `debouncedQuery` yet, so
    // the row data is unchanged and every QRow's props stay reference-equal.
    await userEvent.type(screen.getByLabelText('搜索题目'), '题');

    expect(mathMarkdownRenders.length).toBe(afterLoad);
    expect(mathMarkdownRenders.filter((t) => t === '第一题题面').length).toBe(1);
    expect(mathMarkdownRenders.filter((t) => t === '第二题题面').length).toBe(1);
  });
});
