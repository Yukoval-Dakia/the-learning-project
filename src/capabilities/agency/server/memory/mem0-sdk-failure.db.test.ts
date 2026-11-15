import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { type Server, createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { Memory } from 'mem0ai/oss';
import type { Job } from 'pg-boss';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { installModelEndpointHostAllowlist } from '@/core/config/model-endpoint-allowlist';
import { event, learning_session, provider_attempt } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { readEventDerivationPolicy } from '@/kernel/events/derivation-policy';
import { createMemoryClient } from '@/server/ai/mem0/client';
import { resetDb, testDb } from '../../../../../tests/helpers/db';
import { readIngestCompleted } from './memory-reconcile-handoff-store';
import { buildMemoryEventIngestHandler } from './triggers';

vi.hoisted(() => vi.stubEnv('MEM0_TELEMETRY', 'false'));
let server: Server;
let endpoint: string;
let historyDirectory: string;
let historyPath: string;
let failExtraction = true;
let calls = 0;
const inferenceRequests: string[] = [];
beforeAll(async () => {
  historyDirectory = await mkdtemp(join(tmpdir(), 'mem0-source-history-'));
  historyPath = join(historyDirectory, 'history.db');
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
    inferenceRequests.push(raw);
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
  // YUK-1654 — the memory lanes gate MEM0_*_BASE_URL through the model
  // endpoint allowlist; admit the local fixture endpoint explicitly.
  installModelEndpointHostAllowlist([new URL(endpoint).host]);
});
beforeEach(async () => {
  await resetDb();
  calls = 0;
  inferenceRequests.length = 0;
  failExtraction = true;
  vi.stubEnv('AI_PROVIDER_ATTEMPT_ADMISSION_MODE', 'observe');
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(historyDirectory, { recursive: true, force: true });
});

describe('actual SDK failure through Memory ingestion owner', () => {
  async function setup(
    userMessage = '先画树状图，再写条件概率；保留反例和未验证边界。',
    legacyHistory = false,
  ) {
    const id = randomUUID();
    const sessionId = randomUUID();
    await testDb().insert(learning_session).values({
      id: sessionId,
      type: 'conversation',
      status: 'active',
      started_at: new Date(),
      created_at: new Date(),
      updated_at: new Date(),
      version: 0,
    });
    await writeEvent(testDb(), {
      id,
      session_id: sessionId,
      actor_kind: 'user',
      actor_ref: 'user:memory-test',
      action: 'experimental:copilot_user_ask',
      subject_kind: 'event',
      subject_id: id,
      payload: {
        user_message: userMessage,
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
          historyDbPath: historyPath,
          ...(legacyHistory ? { disableHistory: false } : {}),
        }),
    });
    const send = vi.fn(async () => null);
    const handler = buildMemoryEventIngestHandler(
      testDb(),
      { send, getJobById: vi.fn(async () => null) },
      { memoryClient: client },
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
  // @invariant security: withdrawn learner text in existing SQLite history never reaches a later extraction request, while empty extraction remains complete and is not repurchased
  // @fails-if current SDK config reloads persisted history or an empty result is retried as new paid work
  it('preserves legitimate empty extraction and replays its completion without a new call', async () => {
    failExtraction = false;
    const withdrawnText = 'WITHDRAWN_HISTORY_A：我习惯先画树状图。';
    const { id, handler, job, send } = await setup(withdrawnText, true);
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

    expect(inferenceRequests.at(-1)).toContain(withdrawnText);
    await testDb()
      .update(event)
      .set({ payload: { user_message: withdrawnText, derivation_policy: 'answer_only' } })
      .where(eq(event.id, id));
    expect(await readEventDerivationPolicy(testDb(), id)).toBe('answer_only');
    const currentText = 'CURRENT_LEARNER_B：我偏好分步解释。';
    const next = await setup(currentText);
    await next.handler([next.job]);
    expect(inferenceRequests.at(-1)).toContain(currentText);
    expect(inferenceRequests.at(-1)).not.toContain(withdrawnText);
  });
});
