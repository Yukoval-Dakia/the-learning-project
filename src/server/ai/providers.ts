// Provider Manager (Sub 0d Step 0.1) — single source of truth for which
// upstream serves each AI task. The registry (src/ai/registry.ts) declares
// `defaultProvider + defaultModel` per task; `resolveTaskModel()` looks up the
// provider here, instantiates a Vercel AI SDK LanguageModel pointed at the
// right base URL + auth, and returns it ready to pass into generateText /
// streamText.
//
// Adding a new provider: append an entry to PROVIDERS, set the env-var name +
// optional baseURL. Adding a new task: edit registry.ts only — runner.ts
// already calls resolveTaskModel(kind). No changes here.
//
// ADR-0003 (defer provider abstraction) — this lands the Step 0 spec from
// docs/superpowers/plans/2026-05-11-sub0d-agent-layer.md; xiaomi added for
// the Mimo Anthropic-compat endpoint (single-user budget routing, 2026-05-17).

import { createAnthropic } from '@ai-sdk/anthropic';
import type { LanguageModel } from 'ai';

import { type Provider, type TaskKind, tasks } from '@/ai/registry';

interface ProviderConfig {
  /** Override AI SDK default baseURL. Anthropic direct doesn't need one. */
  baseURL?: string;
  /** Env var holding the bearer / x-api-key value. */
  apiKeyEnv: string;
  /** Header to send the key under. AI SDK defaults to `x-api-key` (Anthropic). */
  apiKeyHeader?: 'x-api-key' | 'authorization';
  /** Optional human-readable note shown in errors when the env is missing. */
  description?: string;
}

const PROVIDERS: Record<Provider, ProviderConfig> = {
  anthropic: {
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    description: 'Anthropic direct (pay-as-you-go API)',
  },
  xiaomi: {
    baseURL: 'https://api.xiaomimimo.com/anthropic/v1',
    apiKeyEnv: 'XIAOMI_API_KEY',
    description: 'Xiaomi Mimo Anthropic-protocol-compat endpoint (mimo-v2.5* models)',
  },
  openrouter: {
    baseURL: 'https://openrouter.ai/api/v1',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    apiKeyHeader: 'authorization',
    description: 'OpenRouter unified multi-provider gateway (not currently in use)',
  },
  gateway: {
    baseURL: 'https://ai-gateway.vercel.sh',
    apiKeyEnv: 'VERCEL_AI_GATEWAY_TOKEN',
    apiKeyHeader: 'authorization',
    description: 'Vercel AI Gateway (not currently in use)',
  },
  openai: {
    apiKeyEnv: 'OPENAI_API_KEY',
    description: 'OpenAI direct (placeholder; not wired)',
  },
};

/**
 * Resolve a task to its concrete LanguageModel binding, ready for the AI SDK.
 *
 * Lookup order:
 *   1. `override.provider` / `override.model` if supplied (test/dev escape hatch)
 *   2. Task registry's `defaultProvider` + `defaultModel`
 *
 * Throws if the resolved provider's env var isn't set. This is intentional —
 * silent fallback to Anthropic on a missing xiaomi key would surprise the
 * caller; better to surface "XIAOMI_API_KEY is required for task X" loudly.
 */
export function resolveTaskModel(
  kind: TaskKind,
  override?: { provider?: Provider; model?: string },
): LanguageModel {
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

  // Only anthropic + xiaomi are wired through createAnthropic (both speak the
  // Anthropic Messages protocol). openrouter / gateway / openai land here as
  // "not implemented" because their wire shapes differ enough to need their
  // own AI SDK provider import + cost-harvesting logic; revisit if a real
  // trigger from ADR-0003 fires.
  if (providerName !== 'anthropic' && providerName !== 'xiaomi') {
    throw new Error(
      `Provider '${providerName}' is reserved but not implemented; only 'anthropic' and 'xiaomi' are wired.`,
    );
  }

  const provider = createAnthropic({
    apiKey,
    ...(config.baseURL ? { baseURL: config.baseURL } : {}),
  });
  return provider(modelId);
}
