import { randomUUID } from 'node:crypto';

import type { Db } from '@/db/client';
import { sql } from 'drizzle-orm';

import type { EventSubscriptionOutcome } from '@/kernel/manifest';

import type { LoadedEventSubscription, LoadedEventSubscriptionRegistry } from './types';

type SubscriptionIdentity = Pick<LoadedEventSubscription, 'id' | 'version'>;

// Max un-delivered events materialized + inserted per bootstrap backfill transaction (YUK-751 OCR
// major): bounds memory and per-tx lock duration when a new subscriber bootstraps against a large
// event history. Each batch commits independently; the backfill resumes across batches.
const BOOTSTRAP_BACKFILL_BATCH_SIZE = 1_000;

// CONTRACT (YUK-751 OCR major): a handler must resolve well INSIDE the checkpoint/delivery claim
// lease TTL (`interval '2 minutes'`). The lease is NOT renewed while the handler runs, so a handler
// that outlives the lease lets a concurrent worker take over and double-process the same delivery.
// Bounding the await below the TTL guarantees the delivery is resolved (retry_wait via
// failSubscriptionDelivery) before the lease can expire. On timeout the handler promise is abandoned
// (JS can't truly cancel it) — its side effects must be idempotent, which the delivery-key dedup
// already assumes. Keep this value < the lease TTL if the lease duration ever changes.
const DEFAULT_HANDLER_TIMEOUT_MS = 90_000;

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

type SubscriptionLease = {
  subscriberId: string;
  subscriberVersion: number;
  declarationHash: string;
  claimOwner: string;
  claimToken: string;
  leaseUntil: Date;
};

export type SubscriptionDeliveryClaim = {
  subscriberId: string;
  subscriberVersion: number;
  declarationHash: string;
  sourceEventId: string;
  deliverySeq: bigint;
  claimOwner: string;
  claimToken: string;
  checkpointClaimOwner: string;
  checkpointClaimToken: string;
  leaseUntil: Date;
};

function getDeclaredSubscription(
  registry: LoadedEventSubscriptionRegistry,
  subscription: SubscriptionIdentity,
): LoadedEventSubscription {
  const declared = registry.get(subscription.id, subscription.version);
  if (!declared) {
    throw new Error(
      `event subscription '${subscription.id}@v${subscription.version}' is not declared by registry`,
    );
  }
  return declared;
}

function asBigint(value: string | number | bigint): bigint {
  return BigInt(value);
}

type DbTransaction = Parameters<Parameters<Db['transaction']>[0]>[0];

type CheckpointFence = {
  subscriberId: string;
  subscriberVersion: number;
  declarationHash: string;
  claimOwner: string;
  claimToken: string;
};

async function withLockedCheckpoint<T>(
  db: Db,
  fence: CheckpointFence,
  transition: (tx: DbTransaction) => Promise<T>,
): Promise<T | null> {
  return db.transaction(async (tx) => {
    const checkpoints = await tx.execute(sql`
      select subscriber_id
      from event_subscription_checkpoint
      where subscriber_id = ${fence.subscriberId}
        and subscriber_version = ${fence.subscriberVersion}
        and declaration_hash = ${fence.declarationHash}
        and status = 'active'
        and claim_owner = ${fence.claimOwner}
        and claim_token = ${fence.claimToken}::uuid
        and claim_lease_until >= clock_timestamp()
      for update
    `);
    if (checkpoints.length !== 1) return null;
    return transition(tx);
  });
}

/**
 * Creates and activates a checkpoint while holding its row lock. Every source
 * event visible during this transaction is durably marked bootstrap_skipped;
 * later racing commits remain absent from the anti-join and will be discovered
 * as pending once the checkpoint is active.
 */
