import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { afterEach, expect, it, vi } from 'vitest';
import {
  __setTraceExporterForTests,
  initializeLaminarTracing,
  traceOperation,
  tracePiStream,
} from './laminar-tracing';
import {
  memoryTraceExporter,
  piTraceUsage,
  piTraceUsageCases,
  traceField,
} from './laminar-tracing.test-support';
import { sanitizeTracePayload } from './laminar-transcript';
import {
  transcriptAssistant,
  transcriptContext,
  transcriptToolInput,
  transcriptToolResult,
} from './laminar-transcript.test-support';
import { withPiUsageEvidence } from './pi-usage-evidence';

const model = {
  id: 'offline-model',
  name: 'Offline',
  provider: 'offline',
  api: 'openai-completions',
  reasoning: false,
  baseUrl: 'https://offline.invalid',
  input: ['text'],
  contextWindow: 10000,
  maxTokens: 100,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} satisfies Parameters<typeof tracePiStream>[1];
afterEach(() => {
  __setTraceExporterForTests();
  vi.unstubAllEnvs();
});

it.each([
  ['development', '1', true],
  ['production', '1', false],
  ['test', '1', false],
  ['', '1', false],
  ['development', '', false],
  ['development', 'true', false],
])(
  'captures actual messages only with explicit development opt-in: %s/%s',
  async (env, flag, enabled) => {
    vi.stubEnv('NODE_ENV', env);
    vi.stubEnv('LMNR_DEV_TRANSCRIPTS', flag);
    const { records, exporter } = memoryTraceExporter();
    __setTraceExporterForTests(exporter);
    const stream = createAssistantMessageEventStream();
    const provider = vi.fn(async () => stream);
    const resultRead = vi.spyOn(stream, 'result');
    const traced = await tracePiStream(provider, model, transcriptContext, {
      apiKey: 'FORBIDDEN_OPTION',
      headers: { Authorization: 'FORBIDDEN_AUTH' },
    });
    stream.push({ type: 'done', reason: 'toolUse', message: transcriptAssistant });
    const events = [];
    for await (const event of traced) events.push(event.type);
    expect(events).toEqual(['done']);
    expect(await traced.result()).toBe(transcriptAssistant);
    expect(await traced.result()).toBe(transcriptAssistant);
    expect(resultRead).toHaveBeenCalledOnce();
    expect(provider).toHaveBeenCalledOnce();
    const input = records[0].attributes['lmnr.span.input'];
    const output = records[0].attributes['lmnr.span.output'];
    if (enabled) {
      expect(input).toContain('你是数学教师');
      expect(input).toContain('按步骤判分');
      expect(JSON.parse(String(input))).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ role: 'system' }),
          expect.objectContaining({ role: 'user' }),
          expect.objectContaining({
            role: 'assistant',
            tool_calls: [expect.objectContaining({ id: 'turn-2-call' })],
          }),
          expect.objectContaining({
            role: 'tool',
            tool_call_id: 'turn-2-call',
            content: expect.stringContaining('根为 ±2'),
          }),
        ]),
      );
      expect(output).toContain('可见结论');
      expect(output).toContain('turn-2-call');
      expect(output).toContain('保留正常教育内容');
      expect(output).toContain('response-2');
    } else {
      expect(input).toBeUndefined();
      expect(output).toBeUndefined();
    }
    expect(JSON.stringify(records)).not.toContain('FORBIDDEN');
    expect(records[0].ends).toBe(1);
  },
);

it('bounds structured tool payloads, circular values, accessors and errors without changing execution', async () => {
  vi.stubEnv('NODE_ENV', 'development');
  vi.stubEnv('LMNR_DEV_TRANSCRIPTS', '1');
  const { records, exporter } = memoryTraceExporter();
  __setTraceExporterForTests(exporter);
  const circular: { answer: string; self?: unknown } = { answer: '正常教育内容'.repeat(10000) };
  circular.self = circular;
  const getter = vi.fn(() => {
    throw new Error('FORBIDDEN_GETTER');
  });
  const payload = {
    ...transcriptToolInput,
    circular,
    many: Array.from({ length: 5000 }, () => '保留内容'),
    bytes: new Uint8Array(100000),
    failure: new Error('FORBIDDEN_ERROR'),
    toJSON: () => {
      throw new Error('FORBIDDEN_TOJSON');
    },
  };
  Object.defineProperty(payload, 'computed', { enumerable: true, get: getter });
  const callback = vi.fn(async () => transcriptToolResult);
  expect(
    await traceOperation('tool.execute', { tool_call_id: 'call-1' }, callback, {
      transcript: { input: () => payload, output: (value) => value },
    }),
  ).toBe(transcriptToolResult);
  expect(callback).toHaveBeenCalledOnce();
  expect(getter).not.toHaveBeenCalled();
  const serialized = String(records[0].attributes['lmnr.span.input']);
  expect(serialized).toContain('TRUNCATED');
  expect(serialized).toContain('circular');
  expect(serialized.length).toBeLessThanOrEqual(65536);
  expect(() => JSON.parse(serialized)).not.toThrow();
  expect(records[0].attributes['lmnr.span.output']).toContain('解法正确');
  expect(JSON.stringify(records)).not.toContain('FORBIDDEN');
});

