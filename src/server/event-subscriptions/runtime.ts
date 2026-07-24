import { randomUUID } from 'node:crypto';

import type { Db } from '@/db/client';
import { sql } from 'drizzle-orm';

import type { EventSubscriptionOutcome } from '@/kernel/manifest';

import type { LoadedEventSubscription, LoadedEventSubscriptionRegistry } from './types';

type SubscriptionIdentity = Pick<LoadedEventSubscription, 'id' | 'version'>;

// Max pending deliveries materialized per discovery transaction (YUK-751 OCR major Tcd9r): the
// anti-join over the immutable event log was unbounded, so a large backlog (e.g. first discovery for
// a new action) loaded + inserted every row in one tx (memory + a long checkpoint-row lock).
// Discovery now drains in bounded batches — one tx each, re-fencing the lease — exactly like bootstrap.
const DISCOVERY_BATCH_SIZE = 1_000;

// Checkpoint + delivery claim lease TTL, in seconds (YUK-751 OCR minor Tc4HQ). Single source for what
// was `interval '2 minutes'` repeated across every claim/renew SQL site — interpolated as
// `${LEASE_TTL_SECONDS} * interval '1 second'` so drift can't creep between sites.
const LEASE_TTL_SECONDS = 120;

// CONTRACT (YUK-751 OCR major): a handler must resolve well INSIDE the checkpoint/delivery claim
// lease TTL (LEASE_TTL_SECONDS). The lease is NOT renewed while the handler runs, so a handler that
// outlives the lease lets a concurrent worker take over and double-process the same delivery. Bounding
// the await below the TTL guarantees the delivery is resolved (retry_wait via failSubscriptionDelivery)
// before the lease can expire. On timeout the handler promise is abandoned (JS can't truly cancel it)
// — its side effects must be idempotent, which the delivery-key dedup already assumes.
const DEFAULT_HANDLER_TIMEOUT_MS = 90_000;

