import { randomUUID } from 'node:crypto';
import type { Db } from '@/db/client';
import { event } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  MEMORY_RECONCILE_HANDOFF_ACTION,
  MemoryReconcileHandoffError,
  memoryReconcileHandoffEventId,
} from './memory-reconcile-handoff-identity';

const RecoveryCursorSchema = z
  .object({
    version: z.literal(1),
    handoff_kind: z.literal('recovery_cursor'),
    after_dispatch_seq: z.string().regex(/^(0|[1-9][0-9]*)$/),
    after_event_id: z.string().min(1),
  })
  .strict();
export type MemoryReconcileRecoveryCursor = z.infer<typeof RecoveryCursorSchema>;
const RECOVERY_CURSOR_SUBJECT_ID = 'memory-reconcile-recovery';

export async function readLatestRecoveryCursor(
  db: Db,
): Promise<MemoryReconcileRecoveryCursor | null> {
  const rows = await db
    .select({ payload: event.payload })
    .from(event)
    .where(
      and(
        eq(event.action, MEMORY_RECONCILE_HANDOFF_ACTION),
        eq(event.subject_id, RECOVERY_CURSOR_SUBJECT_ID),
        eq(sql<string>`${event.payload} ->> 'version'`, '1'),
        eq(sql<string>`${event.payload} ->> 'handoff_kind'`, 'recovery_cursor'),
        sql`jsonb_object_length(${event.payload}) = 4`,
      ),
    )
    .orderBy(desc(event.dispatch_seq), desc(event.id))
    .limit(1);
  if (!rows[0]) return null;
  const parsed = RecoveryCursorSchema.safeParse(rows[0].payload);
  if (!parsed.success) throw new MemoryReconcileHandoffError('invalid recovery cursor');
  return parsed.data;
}

export async function persistRecoveryCursor(
  db: Db,
  cursor: MemoryReconcileRecoveryCursor,
): Promise<void> {
  const payload = RecoveryCursorSchema.parse(cursor);
  const id = memoryReconcileHandoffEventId(
    'recovery_cursor',
    RECOVERY_CURSOR_SUBJECT_ID,
    randomUUID(),
  );
  await writeEvent(db, {
    id,
    actor_kind: 'system',
    actor_ref: 'memory-reconcile-handoff',
    action: MEMORY_RECONCILE_HANDOFF_ACTION,
    subject_kind: 'event',
    subject_id: RECOVERY_CURSOR_SUBJECT_ID,
    outcome: 'success',
    payload,
    ingest_at: new Date(),
  });
}
