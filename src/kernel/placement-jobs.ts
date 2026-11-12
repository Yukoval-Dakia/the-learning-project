/** A placement claim's delivery queue follows its stored supply route. */
export type PlacementJobQueue = 'quiz_gen' | 'supply_execute';

export { JOB_RETRY_DELAY_SECONDS, JOB_RETRY_LIMIT } from '@/server/boss/queue-config';

export async function placementJobState(
  jobId: string,
  queue: PlacementJobQueue = 'quiz_gen',
): Promise<string | null> {
  const { getStartedBoss } = await import('@/server/boss/client');
  const boss = await getStartedBoss();
  return (await boss.getJobById(queue, jobId))?.state ?? null;
}
