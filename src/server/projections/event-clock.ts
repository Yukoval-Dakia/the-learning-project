import { and, desc, eq } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { event } from '@/db/schema';

/** Caller holds the entity write lock. Include genesis in the stream watermark
 * so same-clock or delayed transitions cannot sort backward. No wall-clock read. */
export async function nextProjectionEventTime(
  tx: Tx,
  kind: 'goal' | 'learning_item' | 'mistake_variant',
  id: string,
  requestedAt: Date,
): Promise<Date> {
  const [latest] = await tx
    .select({ created_at: event.created_at })
    .from(event)
    .where(and(eq(event.subject_kind, kind), eq(event.subject_id, id)))
    .orderBy(desc(event.created_at))
    .limit(1);
  return new Date(Math.max(requestedAt.getTime(), (latest?.created_at.getTime() ?? -1) + 1));
}
