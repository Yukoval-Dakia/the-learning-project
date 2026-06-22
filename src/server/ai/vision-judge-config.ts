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
 * TOKEN-AVAILABILITY DEGRADE (the caveat): the OAuth lane (`anthropic-sub`)
 * needs `CLAUDE_CODE_OAUTH_TOKEN`. If the operator names that lane but the token
 * is absent, returning the override would only push the failure to call time
 * (resolveTaskProvider throws when the token env is missing). Instead we log a
 * warning and return `undefined` → degrade to the mimo default rather than fail
 * the judge. The warning fires per call (vision judging is low-frequency, and a
 * repeated warning helps surface the misconfig); it is not de-duplicated. Non-
 * OAuth providers are trusted as-is — an unknown provider string still reaches
 * resolveTaskProvider, which throws a clear "expected one of ..." error per
 * YUK-365 (deferred to call time, not validated here).
 */

import type { Provider } from '@/ai/registry';

/** Env var that names the provider for the two vision judges. Default UNSET. */
export const VISION_JUDGE_PROVIDER_FLAG = 'VISION_JUDGE_PROVIDER';
/** Optional env var that overrides the model id for the vision judges. */
export const VISION_JUDGE_MODEL_FLAG = 'VISION_JUDGE_MODEL';

/** Env var holding the subscription-OAuth token (mirrors providers.ts). */
const OAUTH_TOKEN_ENV = 'CLAUDE_CODE_OAUTH_TOKEN';

/**
 * Providers that authenticate via the subscription-OAuth lane and therefore
 * require `CLAUDE_CODE_OAUTH_TOKEN` at call time. Mirrors the single oauth
 * entry in providers.ts `PROVIDERS` (`anthropic-sub`). Kept as a local set so
 * this reader can degrade BEFORE the runner ever resolves the provider.
 */
const OAUTH_LANE_PROVIDERS = new Set<Provider>(['anthropic-sub']);

/** Minimal env shape this reader needs (a superset of NodeJS.ProcessEnv). */
export type VisionJudgeEnv = Record<string, string | undefined>;

/**
 * Resolve the per-vision-judge provider/model override.
 *
 * - `VISION_JUDGE_PROVIDER` unset → `undefined` (judges keep mimo default).
 * - OAuth-lane provider named but `CLAUDE_CODE_OAUTH_TOKEN` absent → warn (per
 *   call) and return `undefined` (degrade to mimo) rather than a provider that
 *   would throw at call time.
 * - Otherwise → `{ provider, model? }` (model only when `VISION_JUDGE_MODEL`
 *   is set; the resolver supplies the lane default, e.g. claude-opus-4-8).
 */
export function visionJudgeProviderOverride(
  env: VisionJudgeEnv = process.env,
): { provider: Provider; model?: string } | undefined {
  const provider = env[VISION_JUDGE_PROVIDER_FLAG];
  if (!provider) return undefined;

  if (OAUTH_LANE_PROVIDERS.has(provider as Provider) && !env[OAUTH_TOKEN_ENV]) {
    console.warn(
      `[vision-judge] ${VISION_JUDGE_PROVIDER_FLAG}=${provider} but ${OAUTH_TOKEN_ENV} missing — falling back to default vision model`,
    );
    return undefined;
  }

  const model = env[VISION_JUDGE_MODEL_FLAG] || undefined;
  return { provider: provider as Provider, model };
}
