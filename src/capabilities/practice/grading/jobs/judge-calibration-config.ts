// judge-calibration sampling config. All knobs are env-overridable; the kill
// switch is a SEPARATE opt-in using the shared flag grammar (an enqueued run
// no-ops with zero spend while it is off).

import { canonicalProviderName } from '@/ai/task-spec';
import { type ConfigValue, getConfig } from '@/core/config/store';
import { TaskConfigError, readProviderId, resolveTaskBinding } from '@/server/ai/providers';
import type { JudgeCalibrationConfig } from '../server/judge-calibration-sample-core';

/** Opt-in dark-ship flag. Handler reads it through the shared runtime-flag grammar. */
export const JUDGE_CALIBRATION_SAMPLING_ENABLED_ENV = 'JUDGE_CALIBRATION_SAMPLING_ENABLED';

export const JUDGE_CALIBRATION_DEFAULTS: Pick<JudgeCalibrationConfig, 'batchMax' | 'windowDays'> = {
  // Per-run cost gate: default 20 single-shot re-judge calls per run,
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

/** Executed pair for the configured override. The binding reads the process
 * pin, which replaces this per-call override (`anthropic-sub` with no model
 * runs its built-in model). An unresolvable pin keeps that provider; the gate
 * still fail-closes. */
function executedRejudgePair(provider: string, model: string): { provider: string; model: string } {
  const known = readProviderId(provider);
  if (!known) return { provider, model };
  try {
    const binding = resolveTaskBinding('SemanticJudgeTask', { provider: known, model });
    return { provider: canonicalProviderName(binding.provider), model: binding.model };
  } catch (error) {
    if (!(error instanceof TaskConfigError)) throw error;
    // Binding reads the process pin. An unresolvable pin still names that
    // provider so the gate's preflight fails on the pin, not the configured pair.
    const pin = process.env.AI_PROVIDER_OVERRIDE;
    if (!pin) return { provider, model };
    return { provider: canonicalProviderName(pin), model };
  }
}

export function readJudgeCalibrationConfig(
  env: NodeJS.ProcessEnv = process.env,
): JudgeCalibrationConfig {
  // 四键 DB > env > code-default；clamp 仍在 reader 侧（registry
  // schema 校验 DB 写入，但 env 层经 numberEnv 来值仍需本地 clamp，与原
  // readIntInRange 逐位一致）。
  const batchMax = getConfig('JUDGE_CALIBRATION_BATCH_MAX', env);
  const windowDays = getConfig('JUDGE_CALIBRATION_WINDOW_DAYS', env);
  const rejudgeProvider = getConfig('JUDGE_CALIBRATION_REJUDGE_PROVIDER', env);
  const rejudgeModel = getConfig('JUDGE_CALIBRATION_REJUDGE_MODEL', env);
  const executed = executedRejudgePair(
    canonicalProviderName(
      requireConfigString('JUDGE_CALIBRATION_REJUDGE_PROVIDER', rejudgeProvider),
    ),
    requireConfigString('JUDGE_CALIBRATION_REJUDGE_MODEL', rejudgeModel),
  );
  return {
    rejudgeProvider: executed.provider,
    rejudgeModel: executed.model,
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
