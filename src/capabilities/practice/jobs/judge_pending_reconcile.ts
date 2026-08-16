// YUK-777 (A3) — domain-state-scan reconcile sweeper for the durable judge lane.
//
// The recovery source of truth is the DOMAIN log, never `job_events`. Design §3.6b spells out
// why: dispatch does several non-atomic things (write the pending-attempt evidence, `boss.send`,
// write the QUEUED marker), so ANY recovery keyed on `job_events` is structurally blind to the
// window it exists to cover — send-first ordering can leave a job with no marker, marker-first
// can leave a marker with no job, and a crash between the evidence and the send leaves neither.
// Scanning `experimental:judge_pending_attempt` rows for a missing `review` event asks the one
// question that holds in every one of those shapes: **did this answer ever get judged?**
//
// This handler deliberately re-enqueues rather than judging inline. It runs on the `fast` tier
// and does no LLM work itself; the paid call happens in `judge_run`, behind the same
// rate-limited enqueue face the submit route uses (`enqueueJudgeRun`). A sweeper with its own
// bespoke `boss.send` would be a producer of paid inference with no budget gate — the exact
// hazard the ticket calls out, and the worst possible one to add while a provider is already
// throttling us.
//
// Bounded on THREE axes, because an unbounded auto-recovery loop is how a stuck run turns into
// a paid-inference treadmill:
//   - per sweep: `RECONCILE_SCAN_LIMIT` runs, so a backlog drains over ticks;
//   - per run:   `MAX_RECOVERY_ATTEMPTS` re-enqueues, counted from this run's own
//                `judge_run.requeued` markers;
//   - per age:   `RECOVERY_MAX_AGE_MS`, past which the row stays as permanent evidence and
//                recovery becomes manual (RULED D6: manual-only, do not build auto-recovery
//                out ahead of observed DLQ traffic).
// Nothing is ever lost by hitting a bound — the answer is immutable evidence either way.

import type { Job } from 'pg-boss';
import type { Db } from '@/db/client';
import { writeJobEvent } from '@/server/events/writer';
import {
  JUDGE_MAX_RECOVERY_ATTEMPTS,
  JUDGE_RECOVERY_MAX_AGE_MS,
  enqueueJudgeRun,
  findStalledJudgePendingAttempts,
  getJudgeRecoveryMetadata,
  inspectJudgeQueue,
  judgeRecoveryJobId,
} from '../server/judge-run-dispatch';
import { JUDGE_RUN_EVENTS, JUDGE_RUN_TABLE } from '../server/judge-run-status';

/**
 * How long an unjudged attempt must sit before the sweeper considers it stalled.
 *
 * This is NOT the "longest a judge could legitimately take" threshold that a time-only sweeper
 * would need (`EXPIRE_LLM` is 1h and there are two redeliveries behind it, so that number would
 * be hours and the learner would wait them out). It does not need to be, because the queue
 * liveness check below is authoritative: a run whose job is still `created`/`retry`/`active` is
 * skipped no matter how old it is. The threshold only has to be comfortably longer than the
 * dispatch window itself, so a submit in flight right now is never mistaken for a stalled one.
 */
export const RECONCILE_STALL_MS = 15 * 60_000;

/**
 * Past this age the sweeper stops trying. `job_events` is pruned on a 7d retention, so beyond
 * that window the `judge_run.requeued` markers this sweeper counts to bound itself are gone —
 * without the age cap a very old row would have its recovery budget silently reset and start
 * over. Aligning the two windows keeps the bound real instead of nominal.
 */
export const RECOVERY_MAX_AGE_MS = JUDGE_RECOVERY_MAX_AGE_MS;

/** Runs re-enqueued per sweep. Bounds the burst a backlog can put on the paid queue. */
export const RECONCILE_SCAN_LIMIT = 20;
/** Raw pending rows inspected per sweep. Keeps pagination bounded when all candidates are manual. */
export const RECONCILE_RAW_SCAN_LIMIT = 200;

/**
 * Automatic re-enqueues per run. After this, the answer keeps sitting in the domain log as
 * permanent evidence and a human decides (YUK-800 A4). A run that has failed this many fresh
 * dispatches is failing for a reason no further retry will change.
 */
