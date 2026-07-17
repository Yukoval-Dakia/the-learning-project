import { apiJson } from '@/ui/lib/api';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type ProposalInboxRow, listProposals } from './inbox-api';

vi.mock('@/ui/lib/api', () => ({ apiJson: vi.fn() }));

function proposal(id: string, kind: string): ProposalInboxRow {
  return {
    id,
    kind,
    target: { subject_kind: 'learning_item', subject_id: `${id}_item` },
    payload: { kind, reason_md: id, evidence_refs: [] },
    status: 'pending',
    proposed_at: '2026-07-17T00:00:00.000Z',
    decided_at: null,
    actor_ref: 'dreaming',
    task_run_id: null,
    cost_micro_usd: null,
    source_action: 'experimental:proposal',
    source_subject_kind: 'learning_item',
    signals: null,
  };
}

describe('listProposals', () => {
  const apiJsonMock = vi.mocked(apiJson);

  beforeEach(() => {
    apiJsonMock.mockReset();
  });

  it('loads every decision page independently from the bounded observation preview', async () => {
    apiJsonMock
      .mockResolvedValueOnce({ rows: [proposal('decision_1', 'learning_item')], next_cursor: 'd2' })
      .mockResolvedValueOnce({ rows: [proposal('observe_1', 'defer')], next_cursor: 'o2' })
      .mockResolvedValueOnce({
        rows: [proposal('decision_2', 'knowledge_edge')],
        next_cursor: null,
      });

    const page = await listProposals();

    expect(page.rows.map((row) => row.id)).toEqual(['decision_1', 'decision_2', 'observe_1']);
    expect(page.next_cursor).toBeNull();
    expect(page.observation_truncated).toBe(true);
    expect(apiJsonMock).toHaveBeenNthCalledWith(
      1,
      '/api/proposals?lane=decision&limit=500&status=pending',
    );
    expect(apiJsonMock).toHaveBeenNthCalledWith(
      2,
      '/api/proposals?lane=observation&limit=200&status=pending',
    );
    expect(apiJsonMock).toHaveBeenNthCalledWith(
      3,
      '/api/proposals?lane=decision&limit=500&status=pending&cursor=d2',
    );
  });

  it('fails visibly instead of looping forever on a repeated decision cursor', async () => {
    apiJsonMock
      .mockResolvedValueOnce({ rows: [proposal('decision_1', 'learning_item')], next_cursor: 'd2' })
      .mockResolvedValueOnce({ rows: [], next_cursor: null })
      .mockResolvedValueOnce({
        rows: [proposal('decision_2', 'knowledge_edge')],
        next_cursor: 'd2',
      });

    await expect(listProposals()).rejects.toThrow('提议分页游标重复');
  });

  it('fails visibly when a pathological decision backlog exceeds the page safety cap', async () => {
    apiJsonMock.mockImplementation(async (url) => {
      if (String(url).includes('lane=observation')) return { rows: [], next_cursor: null };
      const cursor = new URL(String(url), 'http://localhost').searchParams.get('cursor');
      const page = cursor ? Number(cursor.slice(1)) : 1;
      return {
        rows: [proposal(`decision_${page}`, 'learning_item')],
        next_cursor: `d${page + 1}`,
      };
    });

    await expect(listProposals()).rejects.toThrow('超过安全加载上限');
    expect(apiJsonMock).toHaveBeenCalledTimes(21); // 20 decision pages + observation preview
  });
});
