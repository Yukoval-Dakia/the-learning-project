import { sql } from 'drizzle-orm';

import type { Tx } from '@/db/client';

/**
 * Serializes writes against one evaluation group (activation, appeal, failure-learning
 * judge). Callers that also hold the learning-state write lock take it first.
 */
export async function lockAssessmentEvaluationGroup(
  tx: Tx,
  evaluationGroupId: string,
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('assessment-evaluation-group'), hashtext(${evaluationGroupId}))`,
  );
}
