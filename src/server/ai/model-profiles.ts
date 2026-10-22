import type { KnownProvider, Provider } from '@/ai/registry';
import {
  isCustomProviderConfigured,
  looksLikeCustomProviderId,
} from '@/core/config/custom-providers';
import { type ParsedCatalogModel, catalogModelEntry, catalogModelFacts } from './model-catalog';
import { modelCatalogOverride } from './model-catalog-overrides';
import { PROVIDER_MODEL_BINDINGS } from './providers';

export type ModelCapabilityTriState = true | false | 'unknown';

export interface ModelProfileCapabilities {
  toolCalling: ModelCapabilityTriState;
  vision: ModelCapabilityTriState;
  reasoning: ModelCapabilityTriState;
  structuredOutput: ModelCapabilityTriState;
  forcedToolChoice: ModelCapabilityTriState;
}

export interface ModelProfileLimits {
  contextWindowTokens?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
}

export interface ModelProfileReasoning {
  mode: 'effort' | 'budget_tokens' | 'toggle' | 'unknown';
  supportedEfforts: readonly string[];
  defaultEffort?: string;
}

export interface ModelProfileExecution {
  timeoutClass: 'standard' | 'durable-heavy';
  budgetClass: 'cheap' | 'standard' | 'heavy';
  meteredUsd: boolean;
  localPricebook: boolean;
}

/** Application policy is not a claim about upstream model capabilities. */
export interface ProviderModelBinding {
  execution?: Partial<ModelProfileExecution>;
}

export interface ModelProfile {
  provider: Provider;
  model: string;
  capabilities: ModelProfileCapabilities;
  limits: ModelProfileLimits;
  inputModalities: readonly string[] | 'unknown';
  baseUrl?: string;
  api?: ParsedCatalogModel['api'];
  reasoning: ModelProfileReasoning;
  execution: ModelProfileExecution;
  source: 'binding' | 'catalog' | 'defaults';
}

export const CATALOG_PROVIDER_BY_INTERNAL: Partial<Record<KnownProvider, string>> = {
  anthropic: 'anthropic',
  'anthropic-sub': 'anthropic',
  xiaomi: 'xiaomi',
  'zhipuai-coding-plan': 'zhipuai-coding-plan',
  'opencode-go': 'opencode-go',
  openai: 'openai',
  openrouter: 'openrouter',
};

/**
 * The runtime catalog bucket a provider's facts live in. Known providers map
 * through the static table; a custom provider (YUK-1563 part 4) owns a
 * synthetic bucket under its own id.
 */
export function catalogProviderFor(provider: Provider): string | undefined {
  if (looksLikeCustomProviderId(provider)) {
    return isCustomProviderConfigured(provider) ? provider : undefined;
  }
  return CATALOG_PROVIDER_BY_INTERNAL[provider as KnownProvider];
}

const CONSERVATIVE_EXECUTION: ModelProfileExecution = {
  timeoutClass: 'standard',
  budgetClass: 'standard',
  meteredUsd: false,
  localPricebook: false,
};

export function resolveModelProfile(
  provider: Provider,
  model: string,
  env: Record<string, string | undefined> = process.env,
): ModelProfile {
  const catalogProvider = catalogProviderFor(provider);
  let facts: ParsedCatalogModel = catalogProvider ? catalogModelFacts(catalogProvider, model) : {};
  const override = modelCatalogOverride(provider, model, env);
  // Token Plan has no catalog bucket. Reuse model facts, never Xiaomi's endpoint or tool admission.
  if (provider === 'xiaomi-token-plan' && override) {
    const { baseUrl: _base, toolCalling: _tools, ...shared } = catalogModelFacts('xiaomi', model);
    facts = shared;
  }
  let source: ModelProfile['source'] = Object.values(facts).some((value) => value !== undefined)
    ? 'catalog'
    : 'defaults';
  if (override) {
    const known = Object.fromEntries(
      Object.entries(facts).filter(([, value]) => value !== undefined),
    );
    facts =
      override.when === 'missing'
        ? { ...override.facts, ...known }
        : { ...facts, ...override.facts };
    source = 'binding';
  }
  const binding = PROVIDER_MODEL_BINDINGS[provider];
  return {
    provider,
    model,
    capabilities: {
      toolCalling: facts.toolCalling ?? 'unknown',
      vision: facts.vision ?? 'unknown',
      reasoning: facts.reasoning ?? 'unknown',
      structuredOutput: facts.structuredOutput ?? 'unknown',
      forcedToolChoice: facts.forcedToolChoice ?? 'unknown',
    },
    limits: {
      contextWindowTokens: facts.contextWindowTokens,
      maxInputTokens: facts.maxInputTokens,
      maxOutputTokens: facts.maxOutputTokens,
    },
    inputModalities: facts.inputModalities ?? 'unknown',
    baseUrl: facts.baseUrl,
    api: facts.api,
    reasoning: {
      mode: facts.reasoningMode ?? 'unknown',
      supportedEfforts: facts.supportedEfforts ?? [],
    },
    execution: {
      ...CONSERVATIVE_EXECUTION,
      ...binding?.modelDefaults?.execution,
      ...binding?.models?.[model]?.execution,
    },
    source,
  };
}

export function resolveModelProfileByModel(model: string): ModelProfile {
  for (const [provider, catalogProvider] of Object.entries(CATALOG_PROVIDER_BY_INTERNAL)) {
    if (catalogProvider && catalogModelEntry(catalogProvider, model) !== undefined) {
      return resolveModelProfile(provider as Provider, model);
    }
  }
  return resolveModelProfile('anthropic', model);
}

export interface CapabilityGatedTaskDef {
  readonly kind: string;
  readonly needsToolCall: boolean;
  readonly isMultimodal: boolean;
}

export function assertModelProfileCapabilityFit(
  def: CapabilityGatedTaskDef,
  provider: Provider,
  model: string,
): void {
  const profile = resolveModelProfile(provider, model);
  const capability =
    def.needsToolCall && profile.capabilities.toolCalling !== true
      ? 'toolCalling'
      : def.isMultimodal && profile.capabilities.vision !== true
        ? 'vision'
        : undefined;
  if (!capability) return;
  throw new Error(
    `Task ${def.kind} requires ${capability}, but '${provider}/${model}' reports ${profile.capabilities[capability]} (source: ${profile.source}). Review the catalog finding or add an evidence-backed model-catalog-overrides.ts entry; task model selection is unchanged.`,
  );
}
