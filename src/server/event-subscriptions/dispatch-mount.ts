// Live mount for the durable subscription bus. `startBossWorker` mounts it after
// registering capability jobs, so both the standalone worker and the in-process
// RW_WORKER drive the cycle.
//
// The registry loads once at boot, then a recurring pg-boss job runs one dispatch
// cycle per tick. Checkpoint leases serialize each subscriber across workers, so
// the cadence is not load-bearing and a double-fire is safe. A tick drains a
// bounded slice instead of adding a minute of delay per delivery.

import type { PgBoss } from 'pg-boss';

import type { Db } from '@/db/client';
import type { CapabilityManifest } from '@/kernel/manifest';
import {
  FAST_QUEUE_OPTS,
  JOB_RETRY_DELAY_SECONDS,
  JOB_RETRY_LIMIT,
  createOrUpdateQueue,
} from '@/server/boss/queue-config';
import { fenceAwareJobHandler } from '@/server/contract-epoch';

import { loadEventSubscriptionRegistry } from './registry';
import { runSubscriptionDispatchCycle } from './runtime';

export const EVENT_SUBSCRIPTION_DISPATCH_QUEUE = 'event_subscription_dispatch';

// pg-boss cron granularity floors at 1 minute; the lease makes the period non-load-bearing.
export const EVENT_SUBSCRIPTION_DISPATCH_SCHEDULE = {
  name: EVENT_SUBSCRIPTION_DISPATCH_QUEUE,
  queue: EVENT_SUBSCRIPTION_DISPATCH_QUEUE,
  cron: '* * * * *',
  tz: 'Asia/Shanghai',
  note: '仅在存在订阅时挂载；此处为默认调度声明，不代表 worker 已挂载或确认。',
} as const;
const DEFAULT_DISPATCH_MAX_ATTEMPTS = 5;
// One minute is the idle wake-up floor, not the per-delivery rate. A slice starts
// no new claims after 30s; an active handler keeps its own timeout and lease, so
// 30s is not a hard cycle deadline.
const MAX_DELIVERIES_PER_SUBSCRIPTION = 100;
const MAX_DISPATCH_MS = 30_000;

// Explicit retry policy: pg-boss defaults would retry a failed cycle immediately
// three times during a DB outage. Reuse the job-retry convention and backoff.
const DISPATCH_QUEUE_OPTS = {
  ...FAST_QUEUE_OPTS,
  retryLimit: JOB_RETRY_LIMIT,
  retryDelay: JOB_RETRY_DELAY_SECONDS,
  retryBackoff: true,
} as const;

export type MountSubscriptionDispatchOptions = {
  owner?: string;
  maxAttempts?: number;
  cron?: string;
};

/**
 * Mount the recurring dispatcher. Returns false and creates no queue when no
 * capability declares a subscription.
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
  const cron = options.cron ?? EVENT_SUBSCRIPTION_DISPATCH_SCHEDULE.cron;

  await createOrUpdateQueue(boss, EVENT_SUBSCRIPTION_DISPATCH_QUEUE, DISPATCH_QUEUE_OPTS);
  await boss.work(
    EVENT_SUBSCRIPTION_DISPATCH_QUEUE,
    { pollingIntervalSeconds: 2, batchSize: 1 },
    // Drain mode: delivery is idempotent, but maintenance still stops the tick.
    // Pending-item translation lives in bootstrapSubscription.
    fenceAwareJobHandler(db, EVENT_SUBSCRIPTION_DISPATCH_QUEUE, async () => {
      // Log counts and duration; a dead-lettered delivery is a real failure, so warn.
      const startedAt = Date.now();
      try {
        const cycle = await runSubscriptionDispatchCycle(db, registry, {
          owner,
          maxAttempts,
          maxDeliveriesPerSubscription: MAX_DELIVERIES_PER_SUBSCRIPTION,
          maxDispatchMs: MAX_DISPATCH_MS,
        });
        const durationMs = Date.now() - startedAt;
        const log = cycle.deadLettered > 0 ? console.warn : console.info;
        log('[event-subscriptions] dispatch cycle', { ...cycle, durationMs });
      } catch (err) {
        // Rethrow so pg-boss records and retries the failure instead of losing it.
        console.error('[event-subscriptions] dispatch cycle failed', {
          durationMs: Date.now() - startedAt,
          error: err,
        });
        throw err;
      }
    }),
  );
  // Match the codebase schedule timezone; leases make cadence non-load-bearing.
  await boss.schedule(
    EVENT_SUBSCRIPTION_DISPATCH_QUEUE,
    cron,
    {},
    { tz: EVENT_SUBSCRIPTION_DISPATCH_SCHEDULE.tz },
  );
  return true;
}
