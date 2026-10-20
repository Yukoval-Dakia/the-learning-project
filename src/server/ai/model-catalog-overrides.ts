import type { Provider } from '@/ai/task-spec';
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
        'Absent from models.dev. Preserve the wired metadata in main 518c8b21:src/server/ai/pi-provider-catalog.snapshot.json, not a new live-provider admission. Endpoint still comes from the current provider catalog.',
      facts: {
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
        'Absent from models.dev. Preserve the wired metadata in main 518c8b21:src/server/ai/pi-provider-catalog.snapshot.json, including image input; not a new live-provider admission. Endpoint still comes from the current provider catalog.',
      facts: {
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
        'Absent from models.dev. Text/reasoning run: docs/planning/evidence/2026-09-19-pi-adapter-grok-4.6-actual.json (task_run_id toumilrkxa6vfdqxy4a20toy). Limits, image input and effort tiers: main 518c8b21:src/server/ai/pi-provider-catalog.snapshot.json, not measured by that run. Endpoint still comes from the current provider catalog.',
      facts: {
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

/** Token Plan is absent from models.dev; never borrow the pay-as-you-go endpoint. */
export function tokenPlanEndpointOverride(env: Record<string, string | undefined>): string {
  const explicit = env.XIAOMI_TOKEN_PLAN_BASE_URL?.trim();
  const region = env.XIAOMI_TOKEN_PLAN_REGION?.trim() || 'cn';
  if (!explicit && region !== 'cn' && region !== 'sgp' && region !== 'ams') {
    throw new Error('XIAOMI_TOKEN_PLAN_REGION must be cn, sgp, or ams');
  }
  const endpoint = explicit || `https://token-plan-${region}.xiaomimimo.com/v1`;
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
