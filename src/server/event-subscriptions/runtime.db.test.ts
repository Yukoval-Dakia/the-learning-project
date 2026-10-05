import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '@/db/client';
import * as schema from '@/db/schema';
import { event, event_subscription_checkpoint, event_subscription_delivery } from '@/db/schema';
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

  // ── YUK-1055 — version-bump translation（grounding §15 + YUK-766）──
  // 旧版本 outstanding delivery 不许盲标 bootstrap_skipped：stable source_event_id
  // 下把 pending/claimed/retry_wait 翻译进新版本（保序、保重试预算），其余终态化。

  it('translates outstanding deliveries into the bumped version instead of blindly skipping them (YUK-1055)', async () => {
    const V1 = SUBSCRIBER; // actions ['test:handled']
    const V2: LoadedEventSubscription = {
      ...SUBSCRIBER,
      version: 2,
      actions: ['test:handled'],
      declarationHash: 'subscriber-declaration-hash-v2',
      handler: async () => ({ status: 'succeeded' }),
    };

    // v1 已在跑：bootstrap（空历史）→ 事件到达 → discover 出 pending。
    await bootstrapSubscription(testDb(), registry(V1), V1);
    await insertEvent('m1'); // v1 已终态化（succeeded）
    await insertEvent('m2'); // v1 已终态化（dead_letter）
    await insertEvent('t1'); // v1 retry_wait —— 被翻译
    await insertEvent('t2'); // v1 claimed（in-flight）—— 被翻译、清 claim
    await insertEvent('p1'); // v1 pending —— 被翻译
    const v1Lease = await claimSubscriptionLease(testDb(), registry(V1), V1, 'worker-a');
    if (!v1Lease) throw new Error('expected v1 lease');
    await discoverSubscriptionDeliveries(testDb(), registry(V1), V1, v1Lease);

    // 精确塑造五种 v1 存量：terminal×2 + outstanding×3。
    await testDb().execute(sql`
      update event_subscription_delivery
      set status = 'succeeded', completed_at = clock_timestamp(), outcome = '{"status":"succeeded"}',
          updated_at = clock_timestamp()
      where source_event_id = 'm1'
    `);
    await testDb().execute(sql`
      update event_subscription_delivery
      set status = 'dead_letter', completed_at = clock_timestamp(),
          last_error = 'handler threw', attempt_count = 3,
          updated_at = clock_timestamp()
      where source_event_id = 'm2'
    `);
    await testDb().execute(sql`
      update event_subscription_delivery
      set status = 'retry_wait', attempt_count = 2,
          next_attempt_at = clock_timestamp() + interval '30 minutes',
          last_error = 'flaky handler', updated_at = clock_timestamp()
      where source_event_id = 't1'
    `);
    await testDb().execute(sql`
      update event_subscription_delivery
      set status = 'claimed', claim_owner = 'worker-a',
          claim_token = '22222222-2222-4222-8222-222222222222'::uuid,
          claim_lease_until = clock_timestamp() + interval '5 minutes',
          claimed_at = clock_timestamp(), updated_at = clock_timestamp()
      where source_event_id = 't2'
    `);

    // 版本 bump：v2 bootstrap 必须先翻译 outstanding，再标记历史。
    const result = await bootstrapSubscription(testDb(), registry(V2), V2);
    expect(result).toEqual({ translated: 3, superseded: 3 });

    // 旧版本 outstanding 终态化（'skipped' + 显式 last_error），terminal 行不动。
    const v1Rows = await testDb()
      .select({
        sourceEventId: event_subscription_delivery.source_event_id,
        status: event_subscription_delivery.status,
        lastError: event_subscription_delivery.last_error,
        attemptCount: event_subscription_delivery.attempt_count,
      })
      .from(event_subscription_delivery)
      .where(sql`${event_subscription_delivery.subscriber_version} = 1`)
      .orderBy(event_subscription_delivery.delivery_seq);
    expect(v1Rows).toEqual([
      { sourceEventId: 'm1', status: 'succeeded', lastError: null, attemptCount: 0 },
      { sourceEventId: 'm2', status: 'dead_letter', lastError: 'handler threw', attemptCount: 3 },
      { sourceEventId: 't1', status: 'skipped', lastError: 'translated_to_v2', attemptCount: 2 },
      { sourceEventId: 't2', status: 'skipped', lastError: 'translated_to_v2', attemptCount: 0 },
      { sourceEventId: 'p1', status: 'skipped', lastError: 'translated_to_v2', attemptCount: 0 },
    ]);

    // 新版本行：翻译行按 source_dispatch_seq 占 delivery_seq 1..3（老工作先交付），
    // 历史行（m1/m2）bootstrap_skipped 排其后。claimed→pending 清 claim；retry_wait
    // 保 next_attempt_at/attempt_count（重试预算连续）。
    const v2Rows = await testDb()
      .select({
        sourceEventId: event_subscription_delivery.source_event_id,
        deliverySeq: event_subscription_delivery.delivery_seq,
        status: event_subscription_delivery.status,
        attemptCount: event_subscription_delivery.attempt_count,
        lastError: event_subscription_delivery.last_error,
        nextAttemptAt: event_subscription_delivery.next_attempt_at,
        claimOwner: event_subscription_delivery.claim_owner,
      })
      .from(event_subscription_delivery)
      .where(sql`${event_subscription_delivery.subscriber_version} = 2`)
      .orderBy(event_subscription_delivery.delivery_seq);
    expect(v2Rows.map((r) => [r.sourceEventId, r.deliverySeq, r.status])).toEqual([
      ['t1', 1, 'retry_wait'],
      ['t2', 2, 'pending'],
      ['p1', 3, 'pending'],
      ['m1', 4, 'bootstrap_skipped'],
      ['m2', 5, 'bootstrap_skipped'],
    ]);
    expect(v2Rows[0]).toEqual(
      expect.objectContaining({ attemptCount: 2, lastError: 'flaky handler' }),
    );
    const t1NextAttempt = v2Rows[0]?.nextAttemptAt;
    expect(t1NextAttempt).not.toBeNull();
    if (!t1NextAttempt) throw new Error('expected t1 next_attempt_at preserved');
    expect(t1NextAttempt.getTime()).toBeGreaterThan(Date.now());
    expect(v2Rows[1]).toEqual(expect.objectContaining({ claimOwner: null, attemptCount: 0 }));

    // next_delivery_seq = max(delivery_seq)+1 = 6（冲突丢弃历史行留洞时必须用 max，
    // 不能 count+1——本用例 count=5 恰好等于 max，但含 supersede 的用例会散开）。
    const [cp] = await testDb()
      .select({ nextDeliverySeq: event_subscription_checkpoint.next_delivery_seq })
      .from(event_subscription_checkpoint)
      .where(
        sql`${event_subscription_checkpoint.subscriber_id} = ${V2.id}
          and ${event_subscription_checkpoint.subscriber_version} = 2`,
      );
    expect(cp?.nextDeliverySeq).toBe(6);

    // 旧版本再无 outstanding：v1 lease 下 claim 返回 null（不再交付旧版本工作）。
    await expect(
      claimNextSubscriptionDelivery(testDb(), registry(V1), V1, v1Lease),
    ).resolves.toBeNull();

    // 新版本依序交付：t1 retry_wait 未到期 → 挡住后续 claim（per-subscriber 顺序语义）。
    const v2Lease = await claimSubscriptionLease(testDb(), registry(V2), V2, 'worker-b');
    if (!v2Lease) throw new Error('expected v2 lease');
    await expect(
      claimNextSubscriptionDelivery(testDb(), registry(V2), V2, v2Lease),
    ).resolves.toBeNull();

    await testDb().execute(sql`
      update event_subscription_delivery
      set next_attempt_at = clock_timestamp() - interval '1 second'
      where source_event_id = 't1' and subscriber_version = 2
    `);
    const claimedT1 = await claimNextSubscriptionDelivery(testDb(), registry(V2), V2, v2Lease);
    expect(claimedT1?.sourceEventId).toBe('t1');
    if (!claimedT1) throw new Error('expected t1 claim');
    await completeSubscriptionDelivery(testDb(), claimedT1, { status: 'succeeded' });
    const claimedT2 = await claimNextSubscriptionDelivery(testDb(), registry(V2), V2, v2Lease);
    expect(claimedT2?.sourceEventId).toBe('t2');

    // 幂等：再 bootstrap 一次 v2（同 hash）不重复翻译、不增行。
    const again = await bootstrapSubscription(testDb(), registry(V2), V2);
    expect(again).toEqual({ translated: 0, superseded: 0 });
    const [count] = await testDb()
      .select({ n: sql<number>`count(*)::int` })
      .from(event_subscription_delivery)
      .where(sql`${event_subscription_delivery.subscriber_version} = 2`);
    expect(count?.n).toBe(5);
  });

  it('supersedes old-version deliveries for events the bumped version no longer subscribes to', async () => {
    const V1: LoadedEventSubscription = {
      ...SUBSCRIBER,
      actions: ['test:handled', 'test:extra'],
    };
    const V2: LoadedEventSubscription = {
      ...SUBSCRIBER,
      version: 2,
      actions: ['test:handled'], // 'test:extra' 不再订阅
      declarationHash: 'subscriber-declaration-hash-v2',
      handler: async () => ({ status: 'succeeded' }),
    };

    await bootstrapSubscription(testDb(), registry(V1), V1);
    await insertEvent('e1'); // handled —— 翻译
    await insertEvent('x1', 'test:extra'); // 不再订阅 —— superseded
    await insertEvent('x2', 'test:extra');
    await insertEvent('m1'); // handled、v1 已终态（succeeded）—— 落历史行
    const lease = await claimSubscriptionLease(testDb(), registry(V1), V1, 'worker');
    if (!lease) throw new Error('expected lease');
    await discoverSubscriptionDeliveries(testDb(), registry(V1), V1, lease);
    await testDb().execute(sql`
      update event_subscription_delivery
      set status = 'succeeded', completed_at = clock_timestamp(), outcome = '{"status":"succeeded"}',
          updated_at = clock_timestamp()
      where source_event_id = 'm1'
    `);

    const result = await bootstrapSubscription(testDb(), registry(V2), V2);
    expect(result).toEqual({ translated: 1, superseded: 3 });

    const v1Rows = await testDb()
      .select({
        sourceEventId: event_subscription_delivery.source_event_id,
        status: event_subscription_delivery.status,
        lastError: event_subscription_delivery.last_error,
      })
      .from(event_subscription_delivery)
      .where(sql`${event_subscription_delivery.subscriber_version} = 1`)
      .orderBy(event_subscription_delivery.delivery_seq);
    expect(v1Rows).toEqual([
      { sourceEventId: 'e1', status: 'skipped', lastError: 'translated_to_v2' },
      { sourceEventId: 'x1', status: 'skipped', lastError: 'superseded_by_version_bootstrap' },
      { sourceEventId: 'x2', status: 'skipped', lastError: 'superseded_by_version_bootstrap' },
      { sourceEventId: 'm1', status: 'succeeded', lastError: null },
    ]);

    // v2 只认 'test:handled'：e1 翻译占 seq1；历史候选 {e1,m1}（x1/x2 非 handled）
    // 的 rownum 1,2 → e1 的历史位 seq2 与翻译行 PK 冲突丢弃 → delivery_seq 留洞
    // （1 与 3）。next_delivery_seq 必须取 max+1 = 4：count+1 = 3 会在下一次
    // discovery 撞上 event_subscription_delivery_local_seq_uq —— 这就是断言目标。
    const v2Rows = await testDb()
      .select({
        sourceEventId: event_subscription_delivery.source_event_id,
        deliverySeq: event_subscription_delivery.delivery_seq,
        status: event_subscription_delivery.status,
      })
      .from(event_subscription_delivery)
      .where(sql`${event_subscription_delivery.subscriber_version} = 2`)
      .orderBy(event_subscription_delivery.delivery_seq);
    expect(v2Rows.map((r) => [r.sourceEventId, r.deliverySeq, r.status])).toEqual([
      ['e1', 1, 'pending'],
      ['m1', 3, 'bootstrap_skipped'],
    ]);

    await insertEvent('n1'); // bump 后的新事件
    const v2Lease = await claimSubscriptionLease(testDb(), registry(V2), V2, 'worker');
    if (!v2Lease) throw new Error('expected v2 lease');
    await discoverSubscriptionDeliveries(testDb(), registry(V2), V2, v2Lease);
    const [n1Row] = await testDb()
      .select({ deliverySeq: event_subscription_delivery.delivery_seq })
      .from(event_subscription_delivery)
      .where(
        sql`${event_subscription_delivery.subscriber_version} = 2
          and ${event_subscription_delivery.source_event_id} = 'n1'`,
      );
    expect(n1Row?.deliverySeq).toBe(4); // 无碰撞、无重投：紧接 max(3) 之后
  });
});
