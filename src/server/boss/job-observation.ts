import { getStartedBoss } from '@/server/boss/client';
import type { JobWithMetadata } from 'pg-boss';

export type LiveBossJobState = 'created' | 'retry' | 'active';
export type SettledBossJobState = 'completed' | 'cancelled' | 'failed';

/**
 * Raw queue evidence. Domain adapters deliberately decide what a settled or
 * missing row means; this shared layer never turns observation failure into
 * deadness and never collapses `completed` into `missing`.
 */
export type BossJobObservation =
  | { kind: 'missing' }
  | { kind: 'live'; state: LiveBossJobState; job: JobWithMetadata }
  | { kind: 'settled'; state: SettledBossJobState; job: JobWithMetadata }
  | { kind: 'unknown'; error: unknown };

export interface BossJobObserver {
  getJobById(queue: string, id: string): Promise<JobWithMetadata | null>;
}

const LIVE_STATES: ReadonlySet<JobWithMetadata['state']> = new Set(['created', 'retry', 'active']);
const SETTLED_STATES: ReadonlySet<JobWithMetadata['state']> = new Set([
  'completed',
  'cancelled',
  'failed',
]);

export async function observeBossJob(
  queue: string,
  jobId: string,
  deps: { boss?: BossJobObserver } = {},
): Promise<BossJobObservation> {
  try {
    const boss = deps.boss ?? (await getStartedBoss());
    const job = (await boss.getJobById(queue, jobId)) as JobWithMetadata | null;
    if (job === null) return { kind: 'missing' };
    if (LIVE_STATES.has(job.state)) {
      return { kind: 'live', state: job.state as LiveBossJobState, job };
    }
    if (SETTLED_STATES.has(job.state)) {
      return { kind: 'settled', state: job.state as SettledBossJobState, job };
    }
    return {
      kind: 'unknown',
      error: new Error(`unsupported pg-boss job state: ${String(job.state)}`),
    };
  } catch (error) {
    return { kind: 'unknown', error };
  }
}
