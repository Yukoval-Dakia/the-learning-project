import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { event, provider_attempt, provider_attempt_admission } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import {
  createMem0OpaqueOperationContext,
  executeMem0OpaqueOperation,
} from '@/server/ai/provider-attempt-runtime';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { type Mem0Like, createMemoryClient } from './client';
import type { MemoryIngestReplayRequest } from './memory-ingest-recovery-contract';
import {
  assertMemoryIngestReplayGrant,
  authorizeMemoryIngestReplay,
  claimMemoryIngestReplay,
  listStalledMemoryIngests,
  memoryIngestReplayAnchor,
  memoryIngestReplayGrantId,
} from './memory-ingest-recovery-store';
import {
  claimMemoryIngest,
  memoryReconcileHandoffEventId,
  persistIngestCompleted,
} from './memory-reconcile-handoff-store';
import { buildMemoryEventIngestHandler } from './triggers';

async function stalledSource(sourceId = 'stalled-owner-event', actor: 'user' | 'agent' = 'user') {
  const db = testDb();
  await writeEvent(db, {
    id: sourceId,
    actor_kind: actor,
    actor_ref: 'owner',
    action: 'experimental:recovery_test_source',
    subject_kind: 'query',
    subject_id: 'query-recovery',
    outcome: 'success',
    ingest_at: new Date(),
    affected_scopes: ['topic:algebra', 'preference:learning'],
    payload: {
      tool_name: 'search',
      input: {
        query: 'Review the distinction between a necessary and a sufficient condition.',
        filters: { subjects: ['math', 'logic'], examples: ['A ⇒ B does not imply B ⇒ A.'] },
      },
    },
  });
  await claimMemoryIngest(db, sourceId);
  const markerId = memoryReconcileHandoffEventId('add_started', sourceId);
  await db
    .update(event)
    .set({ created_at: new Date(Date.now() - 180_000) })
    .where(eq(event.id, markerId));
  const request: MemoryIngestReplayRequest = {
    sourceEventId: sourceId,
    requestId: randomUUID(),
    expectedFenceId: markerId,
    operator: 'operator-test',
    reason:
      'Inspected ambiguous provider evidence; explicitly accept the single-event replay cost.',
    allowPaidReplay: true,
  };
  return request;
}

function providerBoundary() {
  const add = vi.fn(async () => ({
    results: [
      {
        id: 'recovered-fact',
        memory:
          'The owner asks to distinguish necessary from sufficient conditions; preserve the implication direction.',
      },
    ],
  }));
  const getAll = vi.fn(async () => ({ results: [] as { id: string; memory: string }[] }));
  const sdk: Mem0Like = {
    add,
    getAll,
    search: vi.fn(async () => ({ results: [] })),
    delete: vi.fn(async () => ({ message: 'ok' })),
    history: vi.fn(async () => []),
    get: vi.fn(async () => null),
  };
  const client = createMemoryClient({
    env: {
      DATABASE_URL: process.env.DATABASE_URL,
      ZHIPU_API_KEY: 'fake-test-key',
      DASHSCOPE_API_KEY: 'fake-test-key',
    },
    memoryFactory: () => sdk,
  });
  const boss = {
    send: vi.fn(async (_queue: string, _data: object, options: object) =>
      'id' in options && typeof options.id === 'string' ? options.id : null,
    ),
  };
  return { add, getAll, client, boss };
}

