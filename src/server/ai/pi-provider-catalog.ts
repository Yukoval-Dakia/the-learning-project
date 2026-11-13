import type { Provider } from '@/ai/registry';
import {
  customProviderDefinition,
  looksLikeCustomProviderId,
} from '@/core/config/custom-providers';
import { catalogModelIds } from './model-catalog';
import { modelCatalogOverrideProtocols } from './model-catalog-overrides';
import {
  type ModelCapabilityTriState,
  type ModelProfileReasoning,
  resolveModelProfile,
} from './model-profiles';
import snapshot from './pi-provider-catalog.snapshot.json' with { type: 'json' };

interface PiModelMetadata {
  api: string;
  baseUrl?: string;
  input: string[];
  reasoning: ModelCapabilityTriState;
  contextWindow?: number;
  maxInputTokens?: number;
  maxTokens?: number;
  catalogReasoning: ModelProfileReasoning;
  thinkingLevelMap?: Record<string, string | null>;
  thinkingFormat?: string;
}

/** Facts narrowed to the executable set (endpoint, limits, reasoning, inputs all known). */
export interface ExecutablePiModelFacts {
  api: string;
  baseUrl: string;
  input: readonly string[];
  reasoning: boolean;
  contextWindow: number;
  maxInputTokens?: number;
  inputSafetyRatio?: number;
  maxTokens: number;
  catalogReasoning: ModelProfileReasoning;
  thinkingLevelMap?: Record<string, string | null>;
  thinkingFormat?: string;
  /** thinkingFormat introduced by our overrides (not the builtin catalog) —
   *  the marker the reasoning view uses to scope unset-suppression. */
  overrideDeclaredThinkingFormat?: string;
}

/** Undefined when a required fact is missing — the model is then not executable. */
function executableFacts(facts: PiModelMetadata): ExecutablePiModelFacts | undefined {
  if (
    !facts.baseUrl ||
    facts.contextWindow === undefined ||
    facts.maxTokens === undefined ||
    facts.reasoning === 'unknown' ||
    facts.input.includes('unknown')
  ) {
    return undefined;
  }
  return facts as ExecutablePiModelFacts;
}

const protocols: Record<
  string,
  Record<string, { api: string; thinkingFormat?: string }>
> = snapshot;

/** OAuth changes the credential, not the protocol. Custom providers are their own pi identity. */
export function piProviderId(provider: Provider): string {
  if (looksLikeCustomProviderId(provider)) return provider;
  if (provider === 'anthropic-sub') return 'anthropic';
  if (provider === 'zhipuai-coding-plan') return 'zai-coding-cn';
  return provider;
}

