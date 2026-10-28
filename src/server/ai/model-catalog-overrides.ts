import type { Provider } from '@/ai/task-spec';
import { endpointKeyOf } from '@/core/config/model-endpoint-allowlist';
import type { ParsedCatalogModel } from './model-catalog';
import protocols from './pi-provider-catalog.snapshot.json' with { type: 'json' };

type CatalogOverride = {
  when: 'missing' | 'disagreement';
  reason: string;
  facts: ParsedCatalogModel;
};

const missingAnthropicEndpoint: CatalogOverride = {
  when: 'missing',
  reason:
    'models.dev omits Anthropic api. The first-party Messages SDK takes the server root (docs.anthropic.com/en/api/messages).',
  facts: { baseUrl: 'https://api.anthropic.com' },
};
const missingOpenAiEndpoint: CatalogOverride = {
  when: 'missing',
  reason:
    'models.dev omits OpenAI api. First-party Responses uses /v1 (platform.openai.com/docs/api-reference/responses).',
  facts: { baseUrl: 'https://api.openai.com/v1' },
};

const overrides: Partial<Record<Provider, Record<string, CatalogOverride>>> = {
  anthropic: Object.fromEntries(
    Object.keys(protocols.anthropic).map((model) => [model, missingAnthropicEndpoint]),
  ),
  'anthropic-sub': Object.fromEntries(
    Object.keys(protocols.anthropic).map((model) => [model, missingAnthropicEndpoint]),
  ),
  openai: {
    ...Object.fromEntries(
      Object.keys(protocols.openai).map((model) => [model, missingOpenAiEndpoint]),
    ),
    'gpt-5-chat-latest': {
      when: 'missing',
      reason:
        'Absent from models.dev. Preserve the wired metadata in main 518c8b21:src/server/ai/pi-provider-catalog.snapshot.json; not a new live-provider admission. First-party endpoint follows the OpenAI API reference.',
      facts: {
        ...missingOpenAiEndpoint.facts,
        reasoning: false,
        inputModalities: ['text', 'image'],
        vision: true,
        contextWindowTokens: 128_000,
        maxOutputTokens: 16_384,
      },
    },
  },
  'opencode-go': {
    'deepseek-v4-flash': {
      when: 'missing',
      reason:
        'Absent from models.dev. Preserve the wired metadata in main 518c8b21:src/server/ai/pi-provider-catalog.snapshot.json, not a new live-provider admission. Endpoint pinned to the OpenCode Go openai path so a catalog regen that drops the provider-level api field cannot unlist the model (YUK-1658); a live catalog endpoint still wins.',
      facts: {
        baseUrl: 'https://opencode.ai/inference/go/openai/v1',
        reasoning: true,
        reasoningMode: 'effort',
        supportedEfforts: ['low', 'high', 'max'],
        inputModalities: ['text'],
        vision: false,
        contextWindowTokens: 1_000_000,
        maxOutputTokens: 384_000,
      },
    },
    'deepseek-v4-flash-vision-exp': {
      when: 'missing',
      reason:
        'Absent from models.dev. Preserve the wired metadata in main 518c8b21:src/server/ai/pi-provider-catalog.snapshot.json, including image input; not a new live-provider admission. Endpoint pinned to the OpenCode Go openai path so a catalog regen that drops the provider-level api field cannot unlist the model (YUK-1658); a live catalog endpoint still wins.',
      facts: {
        baseUrl: 'https://opencode.ai/inference/go/openai/v1',
        reasoning: true,
        reasoningMode: 'effort',
        supportedEfforts: ['low', 'high', 'max'],
        inputModalities: ['text', 'image'],
        vision: true,
        contextWindowTokens: 1_000_000,
        maxOutputTokens: 384_000,
      },
    },
    'grok-4.6': {
      when: 'missing',
      reason:
        'Absent from models.dev. Sealed evidence covers a single text+reasoning AttributionTask run only (docs/planning/evidence/2026-09-19-pi-adapter-grok-4.6-actual.json, task_run_id toumilrkxa6vfdqxy4a20toy); endpoint, limits, image input and effort tiers are untested by it and carried from main 518c8b21:src/server/ai/pi-provider-catalog.snapshot.json. Endpoint pinned to the OpenCode Go openai path (its listed sibling grok-4.7 serves the same path) so a catalog regen that drops the provider-level api field cannot unlist the model (YUK-1658); a live catalog endpoint still wins.',
      facts: {
        baseUrl: 'https://opencode.ai/inference/go/openai/v1',
        reasoning: true,
        reasoningMode: 'effort',
        supportedEfforts: ['low', 'medium', 'high', 'xhigh'],
        inputModalities: ['text', 'image'],
        vision: true,
        contextWindowTokens: 500_000,
        maxOutputTokens: 500_000,
      },
    },
    'deepseek-v4.1-flash': {
      when: 'missing',
      reason:
        'models.dev has no forcedToolChoice field. YUK-1547 actual HTTP 400 with thinking + named tool_choice, request_id 6fde3ba6-8f64-4c84-8a3d-5a5e211b430a.',
      facts: { forcedToolChoice: false },
    },
  },
  openrouter: {
    'typesafe/jev-1.13': {
      when: 'missing',
      reason:
        'Native typed decisions is absent from the bundled models.dev catalog. YUK-1049 D12 catalog probe and typed wire receipt, 2026-09-24.',
      facts: {
        baseUrl: 'https://openrouter.ai/api/v1',
        toolCalling: false,
        reasoning: false,
        vision: false,
        inputModalities: ['text'],
        structuredOutput: true,
        contextWindowTokens: 32_000,
      },
    },
  },
};

