import { getLaneOverride } from '@/core/config/store';
import { resolveModelProfile } from '@/server/ai/model-profiles';
import { executablePiModel } from '@/server/ai/pi-provider-catalog';
import {
  LEGACY_GLM_MODEL_ID,
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
    const model = env.MEM0_LLM_MODEL?.trim() || LEGACY_GLM_MODEL_ID;
    const baseURL =
      env.MEM0_LLM_BASE_URL?.trim() ||
      resolveModelProfile('zhipuai-coding-plan', model, env).baseUrl;
    if (!baseURL) throw new Error('Memory LLM catalog endpoint is unknown');
    return {
      provider: 'glm',
      apiKey,
      model,
      baseURL,
    };
  }
  const credentialEnv = providerCredentialEnvName(pin.provider);
  const native = pin.model ? executablePiModel(pin.provider, pin.model, env) : undefined;
  if (isOauthProvider(pin.provider) || !pin.model || native?.api !== 'openai-completions') {
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
