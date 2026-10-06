import {
  type AssistantMessage,
  type Model,
  Type,
  createAssistantMessageEventStream,
  normalizeContext,
} from '@earendil-works/pi-ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __setTraceExporterForTests,
  flushLaminarTracing,
  initializeLaminarTracing,
  startTraceSpan,
  traceOperation,
  tracePiStream,
  withTraceContext,
} from './laminar-tracing';
import { memoryTraceExporter, traceField } from './laminar-tracing.test-support';
import { withPiUsageEvidence } from './pi-usage-evidence';

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
  it('does not load the SDK without a key and leaves callbacks untouched', async () => {
    const loadSdk = vi.fn(async () => {
      throw new Error('must not load');
    });
    await initializeLaminarTracing({ loadSdk });
    const callback = vi.fn(async () => ({ value: 42 }));
    const result = await traceOperation('task.run', {}, callback);
    expect(loadSdk).not.toHaveBeenCalled();
    expect(callback).toHaveBeenCalledOnce();
    expect(result).toEqual({ value: 42 });
    const stream = createAssistantMessageEventStream();
    const resultObserver = vi.spyOn(stream, 'result');
    expect(await tracePiStream(async () => stream, model, context)).toBe(stream);
    expect(resultObserver).not.toHaveBeenCalled();
  });
  it('initializes once across concurrent boot callers with broad capture disabled', async () => {
    await Promise.all([
      initializeLaminarTracing({ projectApiKey: 'synthetic-key' }),
      initializeLaminarTracing({ projectApiKey: 'synthetic-key' }),
    ]);
    expect(sdk.initialize).toHaveBeenCalledOnce();
    expect(sdk.initialize).toHaveBeenCalledWith({
      projectApiKey: 'synthetic-key',
      instrumentModules: {},
      inheritGlobalContext: false,
      traceExportTimeoutMillis: 500,
      logLevel: 'error',
    });
  });
  it.each(['LMNR_DEBUG', 'LMNR_TRACE_METADATA', 'LMNR_SPAN_CONTEXT'])(
    'refuses unsafe SDK global setting %s before import',
    async (key) => {
      vi.stubEnv(key, 'PRIVATE_GLOBAL_SENTINEL');
      const loadSdk = vi.fn(async () => {
        throw new Error('must not load');
      });
      await initializeLaminarTracing({ projectApiKey: 'synthetic-key', loadSdk });
      expect(loadSdk).not.toHaveBeenCalled();
    },
  );
  it('fails open on initialization and exporter failures without retrying business work', async () => {
    await initializeLaminarTracing({
      projectApiKey: 'synthetic-key',
      loadSdk: async () => {
        throw new Error('SECRET_INIT_ERROR');
      },
    });
    for (const failure of ['start', 'attribute', 'status', 'end']) {
      __setTraceExporterForTests({
        start: () => {
          if (failure === 'start') throw new Error('SECRET_EXPORT_ERROR');
          return {
            setAttribute: () => {
              if (failure === 'attribute') throw new Error('secret');
            },
            setStatus: () => {
              if (failure === 'status') throw new Error('secret');
            },
            end: () => {
              if (failure === 'end') throw new Error('secret');
            },
          };
        },
        flush: async () => {
          throw new Error('secret');
        },
      });
      const value = { unchanged: true };
      const callback = vi.fn(async () => value);
      expect(await traceOperation('task.run', { task_kind: 'AttributionTask' }, callback)).toBe(
        value,
      );
      expect(callback).toHaveBeenCalledOnce();
      const error = new Error('PRIVATE_BUSINESS_ERROR_SENTINEL');
      const rejected = vi.fn(async () => {
        throw error;
      });
      await expect(traceOperation('task.run', {}, rejected)).rejects.toBe(error);
      expect(rejected).toHaveBeenCalledOnce();
      await flushLaminarTracing();
    }
  });
  it('keeps concurrent roots and asynchronous children isolated', async () => {
    const { records, exporter } = memoryTraceExporter();
    __setTraceExporterForTests(exporter);
    let release: () => void = () => {};
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = traceOperation('task.run', { task_run_id: 'run-a' }, async () => {
      await barrier;
      return traceOperation('tool.execute', { tool_call_id: 'a' }, async () => 'a');
    });
    const second = traceOperation('task.run', { task_run_id: 'run-b' }, async () => {
      const result = await traceOperation('tool.execute', { tool_call_id: 'b' }, async () => 'b');
      release();
      return result;
    });
    expect(await Promise.all([first, second])).toEqual(['a', 'b']);
    for (const id of ['a', 'b']) {
      const root = records.find((r) => r.attributes[traceField('task_run_id')] === `run-${id}`);
      const child = records.find((r) => r.attributes[traceField('tool_call_id')] === id);
      expect(child?.parent).toBe(root?.context);
      expect(root?.parent).toBeUndefined();
    }
    expect(records.every((r) => r.ends === 1)).toBe(true);
  });
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
  it('bounds flushing and handles a late exporter rejection', async () => {
    vi.useFakeTimers();
    let rejectFlush: (error: Error) => void = () => {};
    const flush = vi.fn(
      () =>
        new Promise<void>((_, reject) => {
          rejectFlush = reject;
        }),
    );
    const { exporter } = memoryTraceExporter();
    __setTraceExporterForTests({ ...exporter, flush });
    const pending = flushLaminarTracing(30000);
    await vi.advanceTimersByTimeAsync(500);
    await pending;
    expect(flush).toHaveBeenCalledOnce();
    rejectFlush(new Error('late private exporter failure'));
    await Promise.resolve();
  });
});

