// Native appeals evaluate the immutable original and activate a new candidate.
// Historical queued requests receive a durable held receipt, never a fresh score.
import { eq, sql } from 'drizzle-orm';
import type { Job } from 'pg-boss';
import { canonicalHash } from '@/core/migration/canonical';
import type { Db, Tx } from '@/db/client';
import { event } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { rejudgeNativeAppeal } from '../server/assessment/appeal';

export interface RejudgeJobInput {
  appeal_event_id: string;
}

export type RejudgeOutcome =
  | Awaited<ReturnType<typeof rejudgeNativeAppeal>>
  | { status: 'skipped'; reason: string };

async function appealAlreadyResolved(db: Db | Tx, appealId: string): Promise<boolean> {
  const [existing] = await db
    .select({ id: event.id })
    .from(event)
    .where(eq(event.caused_by_event_id, appealId))
    .limit(1);
  return existing !== undefined;
}

export function buildRejudgeHandler(db: Db): (jobs: Job<RejudgeJobInput>[]) => Promise<void> {
  return async (jobs) => {
    for (const job of jobs) await handleRejudge(db, job.data);
  };
}

export async function handleRejudge(db: Db, input: RejudgeJobInput): Promise<RejudgeOutcome> {
  const [appeal] = await db.select().from(event).where(eq(event.id, input.appeal_event_id));
  if (!appeal || appeal.action !== 'experimental:appeal_request') {
    return { status: 'skipped', reason: 'appeal_event_not_found' };
  }
  if (await appealAlreadyResolved(db, appeal.id)) {
    return { status: 'skipped', reason: 'already_resolved' };
  }
  if (appeal.subject_kind === 'evaluation') return rejudgeNativeAppeal(db, appeal);

  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${appeal.id}, 0))`);
    if (await appealAlreadyResolved(tx, appeal.id)) {
      return { status: 'skipped' as const, reason: 'already_resolved' };
    }
    await writeEvent(tx, {
      id: `evt_historical_appeal_${canonicalHash(appeal.id)}`,
      session_id: appeal.session_id,
      actor_kind: 'system',
      actor_ref: 'assessment:appeal',
      action: 'experimental:assessment_appeal_resolution',
      subject_kind: 'event',
      subject_id: appeal.subject_id,
      outcome: null,
      caused_by_event_id: appeal.id,
      payload: { disposition: 'historical_unknown' },
    });
    return { status: 'held' as const, appeal_event_id: appeal.id, reason: 'historical_unknown' };
  });
}
