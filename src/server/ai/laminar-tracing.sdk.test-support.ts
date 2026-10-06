import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import tls from 'node:tls';
import type { AssistantMessage, Model } from '@earendil-works/pi-ai';

// Run in a fresh process and synthetic cwd, with no inherited credentials or SDK state.
let networkAttempts = 0;
const denyNetwork = () => {
  networkAttempts++;
  throw new Error('offline SDK regression forbids network');
};
globalThis.fetch = denyNetwork;
net.Socket.prototype.connect = denyNetwork;
http.request = denyNetwork;
http.get = denyNetwork;
https.request = denyNetwork;
https.get = denyNetwork;
http2.connect = denyNetwork;
tls.connect = denyNetwork;
syncBuiltinESMExports();

const scenario = process.argv[2];
const dotenvMetadata = '{"private_context":{"text":"PRIVATE_CONTEXT_SENTINEL"}}';
const dotenvSettings = {
  LMNR_DEBUG: 'true',
  LMNR_TRACE_METADATA: dotenvMetadata,
  LMNR_SPAN_CONTEXT: JSON.stringify({
    traceId: '11111111-1111-4111-8111-111111111111',
    spanId: '22222222-2222-4222-8222-222222222222',
    metadata: { private_context: 'PRIVATE_CONTEXT_SENTINEL' },
  }),
};
const setting = Object.entries(dotenvSettings).find(([key]) => key === scenario);
assert.ok(
  setting || scenario === 'baseline' || scenario === 'no-key' || scenario === 'usage-accounting',
);
for (const key of Object.keys(dotenvSettings)) assert.equal(process.env[key], undefined);
assert.equal(process.env.LMNR_PROJECT_API_KEY, undefined);
writeFileSync(
  '.env.production',
  setting
    ? `${setting[0]}=${setting[1]}\n`
    : scenario === 'no-key'
      ? `LMNR_TRACE_METADATA=${dotenvMetadata}\nLMNR_PROJECT_API_KEY=synthetic-dotenv-key\n`
      : 'LMNR_LOG_LEVEL=error\n',
);
const tracing = await import('./laminar-tracing');
const exported: {
  name: string;
  id: string;
  trace: string;
  parent?: string;
  attributes: { [key: string]: unknown };
  events: unknown[];
}[] = [];
let initializeCalls = 0;
let loadCalls = 0;
let sdk: typeof import('@lmnr-ai/lmnr') | undefined;
const loadSdk = async () => {
  loadCalls++;
  sdk = await import('@lmnr-ai/lmnr');
  if (setting) assert.equal(process.env[setting[0]], setting[1]);
  else assert.equal(process.env.LMNR_LOG_LEVEL, 'error');
  assert.equal(sdk.Laminar.initialized(), false);
  assert.equal(existsSync('.lmnr'), false);
  const initialize = sdk.Laminar.initialize.bind(sdk.Laminar);
  const { LaminarSpanProcessor } = sdk;
  sdk.Laminar.initialize = (options) => {
    initializeCalls++;
    initialize({
      ...options,
      spanProcessor: new LaminarSpanProcessor({
        disableBatch: true,
        exporter: {
          export(spans, callback) {
            for (const span of spans)
              exported.push({
                name: span.name,
                id: span.spanContext().spanId,
                trace: span.spanContext().traceId,
                parent: span.parentSpanContext?.spanId,
                attributes: { ...span.attributes },
                events: [...span.events],
              });
            callback({ code: 0 });
          },
          shutdown: async () => {},
          forceFlush: async () => {},
        },
      }),
    });
  };
  return sdk;
};

