import type { Provider } from '@/ai/registry';
import snapshot from './pi-provider-catalog.snapshot.json' with { type: 'json' };

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

export function nativePiModels(provider: Provider): Record<string, PiModelMetadata> {
  return catalog[piProviderId(provider)] ?? {};
}

export function nativePiModel(provider: Provider, model: string): PiModelMetadata | undefined {
  const models = nativePiModels(provider);
  return Object.hasOwn(models, model) ? models[model] : undefined;
}
