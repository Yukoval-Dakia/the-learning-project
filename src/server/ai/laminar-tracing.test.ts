import { type AssistantMessage, type Model, Type, normalizeContext } from '@earendil-works/pi-ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __setTraceExporterForTests, traceOperation } from './laminar-tracing';
import { memoryTraceExporter } from './laminar-tracing.test-support';

const sdk = vi.hoisted(() => ({ initialize: vi.fn(), flush: vi.fn(async () => {}) }));
vi.mock('@lmnr-ai/lmnr', () => ({ Laminar: sdk }));

const model: Model<'openai-completions'> = {
  id: 'offline-model',
  name: 'Offline',
  provider: 'xiaomi',
  api: 'openai-completions',
  reasoning: false,
  baseUrl: 'https://offline.invalid',
  input: ['text'],
  contextWindow: 10000,
  maxTokens: 100,
  cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
};
const context = normalizeContext({
  messages: [{ role: 'user', content: 'PRIVATE_HISTORY_SENTINEL', timestamp: 1 }],
  tools: [
    {
      name: 'fixture',
      description: 'private schema description',
      parameters: Type.Object({ query: Type.String() }),
    },
  ],
});
function assistant(tokens = 0): AssistantMessage {
  return {
    role: 'assistant',
    api: model.api,
    provider: model.provider,
    model: model.id,
    timestamp: 2,
    content: [
      { type: 'thinking', thinking: 'RAW_COT_SENTINEL' },
      { type: 'text', text: 'PRIVATE_OUTPUT_SENTINEL' },
    ],
    usage: {
      input: tokens,
      output: tokens,
      totalTokens: tokens * 2,
      cacheRead: 0,
      cacheWrite: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
  };
}
beforeEach(() => {
  __setTraceExporterForTests();
  for (const key of [
    'LMNR_PROJECT_API_KEY',
    'LMNR_DEBUG',
    'LMNR_TRACE_METADATA',
    'LMNR_SPAN_CONTEXT',
  ])
    vi.stubEnv(key, '');
});
afterEach(() => {
  __setTraceExporterForTests();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('optional telemetry isolation', () => {
  it('exports only allowlisted metadata and explicit bounded business text', async () => {
    const { records, exporter } = memoryTraceExporter();
    __setTraceExporterForTests(exporter);
    const unsafe = {
      task_kind: 'AttributionTask',
      bindings: 'BINDING_SENTINEL',
      headers: 'HEADER_SENTINEL',
      apiKey: 'KEY_SENTINEL',
      history: context,
    };
    await traceOperation('task.run', unsafe, async () => assistant());
    const error = new Error('EXCEPTION_SENTINEL');
    await expect(
      traceOperation('tool.execute', {}, async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    for (const secret of [
      'BINDING_SENTINEL',
      'HEADER_SENTINEL',
      'KEY_SENTINEL',
      'RAW_COT_SENTINEL',
      'PRIVATE_HISTORY_SENTINEL',
      'PRIVATE_OUTPUT_SENTINEL',
      'EXCEPTION_SENTINEL',
    ])
      expect(JSON.stringify(records)).not.toContain(secret);
    await traceOperation('task.run', {}, async () => 'safe final', {
      content: { input: { summary: 'synthetic input' }, output: (result) => ({ summary: result }) },
    });
    expect(records.at(-1)?.attributes['lmnr.span.output']).toBe('{"summary":"safe final"}');
    await traceOperation('task.run', {}, async () => 'result', {
      content: {
        input: { summary: 'x'.repeat(5000) },
        output: () => {
          throw new Error('private projector failure');
        },
      },
    });
    expect(String(records.at(-1)?.attributes['lmnr.span.input']).length).toBeLessThan(4050);
    expect(records.at(-1)?.ends).toBe(1);
  });
});