describe('model stream lifetime and usage', () => {
  it.each([undefined, 0, 12])('retains explicit-zero versus unknown usage: %s', async (tokens) => {
    const { records, exporter } = memoryTraceExporter();
    __setTraceExporterForTests(exporter);
    const stream = createAssistantMessageEventStream();
    const originalResult = vi.spyOn(stream, 'result');
    const root = startTraceSpan('task.run');
    const traced = await withTraceContext(root, () =>
      tracePiStream(
        (m, c, o) =>
          withPiUsageEvidence(
            async (_m, _c, options) => {
              if (tokens !== undefined)
                await options?.onProviderStreamEvent?.(
                  { usage: { prompt_tokens: tokens, completion_tokens: tokens } },
                  model,
                );
              return stream;
            },
            m,
            c,
            o,
          ),
        model,
        context,
        { apiKey: 'PRIVATE_KEY_SENTINEL' },
      ),
    );
    expect(records[1].ends).toBe(0);
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
    const message = assistant(tokens ?? 0);
    stream.push({ type: 'done', reason: 'stop', message });
    const events: string[] = [];
    for await (const event of traced) events.push(event.type);
    expect(events).toEqual(['done']);
    expect(await traced.result()).toBe(message);
    expect(await traced.result()).toBe(message);
    expect(originalResult).toHaveBeenCalledOnce();
    expect(records[1].parent).toBe(records[0].context);
    expect(records[1].ends).toBe(1);
    expect(records[1].attributes[traceField('usage_observed')]).toBe(tokens !== undefined);
    expect(records[1].attributes[traceField('cost_basis')]).toBe(
      tokens === undefined ? 'unknown' : 'estimated',
    );
    expect(records[1].attributes['gen_ai.usage.input_tokens']).toBe(tokens);
    expect(records[1].attributes['gen_ai.usage.cost']).toBe(tokens === undefined ? undefined : 0);
    expect(JSON.stringify(records)).not.toMatch(/SENTINEL/);
    root.end();
  });
  it('ends cancelled streams exactly once even if a terminal result arrives later', async () => {
    const { records, exporter } = memoryTraceExporter();
    __setTraceExporterForTests(exporter);
    const signal = new AbortController();
    const stream = createAssistantMessageEventStream();
    const traced = await tracePiStream(async () => stream, model, context, {
      signal: signal.signal,
    });
    signal.abort();
    expect(records[0].ends).toBe(1);
    stream.push({ type: 'done', reason: 'stop', message: assistant(12) });
    await traced.result();
    expect(records[0].ends).toBe(1);
    expect(records[0].attributes[traceField('execution_outcome')]).toBe('cancelled');
  });
  it('preserves stream creation failures and calls the provider exactly once', async () => {
    const { records, exporter } = memoryTraceExporter();
    __setTraceExporterForTests(exporter);
    const error = new Error('SECRET_PROVIDER_ERROR');
    const provider = vi.fn(async () => {
      throw error;
    });
    await expect(tracePiStream(provider, model, context)).rejects.toBe(error);
    expect(provider).toHaveBeenCalledOnce();
    expect(records[0].ends).toBe(1);
    expect(JSON.stringify(records)).not.toContain(error.message);
  });
});
