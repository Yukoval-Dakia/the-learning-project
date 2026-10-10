import { xiaomiTokenPlanBaseUrl } from './xiaomi-token-plan';

// Native pi presets own protocol, model facts and compat flags. Keep imports
// lazy: the migration bundle externalizes the ESM-only pi packages.
export async function createLoomPiModels() {
  const { builtinModels } = await import('@earendil-works/pi-ai/providers/all');
  const { createProvider } = await import('@earendil-works/pi-ai/models');
  const { openAICompletionsApi } = await import(
    '@earendil-works/pi-ai/api/openai-completions.lazy'
  );
  const models = builtinModels();
  const baseUrl = xiaomiTokenPlanBaseUrl();
  models.setProvider(
    createProvider({
      id: 'xiaomi-token-plan',
      name: 'Xiaomi Token Plan',
      baseUrl,
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
      // Preserve Xiaomi's thinking/tool-stream compat and text+image facts.
      // Availability on Token Plan still requires TEST actual-output evidence.
      models: models.getModels('xiaomi').map((model) => ({
        ...model,
        provider: 'xiaomi-token-plan',
        baseUrl,
      })),
      api: openAICompletionsApi(),
    }),
  );
  return models;
}
