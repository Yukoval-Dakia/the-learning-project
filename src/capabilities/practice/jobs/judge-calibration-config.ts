// YUK-573 — judge-calibration sampling config (design doc §3.5). All knobs are
// env-overridable; the kill switch is a SEPARATE opt-in using the shared flag grammar (YUK-572
// dark-ship pattern — cron stays registered, handler no-ops, zero spend).

import { getConfig } from '@/core/config/store';
import type { JudgeCalibrationConfig } from '../server/judge-calibration-sample-core';

/** Opt-in dark-ship flag. Handler reads it through the shared runtime-flag grammar. */
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

export function readJudgeCalibrationConfig(
  env: NodeJS.ProcessEnv = process.env,
): JudgeCalibrationConfig {
  // YUK-1007：四键 DB > env > code-default；clamp 仍在 reader 侧（registry
  // schema 校验 DB 写入，但 env 层经 numberEnv 来值仍需本地 clamp，与原
  // readIntInRange 逐位一致）。
  // Project the operator chat pin into sample provenance; the handler's existing
  // resolveTaskProvider preflight validates it before any paid request.
  const pin = env.AI_PROVIDER_OVERRIDE
    ? { provider: env.AI_PROVIDER_OVERRIDE, model: env.AI_PROVIDER_MODEL }
    : undefined;
  const batchMax = getConfig('JUDGE_CALIBRATION_BATCH_MAX', env);
  const windowDays = getConfig('JUDGE_CALIBRATION_WINDOW_DAYS', env);
  const rejudgeProvider = getConfig('JUDGE_CALIBRATION_REJUDGE_PROVIDER', env);
  const rejudgeModel = getConfig('JUDGE_CALIBRATION_REJUDGE_MODEL', env);
  return {
    rejudgeProvider: pin?.provider
      ? pin.provider
      : typeof rejudgeProvider === 'string' && rejudgeProvider !== ''
        ? rejudgeProvider
        : JUDGE_CALIBRATION_DEFAULTS.rejudgeProvider,
    rejudgeModel: pin?.model
      ? pin.model
      : typeof rejudgeModel === 'string' && rejudgeModel !== ''
        ? rejudgeModel
        : JUDGE_CALIBRATION_DEFAULTS.rejudgeModel,
    batchMax:
      typeof batchMax === 'number'
        ? Math.min(50, Math.max(1, batchMax))
        : JUDGE_CALIBRATION_DEFAULTS.batchMax,
    windowDays:
      typeof windowDays === 'number'
        ? Math.min(90, Math.max(1, windowDays))
        : JUDGE_CALIBRATION_DEFAULTS.windowDays,
  };
}
