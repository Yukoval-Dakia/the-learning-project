import type { QuizGenJobData } from './quiz-gen-contract';
export { fromPgBossDrizzleTx } from '@/server/boss/pg-boss-drizzle';
export { JOB_RETRY_DELAY_SECONDS, JOB_RETRY_LIMIT } from '@/server/boss/queue-config';
import type { SendOptions } from 'pg-boss';

export async function enqueuePlacementJob(
  queue: 'quiz_gen',
  data: QuizGenJobData,
  options: SendOptions,
): Promise<string | null> {
  const { getStartedBoss } = await import('@/server/boss/client');
  const boss = await getStartedBoss();
  return boss.send(queue, data, options);
}

export async function placementJobState(jobId: string): Promise<string | null> {
  const { getStartedBoss } = await import('@/server/boss/client');
  const boss = await getStartedBoss();
  return (await boss.getJobById('quiz_gen', jobId))?.state ?? null;
}
