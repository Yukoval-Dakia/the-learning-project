import { event, provider_attempt, provider_attempt_admission } from '@/db/schema';
import { eq, sql } from 'drizzle-orm';
import type { Job } from 'pg-boss';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import {
  createMem0OpaqueOperationContext,
  executeMem0OpaqueOperation,
} from '../ai/provider-attempt-runtime';
import { type Mem0Like, createMemoryClient } from './client';
import { buildMemoryEventIngestHandler } from './triggers';

const env = {
  DATABASE_URL: 'postgres://loom:secret@127.0.0.1:5433/loom_test?sslmode=disable',
  ZHIPU_API_KEY: 'fake-zhipu-key',
  DASHSCOPE_API_KEY: 'fake-dashscope-key',
};

function deterministicSendId(options: object): string | null {
  return 'id' in options && typeof options.id === 'string' ? options.id : null;
}

describe('Mem0 opaque provider-start fence', () => {
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

  it('admits one fenced opaque add and leaves the concurrent loser unreserved', async () => {
    const db = testDb();
    let releaseWinner = () => {};
    const winnerReleased = new Promise<void>((resolve) => {
      releaseWinner = resolve;
    });
    let reportWinnerHook = () => {};
    const winnerHookEntered = new Promise<void>((resolve) => {
      reportWinnerHook = resolve;
    });
    const winnerHook = vi.fn(async () => {
      reportWinnerHook();
      await winnerReleased;
    });
    const loserHook = vi.fn(async () => {});
    const winnerSdk = vi.fn(async () => 'winner');
    const loserSdk = vi.fn(async () => 'loser');
    const operation = {
      db,
      caller: 'worker' as const,
      deadlineAt: new Date(Date.now() + 65_000),
      operationAnchor: 'fenced-concurrent-add',
      mode: 'observe' as const,
    };
    const winner = executeMem0OpaqueOperation(
      createMem0OpaqueOperationContext(operation),
      'add_inferred',
      winnerSdk,
      {
        providerStartFence: 'operation_kind',
        afterProviderStartReserved: winnerHook,
      },
    );
    await winnerHookEntered;

    await expect(
      executeMem0OpaqueOperation(
        createMem0OpaqueOperationContext(operation),
        'add_inferred',
        loserSdk,
        {
          providerStartFence: 'operation_kind',
          afterProviderStartReserved: loserHook,
        },
      ),
    ).rejects.toMatchObject({ reason: 'active_duplicate' });
    releaseWinner();
    await expect(winner).resolves.toBe('winner');

    expect(winnerHook).toHaveBeenCalledOnce();
    expect(winnerSdk).toHaveBeenCalledOnce();
    expect(loserHook).not.toHaveBeenCalled();
    expect(loserSdk).not.toHaveBeenCalled();
    const attempts = await db.select().from(provider_attempt);
    expect(attempts).toHaveLength(2);
    expect(attempts.filter((attempt) => attempt.provider_start_reserved_at !== null)).toHaveLength(
      1,
    );
    expect(attempts.filter((attempt) => attempt.provider_start_reserved_at === null)).toHaveLength(
      1,
    );
  });

  it('keeps a hook failure ambiguous and requires recovery before another hook or SDK call', async () => {
    const db = testDb();
    const hookFailure = new Error('crash while writing add_started');
    const firstHook = vi.fn(async () => {
      throw hookFailure;
    });
    const firstSdk = vi.fn(async () => 'unreachable');
    const operation = {
      db,
      caller: 'worker' as const,
      deadlineAt: new Date(Date.now() + 65_000),
      operationAnchor: 'ambiguous-fenced-add',
      mode: 'observe' as const,
    };

    await expect(
      executeMem0OpaqueOperation(
        createMem0OpaqueOperationContext(operation),
        'add_verbatim',
        firstSdk,
        {
          providerStartFence: 'operation_kind',
          afterProviderStartReserved: firstHook,
        },
      ),
    ).rejects.toBe(hookFailure);
    const firstAttempt = (await db.select().from(provider_attempt))[0];
    expect(firstAttempt).toMatchObject({
      provider_start_reserved_at: expect.any(Date),
      terminal_status: null,
      finished_at: null,
    });
    expect(firstSdk).not.toHaveBeenCalled();
    if (!firstAttempt) throw new Error('expected the reserved provider attempt');
    await db
      .update(provider_attempt_admission)
      .set({
        lease_expires_at: sql`clock_timestamp() - interval '1 second'`,
        deadline_at: sql`clock_timestamp() - interval '1 second'`,
      })
      .where(eq(provider_attempt_admission.attempt_id, firstAttempt.attempt_id));
    const retryHook = vi.fn(async () => {});
    const retrySdk = vi.fn(async () => 'retry');

    await expect(
      executeMem0OpaqueOperation(
        createMem0OpaqueOperationContext(operation),
        'add_verbatim',
        retrySdk,
        {
          providerStartFence: 'operation_kind',
          afterProviderStartReserved: retryHook,
        },
      ),
    ).rejects.toMatchObject({ reason: 'recovery_required' });

    expect(firstHook).toHaveBeenCalledOnce();
    expect(retryHook).not.toHaveBeenCalled();
    expect(retrySdk).not.toHaveBeenCalled();
    const attempts = await db.select().from(provider_attempt);
    expect(attempts).toHaveLength(2);
    expect(attempts.filter((attempt) => attempt.provider_start_reserved_at !== null)).toHaveLength(
      1,
    );
    expect(attempts.filter((attempt) => attempt.provider_start_reserved_at === null)).toHaveLength(
      1,
    );
  });

  it('runs the edited-conjecture handler through the fenced verbatim provider boundary', async () => {
    const db = testDb();
    const add = vi.fn(async () => ({
      results: [{ id: 'verbatim-memory', memory: 'owner corrected fact' }],
    }));
    const memory: Mem0Like = {
      add,
      search: vi.fn(async () => ({ results: [] })),
      getAll: vi.fn(async () => ({ results: [] })),
      delete: vi.fn(async () => ({ message: 'ok' })),
      history: vi.fn(async () => []),
      get: vi.fn(async () => null),
    };
    const handler = buildMemoryEventIngestHandler(
      db,
      {
        send: vi.fn(async (_queue: string, _data: object, options: object) =>
          deterministicSendId(options),
        ),
      },
      {
        handoffMode: 'write',
        memoryClient: createMemoryClient({ env, memoryFactory: () => memory }),
        loadEvent: async () => ({
          id: 'edited-conjecture-fence',
          actor_kind: 'user',
          action: 'rate',
          subject_kind: 'event',
          subject_id: 'conjecture-fence',
          payload: {
            rating: 'accept',
            conjecture_id: 'conjecture-fence',
            corrected_by_owner: true,
            corrected_claim_md: 'owner corrected fact',
          },
          affected_scopes: [],
          created_at: new Date(1),
          kind: 'preference',
        }),
      },
    );
    const job: Job<{ event_id: string }> = {
      id: 'job:edited-conjecture-fence',
      name: 'memory_event_ingest',
      data: { event_id: 'edited-conjecture-fence' },
      expireInSeconds: 60,
      heartbeatSeconds: null,
      signal: new AbortController().signal,
    };

    await handler([job]);

    expect(add).toHaveBeenCalledWith(
      'owner corrected fact',
      expect.objectContaining({ infer: false }),
    );
    const attempts = await db.select().from(provider_attempt);
    expect(attempts).toEqual([
      expect.objectContaining({
        operation_kind: 'add_verbatim',
        provider_start_reserved_at: expect.any(Date),
        terminal_status: 'succeeded',
      }),
    ]);
    const handoffRows = await db
      .select({ payload: event.payload })
      .from(event)
      .where(eq(event.subject_id, 'edited-conjecture-fence'));
    expect(
      handoffRows.some(
        (row) =>
          row.payload &&
          typeof row.payload === 'object' &&
          'handoff_kind' in row.payload &&
          row.payload.handoff_kind === 'add_started',
      ),
    ).toBe(true);
  });
});
