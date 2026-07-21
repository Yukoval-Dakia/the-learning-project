// YUK-384 (W3) — neutral home for the hub-sync mutation-wake seam. Topology writers live
// in three different capability packages (knowledge/edges, shell/proposal-decisions,
// copilot/accept-chip); routing them through this server module keeps them off a deep
// import into the notes capability's job internals (src/capabilities/AGENTS.md: packages
// talk via manifest public surfaces, never deep imports). Its only dependency,
// getStartedBoss, lives next door in ./client — no ESM cycle, and this module MUST NOT
// import anything from a capability package.

import { getStartedBoss } from '@/server/boss/client';

export const HUB_SYNC_MUTATION_WAKE_QUEUE = 'hub_sync_mutation_wake';

// singletonKey ALONE does not de-duplicate on a standard pg-boss queue — it needs a
// singletonSeconds throttle window (repo lessons YUK-491 / YUK-486). Coalesce a burst of
// topology mutations into ~one wake / 5s.
const HUB_SYNC_WAKE_SINGLETON_SECONDS = 5;

// pg-boss `send` seam, injected so callers/handlers stay unit-testable and no topology
// writer is forced to import pg-boss.
export interface HubSyncSend {
  send: (
    queue: string,
    data: unknown,
    options?: { singletonKey?: string; singletonSeconds?: number },
  ) => Promise<unknown>;
}

/**
 * Best-effort post-commit wake, given a send seam. Swallows send failures —
 * durability is the SQL trigger + minute recovery, never this send.
 */
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
    // best-effort; the minute-recovery floor still converges the durable dirty.
  }
}

/**
 * Fire the immediate coalesced wake from a route/job HANDLER, AFTER the topology
 * mutation's outer transaction has committed. Uses getStartedBoss() — the app process's
 * STANDARD enqueue path, which starts/reuses a send-capable boss and marks it running (the
 * same getter ingestion image-candidate-accept / auto-enroll / operations / extract use).
 * A getRunningBoss() PEEK would be null in an app process that has not yet hit any
 * getStartedBoss path (cold start before the first edge-create / decision / accept-chip),
 * so the immediate wake would NEVER be delivered and owner-chosen FULL mode would silently
 * degrade to the minute-recovery floor. Best-effort: getStartedBoss() can throw (boss start
 * failure); a failure here must NEVER affect the already-committed mutation — the durable
 * trigger + minute-recovery floor converges any missed wake. Hub-agnostic + singleton-keyed.
 *
 * Callers invoke it fire-and-forget (`void wakeHubSyncAfterCommit()`) so the user response
 * is never bound to pg-boss availability/latency; the double error-swallow above + here
 * makes that safe.
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