it('does not evaluate payload projectors without tracing or in production', async () => {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('LMNR_DEV_TRANSCRIPTS', '1');
  const input = vi.fn(() => transcriptToolInput);
  const output = vi.fn(() => transcriptToolResult);
  for (const enabled of [false, true]) {
    __setTraceExporterForTests(enabled ? memoryTraceExporter().exporter : undefined);
    await traceOperation('tool.execute', {}, async () => transcriptToolResult, {
      transcript: { input, output },
    });
  }
  expect(input).not.toHaveBeenCalled();
  expect(output).not.toHaveBeenCalled();
});

it('does not export late output after cancellation', async () => {
  vi.stubEnv('NODE_ENV', 'development');
  vi.stubEnv('LMNR_DEV_TRANSCRIPTS', '1');
  const { records, exporter } = memoryTraceExporter();
  __setTraceExporterForTests(exporter);
  const stream = createAssistantMessageEventStream();
  const controller = new AbortController();
  const traced = await tracePiStream(async () => stream, model, transcriptContext, {
    signal: controller.signal,
  });
  controller.abort();
  stream.push({ type: 'done', reason: 'toolUse', message: transcriptAssistant });
  await traced.result();
  expect(records[0].ends).toBe(1);
  expect(records[0].attributes[traceField('execution_outcome')]).toBe('cancelled');
  expect(records[0].attributes['lmnr.span.input']).toContain('学生原答');
  expect(records[0].attributes['lmnr.span.output']).toBeUndefined();
});

