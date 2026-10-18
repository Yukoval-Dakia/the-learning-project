import type { Provider } from '@/ai/registry';
import { OPENCODE_GO_OPENAI_BASE_URL, isOpenCodeGoOpenAiApi } from './opencode-go';
import snapshot from './pi-provider-catalog.snapshot.json' with { type: 'json' };
import { xiaomiTokenPlanBaseUrl } from './xiaomi-token-plan';

export interface PiModelMetadata {
  api: string;
  baseUrl: string;
  input: string[];
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  /**
   * pi 原生 thinkingLevelMap（level → 模型自己的 wire 值；null = 该 level 不支持）。
   * 非 null 的值集 = 该模型自己声明的合法 wire 值 —— providers.ts 的
   * task.<kind>.reasoning 校验读的就是它（模型自有值，非统一档位枚举）。
   */
  thinkingLevelMap?: Record<string, string | null>;
  /**
   * 模型 compat.thinkingFormat（deepseek/zai/qwen/…）——决定 reasoning_effort
   * 旁的原生开关形状（deepseek → thinking:{type:'enabled'}），providers.ts
   * resolveTaskNativeReasoningParams 按它派生 wire 参数集。
   */
  thinkingFormat?: string;
}

const catalog: Record<string, Record<string, PiModelMetadata>> = snapshot;

/** OAuth is a credential lane, not a second protocol/model catalog. */
export function piProviderId(provider: Provider): string {
  return provider === 'anthropic-sub' ? 'anthropic' : provider;
}

export function nativePiModels(
  provider: Provider,
  env: Record<string, string | undefined> = process.env,
): Record<string, PiModelMetadata> {
  if (provider === 'xiaomi-token-plan') {
    const baseUrl = xiaomiTokenPlanBaseUrl(env);
    return Object.fromEntries(
      Object.entries(catalog.xiaomi ?? {}).map(([id, model]) => [id, { ...model, baseUrl }]),
    );
  }
  // YUK-1547 — the committed snapshot records pi's builtin (legacy /zen/go/v1)
  // baseUrls; the loom-effective endpoint lives once in opencode-go.ts and is
  // re-bound here so every synchronous reader (capability gate, config
  // resolution, reopen preflight) sees the same baseUrl the runtime models
  // carry (pi-models.ts performs the identical rebind).
  if (provider === 'opencode-go') {
    return Object.fromEntries(
      Object.entries(catalog['opencode-go'] ?? {}).map(([id, model]) => [
        id,
        isOpenCodeGoOpenAiApi(model.api)
          ? { ...model, baseUrl: OPENCODE_GO_OPENAI_BASE_URL }
          : model,
      ]),
    );
  }
  return catalog[piProviderId(provider)] ?? {};
}

export function nativePiModel(
  provider: Provider,
  model: string,
  env: Record<string, string | undefined> = process.env,
): PiModelMetadata | undefined {
  const models = nativePiModels(provider, env);
  return Object.hasOwn(models, model) ? models[model] : undefined;
}
