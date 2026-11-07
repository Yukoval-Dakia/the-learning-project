import { and, desc, eq } from 'drizzle-orm';
import { InsightPayload, JudgementPayload } from '@/core/schema/backtrace';
import type { Db, Tx } from '@/db/client';
import { event } from '@/db/schema';
import { filterActiveRows } from '@/kernel/events';
import { allowedEventIds } from '@/kernel/events/derivation-policy';
import { loadBacktraceInput } from './backtrace-input';

export async function activeBacktraceEvents(db: Db | Tx, action: string, attemptId?: string) {
  const rows = await db
    .select()
    .from(event)
    .where(and(eq(event.action, action), attemptId ? eq(event.subject_id, attemptId) : undefined))
    .orderBy(desc(event.created_at), desc(event.dispatch_seq));
  const active = await filterActiveRows(db, rows);
  const allowed = await allowedEventIds(
    db,
    active.map((x) => x.id),
  );
  return active.filter((x) => allowed.has(x.id));
}
export async function currentInsight(db: Db | Tx, attemptId: string) {
  const basis = await loadBacktraceInput(db, attemptId);
  if (!basis) return null;
  for (const row of await activeBacktraceEvents(db, 'experimental:attempt_insight', attemptId)) {
    const parsed = InsightPayload.safeParse(row.payload);
    if (parsed.success && parsed.data.input_digest === basis.digest)
      return { row, insight: parsed.data, basis };
  }
  return null;
}
export async function currentJudgement(db: Db | Tx, attemptId: string, digest: string) {
  for (const row of await activeBacktraceEvents(
    db,
    'experimental:backtrace_judgement',
    attemptId,
  )) {
    const parsed = JudgementPayload.safeParse(row.payload);
    if (parsed.success && parsed.data.pool_digest === digest)
      return { row, judgement: parsed.data };
  }
  return null;
}
