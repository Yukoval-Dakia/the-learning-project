import { beforeEach, describe, expect, it, vi } from 'vitest';

const { bossSend, getStartedBoss } = vi.hoisted(() => ({
  bossSend: vi.fn(),
  getStartedBoss: vi.fn(),
}));

vi.mock('@/server/boss/client', () => ({ getStartedBoss }));

import { enqueueHubAutoSync } from '@/server/boss/hub-auto-sync-enqueue';

describe('enqueueHubAutoSync', () => {
  beforeEach(() => {
    bossSend.mockReset();
    getStartedBoss.mockReset();
    getStartedBoss.mockResolvedValue({ send: bossSend });
  });

  it('uses the persistent global singleton debounce', async () => {
    await enqueueHubAutoSync();

    expect(bossSend).toHaveBeenCalledWith(
      'hub_auto_sync_nightly',
      { source: 'mutation' },
      {
        singletonKey: 'hub_auto_sync',
        singletonSeconds: 300,
        singletonNextSlot: true,
      },
    );
  });

  it('swallows boss acquisition and enqueue failures', async () => {
    getStartedBoss.mockRejectedValueOnce(new Error('boss unavailable'));
    await expect(enqueueHubAutoSync()).resolves.toBeUndefined();

    getStartedBoss.mockResolvedValueOnce({ send: bossSend });
    bossSend.mockRejectedValueOnce(new Error('send failed'));
    await expect(enqueueHubAutoSync()).resolves.toBeUndefined();
  });
});
