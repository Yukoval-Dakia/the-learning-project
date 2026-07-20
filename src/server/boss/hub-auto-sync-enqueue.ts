import { getStartedBoss } from '@/server/boss/client';

const HUB_AUTO_SYNC_SINGLETON_SECONDS = 300;

export async function enqueueHubAutoSync(): Promise<void> {
  try {
    const boss = await getStartedBoss();
    await boss.send(
      'hub_auto_sync_nightly',
      { source: 'mutation' },
      {
        singletonKey: 'hub_auto_sync',
        singletonSeconds: HUB_AUTO_SYNC_SINGLETON_SECONDS,
        singletonNextSlot: true,
      },
    );
  } catch (err) {
    console.warn('[hub_auto_sync] failed to enqueue hub_auto_sync', err);
  }
}
