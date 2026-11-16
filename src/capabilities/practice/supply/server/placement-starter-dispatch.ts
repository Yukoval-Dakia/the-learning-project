// Durable dispatch owner for placement starter deliveries. The dispatch
// transaction binds a stable delivery identity on the claim (pg_boss_job_id)
// and persists the complete send contract on the question_supply ledger event
// (`delivery`); this drain — the starter's only sender — runs after commit,
// reads engine state to resolve ambiguous sends, and writes a job_events
// receipt for every identity the engine accepted. Same-id resends dedupe at
// the engine, so overlapping drains converge on one delivery.
import { randomUUID } from 'node:crypto';
import { and, desc, eq, lte, notExists, sql } from 'drizzle-orm';
import type { SendOptions } from 'pg-boss';
import { z } from 'zod';
import { newId } from '@/core/ids';
import type { Db } from '@/db/client';
import { event, job_events, placement_starter_claim } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { writeJobEvent } from '@/kernel/job-events';
import {
  JOB_RETRY_DELAY_SECONDS,
  JOB_RETRY_LIMIT,
  type PlacementJobQueue,
  enqueuePlacementJob,
  enqueuePlacementSupplyExecuteJob,
} from '@/kernel/placement-jobs';
import type { QuizGenJobData } from '@/kernel/quiz-gen-contract';
import { placementClaimJobQueue } from './placement-starter';
import { PLACEMENT_QUEUE_EXPIRY_MS } from './placement-starter-attempts';

export const PLACEMENT_CLAIM_DISPATCH_RECEIPT = 'placement_claim_dispatch_accepted';
const DISPATCH_DRAIN_BATCH = 50;

type ClaimRow = typeof placement_starter_claim.$inferSelect;

const placementDeliverySchema = z.object({
  queue: z.enum(['quiz_gen', 'supply_execute']),
  /** The exact payload bound at dispatch time; the drain never rebuilds it. */
  job_data: z.record(z.string(), z.unknown()),
  start_after: z.string().optional(),
});
type PlacementDelivery = z.infer<typeof placementDeliverySchema>;

export interface PlacementDispatchBoss {
  send(
    queue: PlacementJobQueue,
    data: unknown,
    options: { id: string } & SendOptions,
  ): Promise<string | null>;
  getJobById(queue: PlacementJobQueue, id: string): Promise<{ state?: string | null } | null>;
}

/** The engine seam for production drains, built on the kernel placement send path. */
export function defaultPlacementDispatchBoss(): PlacementDispatchBoss {
  return {
    send: (queue, data, options) =>
      queue === 'quiz_gen'
        ? enqueuePlacementJob('quiz_gen', data as QuizGenJobData, options)
        : enqueuePlacementSupplyExecuteJob(data as Record<string, unknown>, options),
    getJobById: async (queue, id) => {
      const { getStartedBoss } = await import('@/server/boss/client');
      const boss = await getStartedBoss();
      return boss.getJobById(queue, id);
    },
  };
}

/** Engine-acceptance receipt: durable proof the engine holds this delivery
 * identity, written only after a resolved send or an engine readback.
 * Idempotent — the (claim, job id) pair is recorded at most once. */
export async function writePlacementDispatchReceipt(
  db: Db,
  input: { claimId: string; jobId: string; queue: PlacementJobQueue },
): Promise<void> {
  await db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: job_events.id })
      .from(job_events)
      .where(
        and(
          eq(job_events.business_table, 'placement_starter_claim'),
          eq(job_events.business_id, input.claimId),
          eq(job_events.event_type, PLACEMENT_CLAIM_DISPATCH_RECEIPT),
          sql`${job_events.payload}->>'job_id' = ${input.jobId}`,
        ),
      )
      .limit(1);
    if (existing.length > 0) return;
    await writeJobEvent(tx, {
      business_table: 'placement_starter_claim',
      business_id: input.claimId,
      event_type: PLACEMENT_CLAIM_DISPATCH_RECEIPT,
      payload: { job_id: input.jobId, queue: input.queue, backend: 'pgboss' },
    });
  });
}

export async function placementDispatchReceiptExists(db: Db, jobId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: job_events.id })
    .from(job_events)
    .where(
      and(
        eq(job_events.business_table, 'placement_starter_claim'),
        eq(job_events.event_type, PLACEMENT_CLAIM_DISPATCH_RECEIPT),
        sql`${job_events.payload}->>'job_id' = ${jobId}`,
      ),
    )
    .limit(1);
  return row != null;
}

