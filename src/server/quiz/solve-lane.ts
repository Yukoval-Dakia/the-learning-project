// YUK-608 — heterogeneous solve/verify lane resolution.
//
// docs decision: owner 2026-07-23 决策清单① — solve/verify 用不同模型（异源），接线既有
// verify-framework `solverModelOverride`/`solverProviderOverride` 旋钮。落选项（人审门/接受残差）不做。
//
// WHY 异源: solve_check has the SAME model solve a draft question from scratch and compares its
// answer to the persisted one. When the SOLVER and the GENERATOR are the same model, a systematic
// blind spot (e.g. 误判「以…为…」意动用法) is reproduced on both sides and the check rubber-stamps
// it. Running the solve_check leg (SolutionGenerateTask + the semantic SemanticJudgeTask fallback)
// on a DIFFERENT provider breaks that correlation so an independent model can dissent.
//
// SCOPE — deliberately NOT the global `AI_PROVIDER_OVERRIDE` (which would also move QuizGen /
// QuizVerify and defeat the point). A dedicated pair of envs moves ONLY the solve_check leg:
//   VERIFY_SOLVE_PROVIDER_OVERRIDE — provider name, e.g. `anthropic-sub` (Opus 4.8 via Max sub).
//   VERIFY_SOLVE_MODEL_OVERRIDE    — optional model id; the provider's default applies when unset
//                                    (`anthropic-sub` → claude-opus-4-8).
//
// FAIL-OPEN (owner decision, grounded in the existing solve_check conservatism): verify is an
// AUTOMATIC supply path — a misconfigured / unavailable 异源 lane must NEVER block promotion or
// strand a draft. So this resolver PRE-FLIGHTS the override and, if the named provider is unknown
// or its credential lane is NOT wired in this process's env, DROPS the override entirely and logs
// a fall-back — the solve_check leg then runs on the default (mimo) lane, still an independent
// task/prompt, just homogeneous. (A lane that resolves but fails AT CALL TIME decays through
// runSolveCheck's existing 'unsupported' → non-blocking path — see verify-framework.ts.) The bare
// model-only override (no provider) is a same-provider model swap and is passed through as-is.

import type { Provider } from '@/ai/registry';
import { isKnownProvider, isProviderLaneReady } from '@/server/ai/providers';

export const VERIFY_SOLVE_PROVIDER_ENV = 'VERIFY_SOLVE_PROVIDER_OVERRIDE';
export const VERIFY_SOLVE_MODEL_ENV = 'VERIFY_SOLVE_MODEL_OVERRIDE';

export interface SolveOverride {
  /** Provider name — always a known + lane-ready Provider when present (pre-flighted). */
  provider?: Provider;
  /** Model id — same-provider swap when `provider` is absent. */
  model?: string;
}

/**
 * Resolve the scoped solve_check provider/model override from env, applying the fail-open
 * pre-flight described in the module header. Pure read of `process.env` — returns an empty
 * object when neither env is set, so the caller adds NO override keys and default-lane behavior
 * is byte-identical (the env-unset invariant the regression tests lock).
 *
 * @param warn injectable logger (defaults to console.warn) so tests can assert the fall-back log.
 */
export function resolveSolveOverrideFromEnv(
  warn: (message: string) => void = (m) => console.warn(m),
): SolveOverride {
  const provider = process.env[VERIFY_SOLVE_PROVIDER_ENV]?.trim() || undefined;
  const model = process.env[VERIFY_SOLVE_MODEL_ENV]?.trim() || undefined;

  if (!provider && !model) return {};

  if (provider) {
    if (!isKnownProvider(provider)) {
      // Unknown provider name → drop the WHOLE override (incl. any model, which was chosen for
      // this provider and may 404 on the default lane) and run solve_check on the default lane.
      warn(
        `[quiz_verify] ${VERIFY_SOLVE_PROVIDER_ENV}='${provider}' is not a known provider; solve_check falls back to the default lane`,
      );
      return {};
    }
    if (!isProviderLaneReady(provider)) {
      // Known provider, but its credential env is absent on this deploy → fail-open to default.
      warn(
        `[quiz_verify] solve_check 异源 lane '${provider}' is not configured (credential env missing); falling back to the default lane`,
      );
      return {};
    }
    return { provider, ...(model ? { model } : {}) };
  }

  // Model-only override (no provider): a same-provider model swap on the default lane.
  return { model };
}
