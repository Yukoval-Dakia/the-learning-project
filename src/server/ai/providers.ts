// Provider Manager — single source of truth for which upstream serves each
// AI task. The registry (src/ai/registry.ts) declares `defaultProvider +
// defaultModel` per task; `resolveTaskProvider()` looks up the provider here
// and returns `{ baseUrl, apiKey, model }` for the Claude Agent SDK runner
// to forward via ANTHROPIC_BASE_URL / ANTHROPIC_API_KEY env in the spawned
// `claude` subprocess.
//
// Pre-2026-05-17 this module returned a Vercel AI SDK `LanguageModel`
// instance; the migration to @anthropic-ai/claude-agent-sdk replaces that
// with a plain config record because the SDK accepts no model handle —
// it reads its target from env vars when spawning the CLI.
//
// Adding a new provider: append an entry to PROVIDERS, set the env-var
// name + baseURL.  Adding a new task: edit registry.ts only.

import { type Provider, type TaskKind, tasks } from '@/ai/registry';

interface ProviderConfig {
  /** Override ANTHROPIC_BASE_URL. Anthropic direct doesn't need one. */
  baseUrl?: string;
  /** Env var holding the bearer / x-api-key value. */
  apiKeyEnv: string;
  /** Optional human-readable note shown in errors when the env is missing. */
  description?: string;
}

const PROVIDERS: Record<Provider, ProviderConfig> = {
  anthropic: {
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    description: 'Anthropic direct (pay-as-you-go API)',
  },
  xiaomi: {
    // No `/v1` suffix — both @anthropic-ai/sdk and the agent SDK append the
    // `/v1/messages` path themselves. Doubling up gives a 404.
    baseUrl: 'https://api.xiaomimimo.com/anthropic',
    apiKeyEnv: 'XIAOMI_API_KEY',
    description: 'Xiaomi Mimo Anthropic-protocol-compat endpoint (mimo-v2.5* models)',
  },
  openrouter: {
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    description: 'OpenRouter unified multi-provider gateway (not currently in use)',
  },
  gateway: {
    baseUrl: 'https://ai-gateway.vercel.sh',
    apiKeyEnv: 'VERCEL_AI_GATEWAY_TOKEN',
    description: 'Vercel AI Gateway (not currently in use)',
  },
  openai: {
    apiKeyEnv: 'OPENAI_API_KEY',
    description: 'OpenAI direct (placeholder; not wired)',
  },
};

export interface ResolvedProvider {
  provider: Provider;
  model: string;
  apiKey: string;
  /** undefined for Anthropic direct (uses SDK default). */
  baseUrl?: string;
}

/**
 * Resolve a task to its concrete provider binding.
 *
 * Lookup order:
 *   1. `override.provider` / `override.model` if supplied (test/dev escape hatch)
 *   2. Task registry's `defaultProvider` + `defaultModel`
 *
 * Throws if the resolved provider's env var isn't set.
 */
export function resolveTaskProvider(
  kind: TaskKind,
  override?: { provider?: Provider; model?: string },
): ResolvedProvider {
  const def = tasks[kind];
  const providerName: Provider = override?.provider ?? def.defaultProvider;
  const modelId = override?.model ?? def.defaultModel;

  const config = PROVIDERS[providerName];
  if (!config) {
    throw new Error(
      `Unknown provider '${providerName}' for task ${kind}; expected one of ${Object.keys(PROVIDERS).join(' | ')}`,
    );
  }

  const apiKey = process.env[config.apiKeyEnv];
  if (!apiKey) {
    throw new Error(
      `${config.apiKeyEnv} is required to run task ${kind} (provider=${providerName}${config.description ? ` — ${config.description}` : ''})`,
    );
  }

  // Only anthropic + xiaomi are wired; both speak the Anthropic Messages
  // protocol and so are transparently routable via ANTHROPIC_BASE_URL.
  // openrouter / gateway / openai land here as "not implemented" because
  // their wire shapes differ; revisit if a real trigger fires.
  if (providerName !== 'anthropic' && providerName !== 'xiaomi') {
    throw new Error(
      `Provider '${providerName}' is reserved but not implemented; only 'anthropic' and 'xiaomi' are wired.`,
    );
  }

  return {
    provider: providerName,
    model: modelId,
    apiKey,
    baseUrl: config.baseUrl,
  };
}