describe('explicit single-event memory ingest recovery', () => {
  beforeEach(async () => {
    vi.stubEnv('AI_PROVIDER_ATTEMPT_ADMISSION_MODE', 'off');
    await resetDb();
  });
  afterEach(() => vi.unstubAllEnvs());

  it('lists stalled evidence without content, then appends an idempotent grant without deleting its fence', async () => {
    const request = await stalledSource();
    expect(await listStalledMemoryIngests(testDb())).toMatchObject({
      candidates: [
        {
          sourceEventId: request.sourceEventId,
          expectedFenceId: request.expectedFenceId,
          liveAttempt: false,
        },
      ],
    });
    const grant = await authorizeMemoryIngestReplay(testDb(), request);
    expect(await authorizeMemoryIngestReplay(testDb(), request)).toEqual(grant);
    const rows = await testDb()
      .select()
      .from(event)
      .where(eq(event.subject_id, request.sourceEventId));
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === request.expectedFenceId)).toBeDefined();
    expect(rows.find((row) => row.id === memoryIngestReplayGrantId(grant))).toMatchObject({
      actor_kind: 'system',
      ingest_at: expect.any(Date),
      payload: grant,
    });
    expect(await listStalledMemoryIngests(testDb())).toMatchObject({
      candidates: [{ expectedFenceId: memoryIngestReplayGrantId(grant) }],
    });
    await expect(
      authorizeMemoryIngestReplay(testDb(), { ...request, reason: 'changed' }),
    ).rejects.toThrow(/conflicts/);
    const other = await stalledSource('other-source');
    await expect(
      authorizeMemoryIngestReplay(testDb(), { ...other, requestId: request.requestId }),
    ).rejects.toThrow(/conflicts/);
  });

  it('rejects stale concurrent authorizations and non-user or completed sources', async () => {
    const request = await stalledSource();
    const results = await Promise.allSettled([
      authorizeMemoryIngestReplay(testDb(), request),
      authorizeMemoryIngestReplay(testDb(), { ...request, requestId: randomUUID() }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    const agent = await stalledSource('agent-output', 'agent');
    await expect(authorizeMemoryIngestReplay(testDb(), agent)).rejects.toThrow(
      /existing user event/,
    );
    const completed = await stalledSource('already-completed');
    await persistIngestCompleted(testDb(), {
      sourceEventId: completed.sourceEventId,
      resolution: 'event_lookup',
      memories: [],
      persistIntents: true,
    });
    await expect(authorizeMemoryIngestReplay(testDb(), completed)).rejects.toThrow(/no stalled/);
    expect(
      (await listStalledMemoryIngests(testDb())).candidates.map((row) => row.sourceEventId),
    ).not.toContain(completed.sourceEventId);
  });

  it('rejects a recent marker and missing or forged grants before any external call', async () => {
    const request = await stalledSource();
    await testDb()
      .update(event)
      .set({ created_at: new Date() })
      .where(eq(event.id, request.expectedFenceId));
    await expect(authorizeMemoryIngestReplay(testDb(), request)).rejects.toThrow(/too recent/);
    const another = await stalledSource('valid-stalled');
    const grant = await authorizeMemoryIngestReplay(testDb(), another);
    const boundary = providerBoundary();
    const handler = buildMemoryEventIngestHandler(testDb(), boundary.boss, {
      memoryClient: boundary.client,
      replayGrant: { ...grant, reason: 'forged' },
    });
    await expect(handler([{ data: { event_id: another.sourceEventId } }])).rejects.toThrow(
      /missing or superseded/,
    );
    await expect(
      assertMemoryIngestReplayGrant(testDb(), grant, 'different-source'),
    ).rejects.toThrow(/source mismatch/);
    expect(boundary.getAll).not.toHaveBeenCalled();
    expect(boundary.add).not.toHaveBeenCalled();
  });

  it('does one fenced paid add for concurrent replay of a grant, preserving original evidence and normal retry behavior', async () => {
    const request = await stalledSource();
    const grant = await authorizeMemoryIngestReplay(testDb(), request);
    const boundary = providerBoundary();
    // Ordinary jobs do not discover or consume the explicit operator grant.
    await expect(
      buildMemoryEventIngestHandler(testDb(), boundary.boss, { memoryClient: boundary.client })([
        { data: { event_id: request.sourceEventId } },
      ]),
    ).rejects.toThrow(/incomplete or ambiguous/);
    expect(boundary.add).not.toHaveBeenCalled();
    const run = () =>
      buildMemoryEventIngestHandler(testDb(), boundary.boss, {
        memoryClient: boundary.client,
        replayGrant: grant,
        handoffMode: 'write',
      })([{ data: { event_id: request.sourceEventId } }]);
    const results = await Promise.allSettled([run(), run()]);
    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(boundary.add).toHaveBeenCalledOnce();
    const attempts = await testDb().select().from(provider_attempt);
    expect(attempts.filter((row) => row.terminal_status === 'succeeded')).toHaveLength(1);
    const records = await testDb()
      .select()
      .from(event)
      .where(eq(event.subject_id, request.sourceEventId));
    expect(
      records.filter((row) => row.payload?.handoff_kind === 'operator_add_started'),
    ).toHaveLength(1);
    expect(records.some((row) => row.id === request.expectedFenceId)).toBe(true);
    expect(records.some((row) => row.payload?.handoff_kind === 'ingest_completed')).toBe(true);
    expect(records.some((row) => row.payload?.handoff_kind === 'reconcile_dispatch_complete')).toBe(
      true,
    );
  });

  it('resolves by strict event lookup without using the authorized paid start', async () => {
    const request = await stalledSource();
    const grant = await authorizeMemoryIngestReplay(testDb(), request);
    const boundary = providerBoundary();
    boundary.getAll.mockResolvedValue({
      results: [
        { id: 'already-present', memory: 'A provider response was lost, but the fact is present.' },
      ],
    });
    await buildMemoryEventIngestHandler(testDb(), boundary.boss, {
      memoryClient: boundary.client,
      replayGrant: grant,
    })([{ data: { event_id: request.sourceEventId } }]);
    expect(boundary.getAll).toHaveBeenCalledWith({
      topK: 100,
      filters: { user_id: 'self', event_id: request.sourceEventId },
    });
    expect(boundary.add).not.toHaveBeenCalled();
    expect(await testDb().select().from(provider_attempt)).toHaveLength(0);
  });

  it('replays an owner-edited conjecture through the verbatim fence and preserves its projection identity', async () => {
    const request = await stalledSource('edited-owner-event');
    await testDb()
      .update(event)
      .set({
        action: 'rate',
        subject_kind: 'event',
        payload: {
          rating: 'accept',
          conjecture_id: 'conjecture-original',
          corrected_by_owner: true,
          corrected_claim_md:
            'Only infer an implication when its stated assumptions hold.\nKeep the counterexample and the qualifier.',
        },
      })
      .where(eq(event.id, request.sourceEventId));
    const grant = await authorizeMemoryIngestReplay(testDb(), request);
    const boundary = providerBoundary();
    await buildMemoryEventIngestHandler(testDb(), boundary.boss, {
      memoryClient: boundary.client,
      replayGrant: grant,
      handoffMode: 'write',
    })([{ data: { event_id: request.sourceEventId } }]);
    expect(boundary.add).toHaveBeenCalledOnce();
    expect(boundary.add).toHaveBeenCalledWith(
      expect.stringContaining('counterexample'),
      expect.objectContaining({
        infer: false,
        metadata: expect.objectContaining({
          event_id: request.sourceEventId,
          projection_key: `conjecture-edit:${request.sourceEventId}`,
        }),
      }),
    );
    expect(await testDb().select().from(provider_attempt)).toEqual([
      expect.objectContaining({
        operation_kind: 'add_verbatim',
        terminal_status: 'succeeded',
      }),
    ]);
  });

  it('rejects an original live reservation and advances a read-only cursor across completed markers', async () => {
    const request = await stalledSource('original-live');
    const sdk = vi.fn(async () => 'not called');
    await expect(
      executeMem0OpaqueOperation(
        createMem0OpaqueOperationContext({
          db: testDb(),
          caller: 'worker',
          mode: 'off',
          operationAnchor: request.sourceEventId,
          deadlineAt: new Date(Date.now() + 65_000),
        }),
        'add_inferred',
        sdk,
        {
          providerStartFence: 'operation_kind',
          afterProviderStartReserved: async () => {
            throw new Error('crash');
          },
        },
      ),
    ).rejects.toThrow('crash');
    await expect(authorizeMemoryIngestReplay(testDb(), request)).rejects.toThrow(/still live/);
    const completed = await stalledSource('completed-cursor');
    await persistIngestCompleted(testDb(), {
      sourceEventId: completed.sourceEventId,
      resolution: 'event_lookup',
      memories: [],
      persistIntents: false,
    });
    const all = await listStalledMemoryIngests(testDb());
    const collected = [];
    let after = '';
    do {
      const page = await listStalledMemoryIngests(testDb(), after, 1);
      collected.push(...page.candidates);
      after = page.nextAfterId ?? '';
    } while (after);
    expect(collected).toEqual(all.candidates);
    expect(collected).toHaveLength(1);
    expect(sdk).not.toHaveBeenCalled();
  });

  it('keeps a reserved-before-marker crash fenced; an explicitly superseding grant rejects the old callback', async () => {
    const request = await stalledSource();
    const grant = await authorizeMemoryIngestReplay(testDb(), request);
    const sdk = vi.fn(async () => 'unreachable');
    const operation = createMem0OpaqueOperationContext({
      db: testDb(),
      caller: 'worker',
      mode: 'off',
      operationAnchor: memoryIngestReplayAnchor(grant, request.sourceEventId),
      deadlineAt: new Date(Date.now() + 65_000),
    });
    await expect(
      executeMem0OpaqueOperation(operation, 'add_inferred', sdk, {
        providerStartFence: 'operation_kind',
        afterProviderStartReserved: async () => {
          throw new Error('marker write crash');
        },
      }),
    ).rejects.toThrow('marker write crash');
    const nextRequest = {
      ...request,
      requestId: randomUUID(),
      expectedFenceId: memoryIngestReplayGrantId(grant),
    };
    await expect(authorizeMemoryIngestReplay(testDb(), nextRequest)).rejects.toThrow(/still live/);
    expect((await listStalledMemoryIngests(testDb())).candidates[0]?.liveAttempt).toBe(true);
    await testDb().update(provider_attempt_admission).set({
      lease_expires_at: sql`clock_timestamp() - interval '1 second'`,
      deadline_at: sql`clock_timestamp() - interval '1 second'`,
    });
    await expect(
      executeMem0OpaqueOperation(
        { ...operation, deadlineAt: new Date(Date.now() + 65_000) },
        'add_inferred',
        sdk,
        {
          providerStartFence: 'operation_kind',
          afterProviderStartReserved: () =>
            claimMemoryIngestReplay(testDb(), grant, request.sourceEventId),
        },
      ),
    ).rejects.toMatchObject({ reason: 'recovery_required' });
    const nextGrant = await authorizeMemoryIngestReplay(testDb(), nextRequest);
    await expect(claimMemoryIngestReplay(testDb(), grant, request.sourceEventId)).rejects.toThrow(
      /superseded/,
    );
    await expect(
      claimMemoryIngestReplay(testDb(), nextGrant, request.sourceEventId),
    ).resolves.toBeUndefined();
    await expect(
      claimMemoryIngestReplay(testDb(), nextGrant, request.sourceEventId),
    ).rejects.toThrow(/already started/);
    expect(sdk).not.toHaveBeenCalled();
  });
});
