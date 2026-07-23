import { event, event_subscription_checkpoint, event_subscription_delivery } from '@/db/schema';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import {
  bootstrapSubscription,
  claimNextSubscriptionDelivery,
  claimSubscriptionLease,
  completeSubscriptionDelivery,
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

  it('fences delivery renew, completion, and failure on the checkpoint lease that created the claim', async () => {
    await bootstrapSubscription(testDb(), registry(), SUBSCRIBER);
    await insertEvent('renew-source');
    await insertEvent('complete-source');
    await insertEvent('fail-source');
    const lease = await claimSubscriptionLease(testDb(), registry(), SUBSCRIBER, 'worker-a');
    if (!lease) throw new Error('expected lease');
    await discoverSubscriptionDeliveries(testDb(), registry(), SUBSCRIBER, lease);

    const renewClaim = await claimNextSubscriptionDelivery(testDb(), registry(), SUBSCRIBER, lease);
    if (!renewClaim) throw new Error('expected renew claim');
    await testDb().execute(sql`
      update event_subscription_checkpoint
      set claim_lease_until = clock_timestamp() - interval '1 second'
      where subscriber_id = ${SUBSCRIBER.id} and subscriber_version = ${SUBSCRIBER.version}
    `);
    expect(await renewSubscriptionDeliveryLease(testDb(), renewClaim)).toBe(false);

    const takeover = await claimSubscriptionLease(testDb(), registry(), SUBSCRIBER, 'worker-b');
    if (!takeover) throw new Error('expected takeover');
    await testDb().execute(sql`
      update event_subscription_delivery
      set claim_lease_until = clock_timestamp() - interval '1 second'
      where source_event_id = 'renew-source'
    `);
    const completeClaim = await claimNextSubscriptionDelivery(
      testDb(),
      registry(),
      SUBSCRIBER,
      takeover,
    );
    if (!completeClaim) throw new Error('expected completion claim');
    await testDb().execute(sql`
      update event_subscription_checkpoint
      set claim_lease_until = clock_timestamp() - interval '1 second'
      where subscriber_id = ${SUBSCRIBER.id} and subscriber_version = ${SUBSCRIBER.version}
    `);
    expect(
      await completeSubscriptionDelivery(testDb(), completeClaim, { status: 'succeeded' }),
    ).toBe(false);
    expect(
      await failSubscriptionDelivery(testDb(), completeClaim, new Error('stale'), {
        maxAttempts: 1,
      }),
    ).toBe('lost_lease');
  });

  it('rolls back discovered deliveries when the checkpoint expires before final advancement', async () => {
    await bootstrapSubscription(testDb(), registry(), SUBSCRIBER);
    await insertEvent('discovery-expire');
    const lease = await claimSubscriptionLease(testDb(), registry(), SUBSCRIBER, 'worker');
    if (!lease) throw new Error('expected lease');
    await testDb().execute(
      sql.raw(`
      create or replace function expire_subscription_checkpoint() returns trigger as $$
      begin
        update event_subscription_checkpoint
        set claim_lease_until = clock_timestamp() - interval '1 second'
        where subscriber_id = new.subscriber_id and subscriber_version = new.subscriber_version;
        return new;
      end;
      $$ language plpgsql;
      create trigger expire_subscription_checkpoint_after_delivery
      after insert on event_subscription_delivery
      for each row execute function expire_subscription_checkpoint();
    `),
    );

    try {
      await expect(
        discoverSubscriptionDeliveries(testDb(), registry(), SUBSCRIBER, lease),
      ).rejects.toThrow(/lost checkpoint lease/);
      expect(await deliveryRows()).toEqual([]);
    } finally {
      await testDb().execute(
        sql.raw(`
        drop trigger if exists expire_subscription_checkpoint_after_delivery
          on event_subscription_delivery;
        drop function if exists expire_subscription_checkpoint();
      `),
      );
    }
  });

  it('releases the exact checkpoint lease after no-claim and handler-failure cycles', async () => {
    await bootstrapSubscription(testDb(), registry(), SUBSCRIBER);
    await runSubscriptionDispatchCycle(testDb(), registry(), { owner: 'worker', maxAttempts: 1 });
    expect(await claimSubscriptionLease(testDb(), registry(), SUBSCRIBER, 'worker')).not.toBeNull();

    await testDb().execute(sql`
      update event_subscription_checkpoint
      set claim_owner = null, claim_token = null, claim_lease_until = null
      where subscriber_id = ${SUBSCRIBER.id} and subscriber_version = ${SUBSCRIBER.version}
    `);
    const failing = { ...SUBSCRIBER, handler: async () => Promise.reject(new Error('boom')) };
    await insertEvent('failed-source');
    await runSubscriptionDispatchCycle(testDb(), registry(failing), {
      owner: 'worker',
      maxAttempts: 1,
    });
    expect(
      await claimSubscriptionLease(testDb(), registry(failing), failing, 'worker'),
    ).not.toBeNull();
  });

  it('rejects redrive when a later delivery has reached a terminal state', async () => {
    await bootstrapSubscription(testDb(), registry(), SUBSCRIBER);
    await insertEvent('first');
    await insertEvent('second');
    const lease = await claimSubscriptionLease(testDb(), registry(), SUBSCRIBER, 'worker');
    if (!lease) throw new Error('expected lease');
    await discoverSubscriptionDeliveries(testDb(), registry(), SUBSCRIBER, lease);
    const first = await claimNextSubscriptionDelivery(testDb(), registry(), SUBSCRIBER, lease);
    if (!first) throw new Error('expected first claim');
    expect(
      await failSubscriptionDelivery(testDb(), first, new Error('dead'), { maxAttempts: 1 }),
    ).toBe('dead_letter');
    const second = await claimNextSubscriptionDelivery(testDb(), registry(), SUBSCRIBER, lease);
    if (!second) throw new Error('expected second claim');
    expect(await completeSubscriptionDelivery(testDb(), second, { status: 'succeeded' })).toBe(
      true,
    );

    expect(await redriveSubscriptionDelivery(testDb(), registry(), SUBSCRIBER, 'first')).toBe(
      false,
    );
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
