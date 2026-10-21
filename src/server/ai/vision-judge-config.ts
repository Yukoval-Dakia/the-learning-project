/**
 * Vision-judge provider override — YUK-482.
 *
 * The vision judges (steps / multimodal direct / source grounding) default to
 * their registry provider. The only process-global lever, `AI_PROVIDER_OVERRIDE`,
 * flips every task, so this reader routes ONLY the vision judges to a named lane
 * (e.g. the Opus subscription-OAuth lane) and leaves everything else alone.
 *
 * DARK-SHIPPABLE: `VISION_JUDGE_PROVIDER` defaults to UNSET, so behaviour is
 * unchanged until an operator opts in. `VISION_JUDGE_MODEL` overrides the model.
 *
 * OAuth lanes need `CLAUDE_CODE_OAUTH_TOKEN`: a missing token degrades to the
 * standard resolution chain (with a per-call warning) instead of failing at call
 * time. Non-OAuth provider strings are trusted here and validated by
 * resolveTaskProvider.
 */

import type { Provider, TaskKind } from '@/capabilities/task-registry';
import { getLaneOverride } from '@/core/config/store';
import { resolveModelProfile } from '@/server/ai/model-profiles';
import {
  ANTHROPIC_SUB_DEFAULT_MODEL,
  isOauthProvider,
  readProviderId,
} from '@/server/ai/providers';

/** Live consumers of the vision override; keep validation and read facts aligned. */
export const VISION_JUDGE_TASK_KINDS = [
  'StepsJudgeTask',
  'MultimodalDirectJudgeTask',
  'SourceGroundingVerifyTask',
] as const satisfies readonly TaskKind[];

/** Env var that names the provider for the vision judges. Default UNSET. */
export const VISION_JUDGE_PROVIDER_FLAG = 'VISION_JUDGE_PROVIDER';
/** Optional env var that overrides the model id for the vision judges. */
export const VISION_JUDGE_MODEL_FLAG = 'VISION_JUDGE_MODEL';

/** Env var holding the subscription-OAuth token (mirrors providers.ts). */
const OAUTH_TOKEN_ENV = 'CLAUDE_CODE_OAUTH_TOKEN';

/**
 * YUK-924 site 4 — the model id the named lane would run when it can be named
 * locally (only anthropic-sub has a provider-built-in default). Lanes without an
 * explicit model stay UNCHECKED here; the runTask-time capability gate covers them.
 */
function visionJudgeOverrideModel(
  provider: Provider,
  model: string | undefined,
): string | undefined {
  return model ?? (provider === 'anthropic-sub' ? ANTHROPIC_SUB_DEFAULT_MODEL : undefined);
}

/**
 * Alias of the single OAuth-provider source in providers.ts, so a new OAuth lane
 * automatically reaches this degrade-before-call check.
 */
const isOAuthLaneProvider = isOauthProvider;

/** Minimal env shape this reader needs (a superset of NodeJS.ProcessEnv). */
export type VisionJudgeEnv = Record<string, string | undefined>;

/**
 * Resolve the vision-judge provider/model override.
 *
 * - Unset → undefined (judges keep their registry provider).
 * - OAuth lane without `CLAUDE_CODE_OAUTH_TOKEN` → warn and fall through to the
 *   standard resolution chain rather than fail at call time.
 * - YUK-924 site 4 — a nameable model whose profile confirms no vision input →
 *   warn and fall through; 'unknown' and true pass through.
 * - Otherwise `{ provider, model? }` (model only when explicitly configured).
 */
export function visionJudgeProviderOverride(
  env: VisionJudgeEnv = process.env,
): { provider: Provider; model?: string } | undefined {
  // YUK-1007 — DB lane config wins over env (the passed env is the fallback),
  // matching resolveTaskProvider's global override layering.
  const lane = getLaneOverride('vision_judge', env);
  const rawProvider = lane?.provider;
  if (!rawProvider) return undefined;
  const provider = readProviderId(rawProvider) ?? (rawProvider as Provider);

  if (isOAuthLaneProvider(provider as Provider) && !env[OAUTH_TOKEN_ENV]) {
    console.warn(
      `[vision-judge] ${VISION_JUDGE_PROVIDER_FLAG}=${provider} but ${OAUTH_TOKEN_ENV} missing — omitting the override so resolution falls through to the standard chain (registry default OR AI_PROVIDER_OVERRIDE if set)`,
    );
    return undefined;
  }

  const model = lane?.model || undefined;
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
