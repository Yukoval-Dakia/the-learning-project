import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, Tx } from '@/db/client';
import { event } from '@/db/schema';
import { writeEvent } from '@/kernel/events';

import {
  MEMORY_RECONCILE_HANDOFF_ACTION,
  MemoryReconcileHandoffError,
  type ReconcileMemInput,
  ReconcileMemInputSchema,
  canonicalHandoffJson,
  memoryIntentDigest,
  memoryReconcileHandoffEventId,
  normalizeReconcileInputs,
} from './memory-reconcile-handoff-identity';

export {
  MEMORY_RECONCILE_HANDOFF_ACTION,
  MEMORY_RECONCILE_HANDOFF_KINDS,
  MEMORY_RECONCILE_HANDOFF_VERSION,
  MemoryReconcileHandoffError,
  type ReconcileMemInput,
  memoryIntentDigest,
  memoryReconcileHandoffEventId,
  normalizeReconcileInputs,
} from './memory-reconcile-handoff-identity';

const StartedSchema = z
  .object({
    version: z.literal(1),
    handoff_kind: z.literal('add_started'),
    source_event_id: z.string().min(1),
  })
  .strict();
const CompletedSchema = z
  .object({
    version: z.literal(1),
    handoff_kind: z.literal('ingest_completed'),
    source_event_id: z.string().min(1),
    resolution: z.enum(['provider_result', 'event_lookup']),
    memory_count: z.number().int().nonnegative(),
    intent_digest: z.string().length(64),
  })
  .strict();
const IntentSchema = z
  .object({
    version: z.literal(1),
    handoff_kind: z.literal('reconcile_intent'),
    source_event_id: z.string().min(1),
    intent_digest: z.string().length(64),
    memory: ReconcileMemInputSchema,
  })
  .strict();
export type IngestCompleted = z.infer<typeof CompletedSchema>;

