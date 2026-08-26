// YUK-605 ① + YUK-555 — POST /api/questions/quiz-gen route tests (unit partition,
// no DB): contract validation, the two-layer count guardrail (warn watermark that
// informs without blocking + hard cap), honest knowledge-read semantics (an empty
// read is a 404, never phrased as verified), and enqueue evidence on 202.
//
// The knowledge read / pg-boss enqueue / Tavily gate are vi.mock'd seams — this
// suite pins the route contract, not drizzle SQL (the archived_at guard mirrors
// resolveTrigger's, exercised by the quiz_gen DB suite).

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  enqueueSupplyDispatchJob: vi.fn(),
  tavilyAvailable: vi.fn((): boolean => true),
  knowledgeRows: [] as Array<{ id: string; name: string; domain: string | null }>,
}));

vi.mock('@/db/client', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => mocks.knowledgeRows,
        }),
      }),
    }),
  },
}));
vi.mock('@/kernel/supply-dispatch', () => ({
  enqueueSupplyDispatchJob: mocks.enqueueSupplyDispatchJob,
}));
vi.mock('@/kernel/supply-dispatch-tavily', () => ({
  supplyDispatchTavilyAvailable: mocks.tavilyAvailable,
}));

import { POST } from './quiz-gen-trigger';
import {
  QUIZ_GEN_MANUAL_COUNT_CAP,
  QUIZ_GEN_MANUAL_COUNT_WARN,
} from './quiz-gen-trigger-contracts';

const KC = 'kc_derivatives_chain_rule';