export async function bootstrapSubscription(
  db: Db,
  registry: LoadedEventSubscriptionRegistry,
  subscription: LoadedEventSubscription,
): Promise<void> {
  const declared = getDeclaredSubscription(registry, subscription);
  const actionList = sql.join(
    declared.actions.map((action) => sql`${action}`),
    sql`, `,
  );

  // Ensure the checkpoint row exists + its declaration hash matches (small tx). Returns whether the
  // historical backfill still needs to run ('bootstrapping'); 'active'/'paused' → nothing to do.
  const needsBackfill = await db.transaction(async (tx) => {
    await tx.execute(sql`
      insert into event_subscription_checkpoint
        (subscriber_id, subscriber_version, declaration_hash, status)
      values (${subscription.id}, ${subscription.version}, ${registry.declarationHash}, 'bootstrapping')
      on conflict (subscriber_id, subscriber_version) do nothing
    `);
    const checkpoints = await tx.execute<{
      declaration_hash: string;
      status: 'bootstrapping' | 'active' | 'paused';
    }>(sql`
      select declaration_hash, status
      from event_subscription_checkpoint
      where subscriber_id = ${subscription.id}
        and subscriber_version = ${subscription.version}
      for update
    `);
    const checkpoint = checkpoints[0];
    if (!checkpoint) throw new Error('event subscription checkpoint was not created');
    if (checkpoint.declaration_hash !== registry.declarationHash) {
      throw new Error(
        `event subscription '${subscription.id}@v${subscription.version}' declaration hash mismatch`,
      );
    }
    return checkpoint.status === 'bootstrapping';
  });
  if (!needsBackfill) return;

  // YUK-751 (OCR major): batch the historical backfill rather than loading the ENTIRE un-delivered
  // event set into one long transaction (OOM + a long checkpoint-row lock on a large event history).
  // Each batch commits in its OWN tx so progress survives a crash — the anti-join skips
  // already-inserted deliveries and next_delivery_seq is persisted per batch, so a re-run RESUMES
  // where it left off. The final empty batch flips the checkpoint to 'active'. The FOR UPDATE on the
  // checkpoint serializes batches per subscriber, and the status re-check detects a peer that
  // already finished.
  while (true) {
    const done = await db.transaction(async (tx) => {
      const checkpoints = await tx.execute<{
        declaration_hash: string;
        status: 'bootstrapping' | 'active' | 'paused';
        next_delivery_seq: string;
      }>(sql`
        select declaration_hash, status, next_delivery_seq
        from event_subscription_checkpoint
        where subscriber_id = ${subscription.id}
          and subscriber_version = ${subscription.version}
        for update
      `);
      const checkpoint = checkpoints[0];
      if (
        !checkpoint ||
        checkpoint.declaration_hash !== registry.declarationHash ||
        checkpoint.status !== 'bootstrapping'
      ) {
        return true; // vanished / hash-rotated / already finished by a peer
      }

      const events = await tx.execute<{ id: string; dispatch_seq: number }>(sql`
        select e.id, e.dispatch_seq
        from event e
        where e.action in (${actionList})
          and not exists (
            select 1
            from event_subscription_delivery d
            where d.subscriber_id = ${subscription.id}
              and d.subscriber_version = ${subscription.version}
              and d.source_event_id = e.id
          )
        order by e.dispatch_seq, e.id
        limit ${BOOTSTRAP_BACKFILL_BATCH_SIZE}
      `);

      if (events.length === 0) {
        await tx.execute(sql`
          update event_subscription_checkpoint
          set status = 'active',
              bootstrapped_at = clock_timestamp(),
              activated_at = clock_timestamp(),
              updated_at = clock_timestamp()
          where subscriber_id = ${subscription.id}
            and subscriber_version = ${subscription.version}
        `);
        return true;
      }

      let nextDeliverySeq = asBigint(checkpoint.next_delivery_seq);
      for (const source of events) {
        // RETURNING + count guard: only advance the seq on an ACTUAL insert. ON CONFLICT DO NOTHING
        // can skip a row a prior interrupted batch already inserted, and an unconditional increment
        // would inflate next_delivery_seq and leave permanent gaps (OCR minor — mirrors
        // discoverSubscriptionDeliveries).
        const inserted = await tx.execute(sql`
          insert into event_subscription_delivery
            (subscriber_id, subscriber_version, source_event_id, source_dispatch_seq, delivery_seq,
             status, completed_at)
          values (${subscription.id}, ${subscription.version}, ${source.id}, ${source.dispatch_seq},
            ${nextDeliverySeq}, 'bootstrap_skipped', clock_timestamp())
          on conflict (subscriber_id, subscriber_version, source_event_id) do nothing
          returning source_event_id
        `);
        if (inserted.length === 1) nextDeliverySeq += 1n;
      }
      await tx.execute(sql`
        update event_subscription_checkpoint
        set next_delivery_seq = ${nextDeliverySeq}, updated_at = clock_timestamp()
        where subscriber_id = ${subscription.id}
          and subscriber_version = ${subscription.version}
      `);
      return false; // more batches remain
    });
    if (done) break;
  }
}

