// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MistakeListResponse, MistakeProjection } from '@/capabilities/ingestion/ui-public';
import MistakesPage from './MistakesPage';

const legacyList = vi.hoisted(() => vi.fn());
vi.mock('@/capabilities/ingestion/ui-public', () => ({ listMistakes: legacyList }));
vi.mock('@/capabilities/knowledge/ui-public', () => ({
  getTree: async () => ({
    rows: [
      { id: 'math-k', name: '椭圆离心率', effective_domain: 'math', domain: 'math' },
      { id: 'language-k', name: '主谓取消独立性', effective_domain: 'yuwen', domain: 'wenyan' },
    ],
  }),
}));
vi.mock('@/ui/hooks/useSubjects', () => ({
  useSubjects: () => ({
    subjects: [
      { id: 'math', displayName: '数学', aliases: [] },
      { id: 'yuwen', displayName: '语文', aliases: ['wenyan'] },
    ],
  }),
}));
vi.mock('@/ui/lib/assets', () => ({ peekAssetObject: () => null, fetchAssetObject: vi.fn() }));

function row(id: string, knowledge: string, cause: MistakeProjection['cause']): MistakeProjection {
  return {
    id,
    record_id: `record-${id}`,
    question_id: `question-${id}`,
    prompt_md: `历史题面 ${id}`,
    reference_md: '冻结参考答案',
    wrong_answer_md: '保留原答及帮助程度',
    wrong_answer_image_refs: [],
    knowledge_ids: [knowledge],
    cause,
    correction_state: {
      original_event_id: id,
      state: 'active',
      terminal_state: 'active',
      effective_event_id: id,
      correction_event_id: null,
      replacement_event_id: null,
      chain: [
        { event_id: id, state: 'active', correction_event_id: null, replacement_event_id: null },
      ],
    },
    created_at: Math.floor(Date.now() / 1000),
  };
}
const userCause: NonNullable<MistakeProjection['cause']> = {
  source: 'user',
  primary_category: 'concept',
  primary_label: null,
  secondary_categories: ['vocab'],
  secondary_labels: {},
  user_notes: '自己区分了瞬时理解与独立迁移',
  confidence: null,
};
function response(rows: MistakeProjection[]): MistakeListResponse {
  return { rows, data: rows, page: { limit: 200, next_cursor: null }, next_cursor: null };
}
function mount(list: NonNullable<Parameters<typeof MistakesPage>[0]['list']>, navigate = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MistakesPage navigate={navigate} list={list} />
    </QueryClientProvider>,
  );
  return { client, navigate };
}
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('existing page with Start list injection', () => {
  it('uses only the injected reader, retains subject filtering, reset and deep links', async () => {
    const rows = [row('native', 'math-k', null), row('legacy', 'language-k', userCause)];
    const list = vi.fn(async (input: { limit: number; subject?: string }) =>
      response(input.subject === 'math' ? rows.slice(0, 1) : rows),
    );
    const { navigate, client } = mount(list);
    try {
      await screen.findByText('历史题面 native');
      await screen.findByText('历史题面 legacy');
      expect(list).toHaveBeenCalledWith({ limit: 200, subject: undefined });
      expect(legacyList).not.toHaveBeenCalled();
      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: '数学' }));
      await waitFor(() => expect(list).toHaveBeenCalledWith({ limit: 200, subject: 'math' }));
      await waitFor(() => expect(screen.queryByText('历史题面 legacy')).toBeNull());
      await user.click(screen.getByRole('button', { name: '清除筛选' }));
      await screen.findByText('历史题面 legacy');
      await user.click(screen.getByRole('button', { name: '录新错题' }));
      expect(navigate).toHaveBeenLastCalledWith('/record');
      await user.click(screen.getByRole('button', { name: '重练薄弱点' }));
      expect(navigate).toHaveBeenLastCalledWith('/practice');
      await user.click(screen.getByRole('button', { name: '椭圆离心率' }));
      expect(navigate).toHaveBeenLastCalledWith('/knowledge/math-k');
      await user.click(screen.getAllByRole('button', { name: /查看事件链/ })[0]);
      expect(navigate).toHaveBeenLastCalledWith('/events/native');
    } finally {
      client.clear();
    }
  });

  it('retains visible errors and retries the same reader before the empty state', async () => {
    const list = vi
      .fn()
      .mockRejectedValueOnce(new Error('epoch unavailable'))
      .mockResolvedValueOnce(response([]));
    const { client } = mount(list);
    try {
      await screen.findByText('错题加载失败。');
      expect(screen.queryByText('还没有错题')).toBeNull();
      await userEvent.setup().click(screen.getByRole('button', { name: /重试/ }));
      await screen.findByText('还没有错题');
      expect(list).toHaveBeenCalledTimes(2);
      expect(legacyList).not.toHaveBeenCalled();
    } finally {
      client.clear();
    }
  });
});
