import { and, eq, sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { Db, Tx } from '@/db/client';
import { event } from '@/db/schema';
import { FsrsRating } from '@/kernel/capability-contract-schemas';
import { assessmentAttemptEventId } from '@/kernel/records/assessment-attempt-identity';

export interface SealedSelfClaim {
  rating: z.infer<typeof FsrsRating> | null;
  confidence: number | null;
}

/**
 * Where the learner's claim lands durably: the rating seals as `user_rating` on
 * the activation receipt (first-write-wins; a conflicting retry is a
 * rating_conflict, not an overwrite), the confidence seals as
 * `self_confidence` on the attempt capture event (recorded once). Both reads
 * answer "what did the learner actually claim" after the request that carried
 * it is gone — a replayed submission's new body must never be echoed.
 */
export async function readSealedSelfClaim(
  database: Db | Tx,
  submissionId: string,
  evaluationGroupId: string,
  evaluationId: string,
): Promise<SealedSelfClaim> {
  const [receipts, attempts] = await Promise.all([
    database
      .select({ payload: event.payload })
      .from(event)
      .where(
        and(
          eq(event.action, 'experimental:assessment_activation'),
          eq(event.subject_kind, 'evaluation_group'),
          eq(event.subject_id, evaluationGroupId),
          sql`${event.payload}->>'evaluation_id' = ${evaluationId}`,
        ),
      ),
    database
      .select({ payload: event.payload })
      .from(event)
      .where(eq(event.id, assessmentAttemptEventId(submissionId)))
      .limit(1),
  ]);
  const rating = FsrsRating.safeParse(
    receipts
      .map((row) => row.payload?.user_rating)
      .find((value) => value !== undefined && value !== null),
  );
  const confidence = attempts[0]?.payload?.self_confidence;
  return {
    rating: rating.success ? rating.data : null,
    confidence: typeof confidence === 'number' ? confidence : null,
  };
}
