import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readProposalInbox } from '@/capabilities/shell/server/proposal-inbox-read';
import { ApiError } from '@/kernel/http';
import type { ProposalInboxRow } from '@/kernel/proposals/inbox';
import { buildHonoApp } from '../app';
import { runAuthenticatedStartWorkbench } from './workbench-read';
import {
  createStartProposalDecision,
  readStartAutoApplied,
  readStartConjectures,
  readStartKnowledgeTree,
  readStartOvernightDigest,
  readStartProposalInbox,
  readStartRecentAiChanges,
  readStartTodayCost,
  readStartWorkbenchSummary,
  undoStartAiChange,
} from './workbench-reader';

const seams = vi.hoisted(() => ({
  database: { connection: 'unit-only-no-database' },
  dbImport: vi.fn(),
  summary: vi.fn(),
  overnight: vi.fn(),
  cost: vi.fn(),
  list: vi.fn(),
  autoApplied: vi.fn(),
  tree: vi.fn(),
  conjectures: vi.fn(),
  changes: vi.fn(),
  undo: vi.fn(),
  decision: vi.fn(),
  wake: vi.fn(),
}));
vi.mock('@/db/client', () => {
  seams.dbImport();
  return { db: seams.database };
});
vi.mock('@/capabilities/shell/public', () => ({
  loadWorkbenchSummary: seams.summary,
  readProposalInbox,
  loadPrepDeskConjectures: seams.conjectures,
}));
vi.mock('@/kernel/proposals/inbox', () => ({ listProposalInboxPage: seams.list }));
vi.mock('@/server/today/overnight-digest', () => ({ loadTodayOvernightDigest: seams.overnight }));
vi.mock('@/capabilities/observability/public', () => ({ loadTodayCost: seams.cost }));
vi.mock('@/server/proposals/auto-applied-read', () => ({
  getAutoAppliedDigest: seams.autoApplied,
}));
vi.mock('@/capabilities/knowledge/public', () => ({ loadTreeSnapshot: seams.tree }));
vi.mock('@/capabilities/notes/public', () => ({
  listNoteRefineChanges: seams.changes,
  undoNoteRefineApplyEvent: seams.undo,
}));
vi.mock('@/server/proposals/decision-resource', () => ({ createProposalDecision: seams.decision }));
vi.mock('@/server/boss/hub-sync-wake', () => ({ wakeHubSyncAfterCommit: seams.wake }));

const request = (token?: string) =>
  new Request('http://isolated.test/_serverFn/workbench', {
    method: 'POST',
    headers: token ? { 'x-internal-token': token } : {},
    body: JSON.stringify({ token: 'unit-token', nested: { grant: true } }),
  });
const allowed = () => ({ api: buildHonoApp([], { epochGate: async () => ({ runnable: true }) }) });
const operations: readonly (() => Promise<unknown>)[] = [
  readStartWorkbenchSummary,
  readStartOvernightDigest,
  readStartTodayCost,
  readStartAutoApplied,
  readStartKnowledgeTree,
  readStartConjectures,
  readStartRecentAiChanges,
  () => readStartProposalInbox({ lane: 'decision' }),
  () => createStartProposalDecision({ id: 'p', input: { decision: 'dismiss' } }),
  () => undoStartAiChange({ artifactId: 'a', eventId: 'e' }),
];
const proposal: ProposalInboxRow = {
  id: 'proposal-same-time-b',
  kind: 'knowledge_edge',
  status: 'pending',
  target: { subject_kind: 'knowledge_edge', subject_id: null },
  payload: {
    kind: 'knowledge_edge',
    target: { subject_kind: 'knowledge_edge', subject_id: null },
    reason_md: '保留证据、歧义及长文本\n'.repeat(60),
    evidence_refs: [{ kind: 'event', id: 'failure-a', event_role: 'user_cause' }],
    proposed_change: {
      edge_op: 'create',
      from_knowledge_id: 'kc-a',
      to_knowledge_id: 'kc-b',
      relation_type: 'prerequisite',
      weight: 0.7,
    },
    rollback_plan: { nested: ['preserve', { historical: true }] },
  },
  proposed_at: new Date('2026-10-07T16:00:00Z'),
  decided_at: null,
  actor_ref: 'agent:research',
  task_run_id: 'run-a',
  cost_micro_usd: null,
  source_action: 'experimental:proposal',
  source_subject_kind: 'knowledge_edge',
  signals: {
    acceptance_rate: 0.5,
    dismiss_reason: '保留歧义',
    cooldown_until: new Date('2026-10-08T16:00:00Z'),
    accept_count: 2,
    dismiss_count: 1,
  },
  presentation: null,
};

