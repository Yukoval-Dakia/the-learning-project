import type { Db } from '@/db/client';
import * as schema from '@/db/schema';
import { event, event_subscription_checkpoint, event_subscription_delivery } from '@/db/schema';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
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

const HASH = 'subscriber-declaration-hash';
const SUBSCRIBER: LoadedEventSubscription = {
  id: 'test.subscriber',
  version: 1,
  actions: ['test:handled'],
  declarationHash: HASH,
  handler: async () => ({ status: 'succeeded' }),
};

function registry(subscription = SUBSCRIBER): LoadedEventSubscriptionRegistry {
  return {
    contractVersion: 'event-subscription-registry/v1',
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

async function withIndependentDb<T>(
  run: (db: Db) => Promise<T>,
  applicationName?: string,
): Promise<T> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL not set');
  const client = postgres(url, {
    max: 1,
    connection: applicationName ? { application_name: applicationName } : undefined,
  });
  const db = drizzle(client, { schema }) as unknown as Db;
  try {
    return await run(db);
  } finally {
    await client.end();
  }
}

async function waitForBackendLock(applicationName: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rows = await testDb().execute<{ wait_event_type: string | null }>(sql`
      select wait_event_type
      from pg_stat_activity
      where application_name = ${applicationName}
        and wait_event_type = 'Lock'
    `);
    if (rows.length === 1) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`backend '${applicationName}' did not enter a lock wait`);
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

  it('single-tx bootstrap: an event in-flight during bootstrap is NOT skipped, later delivered (Tcx98/TcWGH)', async () => {
    // The creation tx's OWN snapshot defines history — no seq/xmin/snapshot fence. An event still
    // in-flight (uncommitted) when bootstrap runs is absent from that snapshot, so it is not skipped;
    // once it commits, discovery delivers it as pending (the safe direction, cleaner mechanism).
    await insertEvent('history-committed'); // committed before bootstrap → history.
    const url = process.env.TEST_DATABASE_URL;
    if (!url) throw new Error('TEST_DATABASE_URL not set');
    const held = postgres(url, { max: 1 });
    try {
      await held`begin`;
      await held`
        insert into event (id, actor_kind, actor_ref, action, subject_kind, subject_id, payload)
        values ('in-flight', 'system', 'test', 'test:handled', 'event', 'in-flight', '{}'::jsonb)
      `;
      // Bootstrap runs while 'in-flight' is uncommitted → not in the creation snapshot.
      await bootstrapSubscription(testDb(), registry(), SUBSCRIBER);
      await held`commit`;
    } finally {
      await held.end();
    }

    // history-committed skipped; in-flight left untouched (absent from the creation snapshot).
    expect(await deliveryRows()).toEqual([
      expect.objectContaining({ sourceEventId: 'history-committed', status: 'bootstrap_skipped' }),
    ]);

    const lease = await claimSubscriptionLease(testDb(), registry(), SUBSCRIBER, 'worker');
    if (!lease) throw new Error('expected lease');
    await discoverSubscriptionDeliveries(testDb(), registry(), SUBSCRIBER, lease);
    const rows = await deliveryRows();
    expect(rows).toContainEqual(
      expect.objectContaining({ sourceEventId: 'in-flight', status: 'pending' }),
    );
    expect(rows).toContainEqual(
      expect.objectContaining({ sourceEventId: 'history-committed', status: 'bootstrap_skipped' }),
    );
  });

  it('single-tx bootstrap: a historical event whose row was later UPDATED is still skipped, not over-delivered (Tcx98)', async () => {
    // event rows are NOT immutable — the memory outbox UPDATEs ingest_at, moving xmin. That broke the
    // xmin-based fence (an outbox-touched historical event read as in-flight → over-delivered). The
    // snapshot-based bootstrap is mutation-proof: a committed row is history regardless of its xmin.
    await insertEvent('outbox-touched');
    await testDb().execute(
      sql`update event set ingest_at = clock_timestamp() where id = 'outbox-touched'`,
    );

    await bootstrapSubscription(testDb(), registry(), SUBSCRIBER);

    expect(await deliveryRows()).toEqual([
      expect.objectContaining({ sourceEventId: 'outbox-touched', status: 'bootstrap_skipped' }),
    ]);
    // And discovery does not re-deliver it (no over-delivery of pre-subscription history).
    const lease = await claimSubscriptionLease(testDb(), registry(), SUBSCRIBER, 'worker');
    if (!lease) throw new Error('expected lease');
    expect(await discoverSubscriptionDeliveries(testDb(), registry(), SUBSCRIBER, lease)).toBe(0);
  });

  it('rejects non-positive / non-finite dispatch options at intake (Tcd9v)', async () => {
    await expect(
      runSubscriptionDispatchCycle(testDb(), registry(), { owner: 'w', maxAttempts: 0 }),
    ).rejects.toThrow(/maxAttempts/);
    await expect(
      runSubscriptionDispatchCycle(testDb(), registry(), {
        owner: 'w',
        maxAttempts: 2,
        retryDelaySeconds: -1,
      }),
    ).rejects.toThrow(/retryDelaySeconds/);
    await expect(
      runSubscriptionDispatchCycle(testDb(), registry(), {
        owner: 'w',
        maxAttempts: 2,
        handlerTimeoutMs: Number.NaN,
      }),
    ).rejects.toThrow(/handlerTimeoutMs/);
    // G2 (TdYuS) — a finite-but-too-large caller timeout (>= lease TTL) is also rejected.
    await expect(
      runSubscriptionDispatchCycle(testDb(), registry(), {
        owner: 'w',
        maxAttempts: 2,
        handlerTimeoutMs: 200_000,
      }),
    ).rejects.toThrow(/handlerTimeoutMs.*lease TTL/);
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

  it.each(['renew', 'complete', 'fail'] as const)(
    'serializes stale %s behind checkpoint takeover and then rejects it',
    async (transition) => {
      await bootstrapSubscription(testDb(), registry(), SUBSCRIBER);
      await insertEvent(`interleaved-${transition}`);
      const lease = await claimSubscriptionLease(testDb(), registry(), SUBSCRIBER, 'worker-a');
      if (!lease) throw new Error('expected lease');
      await discoverSubscriptionDeliveries(testDb(), registry(), SUBSCRIBER, lease);
      const claim = await claimNextSubscriptionDelivery(testDb(), registry(), SUBSCRIBER, lease);
      if (!claim) throw new Error('expected delivery claim');

      let locked!: () => void;
      const checkpointLocked = new Promise<void>((resolve) => {
        locked = resolve;
      });
      let release!: () => void;
      const releaseTakeover = new Promise<void>((resolve) => {
        release = resolve;
      });
      const takeover = withIndependentDb((db) =>
        db.transaction(async (tx) => {
          await tx.execute(sql`
            update event_subscription_checkpoint
            set claim_owner = 'worker-b',
                claim_token = '11111111-1111-4111-8111-111111111111'::uuid,
                claim_lease_until = clock_timestamp() + interval '2 minutes'
            where subscriber_id = ${SUBSCRIBER.id}
              and subscriber_version = ${SUBSCRIBER.version}
          `);
          locked();
          await releaseTakeover;
        }),
      );
      await checkpointLocked;

      const staleApplicationName = `yuk751_stale_${transition}`;
      const staleTransition = withIndependentDb(
        async (db) =>
          transition === 'renew'
            ? renewSubscriptionDeliveryLease(db, claim)
            : transition === 'complete'
              ? completeSubscriptionDelivery(db, claim, { status: 'succeeded' })
              : failSubscriptionDelivery(db, claim, new Error('stale'), {
                  maxAttempts: 1,
                }),
        staleApplicationName,
      );
      try {
        await waitForBackendLock(staleApplicationName);
      } finally {
        release();
        await takeover;
      }

      await expect(staleTransition).resolves.toBe(transition === 'fail' ? 'lost_lease' : false);
      const [delivery] = await deliveryRows();
      expect(delivery).toEqual(expect.objectContaining({ status: 'claimed', attemptCount: 0 }));
    },
  );

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

  it('rejects a checkpoint lease from another subscriber without mutating the target delivery', async () => {
    const other = {
      ...SUBSCRIBER,
      id: 'test.other-subscriber',
      declarationHash: 'other-subscriber-declaration-hash',
    };
    const subscriptions = [SUBSCRIBER, other];
    const sharedRegistry: LoadedEventSubscriptionRegistry = {
      contractVersion: 'event-subscription-registry/v1',
      subscriptions,
      get(id, version) {
        return subscriptions.find(
          (subscription) => subscription.id === id && subscription.version === version,
        );
      },
    };
    await bootstrapSubscription(testDb(), sharedRegistry, SUBSCRIBER);
    await bootstrapSubscription(testDb(), sharedRegistry, other);
    await insertEvent('shared-source');
    const firstLease = await claimSubscriptionLease(
      testDb(),
      sharedRegistry,
      SUBSCRIBER,
      'worker-a',
    );
    const otherLease = await claimSubscriptionLease(testDb(), sharedRegistry, other, 'worker-b');
    if (!firstLease || !otherLease) throw new Error('expected both leases');
    await discoverSubscriptionDeliveries(testDb(), sharedRegistry, other, otherLease);

    await expect(
      claimNextSubscriptionDelivery(testDb(), sharedRegistry, other, firstLease),
    ).rejects.toThrow(/lease identity mismatch/);
    const [otherDelivery] = await testDb()
      .select({ status: event_subscription_delivery.status })
      .from(event_subscription_delivery)
      .where(sql`${event_subscription_delivery.subscriber_id} = ${other.id}`);
    expect(otherDelivery?.status).toBe('pending');
  });

  it('rejects redrive when a later delivery has failed into retry_wait', async () => {
    await bootstrapSubscription(testDb(), registry(), SUBSCRIBER);
    await insertEvent('first-dead');
    await insertEvent('later-retry');
    const lease = await claimSubscriptionLease(testDb(), registry(), SUBSCRIBER, 'worker');
    if (!lease) throw new Error('expected lease');
    await discoverSubscriptionDeliveries(testDb(), registry(), SUBSCRIBER, lease);
    const first = await claimNextSubscriptionDelivery(testDb(), registry(), SUBSCRIBER, lease);
    if (!first) throw new Error('expected first claim');
    expect(
      await failSubscriptionDelivery(testDb(), first, new Error('dead'), { maxAttempts: 1 }),
    ).toBe('dead_letter');
    const later = await claimNextSubscriptionDelivery(testDb(), registry(), SUBSCRIBER, lease);
    if (!later) throw new Error('expected later claim');
    expect(
      await failSubscriptionDelivery(testDb(), later, new Error('retry'), { maxAttempts: 2 }),
    ).toBe('retry_wait');

    expect(await redriveSubscriptionDelivery(testDb(), registry(), SUBSCRIBER, 'first-dead')).toBe(
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
      lostLease: 0,
    });
    expect(handler).toHaveBeenCalledWith({
      subscriberId: SUBSCRIBER.id,
      subscriberVersion: SUBSCRIBER.version,
      // YUK-751 review: deliverySeq crosses the handler boundary as a decimal string (serializable).
      deliverySeq: '1',
      sourceEventId: 'source',
    });
    expect(await deliveryRows()).toEqual([
      expect.objectContaining({ sourceEventId: 'source', status: 'skipped' }),
    ]);
  });
});