/**
 * Xiaomi Token Plan is absent from models.dev. Its three regional endpoints are
 * the only code-owned model endpoints not listed by the catalog (the catalog
 * also omits the Anthropic/OpenAI first-party roots; those come in through the
 * override facts above). The endpoint host allowlist unions this set with the
 * catalog's; an explicit `XIAOMI_TOKEN_PLAN_BASE_URL` still has to clear it.
 */
const TOKEN_PLAN_REGIONS = ['cn', 'sgp', 'ams'] as const;

type TokenPlanRegion = (typeof TOKEN_PLAN_REGIONS)[number];

function isTokenPlanRegion(value: string): value is TokenPlanRegion {
  return (TOKEN_PLAN_REGIONS as readonly string[]).includes(value);
}

function tokenPlanEndpointFor(region: TokenPlanRegion): string {
  return `https://token-plan-${region}.xiaomimimo.com/v1`;
}

function endpointKeysOf(urls: readonly string[]): ReadonlySet<string> {
  return new Set(urls.map(endpointKeyOf).filter((key): key is string => key !== undefined));
}

/** Endpoint keys (host[:port]) of the Token Plan regional endpoints. */
export const TOKEN_PLAN_ENDPOINT_KEYS: ReadonlySet<string> = endpointKeysOf(
  TOKEN_PLAN_REGIONS.map(tokenPlanEndpointFor),
);

/**
 * Endpoint keys the code-owned override facts declare for one provider. The
 * bundled catalog snapshot omits the anthropic/openai first-party roots, so a
 * provider's endpoint set is the union of its bucket and these (YUK-1654).
 */
export function builtinEndpointKeysFor(provider: string): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const override of Object.values(overrides[provider as Provider] ?? {})) {
    if (!override.facts.baseUrl) continue;
    const key = endpointKeyOf(override.facts.baseUrl);
    if (key !== undefined) keys.add(key);
  }
  return keys;
}

/**
 * DashScope (Aliyun Model Studio) embedding lane endpoints: code-owned
 * first-party model endpoints the bundled catalog snapshot omits (the runtime
 * catalog lists the compatible-mode endpoints under its alibaba buckets). The
 * embedding credential never travels to another host.
 */
export const DASHSCOPE_EMBEDDING_ENDPOINT_KEYS: ReadonlySet<string> = endpointKeysOf([
  'https://dashscope.aliyuncs.com/compatible-mode/v1',
  'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
]);

export const BUILTIN_MODEL_ENDPOINT_HOSTS: ReadonlySet<string> = (() => {
  const keys = new Set<string>();
  const add = (value: string | undefined) => {
    if (!value) return;
    try {
      const url = new URL(value);
      // Keep the port when the declared endpoint names one (YUK-1654).
      if (url.protocol === 'https:' && !url.username && !url.password) {
        const key = endpointKeyOf(value);
        if (key !== undefined) keys.add(key);
      }
    } catch {
      // A malformed declared endpoint is rejected at resolution, not here.
    }
  };
  for (const models of Object.values(overrides)) {
    for (const override of Object.values(models ?? {})) add(override.facts.baseUrl);
  }
  for (const key of TOKEN_PLAN_ENDPOINT_KEYS) keys.add(key);
  for (const key of DASHSCOPE_EMBEDDING_ENDPOINT_KEYS) keys.add(key);
  return keys;
})();

/** Token Plan is absent from models.dev; never borrow the pay-as-you-go endpoint. */
export function tokenPlanEndpointOverride(env: Record<string, string | undefined>): string {
  const explicit = env.XIAOMI_TOKEN_PLAN_BASE_URL?.trim();
  const region = env.XIAOMI_TOKEN_PLAN_REGION?.trim() || 'cn';
  let endpoint: string;
  if (explicit) {
    endpoint = explicit;
  } else if (isTokenPlanRegion(region)) {
    endpoint = tokenPlanEndpointFor(region);
  } else {
    throw new Error('XIAOMI_TOKEN_PLAN_REGION must be cn, sgp, or ams');
  }
  const url = new URL(endpoint);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.hostname === 'api.xiaomimimo.com'
  ) {
    throw new Error(
      'XIAOMI_TOKEN_PLAN_BASE_URL must be an HTTPS Token Plan endpoint without credentials',
    );
  }
  // YUK-1654 — the Token Plan key is bound to Token Plan regional endpoints:
  // no other host (and no other port) receives it, catalog-listed or not.
  const key = endpointKeyOf(endpoint);
  if (key === undefined || !TOKEN_PLAN_ENDPOINT_KEYS.has(key)) {
    throw new Error(
      'XIAOMI_TOKEN_PLAN_BASE_URL must be a Token Plan regional endpoint (token-plan-cn/sgp/ams.xiaomimimo.com)',
    );
  }
  return endpoint.replace(/\/+$/, '');
}

export function modelCatalogOverride(
  provider: Provider,
  model: string,
  env: Record<string, string | undefined>,
): CatalogOverride | undefined {
  if (provider === 'xiaomi-token-plan' && Object.hasOwn(protocols.xiaomi, model)) {
    return {
      when: 'missing',
      reason:
        "models.dev has no Token Plan provider. Xiaomi model facts are shared, but endpoint/auth are separate (YUK-1402); only mimo-v2.6-pro has this lane's tool-loop receipts.",
      facts: {
        baseUrl: tokenPlanEndpointOverride(env),
        ...(model === 'mimo-v2.6-pro' ? { toolCalling: true } : {}),
      },
    };
  }
  return overrides[provider]?.[model];
}