/** Claims a checkpoint lease, including expired-lease takeover, with registry fencing. */
export async function claimSubscriptionLease(
  db: Db,
  registry: LoadedEventSubscriptionRegistry,
  subscription: SubscriptionIdentity,
  owner: string,
): Promise<SubscriptionLease | null> {
  getDeclaredSubscription(registry, subscription);
  const token = randomUUID();
  const rows = await db.execute<{
    claim_lease_until: Date;
  }>(sql`
    update event_subscription_checkpoint
    set claim_owner = ${owner},
        claim_token = ${token}::uuid,
        claim_lease_until = clock_timestamp() + interval '2 minutes',
        updated_at = clock_timestamp()
    where subscriber_id = ${subscription.id}
      and subscriber_version = ${subscription.version}
      and declaration_hash = ${registry.declarationHash}
      and status = 'active'
      and (claim_lease_until is null or claim_lease_until < clock_timestamp())
    returning claim_lease_until
  `);
  const row = rows[0];
  if (row) {
    return {
      subscriberId: subscription.id,
      subscriberVersion: subscription.version,
      declarationHash: registry.declarationHash,
      claimOwner: owner,
      claimToken: token,
      leaseUntil: row.claim_lease_until,
    };
  }

  const checkpoints = await db.execute<{ declaration_hash: string; status: string }>(sql`
    select declaration_hash, status
    from event_subscription_checkpoint
    where subscriber_id = ${subscription.id} and subscriber_version = ${subscription.version}
  `);
  const checkpoint = checkpoints[0];
  if (checkpoint && checkpoint.declaration_hash !== registry.declarationHash) {
    throw new Error(
      `event subscription '${subscription.id}@v${subscription.version}' declaration hash mismatch`,
    );
  }
  if (checkpoint?.status === 'paused') {
    throw new Error(`event subscription '${subscription.id}@v${subscription.version}' is paused`);
  }
  return null;
}

export async function renewSubscriptionLease(db: Db, lease: SubscriptionLease): Promise<boolean> {
  const rows = await db.execute(sql`
    update event_subscription_checkpoint
    set claim_lease_until = clock_timestamp() + interval '2 minutes',
        updated_at = clock_timestamp()
    where subscriber_id = ${lease.subscriberId}
      and subscriber_version = ${lease.subscriberVersion}
      and declaration_hash = ${lease.declarationHash}
      and claim_owner = ${lease.claimOwner}
      and claim_token = ${lease.claimToken}::uuid
      and claim_lease_until >= clock_timestamp()
    returning subscriber_id
  `);
  return rows.length === 1;
}

async function releaseSubscriptionLease(db: Db, lease: SubscriptionLease): Promise<void> {
  await db.execute(sql`
    update event_subscription_checkpoint
    set claim_owner = null,
        claim_token = null,
        claim_lease_until = null,
        updated_at = clock_timestamp()
    where subscriber_id = ${lease.subscriberId}
      and subscriber_version = ${lease.subscriberVersion}
      and declaration_hash = ${lease.declarationHash}
      and claim_owner = ${lease.claimOwner}
      and claim_token = ${lease.claimToken}::uuid
  `);
}

