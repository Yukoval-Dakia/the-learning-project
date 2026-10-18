import { OPENCODE_GO_OPENAI_BASE_URL, isOpenCodeGoOpenAiApi } from './opencode-go';
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
  // YUK-1547 — pi-ai 1.1.0's builtin opencode-go catalog still serves the
  // legacy /zen/go/v1 base. Rebind the OpenAI-API family (completions +
  // responses share one /v1 surface) onto the official endpoint; the literal
  // lives once in opencode-go.ts. Anthropic-messages models keep their builtin
  // base — no proven new path this slice. The provider's own stream/auth
  // wiring (incl. the x-opencode-session header wrapper) is delegated through
  // untouched; only the model objects' baseUrl changes.
  const opencodeGo = models.getProvider('opencode-go');
  if (opencodeGo) {
    const rebound = opencodeGo
      .getModels()
      .map((model) =>
        isOpenCodeGoOpenAiApi(model.api)
          ? { ...model, baseUrl: OPENCODE_GO_OPENAI_BASE_URL }
          : model,
      );
    models.setProvider({
      ...opencodeGo,
      getModels: () => rebound,
      ...(opencodeGo.getAllModels ? { getAllModels: () => rebound } : {}),
    });
  }
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
