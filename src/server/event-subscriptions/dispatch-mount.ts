// YUK-751 review TcWGF — the live mount for the durable subscription bus. Before this the whole
// runtime (registry + dispatch cycle) had NO production caller: 建成不通电. `startBossWorker` calls
// `mountSubscriptionDispatch` after registering capability jobs, so both the standalone worker
// (scripts/worker.ts) and the in-process RW_WORKER (server/index.ts) drive the cycle.
//
// Shape: load the subscription registry from the manifests once at boot, then a recurring pg-boss
// job runs one dispatch cycle per tick. Checkpoint leases (claimSubscriptionLease) serialize per
// subscriber across workers, so the exact cadence is NOT load-bearing and a double-fire is safe —
// pg-boss's cron floor is 1 minute, which is well within the durable bus's latency budget.

import type { PgBoss } from 'pg-boss';

import type { Db } from '@/db/client';
import type { CapabilityManifest } from '@/kernel/manifest';
import { FAST_QUEUE_OPTS, createOrUpdateQueue } from '@/server/boss/queue-config';

import { loadEventSubscriptionRegistry } from './registry';
import { runSubscriptionDispatchCycle } from './runtime';

export const EVENT_SUBSCRIPTION_DISPATCH_QUEUE = 'event_subscription_dispatch';

// pg-boss cron granularity floors at 1 minute; the lease makes the period non-load-bearing.
const DEFAULT_DISPATCH_CRON = '* * * * *';
const DEFAULT_DISPATCH_MAX_ATTEMPTS = 5;

export type MountSubscriptionDispatchOptions = {
  owner?: string;
  maxAttempts?: number;
  cron?: string;
};

/**
 * Mounts the recurring subscription-dispatch driver. Returns false (mounts nothing) when no
 * capability declares a subscription — there is nothing to power, so we don't create an idle queue.
 */
export async function mountSubscriptionDispatch(
  boss: PgBoss,
  db: Db,
  capabilities: CapabilityManifest[],
  options: MountSubscriptionDispatchOptions = {},
): Promise<boolean> {
  const registry = await loadEventSubscriptionRegistry(capabilities, db);
  if (registry.subscriptions.length === 0) return false;

  const owner = options.owner ?? `worker:${process.pid}`;
  const maxAttempts = options.maxAttempts ?? DEFAULT_DISPATCH_MAX_ATTEMPTS;
  const cron = options.cron ?? DEFAULT_DISPATCH_CRON;

  await createOrUpdateQueue(boss, EVENT_SUBSCRIPTION_DISPATCH_QUEUE, FAST_QUEUE_OPTS);
  await boss.work(
    EVENT_SUBSCRIPTION_DISPATCH_QUEUE,
    { pollingIntervalSeconds: 2, batchSize: 1 },
    async () => {
      await runSubscriptionDispatchCycle(db, registry, { owner, maxAttempts });
    },
  );
  await boss.schedule(EVENT_SUBSCRIPTION_DISPATCH_QUEUE, cron, {}, {});
  return true;
}