function req(body: unknown): Request {
  return new Request('http://test/api/questions/quiz-gen', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

function seedKnowledge(rows = [{ id: KC, name: '链式法则', domain: 'calculus' }]) {
  mocks.knowledgeRows.splice(0, mocks.knowledgeRows.length, ...rows);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.tavilyAvailable.mockReturnValue(true);
  seedKnowledge();
  mocks.enqueueSupplyDispatchJob.mockResolvedValue('boss-job-1');
});

describe('POST /api/questions/quiz-gen — body validation', () => {
  it('rejects a count above the hard cap with 400 and never enqueues', async () => {
    const res = await POST(req({ knowledge_id: KC, count: QUIZ_GEN_MANUAL_COUNT_CAP + 1 }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('validation_error');
    expect(String(body.message)).toContain(String(QUIZ_GEN_MANUAL_COUNT_CAP));
    expect(mocks.enqueueSupplyDispatchJob).not.toHaveBeenCalled();
  });

  it('rejects non-positive and non-integer counts with 400', async () => {
    for (const count of [0, -1, 2.5]) {
      const res = await POST(req({ knowledge_id: KC, count }));
      expect(res.status, `count=${count}`).toBe(400);
    }
    expect(mocks.enqueueSupplyDispatchJob).not.toHaveBeenCalled();
  });

  it('rejects a missing knowledge_id with 400', async () => {
    const res = await POST(req({ count: 3 }));
    expect(res.status).toBe(400);
    expect(mocks.enqueueSupplyDispatchJob).not.toHaveBeenCalled();
  });

  it('rejects an unknown generation_method with 400', async () => {
    const res = await POST(req({ knowledge_id: KC, generation_method: 'vibes' }));
    expect(res.status).toBe(400);
    expect(mocks.enqueueSupplyDispatchJob).not.toHaveBeenCalled();
  });

  it('rejects a non-JSON body with 400', async () => {
    const res = await POST(
      new Request('http://test/api/questions/quiz-gen', {
        method: 'POST',
        body: 'not json',
        headers: { 'content-type': 'application/json' },
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe('POST /api/questions/quiz-gen — honest knowledge-read semantics', () => {
  it('returns 404 (NOT an enqueue) when the knowledge point does not exist', async () => {
    seedKnowledge([]); // empty read must never be phrased as verified
    const res = await POST(req({ knowledge_id: 'kc_missing', count: 3 }));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('not_found');
    expect(body.message).toContain('kc_missing');
    expect(mocks.enqueueSupplyDispatchJob).not.toHaveBeenCalled();
  });
});

describe('POST /api/questions/quiz-gen — Tavily availability gate (material_grounded)', () => {
  it('returns 409 without enqueueing when TAVILY_API_KEY is unset', async () => {
    mocks.tavilyAvailable.mockReturnValue(false);
    const res = await POST(req({ knowledge_id: KC, generation_method: 'material_grounded' }));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.message).toContain('TAVILY_API_KEY');
    expect(mocks.enqueueSupplyDispatchJob).not.toHaveBeenCalled();
  });

  it('still enqueues material_grounded when Tavily is available', async () => {
    const res = await POST(req({ knowledge_id: KC, generation_method: 'material_grounded' }));
    expect(res.status).toBe(202);
  });

  it('enqueues closed_book regardless of Tavily availability', async () => {
    mocks.tavilyAvailable.mockReturnValue(false);
    const res = await POST(req({ knowledge_id: KC, generation_method: 'closed_book' }));
    expect(res.status).toBe(202);
  });
});

describe('POST /api/questions/quiz-gen — 202 enqueue evidence', () => {
  it('enqueues via the dispatcher kernel path with trigger=manual and the KC anchor', async () => {
    const res = await POST(req({ knowledge_id: KC, count: 4 }));
    expect(res.status).toBe(202);

    expect(mocks.enqueueSupplyDispatchJob).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueSupplyDispatchJob).toHaveBeenCalledWith('quiz_gen', {
      trigger: 'manual',
      ref_id: KC,
      knowledge_id: KC,
      count: 4,
    });

    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      status: 'enqueued',
      queue: 'quiz_gen',
      job_id: 'boss-job-1',
      trigger: 'manual',
      knowledge_id: KC,
      count: 4,
    });
    expect('warning' in body).toBe(false);
  });

  it('defaults count when omitted and echoes generation_method when provided', async () => {
    const res = await POST(req({ knowledge_id: KC, generation_method: 'closed_book' }));
    expect(res.status).toBe(202);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.count).toBe(3);
    expect(body.generation_method).toBe('closed_book');
    expect(mocks.enqueueSupplyDispatchJob).toHaveBeenCalledWith('quiz_gen', {
      trigger: 'manual',
      ref_id: KC,
      knowledge_id: KC,
      count: 3,
      generation_method: 'closed_book',
    });
  });

  it('does not fake a 202 when pg-boss returns no job id', async () => {
    mocks.enqueueSupplyDispatchJob.mockResolvedValue(null);
    const res = await POST(req({ knowledge_id: KC }));
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('enqueue_failed');
  });

  it('surfaces an enqueue throw as a 500 internal error', async () => {
    mocks.enqueueSupplyDispatchJob.mockRejectedValue(new Error('boss down'));
    const res = await POST(req({ knowledge_id: KC }));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('internal_error');
  });
});

describe('POST /api/questions/quiz-gen — two-layer count guardrail (YUK-555)', () => {
  it('stays silent below the warning watermark', async () => {
    const res = await POST(req({ knowledge_id: KC, count: QUIZ_GEN_MANUAL_COUNT_WARN - 1 }));
    expect(res.status).toBe(202);
    const body = (await res.json()) as Record<string, unknown>;
    expect('warning' in body).toBe(false);
  });

  it('warns (without blocking) at and above the watermark, up to the cap', async () => {
    for (const count of [QUIZ_GEN_MANUAL_COUNT_WARN, QUIZ_GEN_MANUAL_COUNT_CAP]) {
      const res = await POST(req({ knowledge_id: KC, count }));
      expect(res.status, `count=${count}`).toBe(202);
      const body = (await res.json()) as { warning?: string; count: number };
      const warning = body.warning;
      expect(typeof warning, `count=${count}`).toBe('string');
      expect(warning?.length, `count=${count}`).toBeGreaterThan(0);
      expect(body.count).toBe(count);
    }
  });
});