/** The dispatch event carries the complete send contract under `delivery`;
 * claims bound before this protocol keep only the job id — probe-only. */
async function loadPlacementDelivery(
  db: Db,
  claim: ClaimRow,
): Promise<{ event: typeof event.$inferSelect; delivery: PlacementDelivery | null } | null> {
  const [row] = await db
    .select()
    .from(event)
    .where(
      and(
        eq(event.action, 'experimental:question_supply'),
        eq(event.subject_id, claim.target_id),
        sql`${event.payload}->>'job_id' = ${claim.pg_boss_job_id}`,
        sql`${event.payload}->>'status' = 'dispatched'`,
      ),
    )
    .orderBy(desc(event.created_at))
    .limit(1);
  if (!row) return null;
  const parsed = placementDeliverySchema.safeParse(row.payload?.delivery);
  return { event: row, delivery: parsed.success ? parsed.data : null };
}

/** True when the claim's dispatch event persists a resendable delivery contract.
 * Claims bound before this protocol carry probe-only bindings — when their engine
 * row is also gone there is nothing the drain can deliver, so the sweeper's
 * ordinary queued park/reap path owns them again. */
export async function placementHasBoundDelivery(db: Db, claim: ClaimRow): Promise<boolean> {
  return (await loadPlacementDelivery(db, claim))?.delivery != null;
}

function sendOptionsFor(
  delivery: PlacementDelivery | null,
  claim: ClaimRow,
  now: Date,
): SendOptions & { id: string } {
  const queue = delivery?.queue ?? placementClaimJobQueue(claim);
  const startAfter = delivery?.start_after ? new Date(delivery.start_after) : null;
  return {
    id: claim.pg_boss_job_id as string,
    retryLimit: JOB_RETRY_LIMIT,
    retryDelay: JOB_RETRY_DELAY_SECONDS,
    retryBackoff: true,
    ...(queue === 'supply_execute' ? { expireInSeconds: PLACEMENT_QUEUE_EXPIRY_MS / 1_000 } : {}),
    ...(startAfter && startAfter.getTime() > now.getTime() ? { startAfter } : {}),
  };
}

export type PlacementDispatchOutcome =
  /** This pass delivered (or re-delivered) the bound identity to the engine. */
  | 'dispatched'
  /** The engine already holds a delivery for the bound identity; receipted. */
  | 'accepted'
  /** A concurrent writer moved the claim between reads. */
  | 'raced'
  /** No bound delivery payload exists and the engine holds no row. */
  | 'unbound'
  /** The claim is not owed a delivery (not queued or no bound id). */
  | 'not_queued'
  /** The engine accepted this delivery earlier; receipt already exists. */
  | 'acked';

async function sendBound(
  boss: PlacementDispatchBoss,
  claim: ClaimRow,
  delivery: PlacementDelivery,
  now: Date,
): Promise<'sent' | { state: string } | 'burned'> {
  const sent = await boss.send(
    delivery.queue,
    delivery.job_data,
    sendOptionsFor(delivery, claim, now),
  );
  if (sent !== null) return 'sent';
  const readBack = await boss.getJobById(delivery.queue, claim.pg_boss_job_id as string);
  if (!readBack) return 'burned';
  return { state: readBack.state ?? 'unknown' };
}

/**
 * Deliver the claim's bound delivery identity exactly once at the engine. The
 * post-commit caller and the recovery sweeper both run this — the persisted id
 * plus the engine's own dedup is the once-only barrier, so overlapping drains
 * never mint a second paid delivery. No business lock is held across sends.
 */
