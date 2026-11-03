import type { Db } from '@/db/client';
import { type ActivityTier, classifyActivityTier } from '@/kernel/nightly-eligibility';
import { loadLastLearnerEventAt } from './learner-activity';

export async function loadActivityTier(db: Db, now: Date, before?: Date): Promise<ActivityTier> {
  return classifyActivityTier({
    now,
    lastLearnerEventAt: await loadLastLearnerEventAt(db, before),
  });
}
