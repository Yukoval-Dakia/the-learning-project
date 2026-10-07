import { getLaneOverride } from '@/core/config/store';
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
    return {
      provider: 'glm',
      apiKey,
      model: env.MEM0_LLM_MODEL?.trim() || 'glm-5.2',
      baseURL: env.MEM0_LLM_BASE_URL?.trim() || 'https://open.bigmodel.cn/api/coding/paas/v4',
    };
  }
  const credentialEnv = providerCredentialEnvName(pin.provider);
  const native = pin.model ? nativePiModel(pin.provider, pin.model) : undefined;
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
