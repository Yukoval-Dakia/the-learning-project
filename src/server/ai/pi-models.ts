// YUK-921 P4 (YUK-1025) — loom's pi model catalog.
//
// `builtinModels()` covers the three lanes whose pi-builtin entries match our
// wiring byte-for-byte: 'opencode-go' (the P1 lane — pi's catalog carries the
// correct baseUrl/model ids/api mix), 'anthropic' (api.anthropic.com,
// claude-* ids, anthropic-messages), and 'openai' (api.openai.com/v1,
// gpt-6-astra on the openai-responses wire — YUK-1027; do NOT add a custom
// PROVIDER_PI_CATALOG_SPECS entry for it, the builtin owns the Responses
// driver selection). The remaining live lanes get custom
// providers registered under OUR internal provider ids so
// `getModel(resolved.provider, resolved.model)` resolves without a mapping
// table:
//
//   - xiaomi   — Anthropic-protocol COMPAT endpoint (api.xiaomimimo.com/
//     anthropic). pi's own 'xiaomi' builtin speaks openai-completions against
//     Xiaomi's OpenAI endpoint — a different wire — so we override it.
//   - zhipu    — same story: our GLM coding-plan lane is anthropic-compat
//     (open.bigmodel.cn/api/anthropic); pi's 'zai-coding-cn' builtin is the
//     openai-completions variant.
//   - anthropic-sub — OAuth Bearer lane (CLAUDE_CODE_OAUTH_TOKEN, sk-ant-oat*).
//     The anthropic-messages driver detects the token shape and switches to
//     Bearer auth with the Claude Code identity headers. Models are the same
//     claude-* ids as the 'anthropic' builtin.
//
// Model entries derive from the committed models.dev snapshot
// (model-catalog.snapshot.json — cost/limit/modalities) merged with
// resolveModelProfile bindings (config-over-catalog: the same layering the
// SDK lane consumed, so e.g. mimo-v2.5-pro's vision override wins).
//
// The whole module is reached through dynamic import only — migrate.cjs
// externalizes @earendil-works/* and must never statically pull this tree.

import type { Provider } from '@/ai/registry';
import catalogSnapshot from './model-catalog.snapshot.json' with { type: 'json' };
import { resolveModelProfile } from './model-profiles';
import { PROVIDER_PI_CATALOG_SPECS } from './providers';

type PiApi = import('@earendil-works/pi-ai').Api;
type PiModel = import('@earendil-works/pi-ai').Model<PiApi>;
type PiMutableModels = import('@earendil-works/pi-ai').MutableModels;

type CatalogModelEntry = {
  name?: string;
  modalities?: { input?: string[] };
  reasoning?: boolean;
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
  limit?: { context?: number; output?: number };
};

type CatalogSnapshot = {
  providers: Record<string, { models: Record<string, CatalogModelEntry> }>;
};

const SNAPSHOT = catalogSnapshot as unknown as CatalogSnapshot;

/**
 * Derive one pi Model entry for (loom provider, catalog model id). Returns
 * undefined when the snapshot has no entry — the adapter's catalog-miss
 * guard then fails closed exactly like the SDK lane's endpoint 404, but
 * earlier and cheaper.
 */
function loomPiModel(
  provider: Provider,
  catalogProvider: string,
  modelId: string,
): PiModel | undefined {
  const entry = SNAPSHOT.providers[catalogProvider]?.models[modelId];
  if (!entry) return undefined;
  // The binding layer's explicit declarations win over the raw catalog —
  // mimo-v2.5-pro's production-proven vision is the canonical example.
  const profile = resolveModelProfile(provider, modelId);
  const input: ('text' | 'image')[] = ['text'];
  if (profile.capabilities.vision === true || entry.modalities?.input?.includes('image')) {
    input.push('image');
  }
  return {
    id: modelId,
    name: entry.name ?? modelId,
    api: 'anthropic-messages',
    provider,
    baseUrl: PROVIDER_PI_CATALOG_SPECS[provider]?.baseUrl ?? '',
    reasoning: entry.reasoning ?? false,
    input,
    cost: {
      input: entry.cost?.input ?? 0,
      output: entry.cost?.output ?? 0,
      cacheRead: entry.cost?.cache_read ?? 0,
      cacheWrite: entry.cost?.cache_write ?? 0,
    },
    contextWindow: profile.limits.contextWindowTokens ?? entry.limit?.context ?? 0,
    maxTokens: profile.limits.maxOutputTokens ?? entry.limit?.output ?? 8192,
  } as PiModel;
}

/**
 * Build the adapter's model registry: pi builtins + loom custom providers.
 * Custom providers expose every model their catalog bucket knows — the same
 * "endpoint decides" coverage the SDK lane had, with catalog-miss failing
 * closed inside adapter startup.
 */
export async function createLoomPiModels(): Promise<PiMutableModels> {
  const [{ builtinModels }, { createProvider, envApiKeyAuth }, { anthropicMessagesApi }] =
    await Promise.all([
      import('@earendil-works/pi-ai/providers/all'),
      import('@earendil-works/pi-ai'),
      import('@earendil-works/pi-ai/api/anthropic-messages.lazy'),
    ]);
  const models = builtinModels();
  for (const [provider, spec] of Object.entries(PROVIDER_PI_CATALOG_SPECS) as [
    Provider,
    { catalogProvider: string; baseUrl: string; credentialEnv: string; name: string },
  ][]) {
    const bucket = SNAPSHOT.providers[spec.catalogProvider]?.models ?? {};
    const entries = Object.keys(bucket)
      .map((modelId) => loomPiModel(provider, spec.catalogProvider, modelId))
      .filter((m): m is PiModel => m !== undefined);
    models.setProvider(
      createProvider({
        id: provider,
        name: spec.name,
        baseUrl: spec.baseUrl,
        auth: { apiKey: envApiKeyAuth(spec.name, [spec.credentialEnv]) },
        models: entries,
        api: anthropicMessagesApi(),
      }),
    );
  }
  return models;
}
