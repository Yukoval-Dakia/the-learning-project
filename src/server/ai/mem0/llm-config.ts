import { DEFAULT_TASK_MODEL } from '@/ai/task-spec';
import { assertModelEndpointHostAllowed } from '@/core/config/model-endpoint-allowlist';
import { getLaneOverride } from '@/core/config/store';
import { resolveModelProfile } from '@/server/ai/model-profiles';
import { executablePiModel } from '@/server/ai/pi-provider-catalog';
import {
  LEGACY_GLM_MODEL_ID,
  isOauthProvider,
  providerAuthFileEnvName,
  providerCredentialEnvName,
  resolveGlobalProviderSwitch,
} from '@/server/ai/providers';

export type Env = Record<string, string | undefined>;

export type MemoryLlmConfig = {
  provider: string;
  apiKey: string;
  model: string;
  baseURL: string;
};

/** Memory shares product selection unless explicitly configured on the legacy memory lane. */
export function resolveMemoryLlmConfig(env: Env = process.env): MemoryLlmConfig {
  const global = resolveGlobalProviderSwitch(env, getLaneOverride('global'));
  const explicitLegacy = !!(env.MEM0_LLM_MODEL?.trim() || env.MEM0_LLM_BASE_URL?.trim());
  if (!global && explicitLegacy) {
    const apiKey = env.ZHIPU_API_KEY?.trim();
    if (!apiKey) throw new Error('Mem0 memory client requires ZHIPU_API_KEY');
    const model = env.MEM0_LLM_MODEL?.trim() || LEGACY_GLM_MODEL_ID;
    const baseURL =
      env.MEM0_LLM_BASE_URL?.trim() ||
      resolveModelProfile('zhipuai-coding-plan', model, env).baseUrl;
    if (!baseURL) throw new Error('Memory LLM catalog endpoint is unknown');
    // YUK-1654 — the unpinned rollback still sends ZHIPU_API_KEY: the endpoint
    // host must be one the catalog declares, explicit override or not.
    assertModelEndpointHostAllowed(baseURL, 'MEM0_LLM_BASE_URL (unpinned memory LLM fallback)');
    return {
      provider: 'glm',
      apiKey,
      model,
      baseURL,
    };
  }
  const pin = global ?? {
    provider: DEFAULT_TASK_MODEL.defaultProvider,
    model: DEFAULT_TASK_MODEL.defaultModel,
  };
  const credentialEnv = providerCredentialEnvName(pin.provider);
  if (credentialEnv && credentialEnv === providerAuthFileEnvName(pin.provider)) {
    throw new Error(
      `Memory LLM requires a key-auth credential for the memory selection (${pin.provider}); the ChatGPT-login file lane cannot serve it`,
    );
  }
  const native = pin.model ? executablePiModel(pin.provider, pin.model, env) : undefined;
  if (isOauthProvider(pin.provider) || !pin.model || native?.api !== 'openai-completions') {
    throw new Error(
      `Memory LLM requires a key-auth OpenAI completions model for the memory selection (${pin.provider}/${pin.model ?? 'unset'}); no legacy LLM fallback`,
    );
  }
  const apiKey = credentialEnv ? env[credentialEnv]?.trim() : undefined;
  if (!apiKey) throw new Error(`Mem0 memory client requires ${credentialEnv}`);
  assertModelEndpointHostAllowed(
    native.baseUrl,
    `memory LLM provider '${pin.provider}' model '${pin.model}'`,
  );
  return { provider: pin.provider, apiKey, model: pin.model, baseURL: native.baseUrl };
}

export function memoryLlmHeaders(
  config: MemoryLlmConfig,
  sessionId: string,
): Record<string, string> {
  return config.provider === 'opencode-go' ? { 'x-opencode-session': sessionId } : {};
}