/**
 * Discovers with an anti-join, never with a dispatch_seq watermark. The
 * checkpoint lock serializes delivery_seq allocation for this one subscriber.
 */
export async function discoverSubscriptionDeliveries(
  db: Db,
  registry: LoadedEventSubscriptionRegistry,
  subscription: LoadedEventSubscription,
  lease: SubscriptionLease,
): Promise<number> {
  const declared = getDeclaredSubscription(registry, subscription);
  return db.transaction(async (tx) => {
    const checkpoints = await tx.execute<{
      next_delivery_seq: string;
    }>(sql`
      select next_delivery_seq
      from event_subscription_checkpoint
      where subscriber_id = ${subscription.id}
        and subscriber_version = ${subscription.version}
        and declaration_hash = ${registry.declarationHash}
        and status = 'active'
        and claim_owner = ${lease.claimOwner}
        and claim_token = ${lease.claimToken}::uuid
        and claim_lease_until >= clock_timestamp()
      for update
    `);
    const checkpoint = checkpoints[0];
    if (!checkpoint) return 0;

    const actionList = sql.join(
      declared.actions.map((action) => sql`${action}`),
      sql`, `,
    );
    const sources = await tx.execute<{ id: string; dispatch_seq: number }>(sql`
      select e.id, e.dispatch_seq
      from event e
      where e.action in (${actionList})
        and not exists (
          select 1
          from event_subscription_delivery d
          where d.subscriber_id = ${subscription.id}
            and d.subscriber_version = ${subscription.version}
            and d.source_event_id = e.id
        )
      order by e.dispatch_seq, e.id
    `);

    let nextDeliverySeq = asBigint(checkpoint.next_delivery_seq);
    let inserted = 0;
    for (const source of sources) {
      const rows = await tx.execute(sql`
        insert into event_subscription_delivery
          (subscriber_id, subscriber_version, source_event_id, source_dispatch_seq, delivery_seq, status)
        values (${subscription.id}, ${subscription.version}, ${source.id}, ${source.dispatch_seq},
          ${nextDeliverySeq}, 'pending')
        on conflict (subscriber_id, subscriber_version, source_event_id) do nothing
        returning source_event_id
      `);
      if (rows.length === 1) {
        nextDeliverySeq += 1n;
        inserted += 1;
      }
    }
    if (inserted > 0) {
      const advanced = await tx.execute(sql`
        update event_subscription_checkpoint
        set next_delivery_seq = ${nextDeliverySeq}, updated_at = clock_timestamp()
        where subscriber_id = ${subscription.id}
          and subscriber_version = ${subscription.version}
          and declaration_hash = ${registry.declarationHash}
          and status = 'active'
          and claim_owner = ${lease.claimOwner}
          and claim_token = ${lease.claimToken}::uuid
          and claim_lease_until >= clock_timestamp()
        returning subscriber_id
      `);
      if (advanced.length !== 1) {
        throw new Error(
          `event subscription '${subscription.id}@v${subscription.version}' lost checkpoint lease during discovery`,
        );
      }
    }
    return inserted;
  });
}

/**
 * Claims only the earliest non-terminal delivery. A not-yet-due retry_wait or
 * live claimed predecessor blocks every later delivery for the subscriber.
 */
