import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { provider_attempt } from '@/db/schema';
import { resetDb, testDb } from '../../../tests/helpers/db';
import {
  createMem0OpaqueOperationContext,
  executeMem0OpaqueOperation,
} from '../ai/provider-attempt-runtime';

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
});
