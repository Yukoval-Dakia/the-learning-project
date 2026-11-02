import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Db } from '@/db/client';

import type { EventSubscriptionOutcome } from '@/kernel/manifest';

import type { LoadedEventSubscription, LoadedEventSubscriptionRegistry } from './types';

type SubscriptionIdentity = Pick<LoadedEventSubscription, 'id' | 'version'>;

// Discovery materializes at most this many deliveries per transaction. Without a
// bound, a new subscriber's first discovery could load and insert the whole event
// log in one tx (memory plus a long checkpoint-row lock).
const DISCOVERY_BATCH_SIZE = 1_000;

// Checkpoint and delivery claim lease TTL. Single source for every claim and renew
// site so the intervals cannot drift.
const LEASE_TTL_SECONDS = 120;

// A handler must finish inside the lease TTL. The lease is not renewed while it
// runs, so a slower handler lets another worker take over and process the same
// delivery twice. On timeout the promise is abandoned (JS cannot cancel it), so
// side effects must be idempotent; delivery-key dedup already assumes that.
const DEFAULT_HANDLER_TIMEOUT_MS = 90_000;

// Keep the default timeout below the lease TTL, or a slow handler outlives its lease.
if (DEFAULT_HANDLER_TIMEOUT_MS >= LEASE_TTL_SECONDS * 1000) {
  throw new Error(
    `event subscription DEFAULT_HANDLER_TIMEOUT_MS (${DEFAULT_HANDLER_TIMEOUT_MS}ms) must be below the lease TTL (${LEASE_TTL_SECONDS}s)`,
  );
}

