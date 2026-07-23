import { event, event_subscription_checkpoint, event_subscription_delivery } from '@/db/schema';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import {
  bootstrapSubscription,
  claimNextSubscriptionDelivery,
  claimSubscriptionLease,
  discoverSubscriptionDeliveries,
  failSubscriptionDelivery,
  redriveSubscriptionDelivery,
  renewSubscriptionDeliveryLease,
  renewSubscriptionLease,
  runSubscriptionDispatchCycle,
} from './runtime';
import type { LoadedEventSubscription, LoadedEventSubscriptionRegistry } from './types';

const HASH = 'registry-declaration-hash';
const SUBSCRIBER: LoadedEventSubscription = {
  id: 'test.subscriber',
  version: 1,
  actions: ['test:handled'],
  handler: async () => ({ status: 'succeeded' }),
};

function registry(subscription = SUBSCRIBER): LoadedEventSubscriptionRegistry {
  return {
    contractVersion: 'event-subscription-registry/v1',
    declarationHash: HASH,
    subscriptions: [subscription],
    get(id, version) {
      return id === subscription.id && version === subscription.version ? subscription : undefined;
    },
  };
}

async function insertEvent(id: string, action = 'test:handled') {
  await testDb().insert(event).values({
    id,
    actor_kind: 'system',
    actor_ref: 'test',
    action,
    subject_kind: 'event',
    subject_id: id,
    payload: {},
  });
}

async function deliveryRows() {
  return testDb()
    .select({
      sourceEventId: event_subscription_delivery.source_event_id,
      deliverySeq: event_subscription_delivery.delivery_seq,
      status: event_subscription_delivery.status,
      attemptCount: event_subscription_delivery.attempt_count,
      redriveCount: event_subscription_delivery.redrive_count,
    })
    .from(event_subscription_delivery)
    .orderBy(event_subscription_delivery.delivery_seq);
}

beforeEach(() => resetDb());