export async function drainPlacementClaimDelivery(
  db: Db,
  boss: PlacementDispatchBoss,
  claimId: string,
  now = new Date(),
): Promise<PlacementDispatchOutcome> {
  const [claim] = await db
    .select()
    .from(placement_starter_claim)
    .where(eq(placement_starter_claim.id, claimId));
  if (claim?.status !== 'queued' || !claim.pg_boss_job_id) return 'not_queued';
  const jobId = claim.pg_boss_job_id;
  if (await placementDispatchReceiptExists(db, jobId)) return 'acked';
  const binding = await loadPlacementDelivery(db, claim);
  const queue = binding?.delivery?.queue ?? placementClaimJobQueue(claim);

  const existing = await boss.getJobById(queue, jobId);
  if (existing) {
    await writePlacementDispatchReceipt(db, { claimId: claim.id, jobId, queue });
    return 'accepted';
  }
  if (!binding?.delivery) {
    // Bound before the delivery payload existed — nothing durable to resend.
    console.error(
      `[placement_dispatch] claim ${claim.id} binds ${jobId} with no delivery payload and no engine row; leaving for the sweeper`,
    );
    return 'unbound';
  }
  const delivery = binding.delivery;

  const truth = await sendBound(boss, claim, delivery, now);
  if (truth === 'sent') {
    await writePlacementDispatchReceipt(db, { claimId: claim.id, jobId, queue });
    return 'dispatched';
  }
  if (truth !== 'burned') {
    await writePlacementDispatchReceipt(db, { claimId: claim.id, jobId, queue });
    return 'accepted';
  }

  // `burned`: the engine deduped the id but holds no row — a swept identity.
  // Rebind a fresh identity under the claim lock, restamp the ledger event,
  // and deliver once; the CAS repoint is the fence.
  const rebound = await db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(placement_starter_claim)
      .where(eq(placement_starter_claim.id, claim.id))
      .for('update');
    if (current?.status !== 'queued' || current.pg_boss_job_id !== jobId) return null;
    const fresh = randomUUID();
    await tx
      .update(placement_starter_claim)
      .set({
        pg_boss_job_id: fresh,
        next_reconcile_at: now,
        updated_at: now,
        version: current.version + 1,
      })
      .where(eq(placement_starter_claim.id, current.id));
    await writeEvent(tx, {
      id: newId(),
      actor_kind: 'agent',
      actor_ref: 'placement_starter',
      action: 'experimental:question_supply',
      subject_kind: 'query',
      subject_id: claim.target_id,
      outcome: 'success',
      session_id: binding.event.session_id,
      payload: {
        ...(binding.event.payload as Record<string, unknown>),
        job_id: fresh,
        rebound_from: jobId,
      },
      created_at: now,
    });
    return fresh;
  });
  if (!rebound) return 'raced';
  const retry = await boss.send(delivery.queue, delivery.job_data, {
    ...sendOptionsFor(delivery, claim, now),
    id: rebound,
  });
  if (retry === null) {
    const readBack = await boss.getJobById(delivery.queue, rebound);
    if (!readBack) return 'raced';
  }
  await writePlacementDispatchReceipt(db, { claimId: claim.id, jobId: rebound, queue });
  return 'dispatched';
}

export interface PlacementDispatchDrainResult {
  scanned: number;
  dispatched: number;
  accepted: number;
  failed: number;
}

/**
 * Sweeper leg: every queued claim whose bound identity lacks an acceptance
 * receipt is owed one drain pass. Claim rows are read without locks; each
 * drain re-reads and converges on the persisted id plus engine dedup.
 */
export async function drainUnackedPlacementClaims(
  db: Db,
  boss: PlacementDispatchBoss,
  input: { now?: Date; batchSize?: number } = {},
): Promise<PlacementDispatchDrainResult> {
  const now = input.now ?? new Date();
  const candidates = await db
    .select({ id: placement_starter_claim.id })
    .from(placement_starter_claim)
    .where(
      and(
        eq(placement_starter_claim.status, 'queued'),
        lte(placement_starter_claim.next_reconcile_at, now),
        sql`${placement_starter_claim.pg_boss_job_id} is not null`,
        notExists(
          db
            .select({ id: job_events.id })
            .from(job_events)
            .where(
              and(
                eq(job_events.business_table, 'placement_starter_claim'),
                eq(job_events.event_type, PLACEMENT_CLAIM_DISPATCH_RECEIPT),
                sql`${job_events.payload}->>'job_id' = ${placement_starter_claim.pg_boss_job_id}`,
              ),
            ),
        ),
      ),
    )
    .orderBy(placement_starter_claim.next_reconcile_at, placement_starter_claim.id)
    .limit(input.batchSize ?? DISPATCH_DRAIN_BATCH);
  const result: PlacementDispatchDrainResult = {
    scanned: candidates.length,
    dispatched: 0,
    accepted: 0,
    failed: 0,
  };
  for (const candidate of candidates) {
    try {
      const outcome = await drainPlacementClaimDelivery(db, boss, candidate.id, now);
      if (outcome === 'dispatched') result.dispatched += 1;
      else if (outcome === 'accepted' || outcome === 'acked') result.accepted += 1;
      else if (outcome === 'unbound' || outcome === 'raced') result.failed += 1;
    } catch (error) {
      result.failed += 1;
      console.error(
        `[placement_dispatch] drain failed for claim ${candidate.id}:`,
        error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
      );
    }
  }
  return result;
}
