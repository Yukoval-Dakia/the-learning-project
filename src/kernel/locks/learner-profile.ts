import { sql } from 'drizzle-orm';
import type { Tx } from '@/db/client';

/** The profile drain takes the learning-state lock before these sorted KC locks. */
export async function lockLearnerProfileKnowledge(tx: Tx, knowledgeId: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`learner_profile:knowledge:${knowledgeId}`}))`,
  );
}
