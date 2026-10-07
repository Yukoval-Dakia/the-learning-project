import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiOperationJson } from '@/ui/lib/api';
import { type MistakeProjection, listMistakes } from '../ui-public';

vi.mock('@/ui/lib/api', () => ({ apiOperationJson: vi.fn() }));

const row: MistakeProjection = {
  id: 'attempt_original',
  record_id: 'record_original',
  question_id: 'question_part',
  prompt_md: '共享材料：讨论语法关系。\n\n解释「之」。',
  prompt_materials: [],
  reference_md: null,
  wrong_answer_md: '原答：代词。\n补充推导与上下文。'.repeat(8),
  wrong_answer_image_refs: ['answer_page_1', 'answer_page_2'],
  knowledge_ids: ['kc_syntax', 'kc_context'],
  cause: {
    source: 'user',
    primary_category: 'concept',
    primary_label: null,
    secondary_categories: ['misc_context'],
    secondary_labels: { misc_context: '未结合上下文' },
    user_notes: '原人工归因',
    confidence: null,
  },
  correction_state: {
    original_event_id: 'attempt_original',
    state: 'active',
    terminal_state: 'active',
    effective_event_id: 'attempt_original',
    correction_event_id: null,
    replacement_event_id: null,
    chain: [
      {
        event_id: 'attempt_original',
        state: 'active',
        correction_event_id: null,
        replacement_event_id: null,
      },
    ],
  },
  created_at: 1_700_000_000,
};

beforeEach(() => vi.resetAllMocks());

describe('browser mistakes reader', () => {
  it('preserves the server contract and encodes a custom subject without importing the server reader', async () => {
    const response = {
      data: [row],
      rows: [row],
      page: { limit: 200, next_cursor: 'next' },
      next_cursor: 'next',
    };
    vi.mocked(apiOperationJson).mockResolvedValue(response);
    const result = await listMistakes({ limit: 200, subject: '自定义 & 物理' });
    expect(result).toEqual(response);
    const [operationId, { url, method }] = vi.mocked(apiOperationJson).mock.calls[0];
    expect(operationId).toBe('listMistakes');
    expect(method).toBe('GET');
    const query = new URL(url, 'http://localhost').searchParams;
    expect(query.get('limit')).toBe('200');
    expect(query.get('subject')).toBe('自定义 & 物理');
  });

  it('leaves the subject absent for the existing all-subject view', async () => {
    vi.mocked(apiOperationJson).mockResolvedValue({
      data: [],
      rows: [],
      page: { limit: 200, next_cursor: null },
      next_cursor: null,
    });
    await listMistakes({ limit: 200 });
    expect(apiOperationJson).toHaveBeenCalledWith('listMistakes', {
      url: '/api/mistakes?limit=200',
      method: 'GET',
    });
  });

  it('rejects a malformed attachment array instead of accepting a handwritten wire type', async () => {
    const malformed = { ...row, wrong_answer_image_refs: ['answer_page_1', 42] };
    vi.mocked(apiOperationJson).mockResolvedValue({
      data: [malformed],
      rows: [malformed],
      page: { limit: 200, next_cursor: null },
      next_cursor: null,
    });
    await expect(listMistakes({ limit: 200 })).rejects.toThrow();
  });

  it('preserves text-only rendering for older responses with no attachment field', async () => {
    const { wrong_answer_image_refs: _attachments, ...legacy } = row;
    vi.mocked(apiOperationJson).mockResolvedValue({
      data: [legacy],
      rows: [legacy],
      page: { limit: 200, next_cursor: null },
      next_cursor: null,
    });
    const result = await listMistakes({ limit: 200 });
    expect(result.rows[0].wrong_answer_image_refs).toEqual([]);
    expect(result.rows[0].wrong_answer_md).toBe(row.wrong_answer_md);
  });

  it('propagates transport errors to the existing page error state', async () => {
    const failure = new Error('读取失败');
    vi.mocked(apiOperationJson).mockRejectedValue(failure);
    await expect(listMistakes({ limit: 200 })).rejects.toBe(failure);
  });
});
