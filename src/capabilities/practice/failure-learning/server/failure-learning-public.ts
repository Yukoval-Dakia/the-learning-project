import type { Db } from '@/db/client';
import type { PracticeTaskRunFn } from '../../server/task-runtime';
import { type VariantProposalResult, createFailureLearning } from './failure-learning';

export interface ProposeFailureVariantInput {
  db: Db;
  attemptEventId: string;
  runTaskFn: PracticeTaskRunFn;
}

/** Narrow cross-capability entry point used by the mixed-seed author_question facade. */
export function proposeFailureVariant(
  input: ProposeFailureVariantInput,
): Promise<VariantProposalResult> {
  return createFailureLearning({
    db: input.db,
    runTaskFn: input.runTaskFn,
  }).proposeVariant({ attemptEventId: input.attemptEventId });
}

export type { VariantProposalResult };
