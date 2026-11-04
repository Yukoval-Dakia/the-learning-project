import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, Tx } from '@/db/client';
import { event } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import {
  lockEventDerivationSources,
  readEventDerivationPolicy,
} from '@/kernel/events/derivation-policy';
import { lockMemoryIngestSource } from '@/kernel/locks/memory-locks';
import {
  MEMORY_RECONCILE_HANDOFF_ACTION,
  MemoryReconcileHandoffError,
  type ReconcileMemInput,
  canonicalHandoffJson,
  memoryIntentDigest,
  memoryReconcileHandoffEventId,
  normalizeReconcileInputs,
} from './memory-reconcile-handoff-identity';
import { noteRestrictedMemoryCompletion } from './purpose-repair-store';

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
export type IngestCompleted = z.infer<typeof CompletedSchema>;

export async function writeMemoryHandoffRecord(
  tx: Tx,
  sourceId: string,
  kind: string,
  payload: Record<string, unknown>,
  memoryId = '',
  recordId?: string,
): Promise<void> {
  const id = recordId ?? memoryReconcileHandoffEventId(kind, sourceId, memoryId);
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
    await lockMemoryIngestSource(tx, sourceId);
    const completedId = memoryReconcileHandoffEventId('ingest_completed', sourceId);
    await lockEventDerivationSources(tx, sourceId);
    if ((await readEventDerivationPolicy(tx, sourceId)) !== 'allow')
      throw new MemoryReconcileHandoffError('source purpose withdrawn before add');
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
    await writeMemoryHandoffRecord(tx, sourceId, 'add_started', {
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
    await lockMemoryIngestSource(tx, input.sourceEventId);
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
    await writeMemoryHandoffRecord(tx, input.sourceEventId, 'ingest_completed', completed);
    await lockEventDerivationSources(tx, input.sourceEventId);
    if (await noteRestrictedMemoryCompletion(tx, input.sourceEventId)) return;
  });
  return completed;
}
export async function readMemoryIngestStarted(db: Db | Tx, sourceId: string): Promise<Date | null> {
  const rows = await db
    .select({ payload: event.payload, createdAt: event.created_at })
    .from(event)
    .where(eq(event.id, memoryReconcileHandoffEventId('add_started', sourceId)))
    .limit(1);
  if (!rows[0]) return null;
  const parsed = StartedSchema.safeParse(rows[0].payload);
  if (!parsed.success || parsed.data.source_event_id !== sourceId)
    throw new MemoryReconcileHandoffError(`invalid add marker ${sourceId}`);
  return rows[0].createdAt;
}
