import { createHash } from 'node:crypto';
import type { Db } from '@/db/client';
import { event } from '@/db/schema';
import { and, asc, eq, sql } from 'drizzle-orm';
import {
  persistRecoveryCursor,
  readLatestRecoveryCursor,
} from './memory-reconcile-handoff-cursor-store';
import {
  type IngestCompleted,
  MEMORY_RECONCILE_HANDOFF_ACTION,
  MemoryReconcileHandoffError,
  type ReconcileMemInput,
  loadCompleteIntentSet,
  memoryIntentDigest,
  normalizeReconcileInputs,
  persistDispatchCompleted,
  readIngestCompleted,
} from './memory-reconcile-handoff-store';

export type MemoryReconcileHandoffMode = 'observe' | 'write' | 'recover' | 'drain';
export type MemoryReconcileBoss = {
  send(queue: string, data: object, options: object): Promise<string | null>;
  getJobById?: (queue: string, id: string) => Promise<{ readonly state: string } | null>;
};
export const MEMORY_RECONCILE_QUEUE = 'memory_reconcile';
const RECOVERY_BATCH = 50;
const RECOVERY_SCAN = 200;
const RECOVERY_PAGE = 25;

export function memoryReconcileHandoffMode(
  raw = process.env.MEMORY_RECONCILE_HANDOFF_MODE,
): MemoryReconcileHandoffMode {
  const value = raw?.trim() || 'observe';
  switch (value) {
    case 'observe':
    case 'write':
    case 'recover':
    case 'drain':
      return value;
    default:
      throw new MemoryReconcileHandoffError(
        `invalid MEMORY_RECONCILE_HANDOFF_MODE ${JSON.stringify(raw)}`,
      );
  }
}
export function modePersistsNewIntents(mode: MemoryReconcileHandoffMode): boolean {
  return mode === 'write' || mode === 'recover';
}
export function modeRunsRecovery(mode: MemoryReconcileHandoffMode): boolean {
  return mode === 'recover' || mode === 'drain';
}
export function memoryReconcileJobId(
  sourceId: string,
  memories: readonly ReconcileMemInput[],
): string {
  const bytes = Buffer.from(
    createHash('sha256')
      .update(`memory-reconcile-job-v1\0${sourceId}\0${memoryIntentDigest(memories)}`)
      .digest()
      .subarray(0, 16),
  );
  bytes[6] = ((bytes[6] ?? 0) & 15) | 80;
  bytes[8] = ((bytes[8] ?? 0) & 63) | 128;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
async function readback(boss: MemoryReconcileBoss, jobId: string): Promise<boolean> {
  // Any state for the exact deterministic id proves queue receipt. Dispatch completion
  // is not business completion, so failed jobs must not trigger a second paid reconcile.
  return boss.getJobById ? (await boss.getJobById(MEMORY_RECONCILE_QUEUE, jobId)) !== null : false;
}
export async function dispatchMemoryReconcile(
  db: Db,
  boss: MemoryReconcileBoss,
  input: {
    readonly sourceEventId: string;
    readonly memories: readonly ReconcileMemInput[];
    readonly completion?: IngestCompleted;
  },
): Promise<string | null> {
  const memories = normalizeReconcileInputs(input.memories);
  if (memories.length === 0) return null;
  const jobId = memoryReconcileJobId(input.sourceEventId, memories);
  const options = {
    id: jobId,
    singletonKey: 'memory.reconcile.self',
    singletonSeconds: 90,
    singletonNextSlot: true,
    retryLimit: 3,
    retryDelay: 30,
    retryBackoff: true,
  };
  if (input.completion && (await readback(boss, jobId))) {
    await persistDispatchCompleted(db, input.completion, memories, jobId);
    return jobId;
  }
  let confirmed = false;
  try {
    const sentId = await boss.send(MEMORY_RECONCILE_QUEUE, { memories, user_id: 'self' }, options);
    confirmed = sentId === jobId || (await readback(boss, jobId));
  } catch (error) {
    try {
      confirmed = await readback(boss, jobId);
    } catch {
      throw error;
    }
    if (!confirmed) throw error;
  }
  if (!confirmed)
    throw new MemoryReconcileHandoffError(`enqueue unconfirmed ${input.sourceEventId}`);
  if (input.completion) await persistDispatchCompleted(db, input.completion, memories, jobId);
  return jobId;
}
type RecoveryCursor = {
  readonly dispatchSeq: string;
  readonly id: string;
};
type RecoveryCandidate = RecoveryCursor & { readonly sourceId: string };
async function candidates(
  db: Db,
  after: RecoveryCursor | undefined,
  through: RecoveryCursor | undefined,
  limit: number,
): Promise<readonly RecoveryCandidate[]> {
  const rows = await db
    .select({
      sourceId: event.subject_id,
      dispatchSeq: sql<string>`${event.dispatch_seq}::text`,
      id: event.id,
    })
    .from(event)
    .where(
      and(
        eq(event.action, MEMORY_RECONCILE_HANDOFF_ACTION),
        eq(sql<string>`${event.payload} ->> 'version'`, '1'),
        eq(sql<string>`${event.payload} ->> 'handoff_kind'`, 'ingest_completed'),
        eq(sql<string>`${event.payload} ->> 'source_event_id'`, event.subject_id),
        sql`CASE WHEN jsonb_typeof(${event.payload}) = 'object'
          THEN (SELECT count(*) FROM jsonb_object_keys(${event.payload}))
          ELSE 0 END = 6`,
        sql`${event.payload} ->> 'resolution' IN ('provider_result', 'event_lookup')`,
        sql`${event.payload} ->> 'intent_digest' ~ '^[0-9a-f]{64}$'`,
        sql`CASE WHEN jsonb_typeof(${event.payload} -> 'memory_count') = 'number'
          THEN (${event.payload} ->> 'memory_count')::int ELSE 0 END > 0`,
        sql`(SELECT count(*) FROM ${event} intent
          WHERE intent.action = ${MEMORY_RECONCILE_HANDOFF_ACTION}
            AND intent.subject_id = ${event.subject_id}
            AND intent.payload ->> 'version' = '1'
            AND intent.payload ->> 'handoff_kind' = 'reconcile_intent'
            AND intent.payload ->> 'intent_digest' = ${event.payload} ->> 'intent_digest'
            AND jsonb_typeof(intent.payload -> 'memory') = 'object'
            AND CASE WHEN jsonb_typeof(intent.payload) = 'object'
              THEN (SELECT count(*) FROM jsonb_object_keys(intent.payload)) ELSE 0 END = 5
            AND CASE WHEN jsonb_typeof(intent.payload -> 'memory') = 'object'
              THEN (SELECT count(*) FROM jsonb_object_keys(intent.payload -> 'memory')) ELSE 0 END = 4
            AND intent.payload ->> 'source_event_id' = intent.subject_id
            AND jsonb_typeof(intent.payload -> 'memory' -> 'id') = 'string'
            AND length(intent.payload -> 'memory' ->> 'id') > 0
            AND jsonb_typeof(intent.payload -> 'memory' -> 'text') = 'string'
            AND jsonb_typeof(intent.payload -> 'memory' -> 'created_ms') = 'number'
            AND jsonb_typeof(intent.payload -> 'memory' -> 'kind') = 'string')
          = CASE WHEN jsonb_typeof(${event.payload} -> 'memory_count') = 'number'
              THEN (${event.payload} ->> 'memory_count')::int ELSE 0 END`,
        sql`(SELECT count(*) FROM ${event} done WHERE done.action = ${MEMORY_RECONCILE_HANDOFF_ACTION}
      AND done.subject_id = ${event.subject_id} AND done.payload ->> 'version' = '1'
      AND done.payload ->> 'handoff_kind' = 'reconcile_dispatch_complete'
      AND done.payload ->> 'intent_digest' = ${event.payload} ->> 'intent_digest')
      < CASE WHEN jsonb_typeof(${event.payload} -> 'memory_count') = 'number'
          THEN (${event.payload} ->> 'memory_count')::int ELSE 0 END`,
        after
          ? sql`(${event.dispatch_seq}, ${event.id}) >
              (${after.dispatchSeq}::bigint, ${after.id})`
          : undefined,
        through
          ? sql`(${event.dispatch_seq}, ${event.id}) <=
              (${through.dispatchSeq}::bigint, ${through.id})`
          : undefined,
      ),
    )
    .orderBy(asc(event.dispatch_seq), asc(event.id))
    .limit(limit);
  return rows;
}
export async function recoverMemoryReconcileHandoffs(
  db: Db,
  boss: MemoryReconcileBoss,
  mode = memoryReconcileHandoffMode(),
): Promise<number> {
  if (!modeRunsRecovery(mode)) return 0;
  const errors: unknown[] = [];
  let count = 0;
  let scanned = 0;
  const persistedCursor = await readLatestRecoveryCursor(db);
  const startingCursor = persistedCursor
    ? {
        dispatchSeq: persistedCursor.after_dispatch_seq,
        id: persistedCursor.after_event_id,
      }
    : undefined;
  let cursor = startingCursor;
  let wrapped = false;
  let lastScanned: RecoveryCandidate | undefined;
  while (scanned < RECOVERY_SCAN && count < RECOVERY_BATCH) {
    const page = await candidates(
      db,
      cursor,
      wrapped ? startingCursor : undefined,
      Math.min(RECOVERY_PAGE, RECOVERY_SCAN - scanned),
    );
    if (page.length === 0) {
      if (startingCursor && !wrapped) {
        wrapped = true;
        cursor = undefined;
        continue;
      }
      break;
    }
    for (const candidate of page) {
      scanned += 1;
      cursor = { dispatchSeq: candidate.dispatchSeq, id: candidate.id };
      lastScanned = candidate;
      try {
        const completion = await readIngestCompleted(db, candidate.sourceId);
        if (!completion) continue;
        const memories = await loadCompleteIntentSet(db, completion);
        if (!memories) continue;
        await dispatchMemoryReconcile(db, boss, {
          sourceEventId: candidate.sourceId,
          memories,
          completion,
        });
        count += 1;
      } catch (error) {
        errors.push(error);
      }
      if (count >= RECOVERY_BATCH) break;
    }
  }
  if (lastScanned)
    await persistRecoveryCursor(db, {
      version: 1,
      handoff_kind: 'recovery_cursor',
      after_dispatch_seq: lastScanned.dispatchSeq,
      after_event_id: lastScanned.id,
    });
  if (errors.length > 0) throw errors[0];
  return count;
}
export type { ReconcileMemInput } from './memory-reconcile-handoff-store';