export async function claimNextSubscriptionDelivery(
  db: Db,
  registry: LoadedEventSubscriptionRegistry,
  subscription: LoadedEventSubscription,
  lease: SubscriptionLease,
): Promise<SubscriptionDeliveryClaim | null> {
  getDeclaredSubscription(registry, subscription);
  if (
    lease.subscriberId !== subscription.id ||
    lease.subscriberVersion !== subscription.version ||
    lease.declarationHash !== registry.declarationHash
  ) {
    throw new Error(
      `event subscription '${subscription.id}@v${subscription.version}' lease identity mismatch`,
    );
  }
  const token = randomUUID();
  const rows = await withLockedCheckpoint(
    db,
    {
      subscriberId: subscription.id,
      subscriberVersion: subscription.version,
      declarationHash: registry.declarationHash,
      claimOwner: lease.claimOwner,
      claimToken: lease.claimToken,
    },
    async (tx) =>
      tx.execute<{
        source_event_id: string;
        delivery_seq: number;
        claim_lease_until: Date;
      }>(sql`
      with candidate as (
        select d.source_event_id
        from event_subscription_delivery d
        where d.subscriber_id = ${subscription.id}
          and d.subscriber_version = ${subscription.version}
          and d.status not in ('bootstrap_skipped', 'succeeded', 'skipped', 'dead_letter')
        order by d.delivery_seq
        for update of d
        limit 1
      )
      update event_subscription_delivery d
      set status = 'claimed',
          claim_owner = ${lease.claimOwner},
          claim_token = ${token}::uuid,
          claim_lease_until = clock_timestamp() + interval '2 minutes',
          claimed_at = clock_timestamp(),
          next_attempt_at = null,
          updated_at = clock_timestamp()
      from candidate
      where d.source_event_id = candidate.source_event_id
        and d.subscriber_id = ${subscription.id}
        and d.subscriber_version = ${subscription.version}
        and (
          d.status = 'pending'
          or (d.status = 'retry_wait' and d.next_attempt_at <= clock_timestamp())
          or (d.status = 'claimed' and d.claim_lease_until < clock_timestamp())
        )
      returning d.source_event_id, d.delivery_seq, d.claim_lease_until
    `),
  );
  const row = rows?.[0];
  return row
    ? {
        subscriberId: subscription.id,
        subscriberVersion: subscription.version,
        declarationHash: registry.declarationHash,
        sourceEventId: row.source_event_id,
        deliverySeq: asBigint(row.delivery_seq),
        claimOwner: lease.claimOwner,
        claimToken: token,
        checkpointClaimOwner: lease.claimOwner,
        checkpointClaimToken: lease.claimToken,
        leaseUntil: row.claim_lease_until,
      }
    : null;
}

export async function renewSubscriptionDeliveryLease(
  db: Db,
  claim: SubscriptionDeliveryClaim,
): Promise<boolean> {
  const rows = await withLockedCheckpoint(
    db,
    {
      subscriberId: claim.subscriberId,
      subscriberVersion: claim.subscriberVersion,
      declarationHash: claim.declarationHash,
      claimOwner: claim.checkpointClaimOwner,
      claimToken: claim.checkpointClaimToken,
    },
    async (tx) =>
      tx.execute(sql`
        update event_subscription_delivery
        set claim_lease_until = clock_timestamp() + interval '2 minutes',
            updated_at = clock_timestamp()
        where subscriber_id = ${claim.subscriberId}
          and subscriber_version = ${claim.subscriberVersion}
          and source_event_id = ${claim.sourceEventId}
          and status = 'claimed'
          and claim_owner = ${claim.claimOwner}
          and claim_token = ${claim.claimToken}::uuid
          and claim_lease_until >= clock_timestamp()
        returning source_event_id
      `),
  );
  return rows?.length === 1;
}

export async function completeSubscriptionDelivery(
  db: Db,
  claim: SubscriptionDeliveryClaim,
  outcome: EventSubscriptionOutcome,
): Promise<boolean> {
  const rows = await withLockedCheckpoint(
    db,
    {
      subscriberId: claim.subscriberId,
      subscriberVersion: claim.subscriberVersion,
      declarationHash: claim.declarationHash,
      claimOwner: claim.checkpointClaimOwner,
      claimToken: claim.checkpointClaimToken,
    },
    async (tx) =>
      tx.execute(sql`
        update event_subscription_delivery
        set status = ${outcome.status},
            claim_owner = null,
            claim_token = null,
            claim_lease_until = null,
            claimed_at = null,
            next_attempt_at = null,
            outcome = ${JSON.stringify(outcome.detail ?? {})}::jsonb,
            last_error = ${outcome.status === 'skipped' ? outcome.reason : null},
            completed_at = clock_timestamp(),
            updated_at = clock_timestamp()
        where subscriber_id = ${claim.subscriberId}
          and subscriber_version = ${claim.subscriberVersion}
          and source_event_id = ${claim.sourceEventId}
          and status = 'claimed'
          and claim_owner = ${claim.claimOwner}
          and claim_token = ${claim.claimToken}::uuid
          and claim_lease_until >= clock_timestamp()
        returning source_event_id
      `),
  );
  return rows?.length === 1;
}

