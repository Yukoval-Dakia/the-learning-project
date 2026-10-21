type SupplyDispatchQueue = 'supply_execute' | 'quiz_gen';

export interface EnqueueSupplyDispatchOptions {
  /** pg-boss singleton key: retries with the same key do not double-enqueue. */
  singletonKey?: string;
}

export async function enqueueSupplyDispatchJob(
  queue: SupplyDispatchQueue,
  data: Record<string, unknown>,
  options: EnqueueSupplyDispatchOptions = {},
): Promise<string | null> {
  const { getStartedBoss } = await import('@/server/boss/client');
  const boss = await getStartedBoss();
  return boss.send(
    queue,
    data,
    ...(options.singletonKey ? [{ singletonKey: options.singletonKey }] : []),
  );
}