export const MAX_RECOVERY_ATTEMPTS = JUDGE_MAX_RECOVERY_ATTEMPTS;

export interface JudgePendingReconcileReport {
  scanned: number;
  reenqueued: number;
  /** Skipped because the queue says the run can still progress (or did not answer). */
  skippedLive: number;
  /** Skipped because pg-boss recorded deliberate terminal/DLQ evidence (D6 manual-only). */
  skippedTerminal: number;
  /** Skipped because this run has already used its automatic recovery budget. */
  skippedExhausted: number;
  /** Re-enqueue attempted and threw (rate limit, pg-boss down). Retried next tick. */
  failed: number;
}

export interface JudgePendingReconcileDeps {
  /** test seam — forwarded to `enqueueJudgeRun` / `resolveQueueLiveness`. */
  boss?: {
    send: (name: string, data: unknown, options?: { id?: string }) => Promise<string | null>;
    getJobById: (queue: string, id: string) => Promise<import('pg-boss').JobWithMetadata | null>;
  };
  checkRateLimit?: () => number;
  refundRateLimit?: (token: number) => void;
}

/**
 * One sweep. Pure of scheduling concerns (takes `now`), so it is directly callable from a test
 * and from a boot-time sweep without going through pg-boss — the `ai_task_run_reconcile` shape.
 */
