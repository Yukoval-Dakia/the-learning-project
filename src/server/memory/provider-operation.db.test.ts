import type { Job } from 'pg-boss';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSearchMemoryFactsTool } from '@/capabilities/copilot/server/tools/search-memory-facts';
import { provider_attempt, tool_operation } from '@/db/schema';
import type { ToolContext } from '@/kernel/tools/types';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { createMem0OpaqueOperationContext } from '../ai/provider-attempt-runtime';
import { type Mem0Like, createMemoryClient } from './client';
import { buildMemoryEventIngestHandler } from './triggers';

const env = {
  DATABASE_URL: 'postgres://loom:secret@127.0.0.1:5433/loom_test?sslmode=disable',
  ZHIPU_API_KEY: 'fake-zhipu-key',
  DASHSCOPE_API_KEY: 'fake-dashscope-key',
};

function fakeMem0(overrides: Partial<Pick<Mem0Like, 'add' | 'search' | 'getAll'>> = {}): Mem0Like {
  return {
    add: vi.fn(async () => ({ results: [] })),
    search: vi.fn(async () => ({ results: [] })),
    getAll: vi.fn(async () => ({ results: [] })),
    delete: vi.fn(async () => ({ message: 'ok' })),
    history: vi.fn(async () => []),
    get: vi.fn(async () => null),
    ...overrides,
  };
}

function deterministicSendId(options: object): string | null {
  return 'id' in options && typeof options.id === 'string' ? options.id : null;
}

beforeEach(async () => {
  vi.stubEnv('AI_PROVIDER_ATTEMPT_ADMISSION_MODE', 'observe');
  vi.stubEnv(
    'AI_PROVIDER_ATTEMPT_ADMISSION_POLICIES_JSON',
    JSON.stringify({
      'mem0.event-memory': { maxConcurrentAttempts: 100, maxAttemptStartsPerMinute: 1000 },
    }),
  );
  await resetDb();
});
afterEach(() => vi.unstubAllEnvs());

