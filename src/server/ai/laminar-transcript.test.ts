import { afterEach, expect, it, vi } from 'vitest';
import { __setTraceExporterForTests, type tracePiStream } from './laminar-tracing';
import { sanitizeTracePayload } from './laminar-transcript';

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
