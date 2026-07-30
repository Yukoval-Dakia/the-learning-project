import type { Tx } from '@/db/client';
import { getStartedBoss } from '@/server/boss/client';
import { fromPgBossDrizzleTx } from '@/server/boss/pg-boss-drizzle';
import { PREPARE_INTERVENTION_JOB } from './probe-result-subscription';

/**
 * Fence archived preparation jobs inside the same transaction that replaces
 * their aggregate rows. pg-boss cancellation retires created/retry/active rows;
 * the per-stage job-id guard handles the residual already-running handler.
 */
export async function retireInterventionPreparationJobs(tx: Tx, jobIds: string[]): Promise<void> {
  if (jobIds.length === 0) return;
  const boss = await getStartedBoss();
  await boss.cancel(PREPARE_INTERVENTION_JOB, jobIds, {
    db: fromPgBossDrizzleTx(tx),
  });
}
