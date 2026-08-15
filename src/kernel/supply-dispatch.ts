type SupplyDispatchQueue = 'sourcing' | 'quiz_gen' | 'jyeoo_fetch';

export async function enqueueSupplyDispatchJob(
  queue: SupplyDispatchQueue,
  data: Record<string, unknown>,
): Promise<string | null> {
  const { getStartedBoss } = await import('@/server/boss/client');
  const boss = await getStartedBoss();
  return boss.send(queue, data);
}