try {
  const options = {
    projectApiKey: scenario === 'no-key' ? undefined : 'synthetic-offline-key',
    loadSdk,
  };
  await Promise.all([
    tracing.initializeLaminarTracing(options),
    tracing.initializeLaminarTracing(options),
  ]);
  const result = { text: 'PRIVATE_OUTPUT_SENTINEL' };
  if (scenario === 'usage-accounting') {
    const { createAssistantMessageEventStream, normalizeContext } = await import(
      '@earendil-works/pi-ai'
    );
    const { piTraceUsage, piTraceUsageCases, traceField } = await import(
      './laminar-tracing.test-support'
    );
    const { withPiUsageEvidence } = await import('./pi-usage-evidence');
    const model: Model<'openai-completions'> = {
      id: 'mimo-v2.6-pro',
      name: 'Offline captured usage',
      provider: 'opencode-go',
      api: 'openai-completions',
      reasoning: false,
      baseUrl: 'https://offline.invalid',
      input: ['text'],
      contextWindow: 10000,
      maxTokens: 100,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    for (const fixture of piTraceUsageCases) {
      const start = exported.length;
      await tracing.traceOperation('task.run', {}, () =>
        tracing.traceOperation(
          'task.attempt',
          {
            additive_usage: false,
            includes_child_usage: true,
            usage_observed: fixture.observed,
            cost_basis: fixture.observed ? 'estimated' : 'unknown',
            aggregate_input_tokens: fixture.totalInput,
            aggregate_output_tokens: fixture.observed ? fixture.output : undefined,
            aggregate_cost_usd: fixture.observed ? fixture.totalCost : undefined,
          },
          async () => {
            const stream = createAssistantMessageEventStream();
            const traced = await tracing.tracePiStream(
              (m, c, o) =>
                withPiUsageEvidence(
                  async (_m, _c, options) => {
                    if (fixture.observed)
                      await options?.onProviderStreamEvent?.(
                        {
                          usage: {
                            prompt_tokens: fixture.totalInput,
                            completion_tokens: fixture.output,
                          },
                        },
                        model,
                      );
                    return stream;
                  },
                  m,
                  c,
                  o,
                ),
              model,
              normalizeContext({
                messages: [{ role: 'user', content: 'PRIVATE_HISTORY_SENTINEL', timestamp: 1 }],
              }),
            );
            const message: AssistantMessage = {
              role: 'assistant',
              api: model.api,
              provider: model.provider,
              model: model.id,
              timestamp: 1,
              content: [
                { type: 'text', text: 'PRIVATE_OUTPUT_SENTINEL' },
                { type: 'thinking', thinking: 'RAW_COT_SENTINEL' },
              ],
              stopReason: 'stop',
              usage: piTraceUsage(fixture),
            };
            stream.push({ type: 'done', reason: 'stop', message });
            assert.equal(await traced.result(), message);
          },
        ),
      );
      const spans = exported.slice(start);
      assert.equal(spans.length, 3);
      const named = Object.fromEntries(spans.map((span) => [span.name, span]));
      const leaf = named['llm.call'];
      const parent = named['task.attempt'];
      assert.equal(leaf.parent, parent.id);
      assert.equal(parent.parent, named['task.run'].id);
      assert.equal(new Set(spans.map((span) => span.trace)).size, 1);
      for (const [key, expected] of [
        ['gen_ai.usage.input_tokens', fixture.totalInput],
        ['gen_ai.usage.output_tokens', fixture.observed ? fixture.output : undefined],
        ['llm.usage.total_tokens', fixture.observed ? fixture.totalTokens : undefined],
        ['gen_ai.usage.cache_read_input_tokens', fixture.observed ? fixture.cacheRead : undefined],
        [
          'gen_ai.usage.cache_creation_input_tokens',
          fixture.observed ? fixture.cacheWrite : undefined,
        ],
        ['gen_ai.usage.cost', fixture.observed ? fixture.totalCost : undefined],
        [traceField('usage_observed'), fixture.observed],
        [traceField('cost_basis'), fixture.observed ? 'estimated' : 'unknown'],
        [traceField('additive_usage'), true],
      ] satisfies [string, string | number | boolean | undefined][]) {
        assert.equal(leaf.attributes[key], expected, `${fixture.name}: ${key}`);
      }
      assert.equal(parent.attributes[traceField('aggregate_input_tokens')], fixture.totalInput);
      assert.equal(
        parent.attributes[traceField('aggregate_cost_usd')],
        fixture.observed ? fixture.totalCost : undefined,
      );
      assert.equal(parent.attributes[traceField('additive_usage')], false);
      assert.equal(
        Object.keys(parent.attributes).some(
          (key) => key.startsWith('gen_ai.usage.') || key === 'llm.usage.total_tokens',
        ),
        false,
      );
    }
  } else if (scenario === 'baseline') {
    const { createAssistantMessageEventStream, normalizeContext } = await import(
      '@earendil-works/pi-ai'
    );
    const model: Model<'openai-completions'> = {
      id: 'offline-model',
      name: 'Offline',
      provider: 'offline',
      api: 'openai-completions',
      reasoning: false,
      baseUrl: 'https://offline.invalid',
      input: ['text'],
      contextWindow: 10000,
      maxTokens: 100,
      cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
    };
    const message: AssistantMessage = {
      role: 'assistant',
      api: model.api,
      provider: model.provider,
      model: model.id,
      timestamp: 1,
      content: [
        { type: 'text', text: 'PRIVATE_OUTPUT_SENTINEL' },
        { type: 'thinking', thinking: 'RAW_COT_SENTINEL' },
      ],
      usage: {
        input: 12,
        output: 3,
        totalTokens: 15,
        cacheRead: 0,
        cacheWrite: 0,
        cost: { input: 0.12, output: 0.03, cacheRead: 0, cacheWrite: 0, total: 0.15 },
      },
      stopReason: 'stop',
    };
    const executions = { task: 0, tool: 0, child: 0, provider: 0 };
    assert.equal(
      await tracing.traceOperation('task.run', { task_run_id: 'synthetic-run' }, async () => {
        executions.task++;
        return tracing.traceOperation('tool.execute', { tool_name: 'Task' }, async () => {
          executions.tool++;
          return tracing.traceOperation('agent.child', {}, async () => {
            executions.child++;
            const stream = createAssistantMessageEventStream();
            let resultReads = 0;
            const originalResult = stream.result.bind(stream);
            stream.result = () => {
              resultReads++;
              return originalResult();
            };
            const traced = await tracing.tracePiStream(
              () => {
                executions.provider++;
                return stream;
              },
              model,
              normalizeContext({
                messages: [{ role: 'user', content: 'PRIVATE_HISTORY_SENTINEL', timestamp: 1 }],
              }),
              { apiKey: 'PRIVATE_KEY_SENTINEL' },
            );
            stream.push({ type: 'done', reason: 'stop', message });
            const events: string[] = [];
            for await (const event of traced) events.push(event.type);
            assert.deepEqual(events, ['done']);
            assert.equal(await traced.result(), message);
            assert.equal(await traced.result(), message);
            assert.equal(resultReads, 1);
            return result;
          });
        });
      }),
      result,
    );
    assert.deepEqual(executions, { task: 1, tool: 1, child: 1, provider: 1 });
  } else {
    let executions = 0;
    assert.equal(
      await tracing.traceOperation('task.run', { task_kind: 'AttributionTask' }, async () => {
        executions++;
        return result;
      }),
      result,
    );
    assert.equal(executions, 1);
    const error = new Error('PRIVATE_BUSINESS_ERROR_SENTINEL');
    await assert.rejects(
      tracing.traceOperation('tool.execute', {}, async () => {
        executions++;
        throw error;
      }),
      (caught: unknown) => caught === error,
    );
    assert.equal(executions, 2);
  }
  await tracing.flushLaminarTracing();
  const report = {
    scenario,
    enabled: tracing.isLaminarTracingEnabled(),
    initializeCalls,
    loadCalls,
    exported,
    networkAttempts,
  };
  console.log(JSON.stringify(report));
  assert.equal(networkAttempts, 0);
  assert.equal(JSON.stringify(exported).includes('SENTINEL'), false);
  if (scenario === 'usage-accounting') {
    assert.equal(tracing.isLaminarTracingEnabled(), true);
    assert.equal(initializeCalls, 1);
    assert.equal(loadCalls, 1);
    assert.equal(exported.length, 18);
  } else if (scenario === 'baseline') {
    assert.equal(tracing.isLaminarTracingEnabled(), true);
    assert.equal(initializeCalls, 1);
    assert.equal(loadCalls, 1);
    assert.equal(sdk?.Laminar.initialized(), true);
    assert.equal(exported.length, 4);
    const named = Object.fromEntries(exported.map((span) => [span.name, span]));
    assert.equal(named['tool.execute'].parent, named['task.run'].id);
    assert.equal(named['agent.child'].parent, named['tool.execute'].id);
    assert.equal(named['llm.call'].parent, named['agent.child'].id);
    assert.equal(new Set(exported.map((span) => span.trace)).size, 1);
    assert.ok(sdk);
    assert.equal(named['llm.call'].attributes[sdk.LaminarAttributes.INPUT_TOKEN_COUNT], 12);
    assert.equal(named['llm.call'].attributes[sdk.LaminarAttributes.OUTPUT_TOKEN_COUNT], 3);
    assert.equal(named['llm.call'].attributes[sdk.LaminarAttributes.TOTAL_COST], 0.15);
    assert.equal(
      named['llm.call'].attributes['lmnr.association.properties.metadata.cost_basis'],
      'estimated',
    );
  } else {
    assert.equal(tracing.isLaminarTracingEnabled(), false);
    assert.equal(initializeCalls, 0);
    assert.equal(loadCalls, scenario === 'no-key' ? 0 : 1);
    assert.deepEqual(exported, []);
    assert.equal(sdk?.Laminar.initialized() ?? false, false);
    if (setting) {
      assert.ok(sdk);
      assert.equal(process.env[setting[0]], setting[1]);
    }
    if (scenario === 'no-key')
      for (const key of [...Object.keys(dotenvSettings), 'LMNR_PROJECT_API_KEY'])
        assert.equal(process.env[key], undefined);
  }
  assert.equal(existsSync('.lmnr'), false);
} finally {
  await sdk?.Laminar.shutdown();
  assert.equal(networkAttempts, 0);
}
