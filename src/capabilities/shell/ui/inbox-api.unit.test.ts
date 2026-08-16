import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiOperationJson } from '@/ui/lib/api';
import {
  DECISION_MAX_PAGES,
  type ProposalInboxRow,
  type ProposalPageWire,
  decideProposal,
  decisionPaginationDiagnostics,
  getNextDecisionPageParam,
  listDecisionProposalPage,
  listObservationProposalPreview,
  mergeProposalPages,
} from './inbox-api';

vi.mock('@/ui/lib/api', () => ({ apiOperationJson: vi.fn() }));

function proposal(id: string, kind = 'learning_item'): ProposalInboxRow {
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

function page(ids: string[], next: string | null): ProposalPageWire {
  return { rows: ids.map((id) => proposal(id)), next_cursor: next };
}

describe('proposal decision caller', () => {
  const apiOperationJsonMock = vi.mocked(apiOperationJson);

  beforeEach(() => apiOperationJsonMock.mockReset());

  it('sends only the corrected claim payload for an edited accept', async () => {
    apiOperationJsonMock.mockResolvedValueOnce({ result: { ok: true } } as never);

    await decideProposal('proposal/1', 'accept', { correctedClaimMd: '改写后的判断' });

    expect(apiOperationJsonMock).toHaveBeenCalledWith('createProposalDecision', {
      url: '/api/proposals/proposal%2F1/decisions',
      method: 'POST',
      body: {
        decision: 'accept',
        corrected_payload: { claim_md: '改写后的判断' },
      },
    });
  });
});

describe('progressive proposal page callers', () => {
  const apiOperationJsonMock = vi.mocked(apiOperationJson);

  beforeEach(() => {
    apiOperationJsonMock.mockReset();
  });

  it('fetches only the first decision page when no cursor is supplied', async () => {
    apiOperationJsonMock.mockResolvedValueOnce(page(['decision_1'], 'd2') as never);

    await expect(listDecisionProposalPage()).resolves.toEqual(page(['decision_1'], 'd2'));

    expect(apiOperationJsonMock).toHaveBeenCalledTimes(1);
    expect(apiOperationJsonMock).toHaveBeenCalledWith('listProposals', {
      url: '/api/proposals?lane=decision&limit=500&status=pending',
      method: 'GET',
    });
  });

  it('fetches exactly the requested continuation page', async () => {
    apiOperationJsonMock.mockResolvedValueOnce(page(['decision_2'], null) as never);

    await listDecisionProposalPage('d2');

    expect(apiOperationJsonMock).toHaveBeenCalledTimes(1);
    expect(apiOperationJsonMock).toHaveBeenCalledWith('listProposals', {
      url: '/api/proposals?lane=decision&limit=500&status=pending&cursor=d2',
      method: 'GET',
    });
  });

  it('keeps the bounded observation preview on an independent request', async () => {
    apiOperationJsonMock.mockResolvedValueOnce(page(['observe_1'], 'o2') as never);

    await listObservationProposalPreview();

    expect(apiOperationJsonMock).toHaveBeenCalledTimes(1);
    expect(apiOperationJsonMock).toHaveBeenCalledWith('listProposals', {
      url: '/api/proposals?lane=observation&limit=200&status=pending',
      method: 'GET',
    });
  });
});

describe('progressive proposal page state', () => {
  it('merges incremental pages in first-seen order and deduplicates overlapping rows', () => {
    const first = page(['decision_1', 'decision_2'], 'd2');
    const second = page(['decision_2', 'decision_3'], null);
    second.rows[0] = {
      ...second.rows[0],
      payload: { ...second.rows[0].payload, reason_md: 'later duplicate' },
    };

    const merged = mergeProposalPages([first, second]);

    expect(merged.map((row) => row.id)).toEqual(['decision_1', 'decision_2', 'decision_3']);
    expect(merged[1].payload.reason_md).toBe('decision_2');
  });

  it('continues normally, then stops when the server reports no next cursor', () => {
    expect(getNextDecisionPageParam(page(['d1'], 'd2'), [page(['d1'], 'd2')], null, [null])).toBe(
      'd2',
    );
    expect(
      getNextDecisionPageParam(page(['d2'], null), [page(['d2'], null)], 'd2', [null, 'd2']),
    ).toBeUndefined();
  });

  it('stops and diagnoses a repeated cursor instead of looping', () => {
    const pages = [page(['decision_1'], 'd2'), page(['decision_2'], 'd2')];
    const params = [null, 'd2'];

    expect(getNextDecisionPageParam(pages[1], pages, 'd2', params)).toBeUndefined();
    expect(decisionPaginationDiagnostics(pages, params)).toEqual({
      cursorRepeated: true,
      pageLimitReached: false,
      incomplete: true,
    });
  });

  it('stops at the safety cap and keeps the loaded subset explicitly incomplete', () => {
    const pages = Array.from({ length: DECISION_MAX_PAGES }, (_, index) =>
      page([`decision_${index + 1}`], `d${index + 2}`),
    );
    const params = [
      null,
      ...Array.from({ length: DECISION_MAX_PAGES - 1 }, (_, index) => `d${index + 2}`),
    ];

    expect(
      getNextDecisionPageParam(
        pages[DECISION_MAX_PAGES - 1],
        pages,
        params[DECISION_MAX_PAGES - 1],
        params,
      ),
    ).toBeUndefined();
    expect(decisionPaginationDiagnostics(pages, params)).toEqual({
      cursorRepeated: false,
      pageLimitReached: true,
      incomplete: true,
    });
  });
});
