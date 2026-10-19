import type { Api, Model, ThinkingLevelMap } from '@earendil-works/pi-ai';
import type { Provider } from '@/ai/task-spec';
import type { ModelProfileReasoning } from './model-profiles';
import { nativePiModels, piProviderId } from './pi-provider-catalog';

export type LoomPiModel = Model<Api> & {
  maxInputTokens?: number;
  catalogReasoning?: ModelProfileReasoning;
};

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
      for (const [modelId, facts] of Object.entries(nativePiModels(lane))) {
        const template = templates.find((model) => model.id === modelId);
        if (
          !template ||
          !facts.baseUrl ||
          facts.contextWindow === undefined ||
          facts.maxTokens === undefined ||
          facts.reasoning === 'unknown' ||
          facts.input.includes('unknown')
        )
          continue;
        let thinkingLevelMap: ThinkingLevelMap | undefined;
        if (facts.thinkingLevelMap) {
          thinkingLevelMap = {};
          for (const level of [
            'off',
            'minimal',
            'low',
            'medium',
            'high',
            'xhigh',
            'max',
          ] as const) {
            thinkingLevelMap[level] = facts.thinkingLevelMap[level] ?? null;
          }
        }
        result.push({
          ...template,
          id: modelId,
          provider: id,
          baseUrl: facts.baseUrl,
          input: facts.input.filter(
            (input): input is 'text' | 'image' => input === 'text' || input === 'image',
          ),
          reasoning: facts.reasoning,
          contextWindow: facts.contextWindow,
          maxInputTokens: facts.maxInputTokens,
          maxTokens: facts.maxTokens,
          catalogReasoning: facts.catalogReasoning,
          thinkingLevelMap,
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
  return models;
}
