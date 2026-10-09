// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiAuthError, ApiError, TOKEN_STORAGE_KEY, subscribeAuthInvalidation } from '@/ui/lib/api';
import { startWorkbenchClient } from './workbench-client';

const rpc = vi.hoisted(() => ({
  getStartWorkbenchSummary: vi.fn(),
  getStartOvernightDigest: vi.fn(),
  getStartTodayCost: vi.fn(),
  getStartProposalInbox: vi.fn(),
  getStartAutoApplied: vi.fn(),
  getStartKnowledgeTree: vi.fn(),
  getStartConjectures: vi.fn(),
  getStartRecentAiChanges: vi.fn(),
  decideStartProposal: vi.fn(),
  undoStartArtifactAiChange: vi.fn(),
}));
vi.mock('./workbench-function', () => rpc);
const nextCursor = 'opaque-equal-time:proposal-b';
const rows = [
  {
    id: 'proposal-a',
    kind: 'knowledge_edge',
    status: 'pending',
    target: { subject_kind: 'knowledge_edge', subject_id: null },
    payload: {
      kind: 'knowledge_edge',
      target: { subject_kind: 'knowledge_edge', subject_id: null },
      reason_md: '多层证据与歧义\n'.repeat(100),
      evidence_refs: [{ kind: 'event', id: 'historical', event_role: 'user_cause' }],
      proposed_change: {
        edge_op: 'create',
        from_knowledge_id: 'kc-a',
        to_knowledge_id: 'kc-b',
        relation_type: 'related_to',
        weight: 0.5,
      },
      rollback_plan: { nested: ['original', { retain: true }] },
    },
    proposed_at: '2026-10-07T16:00:00.000Z',
    decided_at: null,
    actor_ref: 'agent:research',
    task_run_id: null,
    cost_micro_usd: null,
    source_action: 'experimental:proposal',
    source_subject_kind: 'knowledge_edge',
    signals: { ambiguity: { candidates: ['one', 'two'] } },
    presentation: null,
  },
];
const page = {
  rows,
  data: rows,
  page: { limit: 500, next_cursor: nextCursor },
  next_cursor: nextCursor,
};
const resource = {
  proposal_id: 'p',
  proposal_kind: 'conjecture',
  decision: 'accept',
  decision_event_id: 'decision-e',
  proposal_status: 'accepted',
  created: true,
  idempotent: false,
  result: { nested: { original: '保留原始结果'.repeat(60) } },
};

beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem(TOKEN_STORAGE_KEY, 'fixture-token');
  vi.stubGlobal('fetch', vi.fn());
  for (const [name, call] of Object.entries(rpc))
    call.mockImplementation(async (options) => {
      const response = await options.fetch(new URL(`http://isolated.test/_serverFn/${name}`), {
        method: name.startsWith('get') ? 'GET' : 'POST',
        headers: { 'x-tsr-serverFn': 'true' },
      });
      return response.json();
    });
});
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe('Start workbench browser adapters', () => {
  it.each([
    ['getWorkbenchSummary', 'getStartWorkbenchSummary'],
    ['getOvernightDigest', 'getStartOvernightDigest'],
    ['getTodayCost', 'getStartTodayCost'],
    ['listAutoApplied', 'getStartAutoApplied'],
    ['getTree', 'getStartKnowledgeTree'],
    ['getPrepDeskConjectures', 'getStartConjectures'],
    ['getRecentAiChanges', 'getStartRecentAiChanges'],
  ] as const)(
    'routes %s through its live RPC with retained authority',
    async (method, functionName) => {
      vi.mocked(fetch).mockResolvedValueOnce(Response.json({ nested: { preserved: true } }));
      expect(await startWorkbenchClient[method]()).toEqual({ nested: { preserved: true } });
      expect(rpc[functionName]).toHaveBeenCalledOnce();
      const [url, init] = vi.mocked(fetch).mock.calls[0];
      expect(String(url)).toContain(`/_serverFn/${functionName}`);
      expect(new Headers(init?.headers).get('x-internal-token')).toBe('fixture-token');
      expect(new Headers(init?.headers).get('x-tsr-serverFn')).toBe('true');
    },
  );
  it('retains decision and observation bounds/cursors and full JSON projection fields', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(Response.json(JSON.stringify(page)))
      .mockResolvedValueOnce(Response.json(JSON.stringify(page)));
    expect(await startWorkbenchClient.listDecisionProposalPage(nextCursor)).toEqual(page);
    expect(rpc.getStartProposalInbox.mock.calls[0][0].data).toEqual({
      lane: 'decision',
      status: 'pending',
      limit: '500',
      cursor: nextCursor,
    });
    await startWorkbenchClient.listObservationProposalPreview();
    expect(rpc.getStartProposalInbox.mock.calls[1][0].data).toEqual({
      lane: 'observation',
      status: 'pending',
      limit: '200',
    });
  });
  it('uses the shared corrected-decision mapping including an empty edit, and returns the original result', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(Response.json(JSON.stringify(resource)))
      .mockResolvedValueOnce(Response.json(JSON.stringify(resource)));
    expect(
      await startWorkbenchClient.decideProposal('p', 'accept', {
        userNote: '审阅\n'.repeat(60),
        correctedClaimMd: 'owner claim',
      }),
    ).toEqual(resource.result);
    expect(rpc.decideStartProposal.mock.calls[0][0].data).toEqual({
      id: 'p',
      input: {
        decision: 'accept',
        user_note: '审阅\n'.repeat(60),
        corrected_payload: { claim_md: 'owner claim' },
      },
    });
    await startWorkbenchClient.decideProposal('p', 'accept', { correctedClaimMd: '' });
    expect(rpc.decideStartProposal.mock.calls[1][0].data.input.corrected_payload).toEqual({
      claim_md: '',
    });
    expect(vi.mocked(fetch).mock.calls[0][1]?.method).toBe('POST');
  });
  it('uses the same decision function for retract instead of a second writer', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json(
        JSON.stringify({
          ...resource,
          decision: 'retract',
          proposal_status: 'stale',
          created: false,
          idempotent: true,
        }),
      ),
    );
    await startWorkbenchClient.retractProposal('p');
    expect(rpc.decideStartProposal.mock.calls[0][0].data).toEqual({
      id: 'p',
      input: { decision: 'retract' },
    });
  });
  it('rejects optimistic note undo conflicts while retaining already-undone success', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(Response.json({ status: 'skipped:version_conflict' }))
      .mockResolvedValueOnce(Response.json({ status: 'skipped:already_undone' }));
    await expect(startWorkbenchClient.undoAiChange('artifact-a', 'apply-e')).rejects.toMatchObject({
      status: 409,
      code: 'version_conflict',
    });
    expect(await startWorkbenchClient.undoAiChange('artifact-a', 'apply-e')).toEqual({
      status: 'skipped:already_undone',
    });
    expect(rpc.undoStartArtifactAiChange.mock.calls[0][0].data).toEqual({
      artifactId: 'artifact-a',
      eventId: 'apply-e',
    });
  });
  it('fails locally without a token', async () => {
    window.localStorage.clear();
    await expect(startWorkbenchClient.getWorkbenchSummary()).rejects.toBeInstanceOf(ApiAuthError);
    await expect(startWorkbenchClient.retractProposal('p')).rejects.toBeInstanceOf(ApiAuthError);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('re-gates the same shell on a 401 mutation response', async () => {
    const invalidated = vi.fn();
    const unsubscribe = subscribeAuthInvalidation(invalidated);
    try {
      vi.mocked(fetch).mockResolvedValueOnce(
        Response.json({ error: 'unauthorized' }, { status: 401 }),
      );
      await expect(startWorkbenchClient.retractProposal('p')).rejects.toBeInstanceOf(ApiAuthError);
      expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
      expect(invalidated).toHaveBeenCalledOnce();
    } finally {
      unsubscribe();
    }
  });
  it.each([
    [400, 'validation_error'],
    [404, 'not_found'],
    [409, 'conflict'],
    [503, 'contract_epoch_fenced'],
  ])('keeps status %s and code %s without clearing the token', async (status, code) => {
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json(
        { error: code, message: 'visible retry remains', reason: 'unavailable' },
        { status },
      ),
    );
    const error = await startWorkbenchClient.decideProposal('p', 'accept').catch((error) => error);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status,
      code,
      message: 'visible retry remains',
      details: { reason: 'unavailable' },
    });
    expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBe('fixture-token');
  });
});