// Reject non-finite or non-positive values at entry; they would corrupt the
// lease bound and the backoff SQL.
function assertPositiveFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      `event subscription dispatch option '${name}' must be a positive finite number, got ${value}`,
    );
  }
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(
      `event subscription dispatch option '${name}' must be a positive integer, got ${value}`,
    );
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  // When the timeout wins, the abandoned promise may reject later; swallow and
  // log it so the process-level unhandled-rejection guard does not exit the worker.
  void promise.catch((err) => {
    console.info(
      '[event-subscriptions] subscription handler promise rejected (abandoned after timeout, or already handled)',
      { error: err },
    );
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
 * Bootstrap a subscriber in one transaction. The tx's MVCC snapshot defines
 * history: visible events become bootstrap_skipped, then the checkpoint becomes
 * active. No seq/xmin fence or resumable phase; event rows are mutable (the memory
 * outbox updates ingest_at), so snapshot visibility is the correct boundary.
 * Events committing later are picked up by discovery.
 *
 * A version bump translates outstanding deliveries before marking history:
 * still-subscribed events become pending/retry_wait with seq and attempts
 * preserved; the rest become explicitly skipped. Terminal rows stay untouched.
 */
export interface BootstrapTranslation {
  /** Outstanding old rows translated into this version. */
  translated: number;
  /** Outstanding old rows terminalized (translated or no longer subscribed). */
  superseded: number;
}

export async function bootstrapSubscription(
  db: Db,
  registry: LoadedEventSubscriptionRegistry,
  subscription: LoadedEventSubscription,
): Promise<BootstrapTranslation> {
  const declared = getDeclaredSubscription(registry, subscription);
  const declarationHash = declared.declarationHash;
  const actionList = sql.join(
    declared.actions.map((action) => sql`${action}`),
    sql`, `,
  );

  return db.transaction(async (tx) => {
    // RETURNING distinguishes a fresh bootstrap (this run marks history) from an
    // existing subscriber. Concurrent bootstraps serialize on the ON CONFLICT row lock.
    const inserted = await tx.execute(sql`
      insert into event_subscription_checkpoint
        (subscriber_id, subscriber_version, declaration_hash, status, bootstrapped_at, activated_at)
      values (${subscription.id}, ${subscription.version}, ${declarationHash}, 'active',
        clock_timestamp(), clock_timestamp())
      on conflict (subscriber_id, subscriber_version) do nothing
      returning subscriber_id
    `);
    if (inserted.length === 0) {
      // Already bootstrapped: fail closed on declaration drift, otherwise nothing to do.
      const rows = await tx.execute<{ declaration_hash: string }>(sql`
        select declaration_hash
        from event_subscription_checkpoint
        where subscriber_id = ${subscription.id}
          and subscriber_version = ${subscription.version}
        for update
      `);
      const existing = rows[0];
      if (!existing) throw new Error('event subscription checkpoint vanished during bootstrap');
      if (existing.declaration_hash !== declarationHash) {
        throw new Error(
          `event subscription '${subscription.id}@v${subscription.version}' declaration hash mismatch`,
        );
      }
      return { translated: 0, superseded: 0 };
    }

    // Translate old outstanding rows before marking history. Claimed rows lose
    // their claim; retry_wait keeps next_attempt_at and attempts. Rows whose event
    // is no longer subscribed get no new row and are terminalized below.
    // ON CONFLICT makes a rerun idempotent.
    const translated = await tx.execute<{ delivery_seq: string }>(sql`
      insert into event_subscription_delivery
        (subscriber_id, subscriber_version, source_event_id, source_dispatch_seq, delivery_seq,
         status, attempt_count, redrive_count, next_attempt_at, last_error)
      select ${subscription.id}, ${subscription.version}, od.source_event_id, od.source_dispatch_seq,
        row_number() over (order by od.source_dispatch_seq, od.source_event_id),
        case when od.status = 'retry_wait' then 'retry_wait' else 'pending' end,
        od.attempt_count, od.redrive_count,
        case when od.status = 'retry_wait' then od.next_attempt_at else null end,
        od.last_error
      from event_subscription_delivery od
      join event e on e.id = od.source_event_id
      where od.subscriber_id = ${subscription.id}
        and od.subscriber_version < ${subscription.version}
        and od.status in ('pending', 'claimed', 'retry_wait')
        and e.action in (${actionList})
      on conflict (subscriber_id, subscriber_version, source_event_id) do nothing
      returning delivery_seq
    `);
    const translatedCount = translated.length;

    // Mark the rest of the snapshot bootstrap_skipped. Translated rows occupy the
    // prefix and history follows, preserving oldest-work-first order. A fresh
    // subscriber cannot conflict (the checkpoint FK gates deliveries); ON CONFLICT
    // only guards a concurrent writer.
    await tx.execute(sql`
      insert into event_subscription_delivery
        (subscriber_id, subscriber_version, source_event_id, source_dispatch_seq, delivery_seq,
         status, completed_at)
      select ${subscription.id}, ${subscription.version}, e.id, e.dispatch_seq,
        ${translatedCount}::bigint + row_number() over (order by e.dispatch_seq, e.id),
        'bootstrap_skipped', clock_timestamp()
      from event e
      where e.action in (${actionList})
      on conflict (subscriber_id, subscriber_version, source_event_id) do nothing
    `);

    // Must advance to max(delivery_seq)+1, not count(*)+1: conflict-dropped
    // history slots leave gaps, and count+1 would collide with the local seq
    // unique index on the next discovery batch.
    await tx.execute(sql`
      update event_subscription_checkpoint
      set next_delivery_seq = 1 + (
            select coalesce(max(delivery_seq), 0) from event_subscription_delivery
            where subscriber_id = ${subscription.id}
              and subscriber_version = ${subscription.version}
          ),
          updated_at = clock_timestamp()
      where subscriber_id = ${subscription.id}
        and subscriber_version = ${subscription.version}
    `);

    // Terminalize old outstanding rows: translated ones get 'translated_to_vN',
    // the rest 'superseded_by_version_bootstrap'. Clear claim, lease and
    // next_attempt_at to satisfy the skipped shape check; terminal rows stay put.
    const superseded = await tx.execute<{ source_event_id: string }>(sql`
      update event_subscription_delivery od
      set status = 'skipped',
          claim_owner = null,
          claim_token = null,
          claim_lease_until = null,
          claimed_at = null,
          next_attempt_at = null,
          completed_at = clock_timestamp(),
          updated_at = clock_timestamp(),
          last_error = case
            when exists (
              select 1 from event_subscription_delivery nv
              where nv.subscriber_id = od.subscriber_id
                and nv.subscriber_version = ${subscription.version}
                and nv.source_event_id = od.source_event_id
            ) then 'translated_to_v' || ${subscription.version}::text
            else 'superseded_by_version_bootstrap'
          end
      where od.subscriber_id = ${subscription.id}
        and od.subscriber_version < ${subscription.version}
        and od.status in ('pending', 'claimed', 'retry_wait')
      returning od.source_event_id
    `);

    return { translated: translatedCount, superseded: superseded.length };
  });
}

/** Claim a checkpoint lease, including expired-lease takeover, fenced by the declaration hash. */
export async function claimSubscriptionLease(
  db: Db,
  registry: LoadedEventSubscriptionRegistry,
  subscription: SubscriptionIdentity,
  owner: string,
): Promise<SubscriptionLease | null> {
  const declarationHash = getDeclaredSubscription(registry, subscription).declarationHash;
  const token = randomUUID();
  const rows = await db.execute<{
    claim_lease_until: Date;
  }>(sql`
    update event_subscription_checkpoint
    set claim_owner = ${owner},
        claim_token = ${token}::uuid,
        claim_lease_until = clock_timestamp() + ${LEASE_TTL_SECONDS} * interval '1 second',
        updated_at = clock_timestamp()
    where subscriber_id = ${subscription.id}
      and subscriber_version = ${subscription.version}
      and declaration_hash = ${declarationHash}
      and status = 'active'
      and (claim_lease_until is null or claim_lease_until < clock_timestamp())
    returning claim_lease_until
  `);
  const row = rows[0];
  if (row) {
    return {
      subscriberId: subscription.id,
      subscriberVersion: subscription.version,
      declarationHash,
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
  if (checkpoint && checkpoint.declaration_hash !== declarationHash) {
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
    set claim_lease_until = clock_timestamp() + ${LEASE_TTL_SECONDS} * interval '1 second',
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
 * Insert undelivered events with an anti-join, never a dispatch_seq watermark.
 * Drains in bounded transactions that re-check the lease, and allocates
 * delivery_seq in SQL with row_number(). The checkpoint lock serializes allocation
 * for this subscriber.
 */
export async function discoverSubscriptionDeliveries(
  db: Db,
  registry: LoadedEventSubscriptionRegistry,
  subscription: LoadedEventSubscription,
  lease: SubscriptionLease,
): Promise<number> {
  const declared = getDeclaredSubscription(registry, subscription);
  const declarationHash = declared.declarationHash;
  const actionList = sql.join(
    declared.actions.map((action) => sql`${action}`),
    sql`, `,
  );

  let total = 0;
  while (true) {
    const insertedThisBatch = await db.transaction(async (tx) => {
      const checkpoints = await tx.execute<{
        next_delivery_seq: string;
      }>(sql`
        select next_delivery_seq
        from event_subscription_checkpoint
        where subscriber_id = ${subscription.id}
          and subscriber_version = ${subscription.version}
          and declaration_hash = ${declarationHash}
          and status = 'active'
          and claim_owner = ${lease.claimOwner}
          and claim_token = ${lease.claimToken}::uuid
          and claim_lease_until >= clock_timestamp()
        for update
      `);
      const checkpoint = checkpoints[0];
      if (!checkpoint) return 0; // lease lost / no longer active → stop draining, keep what's done

      // The anti-join takes up to LIMIT undelivered events by dispatch_seq, and
      // row_number() allocates delivery_seq from next_delivery_seq in SQL. The
      // lease serializes discovery, so ON CONFLICT is belt-and-braces.
      const baseSeq = asBigint(checkpoint.next_delivery_seq);
      const insertedRows = await tx.execute<{ delivery_seq: string }>(sql`
        with candidates as (
          select e.id, e.dispatch_seq,
            (${baseSeq}::bigint - 1) + row_number() over (order by e.dispatch_seq, e.id) as delivery_seq
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
          limit ${DISCOVERY_BATCH_SIZE}
        )
        insert into event_subscription_delivery
          (subscriber_id, subscriber_version, source_event_id, source_dispatch_seq, delivery_seq, status)
        select ${subscription.id}, ${subscription.version}, c.id, c.dispatch_seq, c.delivery_seq, 'pending'
        from candidates c
        on conflict (subscriber_id, subscriber_version, source_event_id) do nothing
        returning delivery_seq
      `);
      const inserted = insertedRows.length;
      if (inserted > 0) {
        // Advance to max+1, robust against gaps, under the same lease fence.
        const advanced = await tx.execute(sql`
          update event_subscription_checkpoint
          set next_delivery_seq = (
                select coalesce(max(delivery_seq), 0) + 1
                from event_subscription_delivery
                where subscriber_id = ${subscription.id}
                  and subscriber_version = ${subscription.version}
              ),
              updated_at = clock_timestamp()
          where subscriber_id = ${subscription.id}
            and subscriber_version = ${subscription.version}
            and declaration_hash = ${declarationHash}
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
    total += insertedThisBatch;
    // A zero-insert batch means the backlog is drained or the lease is gone; stop.
    if (insertedThisBatch === 0) break;
  }
  return total;
}

/**
 * Claim only the earliest non-terminal delivery. A not-yet-due retry_wait or a
 * live claimed predecessor blocks every later delivery for the subscriber.
 */
export async function claimNextSubscriptionDelivery(
  db: Db,
  registry: LoadedEventSubscriptionRegistry,
  subscription: LoadedEventSubscription,
  lease: SubscriptionLease,
): Promise<SubscriptionDeliveryClaim | null> {
  const declarationHash = getDeclaredSubscription(registry, subscription).declarationHash;
  if (
    lease.subscriberId !== subscription.id ||
    lease.subscriberVersion !== subscription.version ||
    lease.declarationHash !== declarationHash
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
      declarationHash,
      claimOwner: lease.claimOwner,
      claimToken: lease.claimToken,
    },
    async (tx) =>
      tx.execute<{
        source_event_id: string;
        // postgres returns bigint as a decimal string; asBigint normalizes it.
        delivery_seq: string;
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
          claim_lease_until = clock_timestamp() + ${LEASE_TTL_SECONDS} * interval '1 second',
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
        declarationHash,
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
        set claim_lease_until = clock_timestamp() + ${LEASE_TTL_SECONDS} * interval '1 second',
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
  // Configurable so callers can widen the aggressive 1s default without editing SQL.
  options: { maxAttempts: number; retryDelaySeconds?: number },
): Promise<'retry_wait' | 'dead_letter' | 'lost_lease'> {
  // Exported entry: validate numeric options before they reach the dead-letter
  // threshold or the backoff SQL.
  assertPositiveInteger(options.maxAttempts, 'maxAttempts');
  if (options.retryDelaySeconds !== undefined) {
    assertPositiveFinite(options.retryDelaySeconds, 'retryDelaySeconds');
  }
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
  const declarationHash = getDeclaredSubscription(registry, subscription).declarationHash;
  const rows = await db.transaction(async (tx) => {
    const checkpoints = await tx.execute(sql`
      select subscriber_id
      from event_subscription_checkpoint
      where subscriber_id = ${subscription.id}
        and subscriber_version = ${subscription.version}
        and declaration_hash = ${declarationHash}
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
      and c.declaration_hash = ${declarationHash}
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
  /**
   * Deliveries claimed this cycle; equals succeeded + skipped + retryScheduled +
   * deadLettered + lostLease.
   */
  dispatched: number;
  succeeded: number;
  skipped: number;
  retryScheduled: number;
  deadLettered: number;
  /** Claims lost to another worker before the terminal write; keeps dispatched reconciled. */
  lostLease: number;
};

/**
 * Drain subscriptions concurrently, one lease and one in-flight handler each.
 * Direct callers keep one delivery per subscriber; production passes a bounded slice.
 */
export async function runSubscriptionDispatchCycle(
  db: Db,
  registry: LoadedEventSubscriptionRegistry,
  options: {
    owner: string;
    maxAttempts: number;
    handlerTimeoutMs?: number;
    retryDelaySeconds?: number;
    maxDeliveriesPerSubscription?: number;
    /** Stop STARTING claims after this budget; never shorten an active handler's timeout. */
    maxDispatchMs?: number;
  },
): Promise<SubscriptionDispatchCycleResult> {
  assertPositiveInteger(options.maxAttempts, 'maxAttempts');
  const maxDeliveries = options.maxDeliveriesPerSubscription ?? 1;
  const maxDispatchMs = options.maxDispatchMs ?? 30_000;
  assertPositiveInteger(maxDeliveries, 'maxDeliveriesPerSubscription');
  assertPositiveFinite(maxDispatchMs, 'maxDispatchMs');
  if (options.handlerTimeoutMs !== undefined) {
    assertPositiveFinite(options.handlerTimeoutMs, 'handlerTimeoutMs');
    if (options.handlerTimeoutMs >= LEASE_TTL_SECONDS * 1000) {
      throw new Error(
        `event subscription dispatch option 'handlerTimeoutMs' (${options.handlerTimeoutMs}ms) must stay below the lease TTL (${LEASE_TTL_SECONDS}s)`,
      );
    }
  }
  if (options.retryDelaySeconds !== undefined) {
    assertPositiveFinite(options.retryDelaySeconds, 'retryDelaySeconds');
  }

  // The registry bounds concurrency: one serial slice per subscriber. Each
  // checkpoint lease still serializes across workers.
  const results = await Promise.all(
    registry.subscriptions.map(async (subscription) => {
      const startedAt = performance.now();
      const result: SubscriptionDispatchCycleResult = {
        dispatched: 0,
        succeeded: 0,
        skipped: 0,
        retryScheduled: 0,
        deadLettered: 0,
        lostLease: 0,
      };
      let stoppedBecause = 'lease_unavailable';
      let firstDeliverySeq: string | null = null;
      let lastDeliverySeq: string | null = null;
      try {
        const bootstrap = await bootstrapSubscription(db, registry, subscription);
        if (bootstrap.translated > 0 || bootstrap.superseded > 0) {
          console.info('[event-subscriptions] bootstrap translated outstanding deliveries', {
            subscriber: `${subscription.id}@v${subscription.version}`,
            translated: bootstrap.translated,
            superseded: bootstrap.superseded,
          });
        }
        const lease = await claimSubscriptionLease(db, registry, subscription, options.owner);
        if (!lease) return result;
        try {
          await discoverSubscriptionDeliveries(db, registry, subscription, lease);
          stoppedBecause = 'delivery_limit';
          while (result.dispatched < maxDeliveries) {
            if (performance.now() - startedAt >= maxDispatchMs) {
              stoppedBecause = 'time_budget';
              break;
            }
            // Discovery and earlier handlers consume lease time, so renew before
            // each claim, not once per batch.
            if (!(await renewSubscriptionLease(db, lease))) {
              stoppedBecause = 'lost_checkpoint_lease';
              break;
            }
            if (performance.now() - startedAt >= maxDispatchMs) {
              stoppedBecause = 'time_budget';
              break;
            }
            const claim = await claimNextSubscriptionDelivery(db, registry, subscription, lease);
            if (!claim) {
              // Includes a not-yet-due retry or another still-leased head; never
              // scan around it to reorder deliveries.
              stoppedBecause = 'empty_or_blocked';
              break;
            }
            result.dispatched += 1;
            firstDeliverySeq ??= claim.deliverySeq.toString();
            lastDeliverySeq = claim.deliverySeq.toString();
            try {
              const outcome = await withTimeout(
                subscription.handler({
                  subscriberId: subscription.id,
                  subscriberVersion: subscription.version,
                  deliverySeq: claim.deliverySeq.toString(),
                  sourceEventId: claim.sourceEventId,
                }),
                options.handlerTimeoutMs ?? DEFAULT_HANDLER_TIMEOUT_MS,
                `event subscription '${subscription.id}@v${subscription.version}' handler exceeded ${options.handlerTimeoutMs ?? DEFAULT_HANDLER_TIMEOUT_MS}ms (below lease TTL) — failing delivery for retry to avoid lease-expiry double-processing`,
              );
              if (await completeSubscriptionDelivery(db, claim, outcome)) {
                if (outcome.status === 'succeeded') result.succeeded += 1;
                else result.skipped += 1;
              } else {
                result.lostLease += 1;
                stoppedBecause = 'lost_delivery_lease';
                break;
              }
            } catch (error) {
              const transition = await failSubscriptionDelivery(db, claim, error, options);
              if (transition === 'retry_wait') result.retryScheduled += 1;
              else if (transition === 'dead_letter') result.deadLettered += 1;
              else result.lostLease += 1;
              // End the slice even on terminal failure; a timed-out handler may
              // still be unwinding.
              stoppedBecause = transition;
              break;
            }
          }
        } finally {
          try {
            await releaseSubscriptionLease(db, lease);
          } catch (releaseErr) {
            console.error('[event-subscriptions] lease release failed (non-fatal)', {
              subscriber: `${subscription.id}@v${subscription.version}`,
              error: releaseErr,
            });
          }
        }
      } catch (error) {
        stoppedBecause = 'infrastructure_error';
        console.error(
          '[event-subscriptions] subscription dispatch step failed; skipping subscriber',
          {
            subscriber: `${subscription.id}@v${subscription.version}`,
            error,
          },
        );
      } finally {
        console.info('[event-subscriptions] subscriber dispatch slice', {
          subscriber: `${subscription.id}@v${subscription.version}`,
          ...result,
          firstDeliverySeq,
          lastDeliverySeq,
          durationMs: Math.round(performance.now() - startedAt),
          stoppedBecause,
          maxDeliveries,
          maxDispatchMs,
        });
      }
      return result;
    }),
  );

  return results.reduce(
    (total, result) => ({
      dispatched: total.dispatched + result.dispatched,
      succeeded: total.succeeded + result.succeeded,
      skipped: total.skipped + result.skipped,
      retryScheduled: total.retryScheduled + result.retryScheduled,
      deadLettered: total.deadLettered + result.deadLettered,
      lostLease: total.lostLease + result.lostLease,
    }),
    { dispatched: 0, succeeded: 0, skipped: 0, retryScheduled: 0, deadLettered: 0, lostLease: 0 },
  );
}
