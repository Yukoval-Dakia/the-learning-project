import { randomUUID } from 'node:crypto';
import { type Server, createServer } from 'node:http';
import { createRequire } from 'node:module';
import { eq, sql } from 'drizzle-orm';
import { Memory, PGVector } from 'mem0ai/oss';
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
  vi.stubEnv('SKIP_BOSS_INGEST', '1');
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe.each([
  ['esm', PGVector],
  ['cjs', cjs.PGVector],
] as const)('actual %s PGVector atomic add', (_format, Constructor) => {
  it('does not leave a partial event identity when one vector fails; valid batches still commit', async () => {
    const collection = `mem0_atomic_${randomUUID().replaceAll('-', '')}`;
    const store = new Constructor({
      connectionString: process.env.TEST_DATABASE_URL,
      collectionName: collection,
      embeddingModelDims: 4,
    });
    try {
      await store.initialize();
      const ids = [randomUUID(), randomUUID()];
      const payloads = [
        {
          event_id: 'atomic-event',
          data: '先画树状图',
          nested: { source: ['a', 'b'], unknown: null },
        },
        {
          event_id: 'atomic-event',
          data: '再核对条件方向',
          nested: { source: ['c'], unknown: true },
        },
      ];
      await expect(
        store.insert(
          [
            [1, 2, 3, 4],
            [1, 2, 3],
          ],
          ids,
          payloads,
        ),
      ).rejects.toThrow();
      expect((await store.list({ event_id: 'atomic-event' }, 10))[0]).toEqual([]);
      await store.insert(
        [
          [1, 2, 3, 4],
          [4, 3, 2, 1],
        ],
        ids,
        payloads,
      );
      expect(
        (await store.list({ event_id: 'atomic-event' }, 10))[0].map((row) => row.id).sort(),
      ).toEqual([...ids].sort());
      await store.insert([], [], []);
    } finally {
      await store.deleteCol();
      await store.close();
    }
  });
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
      signal: new AbortController().signal,
    };
    return { id, handler, job, send };
  }
  it('records failure, writes no completion, and cannot re-burn on same-event redelivery', async () => {
    const { id, handler, job, send } = await setup();
    await expect(handler([job])).rejects.toThrow('synthetic upstream extraction failure');
    const attempts = await testDb()
      .select()
      .from(provider_attempt)
      .where(eq(provider_attempt.lane_id, 'mem0.event-memory'));
    expect(attempts).toHaveLength(1);
    expect(attempts[0].terminal_status).toBe('failed');
    expect(await readIngestCompleted(testDb(), id)).toBeNull();
    const beforeRetry = calls;
    await expect(handler([job])).rejects.toThrow();
    expect(calls).toBe(beforeRetry);
    expect(send).not.toHaveBeenCalled();
    expect(await readIngestCompleted(testDb(), id)).toBeNull();
    const [started] = await testDb().execute<{ count: number }>(
      sql`select count(*)::int count from provider_attempt where provider_start_reserved_at is not null`,
    );
    expect(started.count).toBe(1);
  });
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