describe('Mem0 opaque operation durable surfaces', () => {
  it('persists one worker add attempt while preserving event metadata and output', async () => {
    // Given the real worker ingest handler around an instrumented client and fake Mem0 SDK.
    const add = vi.fn(async () => ({
      results: [{ id: 'mem_worker_852', memory: 'prefers worked examples' }],
    }));
    const memory = fakeMem0({ add });
    const client = createMemoryClient({ env, memoryFactory: () => memory });
    const send = vi.fn(async (_queue: string, _data: object, options: object) =>
      deterministicSendId(options),
    );
    const handler = buildMemoryEventIngestHandler(
      testDb(),
      { send },
      {
        memoryClient: client,
        loadEvent: async () => ({
          id: 'evt_worker_852',
          actor_kind: 'user',
          action: 'rate',
          subject_kind: 'event',
          subject_id: 'evt_source_852',
          payload: { rating: 'accept' },
          affected_scopes: ['global', 'topic:k852'],
          created_at: new Date('2026-08-09T03:00:00.000Z'),
          kind: 'preference',
        }),
      },
    );

    // When one concrete pg-boss invocation performs the Mem0 add.
    const job: Job<{ event_id: string }> = {
      id: '00000000-0000-4000-8000-000000000852',
      name: 'memory_event_ingest',
      data: { event_id: 'evt_worker_852' },
      expireInSeconds: 60,
      heartbeatSeconds: null,
      signal: new AbortController().signal,
    };
    await handler([job]);

    // Then the fake SDK output reaches reconcile and durable truth contains exactly one attempt.
    expect(add).toHaveBeenCalledWith(expect.any(String), {
      userId: 'self',
      infer: true,
      metadata: expect.objectContaining({
        event_id: 'evt_worker_852',
        affected_scopes: ['global', 'topic:k852'],
      }),
    });
    expect(send).toHaveBeenCalledWith(
      'memory_reconcile',
      expect.objectContaining({
        memories: [
          expect.objectContaining({ id: 'mem_worker_852', text: 'prefers worked examples' }),
        ],
      }),
      expect.any(Object),
    );
    const rows = await testDb().select().from(provider_attempt);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      attempt_kind: 'opaque_operation',
      provider: 'mem0',
      model: null,
      lane_id: 'mem0.event-memory',
      caller: 'worker',
      endpoint_class: 'memory.add',
      operation_kind: 'add_inferred',
      provider_start_reserved_at: expect.any(Date),
      terminal_status: 'succeeded',
      wire_count: null,
      cost_basis: 'unknown',
      cost_amount: null,
    });
    expect(rows[0]?.started_at).toBeInstanceOf(Date);
    expect(rows[0]?.finished_at).toBeInstanceOf(Date);
    expect(rows[0]?.finished_at?.getTime()).toBeGreaterThanOrEqual(
      rows[0]?.started_at.getTime() ?? Number.POSITIVE_INFINITY,
    );
  });

  it('persists one API search attempt through the search_memory_facts tool', async () => {
    // Given the real tool/read/client stack with only the inner Mem0 SDK faked.
    const search = vi.fn(async () => ({
      results: [
        {
          id: 'mem_api_852',
          memory: 'likes concise explanations',
          score: 0.91,
          metadata: { event_id: 'evt_source_852', user_id: 'self', kind: 'preference' },
        },
      ],
    }));
    const client = createMemoryClient({ env, memoryFactory: () => fakeMem0({ search }) });
    const tool = buildSearchMemoryFactsTool({ memoryFactory: () => client });
    const ctx: ToolContext = {
      db: testDb(),
      taskRunId: 'tool_api_search_852',
      providerAttemptCaller: 'api',
      providerSessionDeadlineAt: Date.now() + 65_000,
      callerActor: { kind: 'agent', ref: 'agent:copilot' },
    };

    // When the API-hosted tool performs canonical memory search.
    const output = await tool.execute(ctx, { query: 'helpful explanation style', topK: 3 });

    // Then output metadata survives and the opaque API attempt is terminally truthful.
    expect(output).toMatchObject({
      count: 1,
      facts: [
        expect.objectContaining({
          id: 'mem_api_852',
          metadata: expect.objectContaining({ event_id: 'evt_source_852', user_id: 'self' }),
        }),
      ],
    });
    const rows = await testDb().select().from(provider_attempt);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      caller: 'api',
      endpoint_class: 'memory.search',
      operation_kind: 'search',
      terminal_status: 'succeeded',
      wire_count: null,
      usage_json: {
        basis: 'unknown',
        unit: null,
        input: null,
        output: null,
        total: null,
        source: 'mem0_sdk_usage_unavailable',
      },
      cost_basis: 'unknown',
      cost_amount: null,
      cost_currency: null,
      cost_source: 'mem0_sdk_cost_unavailable',
    });
    expect(await testDb().select().from(tool_operation)).toHaveLength(0);
    expect(tool.safeHandoff).toBeUndefined();
  });

  it('shares a stable operation across fresh search attempts and records SDK failure', async () => {
    // Given two SDK searches in one product invocation where the second rejects.
    const sdkError = new Error('fake Mem0 search failure');
    const search = vi
      .fn()
      .mockResolvedValueOnce({ results: [{ id: 'first_852', memory: 'first' }] })
      .mockRejectedValueOnce(sdkError);
    const client = createMemoryClient({ env, memoryFactory: () => fakeMem0({ search }) });
    const providerOperation = createMem0OpaqueOperationContext({
      db: testDb(),
      caller: 'worker',
      deadlineAt: new Date(Date.now() + 65_000),
      operationAnchor: 'worker-reconcile-invocation-852',
    });

    // When both calls execute with the same caller-owned context.
    await client.search('first query', { topK: 2 }, providerOperation);
    const failure = client.search('second query', { topK: 2 }, providerOperation);

    // Then attempts are fresh, operation identity is stable, and the original SDK error survives.
    await expect(failure).rejects.toBe(sdkError);
    const rows = await testDb().select().from(provider_attempt);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.attempt_id))).toHaveLength(2);
    expect(new Set(rows.map((row) => row.operation_id))).toHaveLength(1);
    expect(rows.map((row) => row.terminal_status).sort()).toEqual(['failed', 'succeeded']);
  });

  it('writes no attempt row when addVerbatimOnce returns a getAll cache hit', async () => {
    // Given an existing projection returned by non-model-bearing getAll.
    const add = vi.fn(async () => ({ results: [] }));
    const client = createMemoryClient({
      env,
      memoryFactory: () =>
        fakeMem0({
          add,
          getAll: vi.fn(async () => ({
            results: [{ id: 'cached_852', memory: 'already present' }],
          })),
        }),
    });
    const providerOperation = createMem0OpaqueOperationContext({
      db: testDb(),
      caller: 'worker',
      deadlineAt: new Date(Date.now() + 65_000),
      operationAnchor: 'worker-cache-hit-852',
    });

    // When the idempotency cache satisfies the projection operation.
    const output = await client.addVerbatimOnce(
      'already present',
      { event_id: 'evt_cached_852' },
      'projection:cached_852',
      providerOperation,
      async () => {},
    );

    // Then output is preserved without a fake attempt for getAll.
    expect(output.results?.[0]?.id).toBe('cached_852');
    expect(add).not.toHaveBeenCalled();
    expect(await testDb().select().from(provider_attempt)).toHaveLength(0);
  });
});
