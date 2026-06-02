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