// Validate the contract at module load: the default handler timeout MUST stay below the lease TTL, or
// a slow handler could outlive its lease and get double-processed (Tc4HQ — the single-constant version
// of the "keep < lease TTL" note above).
if (DEFAULT_HANDLER_TIMEOUT_MS >= LEASE_TTL_SECONDS * 1000) {
  throw new Error(
    `event subscription DEFAULT_HANDLER_TIMEOUT_MS (${DEFAULT_HANDLER_TIMEOUT_MS}ms) must be below the lease TTL (${LEASE_TTL_SECONDS}s)`,
  );
}

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
 * Bootstrap a subscriber in ONE transaction (YUK-751 review Tcx98). The creation tx's OWN MVCC
 * snapshot defines "history": a single set-based `INSERT ... SELECT` marks every event visible to that
 * snapshot bootstrap_skipped, then the checkpoint is inserted 'active'. No seq / xmin / snapshot fence
 * and no resumable 'bootstrapping' phase — snapshot visibility is the exactly-right, mutation-proof
 * definition of history. (Event rows are NOT immutable: the memory outbox UPDATEs `ingest_at`, so any
 * xmin-based fence mis-classified an outbox-touched historical event as in-flight → over-delivery.)
 * An event that commits after — or is in-flight during — this tx is simply absent from the snapshot →
 * not skipped → later delivered as pending by discovery (the safe direction). Atomicity makes it
 * crash-safe with no partial state; the whole set streams inside PG (no app-side row loading — the
 * MAJ-2 concern), and a single-user small event table makes the one-shot lock a non-issue.
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

  await db.transaction(async (tx) => {
    // Insert the checkpoint directly 'active'. RETURNING distinguishes a FRESH bootstrap (we own the
    // skip-marking) from an already-bootstrapped subscriber (nothing to do). A concurrent bootstrap of
    // the same subscriber serializes on the ON CONFLICT row lock, so only one run marks history.
    const inserted = await tx.execute(sql`
      insert into event_subscription_checkpoint
        (subscriber_id, subscriber_version, declaration_hash, status, bootstrapped_at, activated_at)
      values (${subscription.id}, ${subscription.version}, ${declarationHash}, 'active',
        clock_timestamp(), clock_timestamp())
      on conflict (subscriber_id, subscriber_version) do nothing
      returning subscriber_id
    `);
    if (inserted.length === 0) {
      // Already bootstrapped — fail closed on declaration drift, else nothing to do.
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
      return;
    }

    // Mark ALL of this snapshot's history bootstrap_skipped, set-based. delivery_seq is allocated 1..N
    // by dispatch order via row_number(); a fresh subscriber has no prior deliveries (the checkpoint FK
    // gates them) and no discovery can run against a not-yet-committed checkpoint, so ON CONFLICT never
    // fires here — it's belt-and-braces against a concurrent writer.
    await tx.execute(sql`
      insert into event_subscription_delivery
        (subscriber_id, subscriber_version, source_event_id, source_dispatch_seq, delivery_seq,
         status, completed_at)
      select ${subscription.id}, ${subscription.version}, e.id, e.dispatch_seq,
        row_number() over (order by e.dispatch_seq, e.id),
        'bootstrap_skipped', clock_timestamp()
      from event e
      where e.action in (${actionList})
      on conflict (subscriber_id, subscriber_version, source_event_id) do nothing
    `);

    // Advance next_delivery_seq past the skipped block (= count + 1) so discovery allocates after it.
    await tx.execute(sql`
      update event_subscription_checkpoint
      set next_delivery_seq = 1 + (
            select count(*) from event_subscription_delivery
            where subscriber_id = ${subscription.id}
              and subscriber_version = ${subscription.version}
          ),
          updated_at = clock_timestamp()
      where subscriber_id = ${subscription.id}
        and subscriber_version = ${subscription.version}
    `);
  });
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
 * Discovers with an anti-join, never with a dispatch_seq watermark. Drains in
 * bounded batches (YUK-751 OCR major Tcd9r) — one tx each, re-fencing the lease,
 * like bootstrap — so a large backlog can't load/insert unboundedly in one tx.
 * Each batch is a single set-based `INSERT … SELECT` with delivery_seq allocated by
 * row_number() (TdYuZ) — no per-row round-trips and no app-side dispatch_seq handling.
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

      // Set-based batch (TdYuZ): the anti-join picks up to LIMIT undelivered events ordered by
      // dispatch_seq, and row_number() allocates delivery_seq contiguously from next_delivery_seq —
      // never crossing dispatch_seq into app code (it stays `e.dispatch_seq` in SQL). The lease fence
      // serializes discovery per subscriber, so ON CONFLICT never fires (belt-and-braces).
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
        // Advance to max(delivery_seq)+1 (robust against any gap) under the same lease fence.
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
  // retryDelaySeconds is configurable (default 1s, current behavior) so a caller can widen the
  // backoff away from the aggressive 1s storm without editing SQL string literals (YUK-751 review).
  options: { maxAttempts: number; retryDelaySeconds?: number },
): Promise<'retry_wait' | 'dead_letter' | 'lost_lease'> {
  // Tc4HN — this is an EXPORTED entry, callable directly (not only via runSubscriptionDispatchCycle),
  // so it validates its own numeric options: a NaN/negative maxAttempts corrupts the dead-letter
  // threshold and retryDelaySeconds feeds the backoff SQL (`* interval '1 second'`).
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
  /** Deliveries CLAIMED this cycle. Reconciles exactly: dispatched = succeeded + skipped +
   *  retryScheduled + deadLettered + lostLease (Tc4HR). */
  dispatched: number;
  succeeded: number;
  skipped: number;
  retryScheduled: number;
  deadLettered: number;
  /** Claims whose lease was lost before the terminal write landed (completeSubscriptionDelivery
   *  returned false, or failSubscriptionDelivery reported 'lost_lease') — a concurrent worker took
   *  over. Tracked so `dispatched` reconciles instead of silently exceeding the terminal counters. */
  lostLease: number;
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
    // G2 (TdYuS) — a caller-provided timeout must ALSO stay below the lease TTL (the module-load
    // assertion only covers DEFAULT_HANDLER_TIMEOUT_MS), or a slow handler outlives its lease and a
    // concurrent worker double-processes the delivery.
    if (options.handlerTimeoutMs >= LEASE_TTL_SECONDS * 1000) {
      throw new Error(
        `event subscription dispatch option 'handlerTimeoutMs' (${options.handlerTimeoutMs}ms) must stay below the lease TTL (${LEASE_TTL_SECONDS}s)`,
      );
    }
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
    lostLease: 0,
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
        // G1 (TdS7R) — a long discovery can burn most of the checkpoint lease TTL. Renew it before the
        // claim + handler so they run against a fresh lease window, not one about to expire (which
        // would phantom lost_lease AFTER the handler's real side effects). Renewal failure = the lease
        // is already gone → skip this subscriber (the finally still releases best-effort).
        if (!(await renewSubscriptionLease(db, lease))) continue;
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
          } else {
            // Lease lost between claim and the terminal write — a peer took over (Tc4HR).
            result.lostLease += 1;
          }
        } catch (error) {
          const transition = await failSubscriptionDelivery(db, claim, error, options);
          if (transition === 'retry_wait') result.retryScheduled += 1;
          else if (transition === 'dead_letter') result.deadLettered += 1;
          else result.lostLease += 1; // 'lost_lease'
        }
      } finally {
        // G6 (TdYuW) — a release failure must NEVER mask the handler outcome or surface as the cycle's
        // error; swallow + log (the lease self-expires at its TTL regardless).
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
