import { getStartedBoss } from '@/server/boss/client';
import { PREPARE_INTERVENTION_JOB } from './preparation-dispatch';

/**
 * Retire archived preparation jobs after the restore transaction commits. The
 * aggregate job-id fence (restored rows lose `preparation_job_id`) already
 * invalidated these deliveries atomically with the restore; the cancel only
 * cleans the transport layer, so it must run outside the restore transaction.
 */
export async function retireInterventionPreparationJobs(jobIds: string[]): Promise<void> {
  if (jobIds.length === 0) return;
  const boss = await getStartedBoss();
  await boss.cancel(PREPARE_INTERVENTION_JOB, jobIds);
}
