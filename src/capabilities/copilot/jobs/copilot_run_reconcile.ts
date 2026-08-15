import { findOutstandingCopilotDurableRuns } from '@/capabilities/copilot/server/durable-run-observation';
import type { Db } from '@/db/client';
import { getStartedBoss } from '@/server/boss/client';
import type { BossJobObserver } from '@/server/boss/job-observation';
import type { Job, QueueStats } from 'pg-boss';

import {
  COPILOT_RUN_QUEUE,
  type CopilotDurableRunObservation,
  reconcileCopilotDurableRun,
} from './copilot_run';

export const COPILOT_RECONCILE_SCAN_LIMIT = 20;

type ObservationCounts = Record<CopilotDurableRunObservation, number>;

export interface CopilotRunReconcileReport {
  scanned: number;
  observations: ObservationCounts;
  failed: number;
}

export interface CopilotRunReconcileBoss extends BossJobObserver {
  getQueueStats(queue: string, options?: { force?: boolean }): Promise<QueueStats[]>;
}

function emptyObservationCounts(): ObservationCounts {
  return {
    settled: 0,
    projection_repaired: 0,
    queued: 0,
    waiting_on_active_run: 0,
    pickup_unavailable: 0,
    retrying: 0,
    running: 0,
    execution_settling: 0,
    pre_execution_lost: 0,
    ambiguous_execution: 0,
    unknown: 0,
  };
}

/** Bounded observation/convergence sweep. It never calls a model, tool or gateway. */
export async function reconcileOutstandingCopilotRuns(
  db: Db,
  args: { now?: Date; boss?: CopilotRunReconcileBoss; limit?: number } = {},
): Promise<CopilotRunReconcileReport> {
  const now = args.now ?? new Date();
  const boss = args.boss ?? ((await getStartedBoss()) as CopilotRunReconcileBoss);
  const observations = emptyObservationCounts();
  let queueActiveCount: number | undefined;
  try {
    queueActiveCount = (await boss.getQueueStats(COPILOT_RUN_QUEUE, { force: true }))[0]
      ?.activeCount;
  } catch (error) {
    // Specific job state is still useful. Only the busy-vs-unavailable display
    // distinction degrades to unknown when aggregate stats are unavailable.
    console.error('[copilot_run_reconcile] queue stats unavailable', error);
  }

  const candidates = await findOutstandingCopilotDurableRuns(
    db,
    args.limit ?? COPILOT_RECONCILE_SCAN_LIMIT,
  );
  let failed = 0;
  for (const candidate of candidates) {
    if (!candidate.sessionId || !candidate.triggeredBy || !candidate.bossJobId) {
      observations.unknown += 1;
      console.error('[copilot_run_reconcile] accepted run metadata is incomplete', {
        runId: candidate.runId,
        hasSessionId: Boolean(candidate.sessionId),
        hasTriggeredBy: Boolean(candidate.triggeredBy),
        hasBossJobId: Boolean(candidate.bossJobId),
      });
      continue;
    }
    try {
      const observation = await reconcileCopilotDurableRun({
        db,
        runId: candidate.runId,
        sessionId: candidate.sessionId,
        triggeredBy: candidate.triggeredBy,
        bossJobId: candidate.bossJobId,
        ...(candidate.pickupDeadlineMs !== undefined
          ? { pickupDeadlineMs: candidate.pickupDeadlineMs }
          : {}),
        ...(queueActiveCount !== undefined ? { queueActiveCount } : {}),
        now,
        boss,
      });
      observations[observation] += 1;
    } catch (error) {
      failed += 1;
      console.error('[copilot_run_reconcile] run convergence failed', {
        runId: candidate.runId,
        error,
      });
    }
  }
  const report = { scanned: candidates.length, observations, failed };
  if (candidates.length > 0) console.info('[copilot_run_reconcile] sweep', report);
  return report;
}

export function buildCopilotRunReconcileHandler(
  db: Db,
): (jobs: Job[]) => Promise<CopilotRunReconcileReport> {
  return async () => reconcileOutstandingCopilotRuns(db);
}
