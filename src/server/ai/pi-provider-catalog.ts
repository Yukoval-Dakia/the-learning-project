import type { Provider } from '@/ai/registry';
import snapshot from './pi-provider-catalog.snapshot.json' with { type: 'json' };
import { xiaomiTokenPlanBaseUrl } from './xiaomi-token-plan';

export interface PiModelMetadata {
  api: string;
  baseUrl: string;
  input: string[];
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
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
