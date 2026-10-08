import { agentLoop } from '@earendil-works/pi-agent-core';
import type { Model } from '@earendil-works/pi-ai';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { afterEach, expect, it, vi } from 'vitest';
import * as config from '@/core/config/store';
import type { ExecutionAdapterStartupArgs } from '@/server/ai/execution-adapter';
import { PiAgentAdapter } from '@/server/ai/pi-agent-adapter';

const model: Model<'openai-completions'> = {
  id: 'controlled-judge',
  name: 'Controlled',
  provider: 'openai',
  api: 'openai-completions',
  baseUrl: 'https://offline.invalid',
  reasoning: false,
  input: ['text'],
  contextWindow: 10000,
  maxTokens: 100,
  cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
};
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it.each([
  { policy: 'none' as const, requests: 1 },
  { policy: undefined, requests: 3 },
])(
  'uses installed Pi lower transport for per-call policy $policy',
  async ({ policy, requests }) => {
    const original = config.getConfig;
    vi.spyOn(config, 'getConfig').mockImplementation((...args) =>
      args[0] === 'CLAUDE_CODE_MAX_RETRIES' ? 2 : original(...args),
    );
    const wire = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: 'controlled transient failure' } }), {
          status: 503,
          headers: { 'content-type': 'application/json', 'retry-after-ms': '0' },
        }),
    );
    vi.stubGlobal('fetch', wire);
    const models = builtinModels();
    vi.spyOn(models, 'getModel').mockReturnValue(model);
    // Real streamSimple, agentLoop, provider retry helper and installed OpenAI SDK. No network socket is opened.
    const adapter = new PiAgentAdapter({ models, agentLoop });
    const args: ExecutionAdapterStartupArgs = {
      kind: 'AssessmentRuleJudgeTask',
      runId: 'controlled-multiunit-claim',
      initializeTimeoutMs: 1000,
      resolved: {
        provider: 'opencode-go',
        model: model.id,
        apiKey: 'fixture-key',
        authMode: 'key',
      },
      options: {
        abortController: new AbortController(),
        systemPrompt: '判定三个评分单元，保留单位与原始方程。',
        ...(policy ? { judgeRetryPolicy: policy } : {}),
      },
    };
    const prepared = await adapter.startup(args);
    const frames = [];
    try {
      for await (const frame of prepared.query('v+c=18; v-c=12; 2v=30. '.repeat(120)))
        frames.push(frame);
    } finally {
      await prepared.close();
    }
    expect(frames.at(-1)).toMatchObject({ type: 'result', is_error: true });
    expect(wire).toHaveBeenCalledTimes(requests);
  },
);
