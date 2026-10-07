import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isAiTaskKind, tasks } from '@/capabilities/task-registry';
import { resetTestConfig, setTestConfig } from '@/core/config/store';
import type { DirectProviderOperationContext } from '@/server/ai/direct-provider-attempt';
import { explicitProviderRouting } from '@/server/ai/execution-adapter';
import { resolveModelProfile } from '@/server/ai/model-profiles';
import { resolveTaskProvider } from '@/server/ai/providers';
import { createMem0Config } from './client';
import { resolveMemoryLlmConfig } from './llm-config';
import { judgeReconciliation } from './reconcile-llm';

const env = {
  DATABASE_URL: 'postgres://test:test@127.0.0.1:5432/test',
  AI_PROVIDER_OVERRIDE: 'opencode-go',
  AI_PROVIDER_MODEL: 'mimo-v2.6-pro',
  OPENCODE_API_KEY: 'dummy-go-key',
  DASHSCOPE_API_KEY: 'dummy-embedding-key',
  MEM0_LLM_MODEL: 'obsolete-glm',
  MEM0_LLM_BASE_URL: 'https://obsolete.invalid',
};

beforeEach(() => {
  resetTestConfig();
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
});
afterEach(() => {
  resetTestConfig();
  vi.unstubAllEnvs();
});

describe('product-wide Go MiMo pin', () => {
  it('covers every chat task, including explicit, per-task and persisted model bindings', () => {
    for (const kind of Object.keys(tasks)) {
      if (!isAiTaskKind(kind)) throw new Error(`Unknown task ${kind}`);
      const task = tasks[kind];
      if ('execution' in task && task.execution === 'typed') continue;
      setTestConfig({ [`task.${kind}.provider`]: 'xiaomi', [`task.${kind}.model`]: 'mimo-v2.5' });
      const routing = explicitProviderRouting({
        override: { provider: 'anthropic-sub' },
        modelBinding: { provider: 'xiaomi', model: 'mimo-v2.5-pro' },
      });
      const binding = resolveTaskProvider(kind, routing);
      expect(binding, task.kind).toMatchObject({
        provider: 'opencode-go',
        model: 'mimo-v2.6-pro',
        apiKey: 'dummy-go-key',
      });
      const profile = resolveModelProfile(binding.provider, binding.model);
      if (task.needsToolCall) expect(profile.capabilities.toolCalling, task.kind).toBe(true);
      if (task.isMultimodal) expect(profile.capabilities.vision, task.kind).toBe(true);
    }
  });

  it('keeps the dedicated typed protocol pin and never sends its body to a chat endpoint', () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'dummy-typed-key');
    expect(
      resolveTaskProvider('JevScoringDecisionTask', {
        provider: 'openrouter',
        model: 'typesafe/jev-1.13',
      }),
    ).toMatchObject({ provider: 'openrouter', model: 'typesafe/jev-1.13' });
  });

  it('routes Mem0 LLM to the product pin while retaining existing vector model and dimensions', () => {
    const config = createMem0Config(env);
    expect(config.llm.config).toMatchObject({
      apiKey: 'dummy-go-key',
      model: 'mimo-v2.6-pro',
      baseURL: 'https://opencode.ai/zen/go/v1',
      defaultHeaders: { 'x-opencode-session': expect.any(String) },
      maxRetries: 0,
      timeout: 60_000,
    });
    expect(config.embedder.config).toMatchObject({
      model: 'text-embedding-v4',
      embeddingDims: 1024,
      apiKey: 'dummy-embedding-key',
    });
    expect(config.vectorStore.config.embeddingModelDims).toBe(1024);
  });

  it('fails before any provider request on a missing Go key or unsupported memory protocol', () => {
    expect(() => resolveMemoryLlmConfig({ ...env, OPENCODE_API_KEY: '' })).toThrow(
      'requires OPENCODE_API_KEY',
    );
    expect(() => resolveMemoryLlmConfig({ ...env, AI_PROVIDER_MODEL: '' })).toThrow(
      'no legacy LLM fallback',
    );
    expect(() => resolveMemoryLlmConfig({ ...env, AI_PROVIDER_OVERRIDE: 'anthropic-sub' })).toThrow(
      'no legacy LLM fallback',
    );
  });

  it('uses the Go attempt session for reconciliation and leaves its unpriced cost unknown', async () => {
    const records: unknown[] = [];
    const context: DirectProviderOperationContext = {
      caller: 'worker',
      deadlineAt: new Date('2030-01-01'),
      mode: 'observe',
      operationId: '00000000-0000-4000-8000-000000000134',
      createLifecycle: ({ identity }) => ({
        identity,
        acquire: async () => ({
          admission: 'acquired',
          reserveProviderStart: async () => {},
          recordExternalRequestId: async () => {},
          finish: async (evidence) => {
            records.push({ identity, evidence });
            return 'settled';
          },
        }),
      }),
    };
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      expect(url).toBe('https://opencode.ai/zen/go/v1/chat/completions');
      expect(new Headers(init?.headers).get('x-opencode-session')).toMatch(/^[a-f0-9-]{36}$/);
      expect(JSON.parse(String(init?.body))).toMatchObject({
        model: 'mimo-v2.6-pro',
        response_format: { type: 'json_object' },
      });
      return Response.json({
        id: 'synthetic-response',
        usage: { prompt_tokens: 900, completion_tokens: 90, total_tokens: 990 },
        choices: [
          {
            message: {
              content: JSON.stringify({
                decisions: [
                  {
                    new_index: 0,
                    action: 'KEEP_BOTH',
                    old_index: null,
                    confidence: 0.9,
                    reason: 'Keep distinct learning evidence.',
                  },
                ],
              }),
            },
          },
        ],
      });
    });
    expect(
      await judgeReconciliation(
        [
          {
            index: 0,
            memory_id: 'synthetic',
            kind: 'weakness',
            text: '有条件概率方向错误，不能猜测掌握。',
            created_ms: 1000,
          },
        ],
        new Map(),
        { env, fetchImpl, providerAttempt: context },
      ),
    ).toMatchObject([{ action: 'KEEP_BOTH' }]);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(records).toMatchObject([
      {
        identity: { provider: 'opencode-go', model: 'mimo-v2.6-pro' },
        evidence: {
          cost: { basis: 'unknown' },
          usage: { basis: 'reported', input: 900, output: 90 },
        },
      },
    ]);
  });
});
