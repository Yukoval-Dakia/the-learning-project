import { beforeEach, describe, expect, it, vi } from 'vitest';

// The wake helper pulls in the reconciler import graph (which type-imports the db
// client); mock the client so this stays a no-DB unit test, and mock the boss
// client so the enqueue path is deterministic. wakeHubSyncAfterCommit uses
// getStartedBoss() (the app-process enqueue path), NOT a getRunningBoss() peek —
// the mock must export getStartedBoss or the call throws and the best-effort catch
// silently swallows it (the exact regression the sweep reviewer caught at 41e67e76).
vi.mock('@/db/client', () => ({ db: {} }));

const send = vi.fn(async (_queue: string, _data: unknown, _options?: unknown) => 'job-id');
const getStartedBoss = vi.fn();
const getRunningBoss = vi.fn(() => null);
vi.mock('@/server/boss/client', () => ({
  getStartedBoss: () => getStartedBoss(),
  getRunningBoss: () => getRunningBoss(),
}));

import { wakeHubSyncAfterCommit } from './hub_auto_sync_nightly';

describe('wakeHubSyncAfterCommit (YUK-384 best-effort mutation wake)', () => {
  beforeEach(() => {
    send.mockReset().mockResolvedValue('job-id');
    getStartedBoss.mockReset().mockResolvedValue({ send });
    getRunningBoss.mockReset().mockReturnValue(null);
  });

  it('sends exactly one singleton-keyed, throttled wake via the app enqueue path (getStartedBoss)', async () => {
    await wakeHubSyncAfterCommit();
    // Uses getStartedBoss (starts/reuses a send-capable boss), not a cold-start-null peek.
    expect(getStartedBoss).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    // singletonKey AND singletonSeconds — the key alone does not de-dup on a standard queue.
    expect(send).toHaveBeenCalledWith(
      'hub_sync_mutation_wake',
      {},
      { singletonKey: 'hub_sync_mutation_wake', singletonSeconds: 5 },
    );
  });

  it('swallows a boss-start failure — best-effort, never throws, never sends', async () => {
    // getStartedBoss() can throw (boss start failure); it must not surface to the caller
    // (the mutation already committed). Replaces the obsolete "no-op when boss not running"
    // test — getStartedBoss has no null path.
    getStartedBoss.mockRejectedValue(new Error('boss start failed'));
    await expect(wakeHubSyncAfterCommit()).resolves.toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });

  it('swallows a send rejection — best-effort, never throws', async () => {
    send.mockRejectedValue(new Error('boss unavailable'));
    await expect(wakeHubSyncAfterCommit()).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(1);
  });
});
