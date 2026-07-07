// YUK-573 — judge_calibration_sample pg-boss handler (report-only, dark-ship).
//
// Nightly disagreement sampling: re-judge recent LLM-route judge events on the
// second provider lane and record agreement observations. The core
// (../server/judge-calibration-sample-core.ts) owns the red line; this handler
// owns two guards:
//
//   1. Kill switch JUDGE_CALIBRATION_SAMPLING_ENABLED — default OFF. The cron
//      stays registered; the handler early-returns unless the flag is exactly
//      '1' (YUK-572 RESEARCH_MEETING_AGENT_ENABLED pattern). Zero spend, zero
//      events.
//
//   2. MF3① batch-level lane pre-flight — resolveTaskProvider is called BARE
//      (outside the judge routes' try/catch, which swallows provider throws
//      into coarse_outcome='unsupported'). A missing CLAUDE_CODE_OAUTH_TOKEN /
//      unknown provider therefore fails the WHOLE handler — a pg-boss-visible
//      failure — instead of a silent night of unsupported skips (the YUK-365
//      Finding 2 worker-env failure face). This is a DELIBERATE reverse of
//      vision-judge-config.ts's degrade-to-undefined: the calibration job's
//      whole purpose is the second-lane contrast, so a dead lane must fail
//      loud, never silently re-route or write observation rows.
//
// Idempotency across pg-boss retries is DB-enforced (MF8 partial unique index,
// drizzle/0059) — a redelivered batch skips already-sampled judges as
// 'duplicate' instead of double-writing.

import type { Job } from 'pg-boss';

import type { Provider } from '@/ai/registry';
import type { Db } from '@/db/client';
import { resolveTaskProvider } from '@/server/ai/providers';
import type {
  JudgeCalibrationConfig,
  JudgeCalibrationSampleDeps,
  JudgeCalibrationSampleResult,
} from '../server/judge-calibration-sample-core';
import {
  JUDGE_CALIBRATION_SAMPLING_ENABLED_ENV,
  readJudgeCalibrationConfig,
} from './judge-calibration-config';

export interface JudgeCalibrationHandlerDeps {
  /** test hook: replace the env-derived config. */
  config?: JudgeCalibrationConfig;
  /** test hook: replace the pre-flight resolver (default: REAL resolveTaskProvider).
   *  Returns void — the call exists solely for its throwing side-effect, and a
   *  sync signature keeps an async test double from turning the intended
   *  pg-boss-visible throw into a dropped promise rejection (OCR review). */
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

export function buildJudgeCalibrationSampleHandler(
  db: Db,
  deps: JudgeCalibrationHandlerDeps = {},
): (jobs: Job<Record<string, never>>[]) => Promise<void> {
  return async () => {
    // Dark-ship gate: default OFF. Zero spend / zero events when disabled.
    if (process.env[JUDGE_CALIBRATION_SAMPLING_ENABLED_ENV] !== '1') {
      console.log(
        `[judge_calibration_sample] disabled (${JUDGE_CALIBRATION_SAMPLING_ENABLED_ENV} != 1)`,
      );
      return;
    }

    const cfg = deps.config ?? readJudgeCalibrationConfig();

    // MF3① — bare pre-flight; a throw here IS the desired failure mode.
    const resolveProviderFn = deps.resolveProviderFn ?? resolveTaskProvider;
    resolveProviderFn('SemanticJudgeTask', {
      provider: cfg.rejudgeProvider as Provider,
      model: cfg.rejudgeModel,
    });

    try {
      // Lazy core import: unit tests inject runSampleFn and never load the
      // reconstruction chain (manifest lazy-load philosophy).
      const runSample =
        deps.runSampleFn ??
        (await import('../server/judge-calibration-sample-core')).runJudgeCalibrationSample;
      const result = await runSample(db, cfg, deps.sampleDeps);
      console.log('[judge_calibration_sample] result', result);
    } catch (err) {
      console.error('[judge_calibration_sample] failed', err);
      throw err; // pg-boss retry — replays are safe (MF8 unique index).
    }
  };
}
