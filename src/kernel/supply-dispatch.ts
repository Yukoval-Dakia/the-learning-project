import { createHash } from 'node:crypto';

type SupplyDispatchQueue = 'supply_execute' | 'quiz_gen';

export interface EnqueueSupplyDispatchOptions {
  /** Deterministic key for the pg-boss job id: hashed to a uuid and deduped on
   * the job primary key, so a retried send of the same key cannot create a
   * second job. (A bare singletonKey is a no-op on these standard-policy
   * queues.) */
  jobKey?: string;
}

export async function enqueueSupplyDispatchJob(
  queue: SupplyDispatchQueue,
  data: Record<string, unknown>,
  options: EnqueueSupplyDispatchOptions = {},
): Promise<string | null> {
  const { getStartedBoss } = await import('@/server/boss/client');
  const boss = await getStartedBoss();
  const hex = options.jobKey ? createHash('sha256').update(options.jobKey).digest('hex') : null;
  const jobId =
    hex === null
      ? null
      : `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  return boss.send(queue, data, ...(jobId ? [{ id: jobId }] : []));
}
