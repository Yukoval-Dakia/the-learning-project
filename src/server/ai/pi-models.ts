import type { Api, Model, ThinkingLevelMap } from '@earendil-works/pi-ai';
import type { Provider } from '@/ai/task-spec';
import {
  type CustomProviderProtocol,
  customProviderDefinitions,
} from '@/core/config/custom-providers';
import { catalogModelCost } from './model-catalog';
import type { ModelProfileReasoning } from './model-profiles';
import {
  type ExecutablePiModelFacts,
  executablePiModels,
  piProviderId,
} from './pi-provider-catalog';

export type LoomPiModel = Model<Api> & {
  maxInputTokens?: number;
  catalogReasoning?: ModelProfileReasoning;
};

/** Pure-protocol builtin lanes a custom provider clones its transport from. */
const PROTOCOL_DONOR: Record<CustomProviderProtocol, string> = {
  'openai-completions': 'deepseek',
  'anthropic-messages': 'anthropic',
};

/**
 * The model ids this provider can actually serve right now — the same
 * required-facts gate `createLoomPiModels().getModel` applies, so a panel that
 * lists these never offers a model the save-time check rejects.
 */
export function executablePiModelIds(provider: Provider): readonly string[] {
  return executablePiModels(provider)
    .map(({ id }) => id)
    .sort();
}

function thinkingLevelMapOf(
  source: Record<string, string | null> | undefined,
): ThinkingLevelMap | undefined {
  if (!source) return undefined;
  const thinkingLevelMap: ThinkingLevelMap = {};
  for (const level of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const) {
    thinkingLevelMap[level] = source[level] ?? null;
  }
  return thinkingLevelMap;
}

/** Anthropic's SDK appends /v1/messages; the API root already includes /v1. */
function baseUrlForWire(facts: ExecutablePiModelFacts): string {
  return facts.api === 'anthropic-messages' ? facts.baseUrl.replace(/\/v1$/, '') : facts.baseUrl;
}

// Pi owns transport/auth/compat. Its model facts never override the runtime directory.
export async function createLoomPiModels() {
  const { builtinModels } = await import('@earendil-works/pi-ai/providers/all');
  const models = builtinModels();
  const xiaomi = models.getProvider('xiaomi');
  const lanes: Provider[] = [
    'anthropic',
    'xiaomi',
    'xiaomi-token-plan',
    'zhipuai-coding-plan',
    'opencode-go',
    'openai',
  ];
  for (const lane of lanes) {
    const id = piProviderId(lane);
    const base = lane === 'xiaomi-token-plan' ? xiaomi : models.getProvider(id);
    if (!base) continue;
    // Freeze protocol templates, but read facts on each lookup so refreshes reach a cached adapter.
    const templates = base.getModels();
    const getModels = (): LoomPiModel[] => {
      const result: LoomPiModel[] = [];
      for (const { id: modelId, ...executable } of executablePiModels(lane)) {
        const template = templates.find((model) => model.id === modelId);
        if (!template) continue;
        result.push({
          ...template,
          id: modelId,
          provider: id,
          api: executable.api,
          compat: executable.api === template.api ? template.compat : undefined,
          baseUrl: baseUrlForWire(executable),
          input: executable.input.filter(
            (input): input is 'text' | 'image' => input === 'text' || input === 'image',
          ),
          reasoning: executable.reasoning,
          contextWindow: executable.contextWindow,
          maxInputTokens: executable.maxInputTokens,
          maxTokens: executable.maxTokens,
          catalogReasoning: executable.catalogReasoning,
          thinkingLevelMap: thinkingLevelMapOf(executable.thinkingLevelMap),
        });
      }
      return result;
    };
    models.setProvider({
      ...base,
      id,
      getModels,
      getAllModels: getModels,
      ...(lane === 'xiaomi-token-plan'
        ? {
            auth: {
              apiKey: {
                name: 'Xiaomi Token Plan API key',
                resolve: async ({ ctx, credential, signal }) => {
                  signal.throwIfAborted();
                  const apiKey = credential?.key ?? (await ctx.env('XIAOMI_TOKEN_PLAN_API_KEY'));
                  signal.throwIfAborted();
                  return apiKey ? { auth: { apiKey } } : undefined;
                },
              },
            },
          }
        : {}),
    });
  }
  // Custom providers (YUK-1563 part 4): configuration-only lanes. The donor
  // supplies the protocol transport; the credential env NAME comes from the
  // definition, model facts from the synthetic catalog bucket. No compat
  // shims — a custom endpoint gets the plain protocol wire.
  for (const definition of customProviderDefinitions()) {
    const base = models.getProvider(PROTOCOL_DONOR[definition.protocol]);
    if (!base) continue;
    const id = definition.id;
    const getModels = (): LoomPiModel[] => {
      const result: LoomPiModel[] = [];
      for (const { id: modelId, ...executable } of executablePiModels(definition.id)) {
        // Catalog rate card copied from the same-id entry; zeros only when the
        // catalog has no card (cost truth then classifies unknown, not free).
        const rates = catalogModelCost(definition.id, modelId);
        result.push({
          id: modelId,
          name: modelId,
          provider: id,
          api: executable.api,
          baseUrl: baseUrlForWire(executable),
          input: executable.input.filter(
            (input): input is 'text' | 'image' => input === 'text' || input === 'image',
          ),
          reasoning: executable.reasoning,
          contextWindow: executable.contextWindow,
          maxInputTokens: executable.maxInputTokens,
          maxTokens: executable.maxTokens,
          cost: {
            input: rates?.input ?? 0,
            output: rates?.output ?? 0,
            cacheRead: rates?.cache_read ?? 0,
            cacheWrite: rates?.cache_write ?? 0,
          },
          catalogReasoning: executable.catalogReasoning,
          thinkingLevelMap: thinkingLevelMapOf(executable.thinkingLevelMap),
        });
      }
      return result;
    };
    models.setProvider({
      ...base,
      id,
      name: definition.displayName,
      baseUrl: definition.baseUrl,
      getModels,
      getAllModels: getModels,
      auth: {
        apiKey: {
          name: `${definition.displayName} API key`,
          resolve: async ({ ctx, credential, signal }) => {
            signal.throwIfAborted();
            const apiKey = credential?.key ?? (await ctx.env(definition.apiKeyEnv));
            signal.throwIfAborted();
            return apiKey ? { auth: { apiKey } } : undefined;
          },
        },
      },
    });
  }
  return models;
}
