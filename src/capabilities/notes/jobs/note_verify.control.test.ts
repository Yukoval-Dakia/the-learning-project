// Offline wiring checks for the retained pg-boss note_verify consumer's
// backend-control admission (YUK-1355 paid-effect control integration). The
// operation itself is mocked: these cases pin the handler's control flow only.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PaidEffectControlAdmission } from '@/server/durable/paid-effect-protocol';

import { buildNoteVerifyHandler } from './note_verify';

const admitted: PaidEffectControlAdmission = {
  kind: 'admitted',
  control: { family: 'note_verify', backend: 'pg-boss', generation: 0, explicit: false },
};

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

  // @invariant concurrency: an admitted delivery reaches exactly one operation execution keyed by the job's artifact_id
  // @fails-if admission throws on the happy path or the handler loses/mangles the artifact_id it hands to the operation
  it('executes the operation once per admitted delivery', async () => {
    const handler = buildNoteVerifyHandler({} as never, {
      admitDelivery: async () => admitted,
    });
    await expect(
      handler([{ id: 'job-2', data: { artifact_id: 'a2' } } as never]),
    ).resolves.toBeUndefined();
    expect(runNoteVerify).toHaveBeenCalledTimes(1);
    expect(runNoteVerify).toHaveBeenCalledWith(expect.objectContaining({ artifactId: 'a2' }));
  });
});
