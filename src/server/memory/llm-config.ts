import { getConfig, getLaneOverride } from '@/core/config/store';
import { nativePiModel } from '@/server/ai/pi-provider-catalog';
import {
  isOauthProvider,
  providerCredentialEnvName,
  resolveGlobalProviderSwitch,
} from '@/server/ai/providers';

export type MemoryLlmConfig = {
  provider: string;
  apiKey: string;
  model: string;
  baseURL: string;
};

/** Mem0 extraction and both direct reconciliation callers share the product pin. */
export function resolveMemoryLlmConfig(
  env: Record<string, string | undefined> = process.env,
): MemoryLlmConfig {
  const pin = resolveGlobalProviderSwitch(env, getLaneOverride('global'));
  if (!pin) {
    const apiKey = env.ZHIPU_API_KEY?.trim();
    if (!apiKey) throw new Error('Mem0 memory client requires ZHIPU_API_KEY');
    // YUK-1559 — the legacy GLM model id lives in the system_config layer
    // (registry codeDefault for MEM0_LLM_MODEL); env '' resolves to it just
    // like the old `?.trim() || default` chain. A non-string resolved value
    // means a corrupt manual DB row — fail closed instead of posting a broken
    // model id.
    const configuredModel = getConfig('MEM0_LLM_MODEL', env);
    if (typeof configuredModel !== 'string' || configuredModel === '') {
      throw new Error(
        `MEM0_LLM_MODEL resolved to an unusable value (${JSON.stringify(configuredModel)})`,
      );
    }
    return {
      provider: 'glm',
      apiKey,
      model: configuredModel,
      baseURL: env.MEM0_LLM_BASE_URL?.trim() || 'https://open.bigmodel.cn/api/coding/paas/v4',
    };
  }
  const credentialEnv = providerCredentialEnvName(pin.provider);
  const native = pin.model ? nativePiModel(pin.provider, pin.model, env) : undefined;
  if (isOauthProvider(pin.provider) || native?.api !== 'openai-completions' || !pin.model) {
    throw new Error(
      `Memory LLM requires a key-auth OpenAI completions model for the global pin (${pin.provider}/${pin.model ?? 'unset'}); no legacy LLM fallback`,
    );
  }
  const apiKey = credentialEnv ? env[credentialEnv]?.trim() : undefined;
  if (!apiKey) throw new Error(`Mem0 memory client requires ${credentialEnv}`);
  return { provider: pin.provider, apiKey, model: pin.model, baseURL: native.baseUrl };
}

export function memoryLlmHeaders(
  config: MemoryLlmConfig,
  sessionId: string,
): Record<string, string> {
  return config.provider === 'opencode-go' ? { 'x-opencode-session': sessionId } : {};
}