export async function failSubscriptionDelivery(
  db: Db,
  claim: SubscriptionDeliveryClaim,
  error: unknown,
  // retryDelaySeconds is configurable (default 1s, current behavior) so a caller can widen the
  // backoff away from the aggressive 1s storm without editing SQL string literals (YUK-751 review).
  options: { maxAttempts: number; retryDelaySeconds?: number },
): Promise<'retry_wait' | 'dead_letter' | 'lost_lease'> {
  const message = error instanceof Error ? error.message : String(error);
  const rows = await withLockedCheckpoint(
    db,
    {
      subscriberId: claim.subscriberId,
      subscriberVersion: claim.subscriberVersion,
      declarationHash: claim.declarationHash,
      claimOwner: claim.checkpointClaimOwner,
      claimToken: claim.checkpointClaimToken,
    },
    async (tx) =>
      tx.execute<{ attempt_count: number }>(sql`
        update event_subscription_delivery
        set status = case when attempt_count + 1 >= ${options.maxAttempts} then 'dead_letter' else 'retry_wait' end,
            attempt_count = attempt_count + 1,
            claim_owner = null,
            claim_token = null,
            claim_lease_until = null,
            claimed_at = null,
            next_attempt_at = case
              when attempt_count + 1 >= ${options.maxAttempts} then null
              else clock_timestamp() + ${options.retryDelaySeconds ?? 1} * interval '1 second'
            end,
            last_error = ${message},
            completed_at = case when attempt_count + 1 >= ${options.maxAttempts} then clock_timestamp() else null end,
            updated_at = clock_timestamp()
        where subscriber_id = ${claim.subscriberId}
          and subscriber_version = ${claim.subscriberVersion}
          and source_event_id = ${claim.sourceEventId}
          and status = 'claimed'
          and claim_owner = ${claim.claimOwner}
          and claim_token = ${claim.claimToken}::uuid
          and claim_lease_until >= clock_timestamp()
        returning attempt_count
      `),
  );
  if (!rows || rows.length === 0) return 'lost_lease';
  return rows[0].attempt_count >= options.maxAttempts ? 'dead_letter' : 'retry_wait';
}

export async function redriveSubscriptionDelivery(
  db: Db,
  registry: LoadedEventSubscriptionRegistry,
  subscription: SubscriptionIdentity,
  sourceEventId: string,
): Promise<boolean> {
  getDeclaredSubscription(registry, subscription);
  const rows = await db.transaction(async (tx) => {
    const checkpoints = await tx.execute(sql`
      select subscriber_id
      from event_subscription_checkpoint
      where subscriber_id = ${subscription.id}
        and subscriber_version = ${subscription.version}
        and declaration_hash = ${registry.declarationHash}
        and status = 'active'
      for update
    `);
    if (checkpoints.length !== 1) return [];
    return tx.execute(sql`
      update event_subscription_delivery d
    set status = 'retry_wait',
        redrive_count = d.redrive_count + 1,
        claim_owner = null,
        claim_token = null,
        claim_lease_until = null,
        claimed_at = null,
        next_attempt_at = clock_timestamp(),
        completed_at = null,
        updated_at = clock_timestamp()
    from event_subscription_checkpoint c
    where d.subscriber_id = ${subscription.id}
      and d.subscriber_version = ${subscription.version}
      and d.source_event_id = ${sourceEventId}
      and c.subscriber_id = d.subscriber_id
      and c.subscriber_version = d.subscriber_version
      and c.declaration_hash = ${registry.declarationHash}
      and c.status = 'active'
      and d.status = 'dead_letter'
      and not exists (
        select 1
        from event_subscription_delivery later
        where later.subscriber_id = d.subscriber_id
          and later.subscriber_version = d.subscriber_version
          and later.delivery_seq > d.delivery_seq
          and (
            later.status <> 'pending'
            or later.attempt_count > 0
            or later.redrive_count > 0
          )
      )
      returning d.source_event_id
    `);
  });
  return rows.length === 1;
}

