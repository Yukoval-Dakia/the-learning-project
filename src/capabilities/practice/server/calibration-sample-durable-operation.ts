// YUK-1355 — judge_calibration_sample durable operation boundary (timed-model
// group reference extraction).
//
// This module is the family-specific reusable execution boundary shared by the
// retained pg-boss handler (../jobs/judge_calibration_sample.ts — the real
// runtime consumer) and the bounded DBOS migration candidate
// (src/server/durable/calibration-sample-family.ts — NOT admitted runtime).
// It preserves the family contract verbatim:
//
//   1. Kill switch JUDGE_CALIBRATION_SAMPLING_ENABLED — default OFF, read
//      through the shared runtime-flag grammar on EVERY execution. Disabled
//      means zero spend, zero events; the cron stays registered.
//   2. MF3① batch-level bare provider pre-flight — resolveTaskProvider is
//      called OUTSIDE any swallowing try/catch (the reverse of
//      vision-judge-config.ts's degrade-to-undefined is deliberate: a dead
//      second lane must fail the WHOLE run loud, never silently re-route or
//      write observations). A throw here is a desired failure mode and is NOT
//      routed through the paid-batch error hook.
//   3. The paid batch stays the readonly core's job (lazy import preserved):
//      per-item isolation, MF8 unique-index duplicate mapping, run-summary
//      event. This module adds NO provider retries, fallbacks or new writes.
//
// A `dbos` source pins the cutoff clock and summary label to scheduledAt.
// This does not freeze candidate rows or prevent paid replay. The unregistered
// DBOS candidate evaluates only the gate until durable claims exist.
// A `pg-boss` source keeps sampleDeps.now (core default: new Date()) unchanged.

import type { Provider } from '@/ai/registry';
import { getConfigFlag } from '@/core/config/store';
import type { Db } from '@/db/client';
import { resolveTaskProvider } from '@/server/ai/providers';
import {
  JUDGE_CALIBRATION_SAMPLING_ENABLED_ENV,
  readJudgeCalibrationConfig,
} from '../jobs/judge-calibration-config';
import type {
  JudgeCalibrationConfig,
  JudgeCalibrationSampleDeps,
  JudgeCalibrationSampleResult,
} from './judge-calibration-sample-core';

/** Producer identity of one calibration tick. */
export type CalibrationSampleTickSource =
  | { kind: 'pg-boss'; jobId: string | null }
  | { kind: 'dbos'; workflowId: string; scheduledAt: Date };

/**
 * Execution seam — identical hooks to the retained handler's historical test
 * surface (config / resolveProviderFn / runSampleFn / sampleDeps), so every
 * existing injection keeps working against the extracted operation.
 */
export interface CalibrationSampleOperationDeps {
  /** test hook: replace the env-derived config. */
  config?: JudgeCalibrationConfig;
  /** test hook: replace the pre-flight resolver (default: REAL resolveTaskProvider).
   *  Returns void — the call exists solely for its throwing side-effect, and a
   *  sync signature keeps an async test double from turning the intended
   *  handler-visible throw into a dropped promise rejection (OCR review). */
  resolveProviderFn?: (
    kind: 'SemanticJudgeTask',
    override: { provider: Provider; model: string },
  ) => void;
  /** test hook: replace the sampling core (default: lazy-imported real core). */
  runSampleFn?: (
    db: Db,
    cfg: JudgeCalibrationConfig,
    deps?: JudgeCalibrationSampleDeps,
  ) => Promise<JudgeCalibrationSampleResult>;
  /** forwarded to the real core (db tests inject runTaskInner through here). */
  sampleDeps?: JudgeCalibrationSampleDeps;
}

/** Optional caller-side reporting hooks. Pure diagnostics; never swallow. */
export interface CalibrationSampleOperationHooks {
  onDisabled?(flagEnv: string | undefined): void;
  onSampled?(result: JudgeCalibrationSampleResult): void;
  /** Called ONLY for paid-batch failures, before the rethrow that preserves the
   *  backend-visible failure (pg-boss retry / DBOS workflow error). Pre-flight
   *  and gate failures bypass this hook — the original handler's distinction. */
  onPaidBatchError?(error: unknown): void;
}