it.each(['development', 'production'])(
  'uses real SDK transcript serialization offline: %s',
  async (env) => {
    const cwd = await mkdtemp(join(tmpdir(), 'tlp-transcript-sdk-'));
    try {
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [
          '--import',
          import.meta.resolve('tsx'),
          fileURLToPath(new URL('./laminar-tracing.sdk.test-support.ts', import.meta.url)),
          'transcript',
        ],
        { cwd, env: { NODE_ENV: env, LMNR_DEV_TRANSCRIPTS: '1' }, timeout: 10000 },
      );
      expect(stdout).toContain('"networkAttempts":0');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
);

it('keeps development opt-in inert without a project key', async () => {
  vi.stubEnv('NODE_ENV', 'development');
  vi.stubEnv('LMNR_DEV_TRANSCRIPTS', '1');
  const loadSdk = vi.fn(async () => {
    throw new Error('must not load SDK');
  });
  await initializeLaminarTracing({ projectApiKey: '', loadSdk });
  const input = vi.fn(() => transcriptToolInput);
  const output = vi.fn(() => transcriptToolResult);
  const callback = vi.fn(async () => transcriptToolResult);
  expect(
    await traceOperation('tool.execute', {}, callback, { transcript: { input, output } }),
  ).toBe(transcriptToolResult);
  expect(callback).toHaveBeenCalledOnce();
  expect(loadSdk).not.toHaveBeenCalled();
  expect(input).not.toHaveBeenCalled();
  expect(output).not.toHaveBeenCalled();
});

it('excludes credentials in structured text, binary/CoT blocks and labeled prose while retaining educational data', () => {
  const result = sanitizeTracePayload({
    data: { equation: 'x²-4=0', roots: [-2, 2] },
    text: 'student answer remains. apiKey="FORBIDDEN_INLINE" password=FORBIDDEN_PASSWORD Bearer FORBIDDEN_BEARER <reasoning>FORBIDDEN_COT</reasoning> visible answer',
    json: JSON.stringify({
      env: { arbitrary: 'FORBIDDEN_ENV' },
      headers: { custom: 'FORBIDDEN_HEADER' },
      token: 'FORBIDDEN_TOKEN',
      answer: '正常教育内容'.repeat(1800),
    }),
    oversizedJson: JSON.stringify({
      env: { arbitrary: 'FORBIDDEN_LARGE_ENV' },
      answer: '中文'.repeat(50000),
    }),
    content: [
      { type: 'reasoning', text: 'FORBIDDEN_REASONING' },
      { type: 'image_url', url: 'FORBIDDEN_IMAGE' },
    ],
    media: { mimeType: 'image/png', data: 'FORBIDDEN_MEDIA' },
    provider_binding: { opaque: 'FORBIDDEN_PROVIDER' },
    modelBinding: { opaque: 'FORBIDDEN_MODEL' },
    auth_headers: { custom: 'FORBIDDEN_HEADER' },
    raw_cot: 'FORBIDDEN_COT',
    private_key: 'FORBIDDEN_PRIVATE_KEY',
    credential: 'FORBIDDEN_CREDENTIAL',
    big: 123n,
  });
  const serialized = JSON.stringify(result);
  expect(serialized).toContain('x²-4=0');
  expect(serialized).toContain('student answer remains');
  expect(serialized).toContain('visible answer');
  expect(serialized).toContain('正常教育内容');
  expect(serialized).toContain('TRUNCATED');
  expect(serialized).not.toContain('FORBIDDEN');
  expect(serialized.length).toBeLessThanOrEqual(65536);
});

it.each(piTraceUsageCases)(
  'preserves usage evidence with development transcripts: $name',
  async (fixture) => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('LMNR_DEV_TRANSCRIPTS', '1');
    const { records, exporter } = memoryTraceExporter();
    __setTraceExporterForTests(exporter);
    const stream = createAssistantMessageEventStream();
    const message = { ...transcriptAssistant, usage: piTraceUsage(fixture) };
    const traced = await tracePiStream(
      (m, c, o) =>
        withPiUsageEvidence(
          async (_m, _c, options) => {
            if (fixture.observed)
              await options?.onProviderStreamEvent?.(
                { usage: { prompt_tokens: fixture.totalInput, completion_tokens: fixture.output } },
                model,
              );
            return stream;
          },
          m,
          c,
          o,
        ),
      model,
      transcriptContext,
    );
    stream.push({ type: 'done', reason: 'toolUse', message });
    expect(await traced.result()).toBe(message);
    expect(records[0].attributes['lmnr.span.output']).toContain('可见结论');
    expect(records[0].attributes['gen_ai.usage.input_tokens']).toBe(fixture.totalInput);
    expect(records[0].attributes['gen_ai.usage.cost']).toBe(
      fixture.observed ? fixture.totalCost : undefined,
    );
    expect(records[0].attributes[traceField('usage_observed')]).toBe(fixture.observed);
  },
);

it('shows truncation for large actual message collections without exporting media', async () => {
  vi.stubEnv('NODE_ENV', 'development');
  vi.stubEnv('LMNR_DEV_TRANSCRIPTS', '1');
  const { records, exporter } = memoryTraceExporter();
  __setTraceExporterForTests(exporter);
  const stream = createAssistantMessageEventStream();
  const messages = Array.from(
    { length: 100 },
    (_, timestamp) =>
      ({
        role: 'user',
        timestamp,
        content: [{ type: 'text', text: '长题干与学生原答。'.repeat(5000) }],
      }) satisfies Parameters<typeof tracePiStream>[2]['messages'][number],
  );
  const traced = await tracePiStream(async () => stream, model, { ...transcriptContext, messages });
  stream.push({ type: 'done', reason: 'toolUse', message: transcriptAssistant });
  await traced.result();
  const input = String(records[0].attributes['lmnr.span.input']);
  expect(JSON.parse(input)).toEqual(
    expect.arrayContaining([expect.objectContaining({ role: 'user' })]),
  );
  for (const message of JSON.parse(input))
    expect(message).toEqual(
      expect.objectContaining({ role: expect.any(String), content: expect.any(String) }),
    );
  expect(input).toContain('长题干');
  expect(input).toContain('TRUNCATED');
  expect(input.length).toBeLessThanOrEqual(65536);
  expect(() => JSON.parse(input)).not.toThrow();
});
