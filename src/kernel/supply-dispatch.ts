type SupplyDispatchQueue = 'supply_execute' | 'quiz_gen';

export interface EnqueueSupplyDispatchOptions {
  /** pg-boss 单例键：同键重投（DLQ 重跑/崩溃恢复窗口）不重复入队——executor 的
   * quiz_gen 派发用它关幂等窗口（YUK-988 Oracle P1-1）。 */
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
