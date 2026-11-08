// Delivery outbox for supply engine sends (placement starter claims, question preparer segments).
// The business transaction persists the complete job request under a stable delivery id; the
// owning domain's drain sends it after commit and writes receipts only from engine evidence.
// This module holds the shared rows and the send/readback step; each domain keeps its own drain
// and decides when an obligation is closed.
import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { SendOptions } from 'pg-boss';
import { z } from 'zod';
import type { Db, Tx } from '@/db/client';
import { event } from '@/db/schema';
import { writeEvent } from '@/kernel/events';

export const SUPPLY_DELIVERY_INTENT_ACTION = 'experimental:supply_delivery_intent';
export const SUPPLY_DELIVERY_RECEIPT_ACTION = 'experimental:supply_delivery_receipt';

const DOMAINS = ['placement_starter', 'question_preparer'] as const;
const QUEUES = ['quiz_gen', 'supply_execute', 'question_preparer_run'] as const;

export type SupplyDeliveryDomain = (typeof DOMAINS)[number];
export type SupplyDeliveryQueue = (typeof QUEUES)[number];
/** accepted: the engine holds the id. settled: the domain owns the outcome from here.
 *  void: the business row no longer binds this delivery. */
export type SupplyDeliveryReceipt = 'accepted' | 'settled' | 'void';

const deliveryOptions = z
  .object({
    startAfter: z.string().datetime().optional(),
    retryLimit: z.number().int().nonnegative().optional(),
    retryDelay: z.number().int().nonnegative().optional(),
    retryBackoff: z.boolean().optional(),
    expireInSeconds: z.number().int().positive().optional(),
  })
  .strict();
export type SupplyDeliveryOptions = z.infer<typeof deliveryOptions>;

const intentPayload = z.object({
  version: z.literal(1),
  domain: z.enum(DOMAINS),
  queue: z.enum(QUEUES),
  job_id: z.string().uuid(),
  data: z.record(z.string(), z.unknown()),
  options: deliveryOptions,
});
export type SupplyDeliveryIntent = z.infer<typeof intentPayload> & { subject_id: string };

export const supplyDeliveryIntentId = (jobId: string) => `supply_delivery_intent_${jobId}`;
export const supplyDeliveryReceiptId = (receipt: SupplyDeliveryReceipt, jobId: string) =>
  `supply_delivery_${receipt}_${jobId}`;

/** Stable RFC 9562 UUIDv8 for a delivery whose identity is fixed by its cause. */
export function supplyDeliveryJobId(cause: string): string {
  const bytes = createHash('sha256')
    .update(`practice.supply-delivery@v1\0${cause}`)
    .digest('hex')
    .slice(0, 32)
    .split('');
  bytes[12] = '8';
  bytes[16] = ((Number.parseInt(bytes[16], 16) & 0x3) | 0x8).toString(16);
  const v = bytes.join('');
  return `${v.slice(0, 8)}-${v.slice(8, 12)}-${v.slice(12, 16)}-${v.slice(16, 20)}-${v.slice(20, 32)}`;
}

/** Persist the obligation in the caller's business transaction. Insert-only on the delivery id. */
export async function writeSupplyDeliveryIntent(
  tx: Db | Tx,
  input: {
    domain: SupplyDeliveryDomain;
    subjectId: string;
    queue: SupplyDeliveryQueue;
    jobId: string;
    data: object;
    options: SupplyDeliveryOptions;
    now?: Date;
  },
): Promise<void> {
  const now = input.now ?? new Date();
  await writeEvent(tx, {
    id: supplyDeliveryIntentId(input.jobId),
    actor_kind: 'system',
    actor_ref: input.domain,
    action: SUPPLY_DELIVERY_INTENT_ACTION,
    subject_kind: 'query',
    subject_id: input.subjectId,
    outcome: null,
    payload: intentPayload.parse({
      version: 1,
      domain: input.domain,
      queue: input.queue,
      job_id: input.jobId,
      data: input.data,
      options: input.options,
    }),
    created_at: now,
    // System dispatch rows never feed memory derivation.
    ingest_at: now,
  });
}

