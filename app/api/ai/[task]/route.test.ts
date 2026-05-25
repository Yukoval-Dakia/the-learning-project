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
  tasks: {
    ReviewIntentTask: { needsToolCall: false, invocation: 'auto' },
    NoteGenerateTask: { needsToolCall: false, invocation: 'auto' },
    VisionExtractTask: { needsToolCall: false, invocation: 'manual_rescue_only' },
    KnowledgeReviewTask: { needsToolCall: true, invocation: 'auto' },
  },
}));

import { POST } from './route';

describe('POST /api/ai/[task]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('allows ReviewIntentTask on the generic route', async () => {
    const { runTask } = await import('@/server/ai/runner');

    const res = await POST(
      buildAuthedRequest('http://localhost/api/ai/ReviewIntentTask', {
        method: 'POST',
        body: JSON.stringify({ input: { total: 3 } }),
      }),
      { params: Promise.resolve({ task: 'ReviewIntentTask' }) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.task_run_id).toBe('r1');
    expect(runTask).toHaveBeenCalledWith('ReviewIntentTask', { total: 3 }, expect.any(Object));
  });

  it('rejects profile-driven tasks on the generic route', async () => {
    const { runTask } = await import('@/server/ai/runner');

    const res = await POST(
      buildAuthedRequest('http://localhost/api/ai/NoteGenerateTask', {
        method: 'POST',
        body: JSON.stringify({ input: {} }),
      }),
      { params: Promise.resolve({ task: 'NoteGenerateTask' }) },
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: 'profile_required',
      task: 'NoteGenerateTask',
    });
    expect(runTask).not.toHaveBeenCalled();
  });

  it('rejects manual rescue tasks on the generic route', async () => {
    const { runTask } = await import('@/server/ai/runner');

    const res = await POST(
      buildAuthedRequest('http://localhost/api/ai/VisionExtractTask', {
        method: 'POST',
        body: JSON.stringify({ input: {} }),
      }),
      { params: Promise.resolve({ task: 'VisionExtractTask' }) },
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: 'requires_domain_route',
      task: 'VisionExtractTask',
      domain_route: '/api/ingestion/[id]/extract',
    });
    expect(runTask).not.toHaveBeenCalled();
  });

  it('rejects tool-calling tasks on the generic route', async () => {
    const { runTask, streamTask } = await import('@/server/ai/runner');

    const res = await POST(
      buildAuthedRequest('http://localhost/api/ai/KnowledgeReviewTask', {
        method: 'POST',
        body: JSON.stringify({ input: {} }),
      }),
      { params: Promise.resolve({ task: 'KnowledgeReviewTask' }) },
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: 'tool_task_requires_domain_route',
      task: 'KnowledgeReviewTask',
    });
    expect(runTask).not.toHaveBeenCalled();
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