describe('YUK-751 durable event subscription runtime', () => {
  it('bootstraps pre-existing events, then anti-joins every undispatched matching event without a cursor', async () => {
    await insertEvent('before-a');
    await insertEvent('ignored', 'test:ignored');
    await insertEvent('before-b');

    await bootstrapSubscription(testDb(), registry(), SUBSCRIBER);
    await insertEvent('after-a');
    const lease = await claimSubscriptionLease(testDb(), registry(), SUBSCRIBER, 'worker-a');
    expect(lease).not.toBeNull();
    if (!lease) throw new Error('expected subscription lease');

    await discoverSubscriptionDeliveries(testDb(), registry(), SUBSCRIBER, lease);

    expect(await deliveryRows()).toEqual([
      expect.objectContaining({
        sourceEventId: 'before-a',
        deliverySeq: 1,
        status: 'bootstrap_skipped',
      }),
      expect.objectContaining({
        sourceEventId: 'before-b',
        deliverySeq: 2,
        status: 'bootstrap_skipped',
      }),
      expect.objectContaining({ sourceEventId: 'after-a', deliverySeq: 3, status: 'pending' }),
    ]);

    const [checkpoint] = await testDb()
      .select({ nextDeliverySeq: event_subscription_checkpoint.next_delivery_seq })
      .from(event_subscription_checkpoint);
    expect(checkpoint?.nextDeliverySeq).toBe(4);
  });

  it('fences checkpoint leases and prevents a later delivery from running while an earlier retry waits', async () => {
    await bootstrapSubscription(testDb(), registry(), SUBSCRIBER);
    await insertEvent('one');
    await insertEvent('two');
    const firstLease = await claimSubscriptionLease(testDb(), registry(), SUBSCRIBER, 'worker-a');
    if (!firstLease) throw new Error('expected first lease');
    await discoverSubscriptionDeliveries(testDb(), registry(), SUBSCRIBER, firstLease);

    expect(await renewSubscriptionLease(testDb(), firstLease)).toBe(true);
    const first = await claimNextSubscriptionDelivery(testDb(), registry(), SUBSCRIBER, firstLease);
    expect(first?.sourceEventId).toBe('one');
    if (!first) throw new Error('expected first delivery');
    expect(await renewSubscriptionDeliveryLease(testDb(), first)).toBe(true);
    expect(
      await failSubscriptionDelivery(testDb(), first, new Error('retry'), { maxAttempts: 2 }),
    ).toBe('retry_wait');
    expect(
      await claimNextSubscriptionDelivery(testDb(), registry(), SUBSCRIBER, firstLease),
    ).toBeNull();

    await testDb().execute(sql`
      update event_subscription_checkpoint
      set claim_lease_until = clock_timestamp() - interval '1 second'
      where subscriber_id = ${SUBSCRIBER.id} and subscriber_version = ${SUBSCRIBER.version}
    `);
    const takeover = await claimSubscriptionLease(testDb(), registry(), SUBSCRIBER, 'worker-b');
    expect(takeover?.claimOwner).toBe('worker-b');
    expect(await renewSubscriptionLease(testDb(), firstLease)).toBe(false);
  });

  it('retries to dead-letter at the configured bound and explicitly redrives terminal failures', async () => {
    await bootstrapSubscription(testDb(), registry(), SUBSCRIBER);
    await insertEvent('source');
    const lease = await claimSubscriptionLease(testDb(), registry(), SUBSCRIBER, 'worker');
    if (!lease) throw new Error('expected lease');
    await discoverSubscriptionDeliveries(testDb(), registry(), SUBSCRIBER, lease);
    const first = await claimNextSubscriptionDelivery(testDb(), registry(), SUBSCRIBER, lease);
    if (!first) throw new Error('expected delivery');
    expect(
      await failSubscriptionDelivery(testDb(), first, new Error('first'), { maxAttempts: 1 }),
    ).toBe('dead_letter');
    expect(await redriveSubscriptionDelivery(testDb(), registry(), SUBSCRIBER, 'source')).toBe(
      true,
    );

    const rows = await deliveryRows();
    expect(rows[0]).toEqual(
      expect.objectContaining({ status: 'retry_wait', attemptCount: 1, redriveCount: 1 }),
    );
  });

  it('fails closed for unknown declarations, declaration drift, and paused checkpoints', async () => {
    const unknown = { ...SUBSCRIBER, version: 2 };
    await expect(bootstrapSubscription(testDb(), registry(), unknown)).rejects.toThrow(
      /not declared/,
    );

    await bootstrapSubscription(testDb(), registry(), SUBSCRIBER);
    await testDb().execute(sql`
      update event_subscription_checkpoint
      set declaration_hash = 'wrong', status = 'paused', paused_at = clock_timestamp()
      where subscriber_id = ${SUBSCRIBER.id} and subscriber_version = ${SUBSCRIBER.version}
    `);
    await expect(
      claimSubscriptionLease(testDb(), registry(), SUBSCRIBER, 'worker'),
    ).rejects.toThrow(/declaration hash mismatch/);
  });

  it('dispatches a claimed delivery to succeeded and observes handler outcomes', async () => {
    const handler = vi.fn(async () => ({ status: 'skipped' as const, reason: 'not applicable' }));
    const subscription = { ...SUBSCRIBER, handler };
    await bootstrapSubscription(testDb(), registry(subscription), subscription);
    await insertEvent('source');

    const result = await runSubscriptionDispatchCycle(testDb(), registry(subscription), {
      owner: 'worker',
      maxAttempts: 2,
    });

    expect(result).toEqual({
      dispatched: 1,
      succeeded: 0,
      skipped: 1,
      retryScheduled: 0,
      deadLettered: 0,
    });
    expect(handler).toHaveBeenCalledWith({
      subscriberId: SUBSCRIBER.id,
      subscriberVersion: SUBSCRIBER.version,
      deliverySeq: 1n,
      sourceEventId: 'source',
    });
    expect(await deliveryRows()).toEqual([
      expect.objectContaining({ sourceEventId: 'source', status: 'skipped' }),
    ]);
  });
});
