import type { Job, QueueStats } from 'pg-boss';
import {
  COPILOT_SESSION_QUEUE_PROTOCOL_VERSION,
  type CopilotDispatchBoss,
  dispatchSessionHead,
  hasCopilotRunDispatched,
} from '@/capabilities/copilot/server/durable-dispatch';
import { findOutstandingCopilotDurableRuns } from '@/capabilities/copilot/server/durable-run-observation';
import type { Db } from '@/db/client';
import { fromPgBossDrizzleTx, getStartedBoss } from '@/server/boss/client';
import { reconcileNativeSubagentsForParent } from '../server/subagent-mailbox';

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

export interface CopilotRunReconcileBoss extends CopilotDispatchBoss {
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
      if (
        candidate.protocolVersion === COPILOT_SESSION_QUEUE_PROTOCOL_VERSION &&
        !candidate.dispatched
      ) {
        const dispatchedRunId = await dispatchSessionHead(db, candidate.sessionId, {
          boss,
          transactionDb: fromPgBossDrizzleTx,
          nowMs: () => now.getTime(),
        });
        const dispatched =
          dispatchedRunId === candidate.runId ||
          (await hasCopilotRunDispatched(db, candidate.runId));
        observations[dispatched ? 'queued' : 'waiting_on_active_run'] += 1;
        continue;
      }

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
      // Child repair is separately committed: failure cannot roll back an
      // already-paid parent outcome. The candidate remains eligible for retry.
      await reconcileNativeSubagentsForParent(db, candidate.sessionId, candidate.runId);
      observations[observation] += 1;
      if (
        observation === 'settled' ||
        observation === 'projection_repaired' ||
        observation === 'pre_execution_lost' ||
        observation === 'ambiguous_execution'
      ) {
        await dispatchSessionHead(db, candidate.sessionId, {
          boss,
          transactionDb: fromPgBossDrizzleTx,
          nowMs: () => now.getTime(),
        });
      }
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
