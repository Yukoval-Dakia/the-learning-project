// Topology writers live in three capability packages. This module is the shared wake
// so none of them imports another package's job internals. It must not import a capability.

import { getStartedBoss } from '@/server/boss/client';

export const HUB_SYNC_MUTATION_WAKE_QUEUE = 'hub_sync_mutation_wake';

// singletonKey does not dedupe on a standard queue unless singletonSeconds is set.
const HUB_SYNC_WAKE_SINGLETON_SECONDS = 5;

// Injected so a topology writer does not import pg-boss.
export interface HubSyncSend {
  send: (
    queue: string,
    data: unknown,
    options?: { singletonKey?: string; singletonSeconds?: number },
  ) => Promise<unknown>;
}

/** Swallows send failures. The SQL trigger and the minute recovery are the durable path. */
export async function sendHubSyncMutationWake(deps: HubSyncSend): Promise<void> {
  try {
    await deps.send(
      HUB_SYNC_MUTATION_WAKE_QUEUE,
      {},
      {
        singletonKey: HUB_SYNC_MUTATION_WAKE_QUEUE,
        singletonSeconds: HUB_SYNC_WAKE_SINGLETON_SECONDS,
      },
    );
  } catch {
    // The minute recovery still converges a missed wake.
  }
}

/**
 * After the topology transaction commits. getStartedBoss() starts a send-capable boss.
 * getRunningBoss() is null until something else has started one, so a cold app process
 * would never deliver the wake and FULL mode would silently wait for the minute recovery.
 * A start failure must not affect the committed mutation. Callers fire this without awaiting,
 * so the response does not wait on pg-boss.
 */
export async function wakeHubSyncAfterCommit(): Promise<void> {
  try {
    const boss = await getStartedBoss();
    await sendHubSyncMutationWake({
      send: (queue, data, options) => boss.send(queue, (data ?? {}) as object, options),
    });
  } catch (err) {
    console.warn('[hub_sync] mutation wake failed (best-effort; minute recovery converges)', err);
  }
}
