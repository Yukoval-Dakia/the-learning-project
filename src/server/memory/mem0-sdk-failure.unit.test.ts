import { randomUUID } from 'node:crypto';
import { type Server, createServer } from 'node:http';
import { createRequire } from 'node:module';
import { Memory } from 'mem0ai/oss';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const cjs: typeof import('mem0ai/oss') = createRequire(import.meta.url)('mem0ai/oss');
vi.hoisted(() => vi.stubEnv('MEM0_TELEMETRY', 'false'));
let server: Server;
let endpoint: string;
type Scenario =
  | 'http_error'
  | 'invalid_json'
  | 'invalid_schema'
  | 'embedding_error'
  | 'empty'
  | 'valid';
let scenario: Scenario;
const fact = '学习概率时先画树状图；保留反例与未知，不因一次答对就推断稳定掌握。';
beforeAll(async () => {
  vi.stubEnv('MEM0_TELEMETRY', 'false');
  server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw);
    response.setHeader('content-type', 'application/json');
    if (request.url === '/embeddings') {
      const values = Array.isArray(input.input) ? input.input : [input.input];
      if (scenario === 'embedding_error' && values.includes(fact)) {
        response
          .writeHead(400)
          .end(JSON.stringify({ error: { message: 'synthetic materialization failure' } }));
      } else {
        response.end(
          JSON.stringify({
            data: values.map((_: string, index: number) => ({
              index,
              embedding: [0.2, 0.4, 0.6, 0.8],
            })),
          }),
        );
      }
      return;
    }
    if (request.url !== '/chat/completions') {
      response.writeHead(404).end('{}');
      return;
    }
    if (scenario === 'http_error') {
      response
        .writeHead(400)
        .end(JSON.stringify({ error: { message: 'synthetic extraction failure' } }));
      return;
    }
    const content =
      scenario === 'invalid_json'
        ? '{"memory":['
        : scenario === 'invalid_schema'
          ? '{"not_memory":[]}'
          : JSON.stringify({
              memory:
                scenario === 'empty'
                  ? []
                  : [{ id: '0', text: fact, attributed_to: 'user', linked_memory_ids: [] }],
            });
    response.end(
      JSON.stringify({
        choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('HTTP fixture did not bind');
  endpoint = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.unstubAllEnvs();
});

describe.each([
  ['esm', Memory],
  ['cjs', cjs.Memory],
] as const)('actual Mem0 %s failure truth', (_format, Constructor) => {
  function memory() {
    return new Constructor({
      embedder: {
        provider: 'openai',
        config: {
          apiKey: 'test-only',
          baseURL: endpoint,
          model: 'test-embedding',
          embeddingDims: 4,
        },
      },
      llm: {
        provider: 'openai',
        config: { apiKey: 'test-only', baseURL: endpoint, model: 'test-extraction' },
      },
      vectorStore: {
        provider: 'memory',
        config: {
          collectionName: `failure_truth_${randomUUID()}`,
          dimension: 4,
          dbPath: ':memory:',
        },
      },
      disableHistory: true,
    });
  }
  const input = JSON.stringify({
    text: fact,
    context: {
      subject: 'probability',
      priorAttempts: [
        { correct: true, confidence: null },
        { correct: false, reason: 'condition direction' },
      ],
      caveats: ['one answer is not mastery', 'retain unknown evidence'],
    },
  });
  it.each(['http_error', 'invalid_json', 'invalid_schema', 'embedding_error'] as const)(
    'rejects %s instead of accepting empty success',
    async (value) => {
      scenario = value;
      await expect(
        memory().add(input, {
          userId: 'self',
          metadata: { event_id: `failure_${value}` },
          infer: true,
        }),
      ).rejects.toThrow();
    },
  );
  it('allows a schema-valid empty extraction', async () => {
    scenario = 'empty';
    await expect(memory().add(input, { userId: 'self', infer: true })).resolves.toMatchObject({
      results: [],
    });
  });
  it('stores a valid extracted fact and retrieves its event identity', async () => {
    scenario = 'valid';
    const client = memory();
    const added = await client.add(input, {
      userId: 'self',
      metadata: { event_id: 'success' },
      infer: true,
    });
    expect(added.results).toHaveLength(1);
    expect(added.results[0]).toMatchObject({ memory: fact });
    const read = await client.getAll({ filters: { user_id: 'self', event_id: 'success' } });
    expect(read.results.map((row) => row.id)).toEqual(added.results.map((row) => row.id));
  });
});
