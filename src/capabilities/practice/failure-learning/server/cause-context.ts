// RatingAdvisor cause-context helper. It delegates to the kernel's shared
// current/authorized cause scan: preview advice and settlement must resolve the
// same effective cause facts, while this module remains the failure-learning
// public entry and performs no cause classification of its own.

import type { CauseCategoryT } from '@/core/schema/event/blocks';
import { resolveCurrentEffectiveCauseForQuestion } from '@/kernel/read-models/cause-policy';

type Db = Parameters<typeof resolveCurrentEffectiveCauseForQuestion>[0];

/** Resolve the effective cause used by the RatingAdvisor on `questionId`. */
export async function resolveAdviceCauseForQuestion(
  db: Db,
  questionId: string,
): Promise<CauseCategoryT | null> {
  return resolveCurrentEffectiveCauseForQuestion(db, questionId);
}
