import { beforeEach, describe, expect, it, vi } from 'vitest';

// The wake helper pulls in the reconciler import graph (which type-imports the db
// client); mock the client so this stays a no-DB unit test, and mock the boss
// client so getRunningBoss is deterministic.
vi.mock('@/db/client', () => ({ db: {} }));

const send = vi.fn();
const getRunningBoss = vi.fn();
vi.mock('@/server/boss/client', () => ({
  getRunningBoss: () => getRunningBoss(),
}));

import { wakeHubSyncAfterCommit } from './hub_auto_sync_nightly';

describe('wakeHubSyncAfterCommit (YUK-384 best-effort mutation wake)', () => {
  beforeEach(() => {
    send.mockReset().mockResolvedValue('job-id');
    getRunningBoss.mockReset();
  });

  it('sends exactly one singleton-keyed wake when boss is running', async () => {
    getRunningBoss.mockReturnValue({ send });
    await wakeHubSyncAfterCommit();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      'hub_sync_mutation_wake',
      {},
      {
        singletonKey: 'hub_sync_mutation_wake',
      },
    );
  });

  it('is a no-op when boss is not running (never starts boss)', async () => {
    getRunningBoss.mockReturnValue(null);
    await expect(wakeHubSyncAfterCommit()).resolves.toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });

  it('swallows a send rejection — best-effort, never throws', async () => {
    send.mockRejectedValue(new Error('boss unavailable'));
    getRunningBoss.mockReturnValue({ send });
    await expect(wakeHubSyncAfterCommit()).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(1);
  });
});
