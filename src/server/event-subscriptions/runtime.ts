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

// Max pending deliveries materialized per discovery transaction (YUK-751 OCR major Tcd9r): the
// anti-join over the immutable event log was unbounded, so a large backlog (e.g. first discovery for
// a new action) loaded + inserted every row in one tx (memory + a long checkpoint-row lock).
// Discovery now drains in bounded batches — one tx each, re-fencing the lease — exactly like bootstrap.
const DISCOVERY_BATCH_SIZE = 1_000;

// CONTRACT (YUK-751 OCR major): a handler must resolve well INSIDE the checkpoint/delivery claim
// lease TTL (`interval '2 minutes'`). The lease is NOT renewed while the handler runs, so a handler
// that outlives the lease lets a concurrent worker take over and double-process the same delivery.
// Bounding the await below the TTL guarantees the delivery is resolved (retry_wait via
// failSubscriptionDelivery) before the lease can expire. On timeout the handler promise is abandoned
// (JS can't truly cancel it) — its side effects must be idempotent, which the delivery-key dedup
// already assumes. Keep this value < the lease TTL if the lease duration ever changes.
const DEFAULT_HANDLER_TIMEOUT_MS = 90_000;

// Options intake guards (YUK-751 OCR minor Tcd9v). A non-finite / non-positive timeout or retry delay
// silently corrupts the lease-TTL bound and the backoff SQL (`* interval '1 second'`), so reject them
// at the cycle entry instead of letting NaN/negatives reach the handler race or the DB.
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
  const declarationHash = declared.declarationHash;
  const actionList = sql.join(
    declared.actions.map((action) => sql`${action}`),
    sql`, `,
  );

  // Ensure the checkpoint row exists + its declaration hash matches (small tx). Returns whether the
  // historical backfill still needs to run ('bootstrapping'); 'active'/'paused' → nothing to do.
  const needsBackfill = await db.transaction(async (tx) => {
    await tx.execute(sql`
      insert into event_subscription_checkpoint
        (subscriber_id, subscriber_version, declaration_hash, status, bootstrap_horizon_seq,
         bootstrap_snapshot)
      values (${subscription.id}, ${subscription.version}, ${declarationHash}, 'bootstrapping',
        (select coalesce(max(dispatch_seq), 0) from event), pg_current_snapshot()::text)
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
    if (checkpoint.declaration_hash !== declarationHash) {
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
        bootstrap_horizon_seq: string | null;
        bootstrap_snapshot: string | null;
      }>(sql`
        select declaration_hash, status, next_delivery_seq, bootstrap_horizon_seq, bootstrap_snapshot
        from event_subscription_checkpoint
        where subscriber_id = ${subscription.id}
          and subscriber_version = ${subscription.version}
        for update
      `);
      const checkpoint = checkpoints[0];
      if (
        !checkpoint ||
        checkpoint.declaration_hash !== declarationHash ||
        checkpoint.status !== 'bootstrapping'
      ) {
        return true; // vanished / hash-rotated / already finished by a peer
      }

      // Bootstrap visibility fence (YUK-751 review TcWGH). A batch skips an event only when it is
      // dispatch_seq <= horizon AND was VISIBLE (committed) to the creation snapshot. dispatch_seq is
      // NOT a snapshot: seq is allocated at insert, but a low-seq tx can COMMIT after a higher-seq tx,
      // so a genuinely-new event committing mid-bootstrap can sit <= horizon — pg_visible_in_snapshot
      // against its xmin excludes it (it was in-flight at creation) so post-activation discovery
      // delivers it. A legacy checkpoint from before these columns existed has a NULL horizon: compute-
      // once-and-persist it here (best-effort). A NULL snapshot (same legacy path) falls back to
      // horizon-only — a documented residual out-of-order skew for that legacy window only, never
      // unbounded.
      let horizon: bigint;
      if (checkpoint.bootstrap_horizon_seq === null) {
        const horizonRows = await tx.execute<{ bootstrap_horizon_seq: string }>(sql`
          update event_subscription_checkpoint
          set bootstrap_horizon_seq = (select coalesce(max(dispatch_seq), 0) from event),
              updated_at = clock_timestamp()
          where subscriber_id = ${subscription.id}
            and subscriber_version = ${subscription.version}
          returning bootstrap_horizon_seq
        `);
        horizon = asBigint(horizonRows[0].bootstrap_horizon_seq);
      } else {
        horizon = asBigint(checkpoint.bootstrap_horizon_seq);
      }

      // xmin is the event's (immutable, append-only) inserting xid; ::text::xid8 lifts the 32-bit xid
      // into the full-xid space the snapshot uses (correct within the current epoch — a bootstrap
      // window can't span a 2^32 xid wrap). No snapshot (legacy) → horizon-only.
      const visibilityClause =
        checkpoint.bootstrap_snapshot === null
          ? sql``
          : sql`and pg_visible_in_snapshot(e.xmin::text::xid8, ${checkpoint.bootstrap_snapshot}::pg_snapshot)`;

      const events = await tx.execute<{ id: string; dispatch_seq: number }>(sql`
        select e.id, e.dispatch_seq
        from event e
        where e.action in (${actionList})
          and e.dispatch_seq <= ${horizon}
          ${visibilityClause}
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
  const declarationHash = getDeclaredSubscription(registry, subscription).declarationHash;
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
 * Discovers with an anti-join, never with a dispatch_seq watermark. Drains in
 * bounded batches (YUK-751 OCR major Tcd9r) — one tx each, re-fencing the lease,
 * like bootstrap — so a large backlog can't load/insert unboundedly in one tx.
 * The checkpoint lock serializes delivery_seq allocation for this one subscriber.
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
        limit ${DISCOVERY_BATCH_SIZE}
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
    // The anti-join only surfaces UNdelivered events and the lease fence serializes discovery for this
    // subscriber, so a zero-insert batch means the backlog is drained (or the lease is gone) — stop.
    if (insertedThisBatch === 0) break;
  }
  return total;
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
  assertPositiveInteger(options.maxAttempts, 'maxAttempts');
  if (options.handlerTimeoutMs !== undefined) {
    assertPositiveFinite(options.handlerTimeoutMs, 'handlerTimeoutMs');
  }
  if (options.retryDelaySeconds !== undefined) {
    assertPositiveFinite(options.retryDelaySeconds, 'retryDelaySeconds');
  }

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