function nativePiModels(
  provider: Provider,
  env: Record<string, string | undefined> = process.env,
): Record<string, PiModelMetadata> {
  // A custom provider's model ids come from its synthetic runtime catalog
  // bucket (its own /models listing ∩ catalog facts); the protocol is its
  // configured one, not a snapshot template.
  if (looksLikeCustomProviderId(provider)) {
    const definition = customProviderDefinition(provider);
    if (!definition) return {};
    const fallbackApi =
      definition.protocol === 'anthropic-messages' ? 'anthropic-messages' : 'openai-completions';
    return Object.fromEntries(
      catalogModelIds(provider).flatMap((id) => {
        const profile = resolveModelProfile(provider, id, env);
        if (!profile.baseUrl) return [];
        return [
          [
            id,
            {
              api: profile.api ?? fallbackApi,
              baseUrl: profile.baseUrl,
              input:
                profile.inputModalities === 'unknown' ? ['unknown'] : [...profile.inputModalities],
              reasoning: profile.capabilities.reasoning,
              contextWindow: profile.limits.contextWindowTokens,
              maxInputTokens: profile.limits.maxInputTokens,
              inputSafetyRatio: profile.limits.inputSafetyRatio,
              maxTokens: profile.limits.maxOutputTokens,
              catalogReasoning: profile.reasoning,
              thinkingLevelMap:
                profile.reasoning.mode === 'effort'
                  ? Object.fromEntries(
                      profile.reasoning.supportedEfforts.map((effort) => [effort, effort]),
                    )
                  : undefined,
            },
          ],
        ];
      }),
    );
  }
  const protocolProvider = provider === 'xiaomi-token-plan' ? 'xiaomi' : piProviderId(provider);
  // Models pi's builtin dropped but overrides still admit (models.dev-served or
  // evidence-backed) keep a declared protocol entry; the snapshot stays the
  // pi-derived truth and is never hand-edited.
  const declared = {
    ...protocols[protocolProvider],
    // token-plan reuses xiaomi's preserved-protocol declarations (v2.5* keep-
    // alive) plus its own keyed entries; baseUrl still comes from the lane's
    // own profile so nothing points at the pay-as-you-go host.
    ...(provider === 'xiaomi-token-plan' ? modelCatalogOverrideProtocols('xiaomi') : {}),
    ...modelCatalogOverrideProtocols(provider),
  };
  return Object.fromEntries(
    Object.entries(declared).flatMap(([id, protocol]) => {
      const profile = resolveModelProfile(provider, id, env);
      const api = profile.api ?? protocol.api;
      if (provider === 'opencode-go' && profile.baseUrl) {
        const path = new URL(profile.baseUrl).pathname;
        if (
          (path.includes('/anthropic/') && api !== 'anthropic-messages') ||
          (path.includes('/openai/') && api === 'anthropic-messages')
        )
          return [];
      }
      return [
        [
          id,
          {
            api,
            baseUrl: profile.baseUrl,
            input:
              profile.inputModalities === 'unknown' ? ['unknown'] : [...profile.inputModalities],
            reasoning: profile.capabilities.reasoning,
            contextWindow: profile.limits.contextWindowTokens,
            maxInputTokens: profile.limits.maxInputTokens,
            inputSafetyRatio: profile.limits.inputSafetyRatio,
            maxTokens: profile.limits.maxOutputTokens,
            catalogReasoning: profile.reasoning,
            thinkingLevelMap:
              profile.reasoning.mode === 'effort'
                ? Object.fromEntries(
                    profile.reasoning.supportedEfforts.map((effort) => [effort, effort]),
                  )
                : undefined,
            thinkingFormat: protocol.thinkingFormat,
            // Marker only when the LANE'S OWN overrides introduce the format —
            // borrowed protocol declarations (token-plan reusing xiaomi's)
            // keep pi's default wire, which is what main sent for them.
            overrideDeclaredThinkingFormat:
              modelCatalogOverrideProtocols(provider)[id]?.thinkingFormat,
          },
        ],
      ];
    }),
  );
}

export function executablePiModels(
  provider: Provider,
  env: Record<string, string | undefined> = process.env,
): ReadonlyArray<ExecutablePiModelFacts & { id: string }> {
  return Object.entries(nativePiModels(provider, env)).flatMap(([id, facts]) => {
    if (id.startsWith('mimo-v2.5')) return [];
    const executable = executableFacts(facts);
    return executable ? [{ id, ...executable }] : [];
  });
}

/** One model's executable facts; undefined = the save-time registry would reject it too. */
export function executablePiModel(
  provider: Provider,
  model: string,
  env: Record<string, string | undefined> = process.env,
): ExecutablePiModelFacts | undefined {
  if (model.startsWith('mimo-v2.5')) return undefined;
  const models = nativePiModels(provider, env);
  return Object.hasOwn(models, model) ? executableFacts(models[model]) : undefined;
}

/** Wire protocol declared for a catalog model; facts execution needs are not required. */
export function nativePiModelApi(
  provider: Provider,
  model: string,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const models = nativePiModels(provider, env);
  return Object.hasOwn(models, model) ? models[model].api : undefined;
}
