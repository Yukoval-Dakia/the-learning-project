import { sql } from 'drizzle-orm';

import type { Tx } from '@/db/client';
import { advisoryLockRegistry, deriveHashtextPairLockNamespace } from '@/kernel/locks/registry';

/** Session-lock namespace for model callers that hold the group across a model run. */
export const ASSESSMENT_EVALUATION_GROUP_LOCK_NAMESPACE = deriveHashtextPairLockNamespace(
  advisoryLockRegistry.assessmentEvaluationGroup,
);

/**
 * Serializes writes against one evaluation group (submission, evaluation, activation,
 * appeal, correction, failure-learning judge). Callers that also hold the learning-state
 * write lock take it first.
 */
export async function lockAssessmentEvaluationGroup(
  tx: Tx,
  evaluationGroupId: string,
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${ASSESSMENT_EVALUATION_GROUP_LOCK_NAMESPACE}), hashtext(${evaluationGroupId}))`,
  );
}
