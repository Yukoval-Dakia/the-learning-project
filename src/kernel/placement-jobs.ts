import type { QuizGenJobData } from './quiz-gen-contract';

/** A placement claim's delivery queue follows its stored supply route. */
export type PlacementJobQueue = 'quiz_gen' | 'supply_execute';

export { fromPgBossDrizzleTx } from '@/db/pg-boss-drizzle';
export { JOB_RETRY_DELAY_SECONDS, JOB_RETRY_LIMIT } from '@/server/boss/queue-config';

import type { SendOptions } from 'pg-boss';

export async function enqueuePlacementJob(
  queue: 'quiz_gen',
  data: QuizGenJobData,
  options: SendOptions,
): Promise<string | null> {
  return sendPlacementJob(queue, data, options);
}

export async function enqueuePlacementSupplyExecuteJob(
  data: Record<string, unknown>,
  options: SendOptions,
): Promise<string | null> {
  return sendPlacementJob('supply_execute', data, options);
}

async function sendPlacementJob(
  queue: PlacementJobQueue,
  data: object,
  options: SendOptions,
): Promise<string | null> {
  const { getStartedBoss } = await import('@/server/boss/client');
  const boss = await getStartedBoss();
  return boss.send(queue, data, options);
}

export async function placementJobState(
  jobId: string,
  queue: PlacementJobQueue = 'quiz_gen',
): Promise<string | null> {
  const { getStartedBoss } = await import('@/server/boss/client');
  const boss = await getStartedBoss();
  return (await boss.getJobById(queue, jobId))?.state ?? null;
}
