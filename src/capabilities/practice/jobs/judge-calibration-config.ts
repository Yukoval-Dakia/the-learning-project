// YUK-573 — judge-calibration sampling config (design doc §3.5). All knobs are
// env-overridable; the kill switch is a SEPARATE strict '1' opt-in (YUK-572
// dark-ship pattern — cron stays registered, handler no-ops, zero spend).
import type { JudgeCalibrationConfig } from '../server/judge-calibration-sample-core';

/** Opt-in dark-ship flag. Handler early-returns unless this is exactly '1'. */
export const JUDGE_CALIBRATION_SAMPLING_ENABLED_ENV = 'JUDGE_CALIBRATION_SAMPLING_ENABLED';

export const JUDGE_CALIBRATION_DEFAULTS: JudgeCalibrationConfig = {
  // The second lane (YUK-365 oauth wiring). Per-task ctx.override only — the
  // global AI_PROVIDER_OVERRIDE is never set or read for routing.
  rejudgeProvider: 'anthropic-sub',
  rejudgeModel: 'claude-opus-4-8',
  // Per-cron-tick cost gate: default 20 single-shot re-judge calls per run,
  // env-adjustable up to the 50 clamp below (OCR review: the clamp IS the hard
  // ceiling — keep it near the documented default so a misconfigured env var
  // cannot starve the shared Max rate limit; MF8's unique index kills retry
  // amplification; S2 — cost_ledger shows $0 for the oauth lane).
  batchMax: 20,
  windowDays: 7,
};

function readIntInRange(
  raw: string | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  const n = Number.parseInt(raw ?? '', 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function readJudgeCalibrationConfig(
  env: NodeJS.ProcessEnv = process.env,
): JudgeCalibrationConfig {
  return {
    rejudgeProvider:
      env.JUDGE_CALIBRATION_REJUDGE_PROVIDER || JUDGE_CALIBRATION_DEFAULTS.rejudgeProvider,
    rejudgeModel: env.JUDGE_CALIBRATION_REJUDGE_MODEL || JUDGE_CALIBRATION_DEFAULTS.rejudgeModel,
    batchMax: readIntInRange(
      env.JUDGE_CALIBRATION_BATCH_MAX,
      1,
      50,
      JUDGE_CALIBRATION_DEFAULTS.batchMax,
    ),
    windowDays: readIntInRange(
      env.JUDGE_CALIBRATION_WINDOW_DAYS,
      1,
      90,
      JUDGE_CALIBRATION_DEFAULTS.windowDays,
    ),
  };
}