async function writeRecord(
  tx: Tx,
  sourceId: string,
  kind: string,
  payload: Record<string, unknown>,
  memoryId = '',
): Promise<void> {
  const id = memoryReconcileHandoffEventId(kind, sourceId, memoryId);
  const rows = await tx
    .select({ payload: event.payload })
    .from(event)
    .where(eq(event.id, id))
    .limit(1);
  if (rows[0]) {
    if (canonicalHandoffJson(rows[0].payload) !== canonicalHandoffJson(payload))
      throw new MemoryReconcileHandoffError(`handoff event ${id} conflicts`);
    return;
  }
  await writeEvent(tx, {
    id,
    actor_kind: 'system',
    actor_ref: 'memory-reconcile-handoff',
    action: MEMORY_RECONCILE_HANDOFF_ACTION,
    subject_kind: 'event',
    subject_id: sourceId,
    outcome: 'success',
    payload,
    ingest_at: new Date(),
  });
}
export async function claimMemoryIngest(
  db: Db,
  sourceId: string,
): Promise<'winner' | 'started' | 'completed'> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`memory:ingest:${sourceId}`}, 0))`,
    );
    const completedId = memoryReconcileHandoffEventId('ingest_completed', sourceId);
    const startedId = memoryReconcileHandoffEventId('add_started', sourceId);
    const rows = await tx
      .select({ id: event.id, payload: event.payload })
      .from(event)
      .where(inArray(event.id, [completedId, startedId]));
    const completed = rows.find((row) => row.id === completedId);
    if (completed) {
      const parsed = CompletedSchema.safeParse(completed.payload);
      if (!parsed.success || parsed.data.source_event_id !== sourceId)
        throw new MemoryReconcileHandoffError(`invalid completion ${sourceId}`);
      return 'completed';
    }
    const started = rows.find((row) => row.id === startedId);
    if (started) {
      const parsed = StartedSchema.safeParse(started.payload);
      if (!parsed.success || parsed.data.source_event_id !== sourceId)
        throw new MemoryReconcileHandoffError(`invalid add marker ${sourceId}`);
      return 'started';
    }
    await writeRecord(tx, sourceId, 'add_started', {
      version: 1,
      handoff_kind: 'add_started',
      source_event_id: sourceId,
    });
    return 'winner';
  });
}
export async function readIngestCompleted(
  db: Db | Tx,
  sourceId: string,
): Promise<IngestCompleted | null> {
  const id = memoryReconcileHandoffEventId('ingest_completed', sourceId);
  const rows = await db
    .select({ payload: event.payload })
    .from(event)
    .where(eq(event.id, id))
    .limit(1);
  if (!rows[0]) return null;
  const parsed = CompletedSchema.safeParse(rows[0].payload);
  if (!parsed.success || parsed.data.source_event_id !== sourceId)
    throw new MemoryReconcileHandoffError(`invalid completion ${sourceId}`);
  return parsed.data;
}
export async function persistIngestCompleted(
  db: Db,
  input: {
    readonly sourceEventId: string;
    readonly resolution: IngestCompleted['resolution'];
    readonly memories: readonly ReconcileMemInput[];
    readonly persistIntents: boolean;
  },
): Promise<IngestCompleted> {
  const memories = normalizeReconcileInputs(input.memories);
  const digest = memoryIntentDigest(memories);
  const completed: IngestCompleted = {
    version: 1,
    handoff_kind: 'ingest_completed',
    source_event_id: input.sourceEventId,
    resolution: input.resolution,
    memory_count: memories.length,
    intent_digest: digest,
  };
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`memory:ingest:${input.sourceEventId}`}, 0))`,
    );
    if (input.resolution === 'provider_result') {
      const startedId = memoryReconcileHandoffEventId('add_started', input.sourceEventId);
      const startedRows = await tx
        .select({ payload: event.payload })
        .from(event)
        .where(eq(event.id, startedId))
        .limit(1);
      const started = StartedSchema.safeParse(startedRows[0]?.payload);
      if (!started.success || started.data.source_event_id !== input.sourceEventId)
        throw new MemoryReconcileHandoffError(
          `missing or invalid add marker ${input.sourceEventId}`,
        );
    }
    await writeRecord(tx, input.sourceEventId, 'ingest_completed', completed);
    if (!input.persistIntents) return;
    for (const memory of memories)
      await writeRecord(
        tx,
        input.sourceEventId,
        'reconcile_intent',
        {
          version: 1,
          handoff_kind: 'reconcile_intent',
          source_event_id: input.sourceEventId,
          intent_digest: digest,
          memory,
        },
        memory.id,
      );
  });
  return completed;
}
export async function loadCompleteIntentSet(
  db: Db,
  completion: IngestCompleted,
): Promise<readonly ReconcileMemInput[] | null> {
  const rows = await db
    .select({ payload: event.payload })
    .from(event)
    .where(
      and(
        eq(event.action, MEMORY_RECONCILE_HANDOFF_ACTION),
        eq(event.subject_id, completion.source_event_id),
        eq(sql<string>`${event.payload} ->> 'version'`, '1'),
        eq(sql<string>`${event.payload} ->> 'handoff_kind'`, 'reconcile_intent'),
      ),
    )
    .orderBy(asc(event.id));
  const memories: ReconcileMemInput[] = [];
  for (const row of rows) {
    const parsed = IntentSchema.safeParse(row.payload);
    if (!parsed.success || parsed.data.intent_digest !== completion.intent_digest) return null;
    memories.push(parsed.data.memory);
  }
  const normalized = normalizeReconcileInputs(memories);
  return normalized.length === completion.memory_count &&
    memoryIntentDigest(normalized) === completion.intent_digest
    ? normalized
    : null;
}
export async function persistDispatchCompleted(
  db: Db,
  completion: IngestCompleted,
  memories: readonly ReconcileMemInput[],
  jobId: string,
): Promise<void> {
  const normalized = normalizeReconcileInputs(memories);
  if (
    normalized.length !== completion.memory_count ||
    memoryIntentDigest(normalized) !== completion.intent_digest
  )
    throw new MemoryReconcileHandoffError(`dispatch batch mismatch ${completion.source_event_id}`);
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`memory:dispatch:${completion.source_event_id}`}, 0))`,
    );
    for (const memory of normalized)
      await writeRecord(
        tx,
        completion.source_event_id,
        'reconcile_dispatch_complete',
        {
          version: 1,
          handoff_kind: 'reconcile_dispatch_complete',
          source_event_id: completion.source_event_id,
          memory_id: memory.id,
          intent_digest: completion.intent_digest,
          job_id: jobId,
        },
        memory.id,
      );
  });
}
