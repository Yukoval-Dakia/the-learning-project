import type { Provider } from '@/ai/registry';
import {
  customProviderDefinition,
  looksLikeCustomProviderId,
} from '@/core/config/custom-providers';
import { catalogModelIds } from './model-catalog';
import {
  type ModelCapabilityTriState,
  type ModelProfileReasoning,
  resolveModelProfile,
} from './model-profiles';
import snapshot from './pi-provider-catalog.snapshot.json' with { type: 'json' };

export interface PiModelMetadata {
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

export function nativePiModels(
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
  return Object.fromEntries(
    Object.entries(protocols[protocolProvider] ?? {}).flatMap(([id, protocol]) => {
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
            maxTokens: profile.limits.maxOutputTokens,
            catalogReasoning: profile.reasoning,
            thinkingLevelMap:
              profile.reasoning.mode === 'effort'
                ? Object.fromEntries(
                    profile.reasoning.supportedEfforts.map((effort) => [effort, effort]),
                  )
                : undefined,
            thinkingFormat: protocol.thinkingFormat,
          },
        ],
      ];
    }),
  );
}

export function nativePiModel(
  provider: Provider,
  model: string,
  env: Record<string, string | undefined> = process.env,
): PiModelMetadata | undefined {
  const models = nativePiModels(provider, env);
  return Object.hasOwn(models, model) ? models[model] : undefined;
}
