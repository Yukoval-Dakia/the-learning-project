import type { Api, Model, OpenAICompletionsCompat, ThinkingLevelMap } from '@earendil-works/pi-ai';
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
  overrideDeclaredThinkingFormat?: string;
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
  // ChatGPT-login lane: the OAuth credential lives in a file-backed store so a
  // pi-internal refresh persists back to disk (pi's in-memory store would lose
  // the rotation). Only present when the lane is configured.
  const chatgptPath = process.env.OPENAI_CHATGPT_AUTH_FILE;
  const { createChatGPTCredentialStore } = await import('./chatgpt-oauth-store');
  if (chatgptPath) {
    // esbuild CJS cannot run pi-ai's dynamic importOAuthModule (import.meta +
    // variable specifier); register only the openai ChatGPT flow statically so
    // refresh/toAuth works in the released bundle (bun-oauth pulls in all 9
    // flows — unnecessary weight and unrelated login paths).
    // pi-ai exposes no `auth/*` subpath — `bun-oauth` is the only public entry
    // to the loader registry.
    const { registerBunOAuthFlows } = await import('@earendil-works/pi-ai/bun-oauth');
    registerBunOAuthFlows();
  }
  const models = builtinModels(
    chatgptPath ? { credentials: createChatGPTCredentialStore(chatgptPath) } : undefined,
  );
  const xiaomi = models.getProvider('xiaomi');
  const lanes: Provider[] = [
    'anthropic',
    'xiaomi',
    'xiaomi-token-plan',
    'zhipuai-coding-plan',
    'opencode-go',
    'openai',
    'openrouter',
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
        // pi 1.5 dropped builtin templates for ids overrides still admit
        // (xiaomi/mimo-v2.5*, opencode-go legacy deepseek/grok): clone the wire
        // template from a same-provider sibling with the same api+thinkingFormat.
        let template = templates.find((model) => model.id === modelId);
        if (!template) {
          template = templates.find(
            (model) =>
              model.api === executable.api &&
              (model.compat as { thinkingFormat?: string } | undefined)?.thinkingFormat ===
                executable.thinkingFormat,
          );
          if (!template) continue;
          const rates = catalogModelCost(lane === 'xiaomi-token-plan' ? 'xiaomi' : lane, modelId);
          result.push({
            ...template,
            id: modelId,
            name: modelId,
            provider: id,
            api: executable.api,
            compat: executable.api === template.api ? template.compat : undefined,
            baseUrl: baseUrlForWire(executable),
            cost: {
              input: rates?.input ?? 0,
              output: rates?.output ?? 0,
              cacheRead: rates?.cache_read ?? 0,
              cacheWrite: rates?.cache_write ?? 0,
            },
            input: executable.input.filter(
              (input): input is 'text' | 'image' => input === 'text' || input === 'image',
            ),
            reasoning: executable.reasoning,
            contextWindow: executable.contextWindow,
            maxInputTokens: executable.maxInputTokens,
            maxTokens: executable.maxTokens,
            catalogReasoning: executable.catalogReasoning,
            overrideDeclaredThinkingFormat: executable.overrideDeclaredThinkingFormat,
            thinkingLevelMap: thinkingLevelMapOf(executable.thinkingLevelMap),
          });
          continue;
        }
        result.push({
          ...template,
          id: modelId,
          provider: id,
          api: executable.api,
          overrideDeclaredThinkingFormat: executable.overrideDeclaredThinkingFormat,
          // A declared thinkingFormat is source data (see model-catalog-overrides
          // protocol): it must reach compat so getCompat emits the model's real
          // thinking switch even when the builtin template predates it.
          compat:
            executable.api === template.api
              ? executable.thinkingFormat
                ? {
                    ...template.compat,
                    thinkingFormat:
                      executable.thinkingFormat as OpenAICompletionsCompat['thinkingFormat'],
                  }
                : template.compat
              : executable.thinkingFormat
                ? {
                    thinkingFormat:
                      executable.thinkingFormat as OpenAICompletionsCompat['thinkingFormat'],
                  }
                : undefined,
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
