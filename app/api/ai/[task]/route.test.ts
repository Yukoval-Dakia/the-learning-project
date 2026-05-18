import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildAuthedRequest } from '../../../../tests/helpers/request';

vi.mock('@/db/client', () => ({ db: {} }));
vi.mock('@/server/r2', () => ({ getR2: () => ({}) }));

vi.mock('@/server/ai/runner', () => ({
  runTask: vi.fn().mockResolvedValue({
    task_run_id: 'r1',
    text: 'ok',
    finishReason: 'stop',
    usage: { inputTokens: 1, outputTokens: 1 },
  }),
  streamTask: vi
    .fn()
    .mockImplementation(
      () => new Response('chunk1\nchunk2\n', { headers: { 'content-type': 'text/plain' } }),
    ),
}));

vi.mock('@/ai/registry', () => ({
  tasks: { cause_attribution: { needsToolCall: false }, judge_flexible: { needsToolCall: true } },
}));

import { POST } from './route';

describe('POST /api/ai/[task]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns JSON for non-streaming task', async () => {
    const res = await POST(
      buildAuthedRequest('http://localhost/api/ai/cause_attribution', {
        method: 'POST',
        body: JSON.stringify({ input: {} }),
      }),
      { params: Promise.resolve({ task: 'cause_attribution' }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.task_run_id).toBe('r1');
  });

  it('rejects tool-calling tasks on the generic route', async () => {
    const { streamTask } = await import('@/server/ai/runner');

    const res = await POST(
      buildAuthedRequest('http://localhost/api/ai/judge_flexible', {
        method: 'POST',
        body: JSON.stringify({ input: {} }),
      }),
      { params: Promise.resolve({ task: 'judge_flexible' }) },
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: 'tool_task_requires_domain_route',
      task: 'judge_flexible',
    });
    expect(streamTask).not.toHaveBeenCalled();
  });

  it('returns 404 for unknown task', async () => {
    const res = await POST(
      buildAuthedRequest('http://localhost/api/ai/nope', { method: 'POST', body: '{}' }),
      { params: Promise.resolve({ task: 'nope' }) },
    );
    expect(res.status).toBe(404);
  });
});
