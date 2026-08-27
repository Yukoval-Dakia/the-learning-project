/**
 * Vision-judge provider override — YUK-482 Lane C cut ③.
 *
 * The two vision judges (multimodal_direct + steps) default to mimo
 * (xiaomi/mimo-v2.5*) via their registry `defaultProvider`. The only
 * process-global lever to route them elsewhere is `AI_PROVIDER_OVERRIDE`
 * (providers.ts), which flips EVERY task — too broad. This reader gives a
 * per-vision-judge override that routes ONLY the two vision judges to a named
 * provider (e.g. the Opus 4.8 subscription-OAuth lane, `anthropic-sub`),
 * leaving every other task on its registry default.
 *
 * ============================================================================
 * DARK-SHIPPABLE: `VISION_JUDGE_PROVIDER` DEFAULTS TO **UNSET**.
 * ============================================================================
 *
 * With the env var unset, `visionJudgeProviderOverride()` returns `undefined`,
 * so the judges keep their registry default (mimo) and behaviour is
 * byte-identical to today. The override only activates when an operator sets
 * `VISION_JUDGE_PROVIDER` explicitly. Optional `VISION_JUDGE_MODEL` overrides
 * the model (for `anthropic-sub` the resolver defaults to `claude-opus-4-8`).
 *
 * TOKEN-AVAILABILITY DEGRADE (the caveat): OAuth-lane providers (the set
 * exported as `OAUTH_PROVIDERS` from providers.ts — currently just
 * `anthropic-sub`) need `CLAUDE_CODE_OAUTH_TOKEN`. If the operator names such a
 * lane but the token is absent, returning the override would only push the
 * failure to call time (resolveTaskProvider throws when the token env is
 * missing). Instead we log a warning and return `undefined` → the caller falls
 * through to the standard provider resolution (registry default, OR
 * `AI_PROVIDER_OVERRIDE` if globally set) rather than fail the judge. The
 * warning fires per call (vision judging is low-frequency, and a repeated
 * warning helps surface the misconfig); it is not de-duplicated. Non-OAuth
 * providers are trusted as-is — an unknown provider string still reaches
 * resolveTaskProvider, which throws a clear "expected one of ..." error per
 * YUK-365 (deferred to call time, not validated here).
 */

import type { Provider } from '@/ai/registry';
import { resolveModelProfile } from '@/server/ai/model-profiles';
import { ANTHROPIC_SUB_DEFAULT_MODEL, isOauthProvider } from '@/server/ai/providers';

/** Env var that names the provider for the two vision judges. Default UNSET. */
export const VISION_JUDGE_PROVIDER_FLAG = 'VISION_JUDGE_PROVIDER';
/** Optional env var that overrides the model id for the vision judges. */
export const VISION_JUDGE_MODEL_FLAG = 'VISION_JUDGE_MODEL';

/** Env var holding the subscription-OAuth token (mirrors providers.ts). */
const OAUTH_TOKEN_ENV = 'CLAUDE_CODE_OAUTH_TOKEN';

/**
 * YUK-924 site 4 — vision-judge lane availability, profile half. Returns the
 * model id the named override lane would actually run, or undefined when no
 * model can be named locally (the judge task's registry default then decides,
 * which this module cannot see). Only anthropic-sub has a provider-built-in
 * default; every other lane without an explicit VISION_JUDGE_MODEL stays
 * UNCHECKED here — byte-identical to the pre-YUK-924 pass-through — and the
 * runTask-time capability gate (model-profiles.ts) covers the resolved lane.
 */
function visionJudgeOverrideModel(
  provider: Provider,
  model: string | undefined,
): string | undefined {
  return model ?? (provider === 'anthropic-sub' ? ANTHROPIC_SUB_DEFAULT_MODEL : undefined);
}

/**
 * Providers that authenticate via the subscription-OAuth lane and therefore
 * require `CLAUDE_CODE_OAUTH_TOKEN` at call time. Delegates to the single source
 * of truth (`OAUTH_PROVIDERS`) exported from providers.ts — adding a new OAuth
 * provider there automatically flows into this degrade-before-call check, with
 * no local mirror to drift. Kept as a local alias only for readable call sites.
 */
const isOAuthLaneProvider = isOauthProvider;

/** Minimal env shape this reader needs (a superset of NodeJS.ProcessEnv). */
export type VisionJudgeEnv = Record<string, string | undefined>;

/**
 * Resolve the per-vision-judge provider/model override.
 *
 * - `VISION_JUDGE_PROVIDER` unset → `undefined` (judges keep mimo default).
 * - OAuth-lane provider named but `CLAUDE_CODE_OAUTH_TOKEN` absent → warn (per
 *   call) and return `undefined` so the caller falls through to the standard
 *   `resolveTaskProvider` resolution chain (registry default, OR a global
 *   `AI_PROVIDER_OVERRIDE` if one is set) — NOT necessarily "the mimo default",
 *   which is why the warning says "falling back to standard provider resolution"
 *   rather than naming mimo. Returning the override here would only push the
 *   failure to call time (resolveTaskProvider throws when the token env is
 *   missing).
 * - YUK-924 site 4 — a lane whose nameable model's ModelProfile CONFIRMS
 *   `capabilities.vision === false` cannot serve the vision judges: warn and
 *   return `undefined` (same degrade shape as the OAuth-token case). 'unknown'
 *   and `true` pass through unchanged; when no model can be named locally the
 *   check is skipped and the runTask-time capability gate owns the lane.
 * - Otherwise → `{ provider, model? }` (model only when `VISION_JUDGE_MODEL`
 *   is set; the resolver supplies the lane default, e.g. claude-opus-4-8).
 */
export function visionJudgeProviderOverride(
  env: VisionJudgeEnv = process.env,
): { provider: Provider; model?: string } | undefined {
  const provider = env[VISION_JUDGE_PROVIDER_FLAG];
  if (!provider) return undefined;

  if (isOAuthLaneProvider(provider as Provider) && !env[OAUTH_TOKEN_ENV]) {
    console.warn(
      `[vision-judge] ${VISION_JUDGE_PROVIDER_FLAG}=${provider} but ${OAUTH_TOKEN_ENV} missing — omitting the override so resolution falls through to the standard chain (registry default OR AI_PROVIDER_OVERRIDE if set)`,
    );
    return undefined;
  }

  const model = env[VISION_JUDGE_MODEL_FLAG] || undefined;
  const nameableModel = visionJudgeOverrideModel(provider as Provider, model);
  if (
    nameableModel !== undefined &&
    resolveModelProfile(provider as Provider, nameableModel).capabilities.vision === false
  ) {
    console.warn(
      `[vision-judge] ${VISION_JUDGE_PROVIDER_FLAG}=${provider}${model ? ` ${VISION_JUDGE_MODEL_FLAG}=${model}` : ''} names model '${nameableModel}' whose profile confirms NO vision input — omitting the override so resolution falls through to the standard chain (declare the capability in the provider binding or pick a vision-capable model)`,
    );
    return undefined;
  }

  return { provider: provider as Provider, model };
}
