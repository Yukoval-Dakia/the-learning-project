import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkbenchSummary } from '@/capabilities/shell/public';
import { db } from '@/db/client';
import { WorkbenchSummaryResponseSchema } from './contracts';

const mocks = vi.hoisted(() => ({
  implementationLoads: 0,
  loadWorkbenchSummary: vi.fn<typeof import('../server/workbench-summary').loadWorkbenchSummary>(),
}));

vi.mock('@/db/client', () => ({ db: { testDb: true } }));
// Isolate the existing public exports so this suite never initializes their DB graph.
vi.mock('../server/overnight-digest', () => ({ loadOvernightDigest: vi.fn() }));
vi.mock('../server/prep-desk', () => ({ loadPrepDeskConjectures: vi.fn() }));
vi.mock('../server/teaching-brief', () => ({
  isCandidateError: vi.fn(),
  validateAckableOutcome: vi.fn(),
}));
vi.mock('../server/workbench-summary', () => {
  mocks.implementationLoads += 1;
  return { loadWorkbenchSummary: mocks.loadWorkbenchSummary };
});

const summary: WorkbenchSummary = {
  proposals: {
    total: 500,
    decision_total: 300,
    by_kind: {
      knowledge_node: 0,
      knowledge_edge: 300,
      knowledge_mutation: 0,
      learning_item: 0,
      note_update: 0,
      variant_question: 0,
      completion: 0,
      relearn: 0,
      defer: 200,
      record_links: 0,
      record_promotion: 0,
      archive: 0,
      judge_retraction: 0,
      goal_scope: 0,
      block_merge: 0,
      image_candidate: 0,
      question_draft: 0,
      question_edit: 0,
      conjecture: 0,
      cause_category: 0,
    },
    has_more: true,
    limit: 500,
    status: 'pending',
  },
  kpi: { due_count: 200, pending_attribution_count: 199, knowledge_count: 42, goal_count: 0 },
  cold_start: {
    is_empty: false,
    evidence: {
      active_goal: false,
      goal_history: true,
      knowledge: true,
      question: true,
      source_material: true,
      artifact: true,
      review_due: true,
      pending_attribution: true,
      practice_stream: true,
      proposal: true,
      learning_session: true,
      user_event: true,
    },
  },
  active_goal: null,
  active_sessions: [
    {
      id: 'review-completed',
      status: 'completed',
      summary_md: `已复习的长文本交班记录：\n\n${'保留推导、歧义与后续验证。'.repeat(80)}`,
      started_at: 1784131200,
      ended_at: 1784131260,
      duration_ms: 60_000,
      reviewed_count: 2,
    },
    {
      id: 'review-started',
      status: 'started',
      summary_md: null,
      started_at: 1784217600,
      ended_at: null,
      duration_ms: 30_000,
      reviewed_count: 0,
    },
  ],
  week_heat: Array.from({ length: 7 }, (_, index) => ({
    day: `2026-07-${10 + index}`,
    count: index === 6 ? 3 : 0,
  })),
};

beforeEach(() => {
  vi.resetModules();
  mocks.implementationLoads = 0;
  mocks.loadWorkbenchSummary.mockReset().mockResolvedValue(summary);
});

afterEach(() => vi.restoreAllMocks());

describe('Workbench public loader and HTTP consumer', () => {
  it('loads the implementation only on invocation and forwards the supplied database', async () => {
    const { loadWorkbenchSummary } = await import('../public');
    expect(mocks.implementationLoads).toBe(0);
    const suppliedDb = new Proxy(db, {});

    expect(await loadWorkbenchSummary(suppliedDb)).toBe(summary);
    expect(mocks.implementationLoads).toBe(1);
    expect(mocks.loadWorkbenchSummary).toHaveBeenCalledExactlyOnceWith(suppliedDb);
    expect(mocks.loadWorkbenchSummary.mock.calls[0]?.[0]).toBe(suppliedDb);
  });

  it('returns the complete public result without changing sampling or lower-bound signals', async () => {
    const { GET } = await import('./workbench-summary');
    expect(mocks.implementationLoads).toBe(0);
    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    const body: unknown = await response.json();
    expect(body).toEqual(summary);
    expect(WorkbenchSummaryResponseSchema.parse(body)).toEqual(summary);
    expect(mocks.loadWorkbenchSummary).toHaveBeenCalledExactlyOnceWith(db);
  });

  it('propagates loader errors to domain callers and sanitizes them at the HTTP boundary', async () => {
    const failure = new Error('due-list handler failed: 503; private database detail');
    mocks.loadWorkbenchSummary.mockRejectedValue(failure);
    const { loadWorkbenchSummary } = await import('../public');
    await expect(loadWorkbenchSummary(db)).rejects.toBe(failure);

    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { GET } = await import('./workbench-summary');
    const response = await GET();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: 'internal_error',
      message: 'Internal Server Error',
    });
    expect(log).toHaveBeenCalledOnce();
  });

  it('preserves existing ApiError status, body and headers', async () => {
    const { ApiError } = await import('@/kernel/http');
    mocks.loadWorkbenchSummary.mockRejectedValue(
      new ApiError('read_unavailable', 'Read temporarily unavailable', 503, {
        'Retry-After': '30',
      }),
    );
    const { GET } = await import('./workbench-summary');
    const response = await GET();
    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('30');
    expect(await response.json()).toEqual({
      error: 'read_unavailable',
      message: 'Read temporarily unavailable',
    });
  });
});