beforeEach(() => {
  vi.stubEnv('INTERNAL_TOKEN', 'unit-token');
  vi.clearAllMocks();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('Start workbench authorization before every consumer', () => {
  it.each([undefined, '', 'wrong', 'unit-token-extra'])(
    'rejects header %s before readers or commands',
    async (token) => {
      const epochGate = vi.fn(async () => ({ runnable: true }));
      const context = { api: buildHonoApp([], { epochGate }) };
      for (const operation of operations) {
        const call = vi.fn(operation);
        const denied = await runAuthenticatedStartWorkbench(context, request(token), call).catch(
          (error) => error,
        );
        if (!(denied instanceof Response)) throw new Error('expected an HTTP denial');
        expect(denied.status).toBe(401);
        expect(call).not.toHaveBeenCalled();
      }
      expect(epochGate).not.toHaveBeenCalled();
      expect(seams.dbImport).not.toHaveBeenCalled();
      expect(seams.decision).not.toHaveBeenCalled();
      expect(seams.wake).not.toHaveBeenCalled();
    },
  );
  it('fences all authenticated consumers with the existing epoch error', async () => {
    const context = {
      api: buildHonoApp([], {
        epochGate: async () => ({ runnable: false, reason: 'unavailable' }),
      }),
    };
    for (const operation of operations) {
      const call = vi.fn(operation);
      const denied = await runAuthenticatedStartWorkbench(
        context,
        request('unit-token'),
        call,
      ).catch((error) => error);
      if (!(denied instanceof Response)) throw new Error('expected an HTTP denial');
      expect(denied.status).toBe(503);
      expect(await denied.json()).toMatchObject({
        error: 'contract_epoch_fenced',
        reason: 'unavailable',
      });
      expect(call).not.toHaveBeenCalled();
    }
    expect(seams.dbImport).not.toHaveBeenCalled();
  });
});

describe('canonical workbench projection adapters', () => {
  it.each([
    [readStartWorkbenchSummary, seams.summary],
    [readStartOvernightDigest, seams.overnight],
    [readStartTodayCost, seams.cost],
    [readStartAutoApplied, seams.autoApplied],
    [readStartConjectures, seams.conjectures],
  ])('returns the canonical projection without an HTTP request', async (read, projection) => {
    const result = { source: 'canonical', nested: { unknown: null, long: '原始证据'.repeat(50) } };
    projection.mockResolvedValueOnce(result);
    expect(
      await runAuthenticatedStartWorkbench<unknown>(allowed(), request('unit-token'), read),
    ).toBe(result);
    expect(projection).toHaveBeenCalledExactlyOnceWith(seams.database);
  });
  it('uses the existing recent-change window/limit and converts dates to the HTTP wire shape', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-08T01:02:03Z'));
    seams.changes.mockResolvedValueOnce([
      { event_id: 'e', created_at: new Date('2026-10-07T23:00:00Z'), undone: false },
    ]);
    const result = await readStartRecentAiChanges();
    expect(seams.changes).toHaveBeenCalledWith(seams.database, {
      since: new Date('2026-10-07T01:02:03Z'),
      limit: 25,
    });
    expect(result.rows[0]).toMatchObject({ created_at: '2026-10-07T23:00:00.000Z', undone: false });
  });
  it('retains learner-visibility filtering on the exported internal knowledge snapshot', async () => {
    seams.tree.mockResolvedValueOnce(
      ['synthetic:seed', 'kc-visible'].map((id) => ({
        id,
        archived_at: null,
        last_evidence_at: null,
        last_active_at: new Date('2026-10-07T00:00:00Z'),
      })),
    );
    expect((await readStartKnowledgeTree()).rows).toEqual([
      {
        id: 'kc-visible',
        archived_at: null,
        last_evidence_at: null,
        last_active_at: '2026-10-07T00:00:00.000Z',
      },
    ]);
  });
});

describe('shared HTTP/Start inbox query contract', () => {
  it.each([
    [{}, 200],
    [{ limit: '900' }, 500],
    [{ limit: '17tail' }, 17],
    [
      {
        limit: '500',
        status: 'pending',
        kind: 'knowledge_edge',
        lane: 'decision',
        cursor: 'opaque-equal-time-b',
      },
      500,
    ],
  ])('preserves query %j with bounded limit %s', async (query, limit) => {
    seams.list.mockResolvedValueOnce({ rows: [proposal], next_cursor: 'opaque-equal-time-c' });
    const value = await readStartProposalInbox(query);
    expect(seams.list).toHaveBeenCalledWith(seams.database, { ...query, limit });
    expect(value.rows[0].payload).toEqual(proposal.payload);
    expect(value.rows[0].proposed_at).toBe('2026-10-07T16:00:00.000Z');
    expect(value.data).toBe(value.rows);
    expect(value.page).toEqual({ limit, next_cursor: 'opaque-equal-time-c' });
    expect(value.next_cursor).toBe('opaque-equal-time-c');
  });
  it.each([
    { limit: '0' },
    { limit: '-1' },
    { limit: '' },
    { limit: 'NaN' },
    { status: '' },
    { status: 'anything' },
    { lane: 'all' },
    { kind: 'unknown' },
    { cursor: 17 },
    null,
  ])('rejects malformed query %j without dispatching the selector', async (query) => {
    const denied = await readStartProposalInbox(query).catch((error) => error);
    if (!(denied instanceof Response)) throw new Error('expected an HTTP denial');
    expect(denied.status).toBe(400);
    expect(await denied.json()).toMatchObject({ error: 'validation_error' });
    expect(seams.list).not.toHaveBeenCalled();
  });
  it('runs the actual domain malformed-cursor validation before any database selector', async () => {
    const domain = await vi.importActual<typeof import('@/kernel/proposals/inbox')>(
      '@/kernel/proposals/inbox',
    );
    seams.list.mockImplementationOnce(domain.listProposalInboxPage);
    const denied = await readStartProposalInbox({ cursor: 'not-a-valid-cursor' }).catch(
      (error) => error,
    );
    if (!(denied instanceof Response)) throw new Error('expected an HTTP denial');
    expect(denied.status).toBe(400);
    expect(await denied.json()).toMatchObject({
      error: 'validation_error',
      message: expect.stringContaining('invalid proposal cursor'),
    });
  });
  it('preserves the existing domain cursor error rather than silently loading the first page', async () => {
    seams.list.mockRejectedValueOnce(
      new ApiError('validation_error', 'invalid proposal cursor', 400),
    );
    const denied = await readStartProposalInbox({ cursor: 'invalid' }).catch((error) => error);
    if (!(denied instanceof Response)) throw new Error('expected an HTTP denial');
    expect(denied.status).toBe(400);
    expect(await denied.json()).toEqual({
      error: 'validation_error',
      message: 'invalid proposal cursor',
    });
  });
});

describe('decision and note-undo command adapters', () => {
  it.each(['accept', 'dismiss', 'reverse', 'retract', 'change_type'])(
    'reuses canonical %s and wakes only after commit',
    async (decision) => {
      const input =
        decision === 'change_type' ? { decision, new_relation_type: 'related_to' } : { decision };
      const resource = {
        proposal_id: 'proposal-a',
        decision_event_id: 'decision-a',
        created: false,
        idempotent: true,
        result: { existing: true },
      };
      seams.decision.mockResolvedValueOnce(resource);
      seams.wake.mockResolvedValueOnce(undefined);
      expect(await createStartProposalDecision({ id: ' proposal-a ', input })).toBe(resource);
      expect(seams.decision).toHaveBeenCalledExactlyOnceWith(seams.database, 'proposal-a', input);
      expect(seams.wake.mock.invocationCallOrder[0]).toBeGreaterThan(
        seams.decision.mock.invocationCallOrder[0],
      );
    },
  );
  it('does not await a slow wake or fail an already-committed corrected decision on wake rejection', async () => {
    let rejectWake: (error: Error) => void = () => {};
    seams.wake.mockReturnValueOnce(
      new Promise<void>((_resolve, reject) => {
        rejectWake = reject;
      }),
    );
    const resource = {
      created: true,
      result: { nested: ['unchanged', { evidence: '保持原件'.repeat(80) }] },
    };
    seams.decision.mockResolvedValueOnce(resource);
    expect(
      await createStartProposalDecision({
        id: 'p',
        input: {
          decision: 'accept',
          corrected_payload: { claim_md: '  修订猜想  ' },
          user_note: 'learner review',
        },
      }),
    ).toBe(resource);
    expect(seams.decision.mock.calls[0][2]).toEqual({
      decision: 'accept',
      corrected_payload: { claim_md: '修订猜想' },
      user_note: 'learner review',
    });
    rejectWake(new Error('queue unavailable'));
    await Promise.resolve();
  });
  it.each([
    { id: '' },
    { id: 'p', input: { decision: 'change_type' } },
    { id: 'p', input: { decision: 'accept', corrected_payload: { claim_md: '' } } },
    { id: 'p', input: { decision: 'dismiss', corrected_payload: { claim_md: 'not allowed' } } },
  ])('rejects malformed decision %j before a write or wake', async (input) => {
    const denied = await createStartProposalDecision(input).catch((error) => error);
    if (!(denied instanceof Response)) throw new Error('expected an HTTP denial');
    expect(denied.status).toBe(400);
    expect(seams.decision).not.toHaveBeenCalled();
    expect(seams.wake).not.toHaveBeenCalled();
  });
  it.each([
    [404, 'not_found'],
    [409, 'conflict'],
    [409, 'probe_slots_full'],
    [500, 'decision_event_missing'],
  ])('preserves mutation status %s/code %s with no wake', async (status, code) => {
    seams.decision.mockRejectedValueOnce(
      new ApiError(code, 'retry/unknown remains explicit', status),
    );
    const denied = await createStartProposalDecision({
      id: 'p',
      input: { decision: 'accept' },
    }).catch((error) => error);
    if (!(denied instanceof Response)) throw new Error('expected an HTTP denial');
    expect(denied.status).toBe(status);
    expect(await denied.json()).toMatchObject({ error: code });
    expect(seams.wake).not.toHaveBeenCalled();
  });
  it('retains artifact ownership before reusing the exported note undo operation', async () => {
    seams.changes.mockResolvedValueOnce([{ event_id: 'other' }]);
    expect(
      (await undoStartAiChange({ artifactId: 'a', eventId: 'e' }).catch((error) => error)).status,
    ).toBe(404);
    expect(seams.undo).not.toHaveBeenCalled();
    seams.changes.mockResolvedValueOnce([{ event_id: 'e' }]);
    seams.undo.mockResolvedValueOnce({ status: 'skipped:version_conflict' });
    expect(await undoStartAiChange({ artifactId: 'a', eventId: 'e' })).toEqual({
      status: 'skipped:version_conflict',
    });
    expect(seams.changes).toHaveBeenLastCalledWith(seams.database, { artifactId: 'a', limit: 200 });
    expect(seams.undo).toHaveBeenCalledExactlyOnceWith(seams.database, { applyEventId: 'e' });
  });
});