export async function writeSupplyDeliveryReceipt(
  db: Db | Tx,
  intent: SupplyDeliveryIntent,
  receipt: SupplyDeliveryReceipt,
  detail: Record<string, unknown> = {},
): Promise<void> {
  const now = new Date();
  await writeEvent(db, {
    id: supplyDeliveryReceiptId(receipt, intent.job_id),
    actor_kind: 'system',
    actor_ref: intent.domain,
    action: SUPPLY_DELIVERY_RECEIPT_ACTION,
    subject_kind: 'query',
    subject_id: intent.subject_id,
    outcome: receipt,
    payload: {
      version: 1,
      domain: intent.domain,
      queue: intent.queue,
      job_id: intent.job_id,
      backend: 'pgboss',
      ...detail,
    },
    created_at: now,
    ingest_at: now,
  });
}

/**
 * Pending = intent of this domain with none of the closing receipts. SKIP LOCKED only partitions
 * one short scan between concurrent drains; the engine's stable-id dedup is the once-only barrier.
 */
export async function selectPendingSupplyDeliveries(
  db: Db,
  input: {
    domain: SupplyDeliveryDomain;
    closedBy: readonly SupplyDeliveryReceipt[];
    jobId?: string;
    limit: number;
  },
): Promise<SupplyDeliveryIntent[]> {
  const closingIds = sql.join(
    input.closedBy.map(
      (kind) => sql`${`supply_delivery_${kind}_`} || (${event.payload}->>'job_id')`,
    ),
    sql`, `,
  );
  const rows = await db.transaction((tx) =>
    tx
      .select({ id: event.id, subject_id: event.subject_id, payload: event.payload })
      .from(event)
      .where(
        and(
          eq(event.action, SUPPLY_DELIVERY_INTENT_ACTION),
          sql`${event.payload}->>'domain' = ${input.domain}`,
          input.jobId ? eq(event.id, supplyDeliveryIntentId(input.jobId)) : undefined,
          sql`NOT EXISTS (SELECT 1 FROM event closing WHERE closing.id IN (${closingIds}))`,
        ),
      )
      .orderBy(event.created_at, event.id)
      .limit(input.limit)
      .for('update', { skipLocked: true }),
  );
  return rows.flatMap((row) => {
    const parsed = intentPayload.safeParse(row.payload);
    if (parsed.success) return [{ ...parsed.data, subject_id: row.subject_id }];
    console.error('[supply-delivery] unreadable intent left pending', { id: row.id });
    return [];
  });
}

export interface SupplyDeliveryBoss {
  send(name: string, data: object, options: SendOptions): Promise<string | null>;
  getJobById(name: string, id: string): Promise<{ state: string } | null>;
}

const LIVE_STATES: ReadonlySet<string> = new Set(['created', 'retry', 'active']);

export type SupplyEngineTruth = { kind: 'live' | 'terminal'; state: string } | { kind: 'absent' };

export async function readSupplyDelivery(
  boss: SupplyDeliveryBoss,
  intent: SupplyDeliveryIntent,
): Promise<SupplyEngineTruth> {
  const job = await boss.getJobById(intent.queue, intent.job_id);
  if (!job) return { kind: 'absent' };
  return { kind: LIVE_STATES.has(job.state) ? 'live' : 'terminal', state: job.state };
}

/**
 * Send under the bound id. A null return means the engine already holds that id; read it back
 * instead of guessing. `absent` after a null send leaves the intent pending for the next pass.
 */
export async function sendSupplyDelivery(
  boss: SupplyDeliveryBoss,
  intent: SupplyDeliveryIntent,
): Promise<SupplyEngineTruth> {
  const { startAfter, ...rest } = intent.options;
  const sent = await boss.send(intent.queue, intent.data, {
    ...rest,
    ...(startAfter ? { startAfter: new Date(startAfter) } : {}),
    id: intent.job_id,
  });
  if (sent !== null) return { kind: 'live', state: 'created' };
  return readSupplyDelivery(boss, intent);
}
