import type { FsrsStateSchemaT } from '@/core/schema/event/blocks';
import type { Tx } from '@/db/client';
import { sql } from 'drizzle-orm';
import { getFsrsState, type FsrsSubjectKind, upsertFsrsState } from '@/server/fsrs/state';
import { scheduleReview } from './fsrs';

/**
 * The only shared state transition used by review settlement commands.
 * Callers own their attempt/judge event and transaction policy; this seam owns
 * the easy-to-drift FSRS protocol: lock, read the subject card, use the
 * question card as a cold-start fallback, compute, then optionally materialize.
 */
export async function settleFsrsSubject(input: {
  tx: Tx;
  subjectKind: FsrsSubjectKind;
  subjectId: string;
  questionId: string;
  rating: 'again' | 'hard' | 'good';
  at: Date;
  eventId: string;
}): Promise<{
  before: FsrsStateSchemaT | null;
  stateAfter: FsrsStateSchemaT;
  dueAt: Date;
}> {
  const { tx, subjectKind, subjectId, questionId, rating, at, eventId } = input;
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`fsrs:${subjectKind}:${subjectId}`}))`,
  );
  const own = await getFsrsState(tx, subjectKind, subjectId);
  const before = own?.state ?? null;
  const source =
    own ?? (subjectKind === 'knowledge' ? await getFsrsState(tx, 'question', questionId) : null);
  const scheduled = scheduleReview(
    source?.state ? { ...source.state, last_review: source.state.last_review ?? null } : null,
    rating,
    at,
  );
  const stateAfter = {
    ...scheduled.nextState,
    due: scheduled.nextState.due,
    last_review: scheduled.nextState.last_review ?? null,
  };
  await upsertFsrsState(tx, {
    subject_kind: subjectKind,
    subject_id: subjectId,
    state: stateAfter,
    due_at: scheduled.dueAt,
    last_review_event_id: eventId,
  });
  return { before, stateAfter, dueAt: scheduled.dueAt };
}