export async function reconcileStalledJudgeAttempts(
  db: Db,
  args: { now?: Date; deps?: JudgePendingReconcileDeps; rawScanLimit?: number } = {},
): Promise<JudgePendingReconcileReport> {
  const now = args.now ?? new Date();
  const deps = args.deps ?? {};
  const rawScanLimit = args.rawScanLimit ?? RECONCILE_RAW_SCAN_LIMIT;
  const report: JudgePendingReconcileReport = {
    scanned: 0,
    reenqueued: 0,
    skippedLive: 0,
    skippedTerminal: 0,
    skippedExhausted: 0,
    failed: 0,
  };
  // Persist these only after the paged scan. Removing rows from the query's eligible set while
  // OFFSET is advancing would shift the remaining rows left and skip candidates in this sweep.
  // Once stamped, the next hourly run excludes them in SQL, so even a >200 manual/exhausted
  // prefix drains instead of permanently hiding later dispatch gaps.
  const newlyTerminal: Array<{
    runId: string;
    pendingEventId: string;
    reason: 'queue_terminal_manual_only' | 'recovery_budget_exhausted';
  }> = [];

  let offset = 0;
  while (report.reenqueued < RECONCILE_SCAN_LIMIT && report.scanned < rawScanLimit) {
    const page = await findStalledJudgePendingAttempts(db, {
      stalledBefore: new Date(now.getTime() - RECONCILE_STALL_MS),
      recordedAfter: new Date(now.getTime() - RECOVERY_MAX_AGE_MS),
      limit: Math.min(RECONCILE_SCAN_LIMIT - report.reenqueued, rawScanLimit - report.scanned),
      offset,
    });
    if (page.rowsRead === 0) break;
    offset += page.rowsRead;
    report.scanned += page.rowsRead;
    for (const pending of page.attempts) {
      const runId = pending.payload.run_id;

      try {
        const recovery = await getJudgeRecoveryMetadata(db, runId);

        // A terminal FAILED is an explicit decision that no delivery remains. Whether it came from
        // exhausted retries (DLQ) or a deterministic error, D6 makes recovery manual-only; queue
        // absence/completion must not reinterpret it as a dispatch gap and buy more paid calls.
        if (recovery.hasTerminalFailure) {
          report.skippedTerminal += 1;
          continue;
        }

        // Distinct attempts, not marker rows: an uncertain INSERT acknowledgement or overlapping
        // sweep can duplicate a marker for the same deterministic delivery without buying another
        // judge call.
        const priorRequeues = recovery.attempts;
        const recoveryJobId = judgeRecoveryJobId(runId, priorRequeues + 1);
        let queue = await inspectJudgeQueue(runId, {
          ...(deps.boss ? { boss: deps.boss } : {}),
          ...(recovery.latestDeliveryId ? { jobId: recovery.latestDeliveryId } : {}),
        });
        if (recovery.latestDeliveryId === null && queue.eligibility === 'eligible') {
          // A successful send can outlive a failed marker write. The deterministic next recovery
          // id is therefore a second liveness source when no marker exists: inspect it before
          // creating what would otherwise be a duplicate paid delivery.
          queue = await inspectJudgeQueue(runId, {
            ...(deps.boss ? { boss: deps.boss } : {}),
            jobId: recoveryJobId,
          });
        }
        if (queue.eligibility === 'manual') {
          report.skippedTerminal += 1;
          newlyTerminal.push({
            runId,
            pendingEventId: pending.pendingEventId,
            reason: 'queue_terminal_manual_only',
          });
          continue;
        }
        if (queue.eligibility !== 'eligible') {
          report.skippedLive += 1;
          continue;
        }

        // The budget limits creation of another delivery; it does not revoke the final delivery
        // while that job can still finish. Queue liveness above is authoritative, so only stamp a
        // terminal manual decision after the latest recovery has actually stopped.
        if (priorRequeues >= MAX_RECOVERY_ATTEMPTS) {
          report.skippedExhausted += 1;
          newlyTerminal.push({
            runId,
            pendingEventId: pending.pendingEventId,
            reason: 'recovery_budget_exhausted',
          });
          console.warn(
            `[judge_pending_reconcile] ${runId} has used its ${MAX_RECOVERY_ATTEMPTS} automatic recovery attempts — the answer stays recorded and unjudged, pending a manual re-enqueue`,
            { pending_event_id: pending.pendingEventId },
          );
          continue;
        }

        const jobId = await enqueueJudgeRun(
          { run_id: runId, caller: pending.payload.caller, submit: pending.payload.submit },
          deps,
          { jobId: recoveryJobId, acceptExistingJobId: true },
        );
        // A successful dispatch is not complete until its liveness marker is durable. Retry the
        // marker once immediately; if the DB remains unavailable, the deterministic job id keeps
        // a later sweep from creating a second delivery for the same recovery attempt.
        let markerError: unknown = null;
        for (let markerAttempt = 0; markerAttempt < 2; markerAttempt++) {
          try {
            await writeJobEvent(db, {
              business_table: JUDGE_RUN_TABLE,
              business_id: runId,
              event_type: JUDGE_RUN_EVENTS.REQUEUED,
              payload: {
                delivery_id: jobId,
                attempt: priorRequeues + 1,
                pending_event_id: pending.pendingEventId,
                submitted_at: pending.submittedAt.toISOString(),
              },
            });
            markerError = null;
            break;
          } catch (err) {
            markerError = err;
          }
        }
        if (markerError !== null) throw markerError;
        report.reenqueued += 1;
        console.info(
          `[judge_pending_reconcile] re-enqueued ${runId} (recovery attempt ${priorRequeues + 1}/${MAX_RECOVERY_ATTEMPTS})`,
        );
      } catch (err) {
        // One transient metadata query or dispatch failure must not strand the rest of the batch.
        report.failed += 1;
        console.error(
          `[judge_pending_reconcile] recovery check or enqueue failed for ${runId}`,
          err,
        );
      }
    }
  }

  for (const terminal of newlyTerminal) {
    try {
      await writeJobEvent(db, {
        business_table: JUDGE_RUN_TABLE,
        business_id: terminal.runId,
        event_type: JUDGE_RUN_EVENTS.FAILED,
        payload: {
          reason: terminal.reason,
          pending_event_id: terminal.pendingEventId,
          observed_at: now.toISOString(),
        },
      });
    } catch (err) {
      // Without the marker this row remains eligible and is retried next tick. Count the failed
      // state transition explicitly instead of claiming the permanent manual decision landed.
      report.failed += 1;
      console.error(
        `[judge_pending_reconcile] failed to persist terminal evidence for ${terminal.runId}`,
        err,
      );
    }
  }
  return report;
}

/**
 * pg-boss handler factory. Returns the report as the job `output` (YUK-779) so a sweep that
 * scanned rows but recovered none is visible in `/api/logs/jobs` instead of looking identical
 * to a sweep that had nothing to do.
 */
export function buildJudgePendingReconcileHandler(
  db: Db,
  deps: JudgePendingReconcileDeps = {},
): (jobs: Job[]) => Promise<JudgePendingReconcileReport> {
  return async () => await reconcileStalledJudgeAttempts(db, { deps });
}
