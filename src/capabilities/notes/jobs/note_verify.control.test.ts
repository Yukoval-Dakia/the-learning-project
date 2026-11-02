// Offline wiring checks for the retained pg-boss note_verify consumer's
// backend-control admission (YUK-1355 paid-effect control integration). The
// operation itself is mocked: these cases pin the handler's control flow only.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildNoteVerifyHandler } from './note_verify';

const runNoteVerify = vi.hoisted(() =>
  vi.fn(async () => ({ status: 'skipped:not_found' as const })),
);

vi.mock('@/capabilities/notes/server/note-verify-durable-operation', () => ({
  finalizeStagedNoteVerification: vi.fn(),
  noteVerificationRetryRequired: (artifactId: string, reason: string) =>
    new Error(`note verification retry required for ${artifactId}: ${reason}`),
  runNoteVerify,
}));

describe('note_verify pg-boss handler backend-control admission', () => {
  beforeEach(() => {
    runNoteVerify.mockClear();
  });

  // @invariant concurrency: a fenced delivery is NOT silently consumed — the handler throws so pg-boss redelivers and ultimately DLQs the job, keeping the accepted job and its unverified artifact visible under the wrong owner
  // @fails-if a fenced delivery still invokes runNoteVerify (paid work under the wrong owner) or is consumed with a skip instead of failing
  it('fails fenced deliveries without touching the operation', async () => {
    const handler = buildNoteVerifyHandler({} as never, {
      admitDelivery: async () => ({
        kind: 'fenced',
        reason: 'backend_mismatch',
        owner: 'dbos',
        generation: 1,
      }),
    });
    await expect(handler([{ id: 'job-1', data: { artifact_id: 'a1' } } as never])).rejects.toThrow(
      'fenced',
    );
    expect(runNoteVerify).not.toHaveBeenCalled();
  });
});
