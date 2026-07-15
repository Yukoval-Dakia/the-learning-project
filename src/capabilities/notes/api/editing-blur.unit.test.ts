import { beforeEach, describe, expect, it, vi } from 'vitest';

import { EditingBlurResponseSchema } from '@/capabilities/notes/api/contracts';

vi.mock('@/db/client', () => ({ db: {} }));

const markArtifactIdleAndFlush = vi.fn();
vi.mock('@/server/artifacts/editing-session', () => ({
  markArtifactIdleAndFlush: (...args: unknown[]) => markArtifactIdleAndFlush(...args),
}));

import { POST } from './editing-blur';

function request(body: unknown): Request {
  return new Request('http://localhost/api/editing-session/blur', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

describe('POST /api/editing-session/blur', () => {
  beforeEach(() => {
    markArtifactIdleAndFlush.mockReset();
  });

  it('validates the current presence flush response', async () => {
    markArtifactIdleAndFlush.mockResolvedValue({
      artifact_id: 'note_1',
      flushed: 1,
      results: [{ status: 'applied', artifact_id: 'note_1', artifact_version: 2 }],
    });

    const response = await POST(request({ artifact_id: 'note_1' }));
    expect(response.status).toBe(200);
    expect(EditingBlurResponseSchema.parse(await response.json())).toMatchObject({
      artifact_id: 'note_1',
      flushed: 1,
    });
  });

  it('rejects a missing artifact id before flushing', async () => {
    const response = await POST(request({}));
    expect(response.status).toBe(400);
    expect(markArtifactIdleAndFlush).not.toHaveBeenCalled();
  });
});
