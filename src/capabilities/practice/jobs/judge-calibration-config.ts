// judge-calibration sampling config. All knobs are env-overridable; the kill
// switch is a SEPARATE opt-in using the shared flag grammar (cron stays
// registered, handler no-ops, zero spend).

import { canonicalProviderName } from '@/ai/task-spec';
import { type ConfigValue, getConfig } from '@/core/config/store';
import type { JudgeCalibrationConfig } from '../server/judge-calibration-sample-core';

/** Opt-in dark-ship flag. Handler reads it through the shared runtime-flag grammar. */
export const JUDGE_CALIBRATION_SAMPLING_ENABLED_ENV = 'JUDGE_CALIBRATION_SAMPLING_ENABLED';

export const JUDGE_CALIBRATION_DEFAULTS: Pick<JudgeCalibrationConfig, 'batchMax' | 'windowDays'> = {
  // Per-cron-tick cost gate: default 20 single-shot re-judge calls per run,
  // env-adjustable up to the 50 clamp below (the clamp IS the hard ceiling — keep
  // it near the documented default so a misconfigured env var cannot starve the
  // shared Max rate limit; the unique index on sampled events kills retry
  // amplification; the oauth lane shows $0 in cost_ledger).
  batchMax: 20,
  windowDays: 7,
};

/**
 * The rejudge lane's provider/model come from the resolved system_config
 * overrides (registry codeDefaults when nothing is written) — no duplicate
 * literal default lives here. A non-string/'' resolved value
 * means a corrupt manual DB row — fail closed instead of silently drifting
 * back to a shadow default.
 */
function requireConfigString(key: string, value: ConfigValue | undefined): string {
  if (typeof value !== 'string' || value === '') {
    throw new Error(`${key} resolved to an unusable value (${JSON.stringify(value)})`);
  }
  return value;
}

export function readJudgeCalibrationConfig(
  env: NodeJS.ProcessEnv = process.env,
): JudgeCalibrationConfig {
  // 四键 DB > env > code-default；clamp 仍在 reader 侧（registry
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
    rejudgeProvider: canonicalProviderName(
      pin?.provider
        ? pin.provider
        : requireConfigString('JUDGE_CALIBRATION_REJUDGE_PROVIDER', rejudgeProvider),
    ),
    rejudgeModel: pin?.model
      ? pin.model
      : requireConfigString('JUDGE_CALIBRATION_REJUDGE_MODEL', rejudgeModel),
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
