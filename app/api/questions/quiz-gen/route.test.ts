// Q4 — POST /api/questions/quiz-gen route test.
//
// docs/superpowers/specs/2026-06-02-quizgen-search-grounded-design.md §4:
// thin route behind the x-internal-token middleware → validate body (zod) →
// enqueue a quiz_gen job → 202. Manual-first.
//
// The route only enqueues (no direct DB), so we mock the pg-boss client. The
// mock makes @/server/boss/client a *mocked* DB import (audit-partition treats
// it as satisfied); the file stays in the db partition (default).

import { beforeEach, describe, expect, it, vi } from 'vitest';

const send = vi.fn(async () => 'job-id-1');
vi.mock('@/server/boss/client', () => ({
  getStartedBoss: vi.fn(async () => ({ send })),
}));

// YUK-226 S2-5b — sequence mode lazy-imports @/db/client + the orchestrator. Mock
// both so the route test stays DB-free (the orchestrator itself is DB-tested in
// src/server/quiz/sourcing-sequence.test.ts).
vi.mock('@/db/client', () => ({ db: {} }));
const runSourcingSequence = vi.fn(async () => ({
  existing: [{ question_id: 'q1', source: 'wenyan', tier: 1 }],
  satisfiedFromPool: false,
  enqueued: ['external_sourcing', 'material_grounded', 'closed_book'],
  needs: [
    { kind: 'question_generation', knowledge_id: 'k1', source: 'external_sourcing', reason: 'r' },
  ],
}));
vi.mock('@/server/quiz/sourcing-sequence', () => ({ runSourcingSequence }));

import { POST } from './route';

function postReq(body: unknown): Request {
  return new Request('http://localhost/api/questions/quiz-gen', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/questions/quiz-gen', () => {
  beforeEach(() => {
    send.mockClear();
    runSourcingSequence.mockClear();
  });

  it('enqueues a quiz_gen job and returns 202 with the job id', async () => {
    const res = await POST(postReq({ trigger: 'knowledge', ref_id: 'k1', count: 3 }));

    expect(res.status).toBe(202);
    const json = (await res.json()) as { job_id: string; enqueued: boolean };
    expect(json.enqueued).toBe(true);
    expect(json.job_id).toBe('job-id-1');

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('quiz_gen', {
      trigger: 'knowledge',
      ref_id: 'k1',
      count: 3,
    });
  });

  it('omits count from the job payload when the caller does not provide one', async () => {
    const res = await POST(postReq({ trigger: 'learning_item', ref_id: 'li1' }));

    expect(res.status).toBe(202);
    expect(send).toHaveBeenCalledWith('quiz_gen', {
      trigger: 'learning_item',
      ref_id: 'li1',
    });
  });

  it('accepts the manual trigger', async () => {
    const res = await POST(postReq({ trigger: 'manual', ref_id: 'topic-x' }));
    expect(res.status).toBe(202);
    expect(send).toHaveBeenCalledWith('quiz_gen', { trigger: 'manual', ref_id: 'topic-x' });
  });

  it('returns 400 on an unknown trigger', async () => {
    const res = await POST(postReq({ trigger: 'bogus', ref_id: 'k1' }));
    expect(res.status).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });

  it('returns 400 when ref_id is missing', async () => {
    const res = await POST(postReq({ trigger: 'knowledge' }));
    expect(res.status).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });

  it('returns 400 when count is out of range', async () => {
    const res = await POST(postReq({ trigger: 'knowledge', ref_id: 'k1', count: 99 }));
    expect(res.status).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });

  it('sequence mode routes through the orchestrator instead of enqueuing quiz_gen', async () => {
    const res = await POST(
      postReq({ trigger: 'knowledge', ref_id: 'k1', count: 3, sequence: true }),
    );

    expect(res.status).toBe(202);
    const json = (await res.json()) as { mode: string; enqueued: string[]; needs: unknown[] };
    expect(json.mode).toBe('sequence');
    expect(json.enqueued).toEqual(['external_sourcing', 'material_grounded', 'closed_book']);
    expect(json.needs).toHaveLength(1);

    // the bare quiz_gen enqueue path is NOT taken in sequence mode.
    expect(send).not.toHaveBeenCalled();
    expect(runSourcingSequence).toHaveBeenCalledTimes(1);
    expect(runSourcingSequence).toHaveBeenCalledWith(
      expect.objectContaining({ knowledgeId: 'k1', trigger: 'knowledge', refId: 'k1', count: 3 }),
    );
  });

  it('sequence mode 400s when no knowledge node can be resolved', async () => {
    // manual trigger + no knowledge_id → cannot key step 1.
    const res = await POST(postReq({ trigger: 'manual', ref_id: 'topic-x', sequence: true }));
    expect(res.status).toBe(400);
    expect(runSourcingSequence).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('returns 400 on a non-JSON body', async () => {
    const res = await POST(
      new Request('http://localhost/api/questions/quiz-gen', {
        method: 'POST',
        body: 'not json',
      }),
    );
    expect(res.status).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });
});