export type SubscriptionDispatchCycleResult = {
  dispatched: number;
  succeeded: number;
  skipped: number;
  retryScheduled: number;
  deadLettered: number;
};

/** Performs at most one delivery per declared subscriber, with no worker wiring. */
export async function runSubscriptionDispatchCycle(
  db: Db,
  registry: LoadedEventSubscriptionRegistry,
  options: {
    owner: string;
    maxAttempts: number;
    handlerTimeoutMs?: number;
    retryDelaySeconds?: number;
  },
): Promise<SubscriptionDispatchCycleResult> {
  const result: SubscriptionDispatchCycleResult = {
    dispatched: 0,
    succeeded: 0,
    skipped: 0,
    retryScheduled: 0,
    deadLettered: 0,
  };

  for (const subscription of registry.subscriptions) {
    // YUK-751 (OCR major): per-subscription error boundary. bootstrapSubscription /
    // claimSubscriptionLease / discoverSubscriptionDeliveries / claimNextSubscriptionDelivery all
    // sat outside any catch, so one throwing subscriber (declaration-hash mismatch, DB blip, …)
    // aborted the WHOLE cycle and starved every other subscriber. Isolate each: log + skip, then the
    // rest still run. The delivery HANDLER keeps its own inner catch (failSubscriptionDelivery
    // retry/dead-letter semantics); this boundary is for the infra steps around it.
    try {
      await bootstrapSubscription(db, registry, subscription);
      const lease = await claimSubscriptionLease(db, registry, subscription, options.owner);
      if (!lease) continue;
      try {
        await discoverSubscriptionDeliveries(db, registry, subscription, lease);
        const claim = await claimNextSubscriptionDelivery(db, registry, subscription, lease);
        if (!claim) continue;

        result.dispatched += 1;
        try {
          const outcome = await withTimeout(
            subscription.handler({
              subscriberId: subscription.id,
              subscriberVersion: subscription.version,
              // Serialize the bigint at the handler boundary (manifest contract is a decimal string).
              deliverySeq: claim.deliverySeq.toString(),
              sourceEventId: claim.sourceEventId,
            }),
            options.handlerTimeoutMs ?? DEFAULT_HANDLER_TIMEOUT_MS,
            `event subscription '${subscription.id}@v${subscription.version}' handler exceeded ${options.handlerTimeoutMs ?? DEFAULT_HANDLER_TIMEOUT_MS}ms (below lease TTL) — failing delivery for retry to avoid lease-expiry double-processing`,
          );
          if (await completeSubscriptionDelivery(db, claim, outcome)) {
            if (outcome.status === 'succeeded') result.succeeded += 1;
            else result.skipped += 1;
          }
        } catch (error) {
          const transition = await failSubscriptionDelivery(db, claim, error, options);
          if (transition === 'retry_wait') result.retryScheduled += 1;
          if (transition === 'dead_letter') result.deadLettered += 1;
        }
      } finally {
        await releaseSubscriptionLease(db, lease);
      }
    } catch (error) {
      console.error(
        '[event-subscriptions] subscription dispatch step failed; skipping subscriber',
        {
          subscriber: `${subscription.id}@v${subscription.version}`,
          error,
        },
      );
    }
  }
  return result;
}
