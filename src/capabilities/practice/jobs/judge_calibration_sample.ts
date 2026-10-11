// YUK-573 — judge_calibration_sample pg-boss handler (report-only, dark-ship).
// YUK-1355 — thin retained handler: the whole execution contract now lives in
// the extracted operation boundary (../server/calibration-sample-durable-operation.ts),
// which this handler remains the REAL runtime consumer of. The DBOS family
// adapter (src/server/durable/calibration-sample-family.ts) is an unadmitted
// migration candidate sharing that same operation; pg-boss stays the default
// backend until parent serial registration and proof.
//
// Family contract preserved verbatim:
//
//   1. Kill switch JUDGE_CALIBRATION_SAMPLING_ENABLED — default OFF. The cron
//      stays registered; the handler early-returns unless the shared runtime-flag
//      grammar enables it. Zero spend, zero events.
//
//   2. MF3① batch-level lane pre-flight — resolveTaskProvider is called BARE
//      (outside the paid-batch error hook, which only reports batch failures).
//      A missing CLAUDE_CODE_OAUTH_TOKEN / unknown provider therefore fails the
//      WHOLE handler — a pg-boss-visible failure — instead of a silent night of
//      unsupported skips (the YUK-365 Finding 2 worker-env failure face). This
//      is a DELIBERATE reverse of vision-judge-config.ts's
//      degrade-to-undefined: the calibration job's whole purpose is the
//      second-lane contrast, so a dead lane must fail loud, never silently
//      re-route or write observation rows.
//
//   3. Idempotency across pg-boss retries is DB-enforced at the EVENT layer
//      (MF8 partial unique index, drizzle/0059) — a redelivered batch skips
//      already-sampled judges as 'duplicate' instead of double-writing. That
//      index does NOT make the batch paid-idempotent: a re-executed batch
//      re-pays every selected-but-unwritten judge event (the LLM call precedes
//      the write). See the YUK-1355 timed-reference doc for the admission prerequisite.
import type { Job } from 'pg-boss';

import type { Db } from '@/db/client';
import {
  type CalibrationSampleOperationDeps,
  runCalibrationSampleOperation,
} from '../server/calibration-sample-durable-operation';
import { JUDGE_CALIBRATION_SAMPLING_ENABLED_ENV } from './judge-calibration-config';

/** Historical test seam name, kept for existing imports. */
export type JudgeCalibrationHandlerDeps = CalibrationSampleOperationDeps;

export function buildJudgeCalibrationSampleHandler(
  db: Db,
  deps: JudgeCalibrationHandlerDeps = {},
): (jobs: Job<Record<string, never>>[]) => Promise<void> {
  return async (jobs) => {
    await runCalibrationSampleOperation(db, { kind: 'pg-boss', jobId: jobs[0]?.id ?? null }, deps, {
      onDisabled: (flagEnv) =>
        console.log(
          `[judge_calibration_sample] disabled (${JUDGE_CALIBRATION_SAMPLING_ENABLED_ENV}=${JSON.stringify(flagEnv)})`,
        ),
      onSampled: (result) => console.log('[judge_calibration_sample] result', result),
      // pg-boss retry — replays land on the MF8 index (event-layer idempotency).
      onPaidBatchError: (error) => console.error('[judge_calibration_sample] failed', error),
    });
  };
}
