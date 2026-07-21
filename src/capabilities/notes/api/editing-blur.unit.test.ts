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

  const SESSION_ID = '22222222-2222-4222-8222-222222222222';

  it('forwards the caller session and validates the presence flush response', async () => {
    markArtifactIdleAndFlush.mockResolvedValue({
      artifact_id: 'note_1',
      flushed: 2,
      results: [
        { status: 'skipped:target_not_found', artifact_id: 'note_1', skipped_ops: 1 },
        { status: 'applied', artifact_id: 'note_1', artifact_version: 2 },
      ],
    });

    const response = await POST(request({ artifact_id: 'note_1', editor_session_id: SESSION_ID }));
    expect(response.status).toBe(200);
    // YUK-384 — blur removes ONLY the caller's session.
    expect(markArtifactIdleAndFlush).toHaveBeenCalledWith(
      expect.objectContaining({ artifactId: 'note_1', sessionId: SESSION_ID }),
    );
    const parsed = EditingBlurResponseSchema.parse(await response.json());
    expect(parsed).toMatchObject({
      artifact_id: 'note_1',
      flushed: 2,
    });
    expect(parsed.results[0]).toMatchObject({ status: 'skipped:target_not_found', skipped_ops: 1 });
  });

  it('rejects a missing artifact id before flushing', async () => {
    const response = await POST(request({ editor_session_id: SESSION_ID }));
    expect(response.status).toBe(400);
    expect(markArtifactIdleAndFlush).not.toHaveBeenCalled();
  });

  it('rejects a missing editor_session_id before flushing', async () => {
    const response = await POST(request({ artifact_id: 'note_1' }));
    expect(response.status).toBe(400);
    expect(markArtifactIdleAndFlush).not.toHaveBeenCalled();
  });
});