export type CalibrationSampleGate =
  | { kind: 'disabled'; flagEnv: string | undefined }
  | { kind: 'enabled'; cfg: JudgeCalibrationConfig };

export type CalibrationSampleOperationOutcome =
  | { kind: 'disabled'; flagEnv: string | undefined }
  | { kind: 'sampled'; source: CalibrationSampleTickSource; result: JudgeCalibrationSampleResult };

/**
 * Phase 1 — replay-safe, zero spend. Kill switch, then config, then the bare
 * MF3① pre-flight whose throw IS the failure mode. Order matches the retained
 * handler exactly.
 */
export async function readCalibrationSampleGate(
  deps: CalibrationSampleOperationDeps = {},
): Promise<CalibrationSampleGate> {
  // Dark-ship gate: default OFF. Zero spend / zero events when disabled.
  if (!getConfigFlag(JUDGE_CALIBRATION_SAMPLING_ENABLED_ENV)) {
    return {
      kind: 'disabled',
      flagEnv: process.env[JUDGE_CALIBRATION_SAMPLING_ENABLED_ENV],
    };
  }

  const cfg = deps.config ?? readJudgeCalibrationConfig();

  // MF3① — bare pre-flight; a throw here IS the desired failure mode.
  const resolveProviderFn = deps.resolveProviderFn ?? resolveTaskProvider;
  resolveProviderFn('SemanticJudgeTask', {
    provider: cfg.rejudgeProvider as Provider,
    model: cfg.rejudgeModel,
  });

  return { kind: 'enabled', cfg };
}

/**
 * Phase 2 — the paid batch. Lazy core import preserved (unit tests inject
 * runSampleFn and never load the reconstruction chain). Errors propagate to
 * the caller; this phase never catches.
 */
export async function runCalibrationSamplePaidBatch(
  db: Db,
  cfg: JudgeCalibrationConfig,
  deps: CalibrationSampleOperationDeps = {},
): Promise<JudgeCalibrationSampleResult> {
  const runSample =
    deps.runSampleFn ?? (await import('./judge-calibration-sample-core')).runJudgeCalibrationSample;
  return runSample(db, cfg, deps.sampleDeps);
}

/** dbos sources pin the batch clock to the scheduled tick; pg-boss passes through. */
function paidBatchDeps(
  source: CalibrationSampleTickSource,
  deps: CalibrationSampleOperationDeps,
): CalibrationSampleOperationDeps {
  if (source.kind !== 'dbos') return deps;
  return {
    ...deps,
    sampleDeps: { ...deps.sampleDeps, now: () => source.scheduledAt },
  };
}

/**
 * Bind typed gate dependencies on the capability side. The DBOS candidate
 * receives only readGate and has no paid execution port.
 */
export function buildCalibrationSampleOperationPort(deps: CalibrationSampleOperationDeps = {}) {
  return { readGate: () => readCalibrationSampleGate(deps) };
}

/**
 * Composite operation — the retained handler's whole body. Gate → paid batch,
 * with reporting hooks and error rethrow preserving the backend-visible
 * failure contract (pg-boss retry; replays land on the MF8 index).
 */
export async function runCalibrationSampleOperation(
  db: Db,
  source: CalibrationSampleTickSource,
  deps: CalibrationSampleOperationDeps = {},
  hooks: CalibrationSampleOperationHooks = {},
): Promise<CalibrationSampleOperationOutcome> {
  const gate = await readCalibrationSampleGate(deps);
  if (gate.kind === 'disabled') {
    await hooks.onDisabled?.(gate.flagEnv);
    return { kind: 'disabled', flagEnv: gate.flagEnv };
  }

  let result: JudgeCalibrationSampleResult;
  try {
    result = await runCalibrationSamplePaidBatch(db, gate.cfg, paidBatchDeps(source, deps));
    await hooks.onSampled?.(result);
  } catch (error) {
    await hooks.onPaidBatchError?.(error);
    throw error;
  }
  return { kind: 'sampled', source, result };
}
