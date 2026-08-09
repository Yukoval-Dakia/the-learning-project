import { ProviderRequestIdentity } from '@/core/schema/provider-attempt';
import { provider_attempt, provider_attempt_admission } from '@/db/schema';
import { createProviderAttemptLifecycle } from '@/server/ai/provider-attempt-lifecycle';
import { createMem0OpaqueOperationContext } from '@/server/ai/provider-attempt-runtime';
import { type Mem0Like, createMemoryClient } from '@/server/memory/client';
import { eq } from 'drizzle-orm';
import { unzipSync } from 'fflate';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { memR2 } from '../../../tests/helpers/r2';
import { buildBackupArchive, restoreFromArchive } from './archive';

const ATTEMPT_ID = '00000000-0000-4000-8000-000000000918';

async function buildZipBytes(): Promise<Uint8Array> {
  const { stream } = await buildBackupArchive({
    db: testDb(),
    r2: memR2(),
    includeAssets: false,
  });
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

describe('provider attempt backup lifecycle', () => {
  beforeEach(resetDb);
  afterAll(resetDb);

  it('restores a reserved nonterminal attempt as a recovery-required orphan', async () => {
    // Given a reserved nonterminal provider attempt and its operational owner lease.
    const deadlineAt = new Date(Date.now() + 60_000);
    const identity = ProviderRequestIdentity.parse({
      attemptId: ATTEMPT_ID,
      operationId: '00000000-0000-4000-8000-000000000919',
      attemptKind: 'wire',
      provider: 'xiaomi',
      model: 'mimo-v2.5',
      lane: 'generation',
      protocol: 'anthropic-compatible',
      endpointClass: 'messages',
      caller: 'worker',
      operationKind: 'QuestionGenerateTask',
    });
    const handle = await createProviderAttemptLifecycle({
      mode: 'enforce',
      identity,
      deadlineAt,
      db: testDb(),
    }).acquire();
    await handle.reserveProviderStart();

    // When production archive export and restore run after durable truth is removed.
    const bytes = await buildZipBytes();
    const data = JSON.parse(new TextDecoder().decode(unzipSync(bytes)['data.json'])) as Record<
      string,
      Array<Record<string, unknown>>
    >;
    expect(data.provider_attempt).toHaveLength(1);
    expect(data.provider_attempt?.[0]).toMatchObject({
      attempt_id: ATTEMPT_ID,
      provider_start_reserved_at: expect.any(String),
      terminal_status: null,
      finished_at: null,
    });
    expect(data.provider_attempt_admission).toBeUndefined();
    await testDb().delete(provider_attempt).where(eq(provider_attempt.attempt_id, ATTEMPT_ID));
    const restored = await restoreFromArchive({ db: testDb(), r2: memR2(), bytes });

    // Then durable truth returns without an owner and same-deadline acquisition requires recovery.
    expect(restored.status).toBe(200);
    const restoredAttempt = await testDb()
      .select()
      .from(provider_attempt)
      .where(eq(provider_attempt.attempt_id, ATTEMPT_ID));
    expect(restoredAttempt).toEqual([
      expect.objectContaining({
        attempt_id: ATTEMPT_ID,
        provider_start_reserved_at: expect.any(Date),
        terminal_status: null,
        finished_at: null,
      }),
    ]);
    expect(await testDb().select().from(provider_attempt_admission)).toEqual([]);
    await expect(
      createProviderAttemptLifecycle({
        mode: 'enforce',
        identity,
        deadlineAt,
        db: testDb(),
      }).acquire(),
    ).rejects.toMatchObject({ reason: 'recovery_required' });
    expect(
      await testDb()
        .select()
        .from(provider_attempt)
        .where(eq(provider_attempt.attempt_id, ATTEMPT_ID)),
    ).toEqual(restoredAttempt);
    expect(await testDb().select().from(provider_attempt_admission)).toEqual([]);
  });

  it('round-trips terminal opaque truth without restoring admission or coupling API search', async () => {
    // Given a terminal API Mem0 search attempt plus operational admission state.
    const search = vi.fn(async () => ({
      results: [{ id: 'archive-memory-852', memory: 'archive survives' }],
    }));
    const memory: Mem0Like = {
      add: vi.fn(async () => ({ results: [] })),
      search,
      getAll: vi.fn(async () => ({ results: [] })),
      delete: vi.fn(async () => ({ message: 'ok' })),
      history: vi.fn(async () => []),
      get: vi.fn(async () => null),
    };
    const client = createMemoryClient({
      env: {
        DATABASE_URL: 'postgres://loom:secret@127.0.0.1:5433/loom_test?sslmode=disable',
        ZHIPU_API_KEY: 'fake-zhipu-key',
        DASHSCOPE_API_KEY: 'fake-dashscope-key',
      },
      memoryFactory: () => memory,
    });
    const result = await client.search(
      'archive opaque query',
      { topK: 3 },
      createMem0OpaqueOperationContext({
        db: testDb(),
        caller: 'api',
        deadlineAt: new Date(Date.now() + 65_000),
        operationAnchor: 'archive-api-search-852',
        mode: 'observe',
      }),
    );
    expect(result.results?.[0]?.id).toBe('archive-memory-852');
    const [terminalAttempt] = await testDb().select().from(provider_attempt);
    expect(terminalAttempt).toMatchObject({
      attempt_kind: 'opaque_operation',
      provider: 'mem0',
      model: null,
      lane_id: 'mem0.event-memory',
      protocol: 'mem0-oss-sdk',
      endpoint_class: 'memory.search',
      caller: 'api',
      operation_kind: 'search',
      terminal_status: 'succeeded',
      wire_count: null,
      cost_basis: 'unknown',
      cost_amount: null,
    });
    if (!terminalAttempt) throw new Error('terminal opaque attempt fixture was not written');
    expect(await testDb().select().from(provider_attempt_admission)).toEqual([
      expect.objectContaining({
        attempt_id: terminalAttempt.attempt_id,
        mode: 'observe',
        status: 'released',
      }),
    ]);

    // When the production archive is built and restored over the same database.
    const bytes = await buildZipBytes();
    const archived = JSON.parse(new TextDecoder().decode(unzipSync(bytes)['data.json'])) as Record<
      string,
      Array<Record<string, unknown>>
    >;
    expect(archived.provider_attempt).toHaveLength(1);
    expect(archived.provider_attempt_admission).toBeUndefined();
    const restored = await restoreFromArchive({ db: testDb(), r2: memR2(), bytes });

    // Then opaque truth is byte-semantic complete, admission is wiped, and a later API search works without rewriting it.
    expect(restored.status).toBe(200);
    const restoredAttempt = await testDb()
      .select()
      .from(provider_attempt)
      .where(eq(provider_attempt.attempt_id, terminalAttempt.attempt_id));
    expect(restoredAttempt).toEqual([terminalAttempt]);
    expect(await testDb().select().from(provider_attempt_admission)).toEqual([]);
    const preservedBeforeSearch = restoredAttempt[0];
    const laterResult = await client.search(
      'later API query',
      { topK: 1 },
      createMem0OpaqueOperationContext({
        db: testDb(),
        caller: 'api',
        deadlineAt: new Date(Date.now() + 65_000),
        operationAnchor: 'later-api-search-852',
        mode: 'observe',
      }),
    );
    expect(laterResult.results?.[0]?.id).toBe('archive-memory-852');
    expect(
      await testDb()
        .select()
        .from(provider_attempt)
        .where(eq(provider_attempt.attempt_id, terminalAttempt.attempt_id)),
    ).toEqual([preservedBeforeSearch]);
  });
});
