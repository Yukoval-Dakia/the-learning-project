import type { Job } from 'pg-boss';
import type { Db } from '@/db/client';
import { runSessionOrphanTick } from '@/server/durable/session-orphan-family';

export async function runPruneOrphanPlacementSessions(db: Db, input: { jobId: string }) {
  return runSessionOrphanTick(db, {
    family: 'prune_orphan_placement_sessions',
    source: { kind: 'pg-boss', jobId: input.jobId },
  });
}
export function buildPruneOrphanPlacementSessionsHandler(
  db: Db,
): (jobs: Job<Record<string, never>>[]) => Promise<void> {
  return async (jobs) => {
    for (const job of jobs) {
      if (job.name !== 'prune_orphan_placement_sessions')
        throw new Error('Unexpected legacy session orphan job name');
      await runPruneOrphanPlacementSessions(db, { jobId: job.id });
    }
  };
}
