import { randomUUID } from 'node:crypto';
import { type Server, createServer } from 'node:http';
import { createRequire } from 'node:module';
import { eq } from 'drizzle-orm';
import { Memory } from 'mem0ai/oss';
import type { Job } from 'pg-boss';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { provider_attempt } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { createMemoryClient } from './client';
import { readIngestCompleted } from './memory-reconcile-handoff-store';
import { buildMemoryEventIngestHandler } from './triggers';

vi.hoisted(() => vi.stubEnv('MEM0_TELEMETRY', 'false'));
const cjs: typeof import('mem0ai/oss') = createRequire(import.meta.url)('mem0ai/oss');
let server: Server;
let endpoint: string;
let failExtraction = true;
let calls = 0;
beforeAll(async () => {
  server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    calls++;
    response.setHeader('content-type', 'application/json');
    if (request.url === '/embeddings') {
      const input = JSON.parse(raw);
      const values = Array.isArray(input.input) ? input.input : [input.input];
      response.end(
        JSON.stringify({
          data: values.map((_: string, index: number) => ({
            index,
            embedding: [0.2, 0.4, 0.6, 0.8],
          })),
        }),
      );
      return;
    }
    if (failExtraction) {
      response
        .writeHead(400)
        .end(JSON.stringify({ error: { message: 'synthetic upstream extraction failure' } }));
      return;
    }
    response.end(
      JSON.stringify({
        choices: [
          { message: { role: 'assistant', content: '{"memory":[]}' }, finish_reason: 'stop' },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('Fixture bind failed');
  endpoint = `http://127.0.0.1:${address.port}`;
});
beforeEach(async () => {
  await resetDb();
  calls = 0;
  failExtraction = true;
  vi.stubEnv('AI_PROVIDER_ATTEMPT_ADMISSION_MODE', 'observe');
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('actual SDK failure through Memory ingestion owner', () => {
  async function setup() {
    const id = randomUUID();
    await writeEvent(testDb(), {
      id,
      actor_kind: 'user',
      actor_ref: 'user:memory-test',
      action: 'experimental:memory_failure_test',
      subject_kind: 'event',
      subject_id: id,
      payload: {
        text: '先画树状图，再写条件概率；保留反例和未验证边界。',
        examples: [
          { correct: true, confidence: null },
          { correct: false, condition: 'reversed' },
        ],
      },
      affected_scopes: [],
    });
    const client = createMemoryClient({
      env: {
        DATABASE_URL: process.env.TEST_DATABASE_URL,
        ZHIPU_API_KEY: 'test-only',
        DASHSCOPE_API_KEY: 'test-only',
        MEM0_LLM_BASE_URL: endpoint,
        MEM0_EMBEDDING_BASE_URL: endpoint,
        MEM0_EMBEDDING_DIMS: '4',
      },
      memoryFactory: (config) =>
        new Memory({
          ...config,
          vectorStore: { provider: 'memory', config: { dimension: 4, dbPath: ':memory:' } },
          disableHistory: true,
        }),
    });
    const send = vi.fn(async () => null);
    const handler = buildMemoryEventIngestHandler(
      testDb(),
      { send, getJobById: vi.fn(async () => null) },
      { memoryClient: client, handoffMode: 'recover' },
    );
    const job: Job<{ event_id: string }> = {
      id: randomUUID(),
      name: 'memory_event_ingest',
      data: { event_id: id },
      expireInSeconds: 60,
      heartbeatSeconds: null,
      retryCount: 0,
      signal: new AbortController().signal,
    };
    return { id, handler, job, send };
  }
  it('preserves legitimate empty extraction and replays its completion without a new call', async () => {
    failExtraction = false;
    const { id, handler, job, send } = await setup();
    await handler([job]);
    expect(await readIngestCompleted(testDb(), id)).toMatchObject({
      memory_count: 0,
      resolution: 'provider_result',
    });
    const beforeRetry = calls;
    await handler([job]);
    expect(calls).toBe(beforeRetry);
    expect(send).not.toHaveBeenCalled();
    const attempts = await testDb()
      .select()
      .from(provider_attempt)
      .where(eq(provider_attempt.lane_id, 'mem0.event-memory'));
    expect(attempts).toHaveLength(1);
    expect(attempts[0].terminal_status).toBe('succeeded');
  });
});
