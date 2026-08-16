import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ProviderAttemptTerminalEvidence,
  ProviderRequestIdentity,
} from '@/core/schema/provider-attempt';
import type { Db } from '@/db/client';
import * as schema from '@/db/schema';
import { provider_attempt, provider_attempt_admission } from '@/db/schema';
import { resetDb, testDb } from '../../../tests/helpers/db';
import {
  type DirectProviderAttemptControl,
  createDirectProviderOperationContext,
  executeDirectProviderAttempt,
} from './direct-provider-attempt';
import {
  createMem0OpaqueOperationContext,
  executeMem0OpaqueOperation,
} from './opaque-provider-operation';
import { createProviderAttemptLifecycle } from './provider-attempt-lifecycle';

interface IndependentDb {
  readonly db: Db;
  close(): Promise<void>;
}

const opened: IndependentDb[] = [];

function openIndependentDb(): IndependentDb {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL not set');
  const client = postgres(url, { max: 1 });
  const handle: IndependentDb = {
    db: drizzle(client, { schema }),
    close: () => client.end(),
  };
  opened.push(handle);
  return handle;
}

const identity = (attemptId: string, caller: 'api' | 'worker' = 'api') =>
  ProviderRequestIdentity.parse({
    attemptId,
    operationId: '00000000-0000-4000-8000-000000000852',
    attemptKind: 'wire',
    provider: 'xiaomi',
    model: 'mimo-v2.5',
    lane: 'generation',
    protocol: 'anthropic-compatible',
    endpointClass: 'messages',
    caller,
    operationKind: 'QuestionGenerateTask',
  });

const identityForOperation = (attemptId: string, operationId: string) =>
  ProviderRequestIdentity.parse({ ...identity(attemptId), operationId });

const unknownEvidence = {
  terminal: 'unknown' as const,
  reason: 'provider did not expose terminal accounting',
  wireCount: null,
  usage: {
    basis: 'unknown' as const,
    unit: null,
    input: null,
    output: null,
    total: null,
    source: 'provider:no-usage',
  },
  cost: {
    basis: 'unknown' as const,
    amount: null,
    currency: null,
    source: 'pricebook:no-entry',
  },
};

beforeEach(async () => {
  await resetDb();
});

afterEach(async () => {
  await Promise.all(opened.splice(0).map((handle) => handle.close()));
});

describe('ProviderAttemptLifecycle', () => {
  it.each(['api', 'worker'] as const)(
    'keeps admission off for a %s-shaped call while persisting attempt and cost truth',
    async (caller) => {
      const providerCall = vi.fn(async (attempt: DirectProviderAttemptControl) => {
        attempt.reportUsage({ input: 12, output: 3, total: 15 });
        attempt.estimateCost({ amount: 0.0015, currency: 'CNY', source: 'test-pricebook' });
        return 'provider-result';
      });
      const context = createDirectProviderOperationContext({
        db: testDb(),
        caller,
        deadlineAt: new Date(Date.now() + 60_000),
        env: {},
        operationAnchor: `off-${caller}-provider-operation`,
      });

      const result = await executeDirectProviderAttempt(
        context,
        {
          provider: 'glm',
          model: 'glm-test',
          lane: 'glm.memory-reconcile',
          protocol: 'http',
          endpointClass: 'openai-compatible.chat-completions',
          operationKind: 'memory_reconcile',
          unknownCostCurrency: 'CNY',
        },
        providerCall,
      );

      expect(result.value).toBe('provider-result');
      expect(providerCall).toHaveBeenCalledOnce();
      const attempts = await testDb().select().from(provider_attempt);
      const admissions = await testDb().select().from(provider_attempt_admission);
      expect(attempts).toEqual([
        expect.objectContaining({
          attempt_id: result.attemptId,
          caller,
          terminal_status: 'succeeded',
          wire_count: 1,
          cost_basis: 'estimated',
          cost_amount: 0.0015,
          cost_currency: 'CNY',
        }),
      ]);
      expect(admissions).toEqual([
        expect.objectContaining({
          attempt_id: result.attemptId,
          mode: 'off',
          status: 'released',
          terminal_reason: 'attempt_finished',
        }),
      ]);
    },
  );

  it('persists an elapsed off attempt as acquired and never records would-deny', async () => {
    const attemptId = '00000000-0000-4000-8000-000000000964';
    const deadlineAt = new Date(Date.now() - 1_000);
    const handle = await createProviderAttemptLifecycle({
      mode: 'off',
      persistAttemptWhenOff: true,
      identity: identity(attemptId),
      deadlineAt,
      db: testDb(),
    }).acquire();

    expect(handle.admission).toBe('acquired');
    const activeAdmission = (
      await testDb()
        .select()
        .from(provider_attempt_admission)
        .where(eq(provider_attempt_admission.attempt_id, attemptId))
    )[0];
    expect(activeAdmission).toMatchObject({
      mode: 'off',
      status: 'acquired',
      terminal_reason: null,
    });
    expect(activeAdmission?.lease_expires_at?.getTime()).toBeGreaterThan(deadlineAt.getTime());

    await expect(handle.reserveProviderStart()).resolves.toBeUndefined();
    await expect(handle.finish(unknownEvidence)).resolves.toBe('settled');
    expect(
      (
        await testDb()
          .select()
          .from(provider_attempt_admission)
          .where(eq(provider_attempt_admission.attempt_id, attemptId))
      )[0],
    ).toMatchObject({ mode: 'off', status: 'released', terminal_reason: 'attempt_finished' });
    expect(
      await testDb()
        .select()
        .from(provider_attempt_admission)
        .where(eq(provider_attempt_admission.status, 'would_deny')),
    ).toEqual([]);
  });

  it('lets a default-off direct provider call proceed untracked when its control plane is unavailable', async () => {
    const unavailable = openIndependentDb();
    await unavailable.close();
    opened.splice(0);
    const providerCall = vi.fn(async () => 'direct-result');
    const context = createDirectProviderOperationContext({
      db: unavailable.db,
      caller: 'worker',
      deadlineAt: new Date(Date.now() + 60_000),
      env: {},
      operationAnchor: 'default-off-unavailable-direct',
    });

    await expect(
      executeDirectProviderAttempt(
        context,
        {
          provider: 'glm',
          model: 'glm-test',
          lane: 'glm.memory-reconcile',
          protocol: 'http',
          endpointClass: 'openai-compatible.chat-completions',
          operationKind: 'memory_reconcile',
          unknownCostCurrency: 'CNY',
        },
        providerCall,
      ),
    ).resolves.toMatchObject({ value: 'direct-result' });
    expect(providerCall).toHaveBeenCalledOnce();
  });

  it('executes and durably settles a default-off opaque provider operation', async () => {
    const providerCall = vi.fn(async () => 'opaque-result');
    const context = createMem0OpaqueOperationContext({
      db: testDb(),
      caller: 'worker',
      deadlineAt: new Date(Date.now() + 60_000),
      env: {},
      operationAnchor: 'default-off-durable-opaque',
    });

    await expect(executeMem0OpaqueOperation(context, 'search', providerCall)).resolves.toBe(
      'opaque-result',
    );
    expect(providerCall).toHaveBeenCalledOnce();
    expect(await testDb().select().from(provider_attempt_admission)).toEqual([
      expect.objectContaining({
        mode: 'off',
        status: 'released',
        terminal_reason: 'attempt_finished',
      }),
    ]);
  });

  it('lets a default-off opaque provider call proceed untracked when its control plane is unavailable', async () => {
    const unavailable = openIndependentDb();
    await unavailable.close();
    opened.splice(0);
    const providerCall = vi.fn(async () => 'opaque-result');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const context = createMem0OpaqueOperationContext({
      db: unavailable.db,
      caller: 'api',
      deadlineAt: new Date(Date.now() + 60_000),
      env: {},
      operationAnchor: 'default-off-unavailable-opaque',
    });

    try {
      await expect(executeMem0OpaqueOperation(context, 'search', providerCall)).resolves.toBe(
        'opaque-result',
      );
      expect(providerCall).toHaveBeenCalledOnce();
      expect(errorSpy).toHaveBeenCalledWith(
        '[mem0-provider-operation] terminal settlement failed; preserving provider outcome',
        expect.objectContaining({ settlementReason: 'finish_untracked' }),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it.each(['api', 'worker'] as const)(
    'acquires and atomically settles a %s attempt',
    async (caller) => {
      // Given a public lifecycle with a live deadline.
      const lifecycle = createProviderAttemptLifecycle({
        mode: 'enforce',
        identity: identity(
          `00000000-0000-4000-8000-00000000085${caller === 'api' ? '3' : '4'}`,
          caller,
        ),
        deadlineAt: new Date(Date.now() + 60_000),
        db: testDb(),
      });

      // When its attempt is acquired and finished.
      const handle = await lifecycle.acquire();
      await handle.reserveProviderStart();
      const result = await handle.finish(unknownEvidence);

      // Then durable attempt truth and released ownership are visible together.
      expect(handle.admission).toBe('acquired');
      expect(result).toBe('settled');
      const attempts = await testDb()
        .select()
        .from(provider_attempt)
        .where(eq(provider_attempt.attempt_id, lifecycle.identity.attemptId));
      const admissions = await testDb()
        .select()
        .from(provider_attempt_admission)
        .where(eq(provider_attempt_admission.attempt_id, lifecycle.identity.attemptId));
      expect(attempts[0]).toMatchObject({
        caller,
        terminal_status: 'unknown',
        terminal_reason: unknownEvidence.reason,
        wire_count: null,
        cost_basis: 'unknown',
        cost_amount: null,
      });
      expect(admissions[0]).toMatchObject({
        status: 'released',
        terminal_reason: 'attempt_finished',
      });
    },
  );

  it('settles a current pre-start owner when local failure occurs before reservation', async () => {
    // Given an acquired attempt whose provider-start right was never reserved.
    const attemptId = '00000000-0000-4000-8000-000000000903';
    const handle = await createProviderAttemptLifecycle({
      mode: 'enforce',
      identity: identity(attemptId),
      deadlineAt: new Date(Date.now() + 60_000),
      db: testDb(),
    }).acquire();

    // When the current owner records a local abort before any provider start.
    const result = await handle.finish({
      ...unknownEvidence,
      terminal: 'aborted',
      reason: 'local validation failed before provider start',
    });

    // Then the attempt settles without fabricating a start reservation.
    expect(result).toBe('settled');
    expect((await testDb().select().from(provider_attempt))[0]).toMatchObject({
      provider_start_reserved_at: null,
      terminal_status: 'aborted',
      terminal_reason: 'local validation failed before provider start',
    });
    expect((await testDb().select().from(provider_attempt_admission))[0]).toMatchObject({
      status: 'released',
      terminal_reason: 'attempt_finished',
    });
  });

  it('keeps acquire idempotent on one lifecycle and rejects an independently owned active duplicate', async () => {
    // Given two independent clients for one attempt identity.
    const firstDb = openIndependentDb();
    const secondDb = openIndependentDb();
    const attemptIdentity = identity('00000000-0000-4000-8000-000000000855');
    const deadlineAt = new Date(Date.now() + 60_000);
    const first = createProviderAttemptLifecycle({
      mode: 'enforce',
      identity: attemptIdentity,
      deadlineAt,
      db: firstDb.db,
    });
    const second = createProviderAttemptLifecycle({
      mode: 'enforce',
      identity: attemptIdentity,
      deadlineAt,
      db: secondDb.db,
    });

    // When the independent owners race acquisition.
    const results = await Promise.allSettled([first.acquire(), second.acquire()]);

    // Then exactly one owns the lease and its repeated acquire returns the same handle.
    const winner = results.find((result) => result.status === 'fulfilled');
    const loser = results.find((result) => result.status === 'rejected');
    expect(winner?.status).toBe('fulfilled');
    expect(loser).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ reason: 'active_duplicate' }),
    });
    if (winner?.status !== 'fulfilled') throw new Error('expected one acquired lifecycle');
    const owningLifecycle = results[0].status === 'fulfilled' ? first : second;
    expect(await owningLifecycle.acquire()).toBe(winner.value);
  });

  it('allows expired takeover, fences the old owner, and does not terminalize on expiry alone', async () => {
    // Given an acquired attempt whose lease is expired without a terminal attempt.
    const attemptId = '00000000-0000-4000-8000-000000000856';
    const deadlineAt = new Date(Date.now() + 60_000);
    const oldLifecycle = createProviderAttemptLifecycle({
      mode: 'enforce',
      identity: identity(attemptId),
      deadlineAt,
      db: testDb(),
    });
    const oldHandle = await oldLifecycle.acquire();
    await testDb().execute(sql`UPDATE provider_attempt_admission
      SET lease_expires_at = clock_timestamp() - interval '1 second'
      WHERE attempt_id = ${attemptId}`);
    const beforeTakeover = await testDb()
      .select({ finishedAt: provider_attempt.finished_at })
      .from(provider_attempt)
      .where(eq(provider_attempt.attempt_id, attemptId));

    // When a new owner takes over the expired lease.
    const newLifecycle = createProviderAttemptLifecycle({
      mode: 'enforce',
      identity: identity(attemptId),
      deadlineAt,
      db: openIndependentDb().db,
    });
    const newHandle = await newLifecycle.acquire();

    // Then expiry was nonterminal, the old owner is fenced, and the new owner can settle.
    expect(beforeTakeover[0]?.finishedAt).toBeNull();
    await expect(oldHandle.reserveProviderStart()).rejects.toMatchObject({
      reason: 'lease_lost',
    });
    await newHandle.reserveProviderStart();
    await expect(newHandle.finish(unknownEvidence)).resolves.toBe('settled');
    await expect(oldHandle.finish(unknownEvidence)).rejects.toMatchObject({ reason: 'lease_lost' });
  });

  it('lets an expired owner settle when no takeover occurred', async () => {
    // Given an expired lease with its original owner still recorded.
    const attemptId = '00000000-0000-4000-8000-000000000857';
    const lifecycle = createProviderAttemptLifecycle({
      mode: 'enforce',
      identity: identity(attemptId),
      deadlineAt: new Date(Date.now() + 60_000),
      db: testDb(),
    });
    const handle = await lifecycle.acquire();
    await handle.reserveProviderStart();
    await testDb().execute(sql`UPDATE provider_attempt_admission
      SET lease_expires_at = clock_timestamp() - interval '1 second'
      WHERE attempt_id = ${attemptId}`);

    // When the original owner finishes without any takeover.
    const result = await handle.finish(unknownEvidence);

    // Then settlement succeeds despite elapsed lease time.
    expect(result).toBe('settled');
  });

  it('denies enforce after deadline, observes would-deny, and keeps off free of SQL rows', async () => {
    // Given elapsed deadlines in each policy mode.
    const enforceId = '00000000-0000-4000-8000-000000000858';
    const observeId = '00000000-0000-4000-8000-000000000859';
    const offId = '00000000-0000-4000-8000-000000000860';
    const past = new Date(Date.now() - 1_000);

    // When each lifecycle acquires.
    await expect(
      createProviderAttemptLifecycle({
        mode: 'enforce',
        identity: identity(enforceId),
        deadlineAt: past,
        db: testDb(),
      }).acquire(),
    ).rejects.toMatchObject({ reason: 'deadline_elapsed' });
    const observed = await createProviderAttemptLifecycle({
      mode: 'observe',
      identity: identity(observeId),
      deadlineAt: past,
      db: testDb(),
    }).acquire();
    const off = await createProviderAttemptLifecycle({
      mode: 'off',
      identity: identity(offId),
      deadlineAt: past,
      db: testDb(),
    }).acquire();

    // Then enforce persists only denial, observe persists an attempt, and off persists nothing.
    expect(observed.admission).toBe('would_deny');
    await expect(observed.reserveProviderStart()).resolves.toBeUndefined();
    await expect(observed.finish(unknownEvidence)).resolves.toBe('settled');
    expect(off.admission).toBe('off');
    expect(await off.finish(unknownEvidence)).toBe('untracked');
    const attempts = await testDb().select().from(provider_attempt);
    const admissions = await testDb().select().from(provider_attempt_admission);
    expect(attempts.map((row) => row.attempt_id)).toEqual([observeId]);
    expect(admissions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ attempt_id: enforceId, status: 'denied' }),
        expect.objectContaining({ attempt_id: observeId, status: 'released' }),
      ]),
    );
    expect(admissions.some((row) => row.attempt_id === offId)).toBe(false);
  });

  it('keeps observe start permissive after its acquired deadline elapses', async () => {
    // Given observe acquired after its hard deadline as a would-deny lease.
    const attemptId = '00000000-0000-4000-8000-000000000868';
    const deadlineAt = new Date(Date.now() - 1_000);
    const lifecycle = createProviderAttemptLifecycle({
      mode: 'observe',
      identity: identity(attemptId),
      deadlineAt,
      db: testDb(),
    });
    const handle = await lifecycle.acquire();

    // When start is reserved after the DB deadline, Then observe still permits and can settle.
    await expect(handle.reserveProviderStart()).resolves.toBeUndefined();
    await expect(
      createProviderAttemptLifecycle({
        mode: 'enforce',
        identity: lifecycle.identity,
        deadlineAt,
        db: openIndependentDb().db,
      }).acquire(),
    ).rejects.toMatchObject({ reason: 'recovery_required' });
    await expect(handle.finish(unknownEvidence)).resolves.toBe('settled');
  });

  it('rejects immutable identity collisions after lease expiry', async () => {
    // Given an expired durable attempt identity.
    const attemptId = '00000000-0000-4000-8000-000000000861';
    await createProviderAttemptLifecycle({
      mode: 'enforce',
      identity: identity(attemptId),
      deadlineAt: new Date(Date.now() + 60_000),
      db: testDb(),
    }).acquire();
    await testDb().execute(sql`UPDATE provider_attempt_admission
      SET lease_expires_at = clock_timestamp() - interval '1 second'
      WHERE attempt_id = ${attemptId}`);

    // When another lifecycle reuses the id for another provider.
    const collision = createProviderAttemptLifecycle({
      mode: 'observe',
      identity: { ...identity(attemptId), provider: 'anthropic' },
      deadlineAt: new Date(Date.now() + 60_000),
      db: openIndependentDb().db,
    });

    // Then observe mode still fails closed on identity collision.
    await expect(collision.acquire()).rejects.toMatchObject({ reason: 'identity_collision' });
  });

  it('records an external id once and rejects conflicting CAS', async () => {
    // Given an acquired provider attempt.
    const attemptId = '00000000-0000-4000-8000-000000000862';
    const handle = await createProviderAttemptLifecycle({
      mode: 'enforce',
      identity: identity(attemptId),
      deadlineAt: new Date(Date.now() + 60_000),
      db: testDb(),
    }).acquire();
    await testDb().execute(sql`UPDATE provider_attempt_admission
      SET lease_expires_at = clock_timestamp() - interval '1 second'
      WHERE attempt_id = ${attemptId}`);

    // When the current owner binds after expiry and replays identically, then differently.
    await handle.recordExternalRequestId('provider-request-862');
    await handle.recordExternalRequestId('provider-request-862');

    // Then the identical replay is accepted and the conflicting value is rejected.
    await expect(handle.recordExternalRequestId('provider-request-other')).rejects.toMatchObject({
      reason: 'external_request_id_conflict',
    });
  });

  it('CAS-binds an initial external id during expired takeover and rejects conflicts', async () => {
    // Given an expired attempt whose durable external request id is still null.
    const attemptId = '00000000-0000-4000-8000-000000000869';
    const deadlineAt = new Date(Date.now() + 60_000);
    const first = await createProviderAttemptLifecycle({
      mode: 'enforce',
      identity: identity(attemptId),
      deadlineAt,
      db: testDb(),
    }).acquire();
    await testDb().execute(sql`UPDATE provider_attempt_admission
      SET lease_expires_at = clock_timestamp() - interval '1 second'
      WHERE attempt_id = ${attemptId}`);

    // When takeover supplies an initial external id, it is bound before acquire returns.
    await createProviderAttemptLifecycle({
      mode: 'enforce',
      identity: { ...identity(attemptId), externalRequestId: 'provider-request-869' },
      deadlineAt,
      db: openIndependentDb().db,
    }).acquire();
    expect(
      (
        await testDb()
          .select({ externalRequestId: provider_attempt.external_request_id })
          .from(provider_attempt)
          .where(eq(provider_attempt.attempt_id, attemptId))
      )[0]?.externalRequestId,
    ).toBe('provider-request-869');
    await expect(first.recordExternalRequestId('old-owner-value')).rejects.toMatchObject({
      reason: 'lease_lost',
    });
    await testDb().execute(sql`UPDATE provider_attempt_admission
      SET lease_expires_at = clock_timestamp() - interval '1 second'
      WHERE attempt_id = ${attemptId}`);

    // Then identical takeover replay succeeds, but a later conflicting value fails closed.
    await createProviderAttemptLifecycle({
      mode: 'enforce',
      identity: { ...identity(attemptId), externalRequestId: 'provider-request-869' },
      deadlineAt,
      db: openIndependentDb().db,
    }).acquire();
    await testDb().execute(sql`UPDATE provider_attempt_admission
      SET lease_expires_at = clock_timestamp() - interval '1 second'
      WHERE attempt_id = ${attemptId}`);
    await expect(
      createProviderAttemptLifecycle({
        mode: 'observe',
        identity: { ...identity(attemptId), externalRequestId: 'provider-request-conflict' },
        deadlineAt,
        db: openIndependentDb().db,
      }).acquire(),
    ).rejects.toMatchObject({ reason: 'external_request_id_conflict' });
  });

  it.each([
    ['enforce', null, '00000000-0000-4000-8000-000000000870'],
    ['observe', 'orphan-request', '00000000-0000-4000-8000-000000000871'],
  ] as const)(
    'fails %s closed when a nonterminal durable attempt is missing admission',
    async (mode, externalRequestId, attemptId) => {
      // Given a restored durable attempt whose wipe-only admission row is absent.
      await testDb()
        .insert(provider_attempt)
        .values({
          attempt_id: attemptId,
          operation_id: identity(attemptId).operationId,
          attempt_kind: 'wire',
          provider: 'xiaomi',
          model: 'mimo-v2.5',
          lane_id: 'generation',
          protocol: 'anthropic-compatible',
          endpoint_class: 'messages',
          caller: 'api',
          operation_kind: 'QuestionGenerateTask',
          external_request_id: externalRequestId,
          started_at: new Date('2026-01-01T00:00:00.000Z'),
        });
      const before = await testDb()
        .select()
        .from(provider_attempt)
        .where(eq(provider_attempt.attempt_id, attemptId));

      // When reacquisition is attempted, Then recovery is required without mutation/recreation.
      await expect(
        createProviderAttemptLifecycle({
          mode,
          identity: {
            ...identity(attemptId),
            ...(externalRequestId === null ? {} : { externalRequestId }),
          },
          deadlineAt: new Date(Date.now() + 60_000),
          db: openIndependentDb().db,
        }).acquire(),
      ).rejects.toMatchObject({ reason: 'recovery_required' });
      expect(
        await testDb()
          .select()
          .from(provider_attempt)
          .where(eq(provider_attempt.attempt_id, attemptId)),
      ).toEqual(before);
      expect(
        await testDb()
          .select()
          .from(provider_attempt_admission)
          .where(eq(provider_attempt_admission.attempt_id, attemptId)),
      ).toEqual([]);
    },
  );

  it('returns already_settled for identical evidence and rejects terminal conflicts and reuse', async () => {
    // Given a settled attempt.
    const attemptId = '00000000-0000-4000-8000-000000000863';
    const deadlineAt = new Date(Date.now() + 60_000);
    const lifecycle = createProviderAttemptLifecycle({
      mode: 'enforce',
      identity: identity(attemptId),
      deadlineAt,
      db: testDb(),
    });
    const handle = await lifecycle.acquire();
    await handle.reserveProviderStart();
    await handle.finish(unknownEvidence);

    // When finish is replayed identically or with different evidence.
    const replay = await handle.finish(unknownEvidence);

    // Then identical replay is idempotent and terminal reuse wins even if the deadline changed.
    expect(replay).toBe('already_settled');
    await expect(handle.finish({ ...unknownEvidence, reason: 'different' })).rejects.toMatchObject({
      reason: 'terminal_conflict',
    });
    await expect(
      createProviderAttemptLifecycle({
        mode: 'enforce',
        identity: identity(attemptId),
        deadlineAt: new Date(deadlineAt.getTime() + 1),
        db: openIndependentDb().db,
      }).acquire(),
    ).rejects.toMatchObject({ reason: 'terminal_reuse' });
  });

  it('enforces opaque wire truth and persists explicit known zero cost', async () => {
    // Given an opaque operation and a wire attempt.
    const opaque = await createProviderAttemptLifecycle({
      mode: 'enforce',
      identity: {
        ...identity('00000000-0000-4000-8000-000000000864'),
        attemptKind: 'opaque_operation',
      },
      deadlineAt: new Date(Date.now() + 60_000),
      db: testDb(),
    }).acquire();
    const wire = await createProviderAttemptLifecycle({
      mode: 'enforce',
      identity: identity('00000000-0000-4000-8000-000000000865'),
      deadlineAt: new Date(Date.now() + 60_000),
      db: testDb(),
    }).acquire();
    await opaque.reserveProviderStart();
    await wire.reserveProviderStart();
    const knownZero = ProviderAttemptTerminalEvidence.parse({
      terminal: 'succeeded',
      reason: 'completed',
      wireCount: 1,
      usage: {
        basis: 'reported',
        unit: 'tokens',
        input: 0,
        output: null,
        total: null,
        source: 'sdk:usage',
      },
      cost: {
        basis: 'estimated',
        amount: 0,
        currency: 'USD',
        source: 'pricebook:v1',
      },
    });

    // When opaque evidence claims a wire and wire evidence reports known zero.
    await expect(opaque.finish(knownZero)).rejects.toMatchObject({ reason: 'opaque_wire_count' });
    await opaque.finish({ ...unknownEvidence, wireCount: null });
    await wire.finish(knownZero);

    // Then opaque remains null and known zero is durable rather than unknown.
    const rows = await testDb().select().from(provider_attempt);
    expect(rows.find((row) => row.attempt_id.endsWith('864'))?.wire_count).toBeNull();
    expect(rows.find((row) => row.attempt_id.endsWith('865'))).toMatchObject({
      cost_basis: 'estimated',
      cost_amount: 0,
      cost_currency: 'USD',
    });
  });

  it('canonicalizes mixed-case UUIDs before concurrent acquisition', async () => {
    // Given independent lifecycle inputs that differ only by UUID casing.
    const deadlineAt = new Date(Date.now() + 60_000);
    const lower = identity('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    const upper = ProviderRequestIdentity.parse({
      ...lower,
      attemptId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
      operationId: '00000000-0000-4000-8000-000000000852',
    });
    const first = createProviderAttemptLifecycle({
      mode: 'enforce',
      identity: lower,
      deadlineAt,
      db: openIndependentDb().db,
    });
    const second = createProviderAttemptLifecycle({
      mode: 'enforce',
      identity: upper,
      deadlineAt,
      db: openIndependentDb().db,
    });

    // When both acquire concurrently.
    const results = await Promise.allSettled([first.acquire(), second.acquire()]);

    // Then the canonical durable identity has exactly one owner.
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(await testDb().select().from(provider_attempt)).toHaveLength(1);
  });

  it('requires recovery after start reservation and lets the original owner finish after expiry', async () => {
    // Given a reserved provider start whose pre-start lease later expires.
    const attemptId = '00000000-0000-4000-8000-000000000898';
    const deadlineAt = new Date(Date.now() + 60_000);
    const first = await createProviderAttemptLifecycle({
      mode: 'enforce',
      identity: identity(attemptId),
      deadlineAt,
      db: testDb(),
    }).acquire();
    const reservation = first.reserveProviderStart();
    expect(first.reserveProviderStart()).toBe(reservation);
    await reservation;
    await testDb().execute(sql`UPDATE provider_attempt_admission
      SET lease_expires_at = clock_timestamp() - interval '1 second'
      WHERE attempt_id = ${attemptId}`);

    // When a distinct lifecycle tries to take over and the owner later finishes.
    const takeover = createProviderAttemptLifecycle({
      mode: 'enforce',
      identity: identity(attemptId),
      deadlineAt,
      db: openIndependentDb().db,
    });

    // Then takeover is permanently fenced while the original owner can settle.
    await expect(takeover.acquire()).rejects.toMatchObject({ reason: 'recovery_required' });
    await expect(first.finish(unknownEvidence)).resolves.toBe('settled');
  });

  it('rejects a changed absolute deadline without mutating either row', async () => {
    // Given an unreserved attempt with an immutable deadline.
    const attemptId = '00000000-0000-4000-8000-000000000899';
    const deadlineAt = new Date(Date.now() + 60_000);
    await createProviderAttemptLifecycle({
      mode: 'enforce',
      identity: identity(attemptId),
      deadlineAt,
      db: testDb(),
    }).acquire();
    const beforeAttempt = await testDb().select().from(provider_attempt);
    const beforeAdmission = await testDb().select().from(provider_attempt_admission);

    // When the same identity is presented with another absolute deadline.
    const mismatch = createProviderAttemptLifecycle({
      mode: 'enforce',
      identity: identity(attemptId),
      deadlineAt: new Date(deadlineAt.getTime() + 1),
      db: openIndependentDb().db,
    });

    // Then the typed mismatch occurs before any durable mutation.
    await expect(mismatch.acquire()).rejects.toMatchObject({ reason: 'deadline_mismatch' });
    expect(await testDb().select().from(provider_attempt)).toEqual(beforeAttempt);
    expect(await testDb().select().from(provider_attempt_admission)).toEqual(beforeAdmission);
  });

  it('persists an elapsed enforce denial without terminalizing the attempt', async () => {
    // Given an elapsed observe attempt that remains unreserved.
    const attemptId = '00000000-0000-4000-8000-000000000900';
    const deadlineAt = new Date(Date.now() - 1_000);
    const observed = await createProviderAttemptLifecycle({
      mode: 'observe',
      identity: identity(attemptId),
      deadlineAt,
      db: testDb(),
    }).acquire();

    // When enforce evaluates the same immutable elapsed deadline.
    const enforce = createProviderAttemptLifecycle({
      mode: 'enforce',
      identity: identity(attemptId),
      deadlineAt,
      db: openIndependentDb().db,
    });

    // Then it denies atomically, cannot reserve, and leaves attempt truth nonterminal.
    await expect(enforce.acquire()).rejects.toMatchObject({ reason: 'deadline_elapsed' });
    await expect(observed.reserveProviderStart()).rejects.toMatchObject({ reason: 'lease_lost' });
    expect((await testDb().select().from(provider_attempt))[0]).toMatchObject({
      terminal_status: null,
      finished_at: null,
      provider_start_reserved_at: null,
    });
    expect((await testDb().select().from(provider_attempt_admission))[0]).toMatchObject({
      status: 'denied',
      lease_owner: null,
      acquired_at: null,
      lease_expires_at: null,
      terminal_reason: 'deadline_elapsed',
    });
    await expect(
      createProviderAttemptLifecycle({
        mode: 'enforce',
        identity: identity(attemptId),
        deadlineAt,
        db: openIndependentDb().db,
      }).acquire(),
    ).rejects.toMatchObject({ reason: 'terminal_reuse' });
  });

  it('caps the pre-start lease at the immutable hard deadline', async () => {
    // Given a hard deadline shorter than the normal pre-start lease.
    const attemptId = '00000000-0000-4000-8000-000000000901';
    const deadlineAt = new Date(Date.now() + 5_000);

    // When enforce acquires the attempt.
    await createProviderAttemptLifecycle({
      mode: 'enforce',
      identity: identity(attemptId),
      deadlineAt,
      db: testDb(),
    }).acquire();

    // Then its lease cannot exceed the absolute deadline.
    const row = (await testDb().select().from(provider_attempt_admission))[0];
    expect(row?.lease_expires_at?.getTime()).toBeLessThanOrEqual(deadlineAt.getTime());
  });

  it('rolls back attempt settlement when admission release fails', async () => {
    // Given a reserved attempt and a temporary trigger that rejects admission release.
    const attemptId = '00000000-0000-4000-8000-000000000902';
    const handle = await createProviderAttemptLifecycle({
      mode: 'enforce',
      identity: identity(attemptId),
      deadlineAt: new Date(Date.now() + 60_000),
      db: testDb(),
    }).acquire();
    await handle.reserveProviderStart();
    await testDb().execute(sql`CREATE FUNCTION yuk851_reject_release() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'reject release'; END $$`);
    await testDb().execute(sql`CREATE TRIGGER yuk851_reject_release
      BEFORE UPDATE ON provider_attempt_admission
      FOR EACH ROW WHEN (NEW.status = 'released') EXECUTE FUNCTION yuk851_reject_release()`);

    try {
      // When finish reaches the admission release write.
      await expect(handle.finish(unknownEvidence)).rejects.toMatchObject({
        reason: 'control_plane_unavailable',
      });

      // Then the attempt update and admission update both rolled back.
      expect((await testDb().select().from(provider_attempt))[0]).toMatchObject({
        terminal_status: null,
        finished_at: null,
      });
      expect((await testDb().select().from(provider_attempt_admission))[0]).toMatchObject({
        status: 'acquired',
      });
    } finally {
      await testDb().execute(sql`DROP TRIGGER IF EXISTS yuk851_reject_release
        ON provider_attempt_admission`);
      await testDb().execute(sql`DROP FUNCTION IF EXISTS yuk851_reject_release()`);
    }
  });

  it('observe records capacity would-deny while allowing a second provider start', async () => {
    const policy = { maxConcurrentAttempts: 1, maxAttemptStartsPerMinute: 10 };
    const first = await createProviderAttemptLifecycle({
      mode: 'observe',
      policy,
      identity: identity('00000000-0000-4000-8000-000000000920'),
      deadlineAt: new Date(Date.now() + 60_000),
      db: testDb(),
    }).acquire();
    await first.reserveProviderStart();

    const second = await createProviderAttemptLifecycle({
      mode: 'observe',
      policy,
      identity: identity('00000000-0000-4000-8000-000000000921'),
      deadlineAt: new Date(Date.now() + 60_000),
      db: testDb(),
    }).acquire();

    expect(second.admission).toBe('would_deny');
    await expect(second.reserveProviderStart()).resolves.toBeUndefined();
  });

  it('enforce rejects capacity and rate before provider start reservation', async () => {
    const capacityPolicy = { maxConcurrentAttempts: 1, maxAttemptStartsPerMinute: 10 };
    const first = await createProviderAttemptLifecycle({
      mode: 'enforce',
      policy: capacityPolicy,
      identity: identity('00000000-0000-4000-8000-000000000922'),
      deadlineAt: new Date(Date.now() + 60_000),
      db: testDb(),
    }).acquire();
    await first.reserveProviderStart();
    await expect(
      createProviderAttemptLifecycle({
        mode: 'enforce',
        policy: capacityPolicy,
        identity: identity('00000000-0000-4000-8000-000000000923'),
        deadlineAt: new Date(Date.now() + 60_000),
        db: testDb(),
      }).acquire(),
    ).rejects.toMatchObject({ reason: 'capacity_exhausted' });
    await first.finish(unknownEvidence);

    const rateLimited = await createProviderAttemptLifecycle({
      mode: 'enforce',
      policy: { maxConcurrentAttempts: 10, maxAttemptStartsPerMinute: 1 },
      identity: identity('00000000-0000-4000-8000-000000000924'),
      deadlineAt: new Date(Date.now() + 60_000),
      db: testDb(),
    }).acquire();
    await expect(rateLimited.reserveProviderStart()).rejects.toMatchObject({
      reason: 'rate_exhausted',
    });
    expect(
      await testDb()
        .select()
        .from(provider_attempt)
        .where(eq(provider_attempt.attempt_id, '00000000-0000-4000-8000-000000000923')),
    ).toHaveLength(0);
  });

  it.each(['observe', 'enforce'] as const)(
    'excludes live and recent off rows from %s policy accounting',
    async (mode) => {
      const liveOff = await createProviderAttemptLifecycle({
        mode: 'off',
        persistAttemptWhenOff: true,
        identity: identity('00000000-0000-4000-8000-000000000965'),
        deadlineAt: new Date(Date.now() + 60_000),
        db: testDb(),
      }).acquire();
      await liveOff.reserveProviderStart();
      const recentOff = await createProviderAttemptLifecycle({
        mode: 'off',
        persistAttemptWhenOff: true,
        identity: identity('00000000-0000-4000-8000-000000000966'),
        deadlineAt: new Date(Date.now() + 60_000),
        db: testDb(),
      }).acquire();
      await recentOff.finish(unknownEvidence);

      const admitted = await createProviderAttemptLifecycle({
        mode,
        policy: { maxConcurrentAttempts: 1, maxAttemptStartsPerMinute: 1 },
        identity: identity('00000000-0000-4000-8000-000000000967'),
        deadlineAt: new Date(Date.now() + 60_000),
        db: testDb(),
      }).acquire();

      expect(admitted.admission).toBe('acquired');
      await expect(admitted.reserveProviderStart()).resolves.toBeUndefined();
      expect(admitted.admission).toBe('acquired');
    },
  );

  it('replaces an expired unreserved admission with a durable enforce denial on conflict', async () => {
    const attemptId = '00000000-0000-4000-8000-000000000936';
    const deadlineAt = new Date(Date.now() + 60_000);
    const policy = { maxConcurrentAttempts: 1, maxAttemptStartsPerMinute: 100 };
    await createProviderAttemptLifecycle({
      mode: 'enforce',
      policy,
      identity: identity(attemptId),
      deadlineAt,
      db: testDb(),
    }).acquire();
    await testDb().execute(sql`UPDATE provider_attempt_admission
      SET lease_expires_at = clock_timestamp() - interval '1 second'
      WHERE attempt_id = ${attemptId}`);
    await createProviderAttemptLifecycle({
      mode: 'enforce',
      policy,
      identity: identity('00000000-0000-4000-8000-000000000937'),
      deadlineAt,
      db: testDb(),
    }).acquire();

    await expect(
      createProviderAttemptLifecycle({
        mode: 'enforce',
        policy,
        identity: identity(attemptId),
        deadlineAt,
        db: testDb(),
      }).acquire(),
    ).rejects.toMatchObject({ reason: 'capacity_exhausted' });

    const admission = (
      await testDb()
        .select()
        .from(provider_attempt_admission)
        .where(eq(provider_attempt_admission.attempt_id, attemptId))
    )[0];
    expect(admission).toMatchObject({
      mode: 'enforce',
      status: 'denied',
      lease_owner: null,
      acquired_at: null,
      lease_expires_at: null,
      terminal_reason: 'capacity_exhausted',
    });
    expect(admission?.terminal_at).toBeInstanceOf(Date);
  });

  it('observe records rate would-deny and keeps the start reservable', async () => {
    const policy = { maxConcurrentAttempts: 10, maxAttemptStartsPerMinute: 1 };
    const first = await createProviderAttemptLifecycle({
      mode: 'observe',
      policy,
      identity: identity('00000000-0000-4000-8000-000000000929'),
      deadlineAt: new Date(Date.now() + 60_000),
      db: testDb(),
    }).acquire();
    await first.reserveProviderStart();
    await first.finish(unknownEvidence);

    const second = await createProviderAttemptLifecycle({
      mode: 'observe',
      policy,
      identity: identity('00000000-0000-4000-8000-000000000935'),
      deadlineAt: new Date(Date.now() + 60_000),
      db: testDb(),
    }).acquire();

    expect(second.admission).toBe('acquired');
    await expect(second.reserveProviderStart()).resolves.toBeUndefined();
    expect(second.admission).toBe('would_deny');
  });

  it('does not count an acquired attempt until provider start is reserved', async () => {
    const policy = { maxConcurrentAttempts: 10, maxAttemptStartsPerMinute: 1 };
    await createProviderAttemptLifecycle({
      mode: 'enforce',
      policy,
      identity: identity('00000000-0000-4000-8000-000000000970'),
      deadlineAt: new Date(Date.now() + 60_000),
      db: testDb(),
    }).acquire();
    const started = await createProviderAttemptLifecycle({
      mode: 'enforce',
      policy,
      identity: identity('00000000-0000-4000-8000-000000000971'),
      deadlineAt: new Date(Date.now() + 60_000),
      db: testDb(),
    }).acquire();

    await expect(started.reserveProviderStart()).resolves.toBeUndefined();
    expect(
      (
        await testDb()
          .select()
          .from(provider_attempt)
          .where(eq(provider_attempt.attempt_id, '00000000-0000-4000-8000-000000000970'))
      )[0]?.provider_start_reserved_at,
    ).toBeNull();
  });

  it('counts a newly reserved start even when acquisition is older than one minute', async () => {
    const policy = { maxConcurrentAttempts: 10, maxAttemptStartsPerMinute: 1 };
    const seedId = '00000000-0000-4000-8000-000000000972';
    const seed = await createProviderAttemptLifecycle({
      mode: 'enforce',
      policy,
      identity: identity(seedId),
      deadlineAt: new Date(Date.now() + 60_000),
      db: testDb(),
    }).acquire();
    await testDb().execute(sql`UPDATE provider_attempt_admission
      SET acquired_at = clock_timestamp() - interval '2 minutes'
      WHERE attempt_id = ${seedId}`);
    await seed.reserveProviderStart();
    const contender = await createProviderAttemptLifecycle({
      mode: 'enforce',
      policy,
      identity: identity('00000000-0000-4000-8000-000000000973'),
      deadlineAt: new Date(Date.now() + 60_000),
      db: testDb(),
    }).acquire();

    await expect(contender.reserveProviderStart()).rejects.toMatchObject({
      reason: 'rate_exhausted',
    });
  });

  it('serializes concurrent enforce starts across operations at the lane rate limit', async () => {
    const policy = { maxConcurrentAttempts: 10, maxAttemptStartsPerMinute: 1 };
    const first = await createProviderAttemptLifecycle({
      mode: 'enforce',
      policy,
      identity: identityForOperation(
        '00000000-0000-4000-8000-000000000974',
        '00000000-0000-4000-8000-000000000074',
      ),
      deadlineAt: new Date(Date.now() + 60_000),
      db: openIndependentDb().db,
    }).acquire();
    const second = await createProviderAttemptLifecycle({
      mode: 'enforce',
      policy,
      identity: identityForOperation(
        '00000000-0000-4000-8000-000000000975',
        '00000000-0000-4000-8000-000000000075',
      ),
      deadlineAt: new Date(Date.now() + 60_000),
      db: openIndependentDb().db,
    }).acquire();

    const results = await Promise.allSettled([
      first.reserveProviderStart(),
      second.reserveProviderStart(),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ reason: 'rate_exhausted' }) }),
    ]);
    const attempts = await testDb().select().from(provider_attempt);
    expect(attempts.filter((attempt) => attempt.provider_start_reserved_at !== null)).toHaveLength(
      1,
    );
    const admissions = await testDb().select().from(provider_attempt_admission);
    expect(admissions.filter((admission) => admission.status === 'denied')).toEqual([
      expect.objectContaining({ terminal_reason: 'rate_exhausted' }),
    ]);
  });

  it('marks one concurrent observe start would-deny while reserving both operations', async () => {
    const policy = { maxConcurrentAttempts: 10, maxAttemptStartsPerMinute: 1 };
    const first = await createProviderAttemptLifecycle({
      mode: 'observe',
      policy,
      identity: identityForOperation(
        '00000000-0000-4000-8000-000000000976',
        '00000000-0000-4000-8000-000000000076',
      ),
      deadlineAt: new Date(Date.now() + 60_000),
      db: openIndependentDb().db,
    }).acquire();
    const second = await createProviderAttemptLifecycle({
      mode: 'observe',
      policy,
      identity: identityForOperation(
        '00000000-0000-4000-8000-000000000977',
        '00000000-0000-4000-8000-000000000077',
      ),
      deadlineAt: new Date(Date.now() + 60_000),
      db: openIndependentDb().db,
    }).acquire();

    await expect(
      Promise.all([first.reserveProviderStart(), second.reserveProviderStart()]),
    ).resolves.toEqual([undefined, undefined]);
    expect([first.admission, second.admission].sort()).toEqual(['acquired', 'would_deny']);
    const attempts = await testDb().select().from(provider_attempt);
    expect(attempts.filter((attempt) => attempt.provider_start_reserved_at !== null)).toHaveLength(
      2,
    );
    const admissions = await testDb().select().from(provider_attempt_admission);
    expect(admissions.filter((admission) => admission.status === 'would_deny')).toHaveLength(1);
  });

  it('does not charge an operation-fence loser as a provider start', async () => {
    const policy = { maxConcurrentAttempts: 10, maxAttemptStartsPerMinute: 1 };
    const winnerId = '00000000-0000-4000-8000-000000000978';
    const winner = await createProviderAttemptLifecycle({
      mode: 'observe',
      policy,
      identity: identity(winnerId),
      deadlineAt: new Date(Date.now() + 60_000),
      providerStartFence: 'operation_kind',
      db: testDb(),
    }).acquire();
    await winner.reserveProviderStart();
    const loserId = '00000000-0000-4000-8000-000000000979';
    const loser = await createProviderAttemptLifecycle({
      mode: 'observe',
      policy,
      identity: identity(loserId),
      deadlineAt: new Date(Date.now() + 60_000),
      providerStartFence: 'operation_kind',
      db: testDb(),
    }).acquire();
    await expect(loser.reserveProviderStart()).rejects.toMatchObject({
      reason: 'active_duplicate',
    });
    await testDb().execute(sql`UPDATE provider_attempt
      SET started_at = clock_timestamp() - interval '3 minutes',
        provider_start_reserved_at = clock_timestamp() - interval '2 minutes'
      WHERE attempt_id = ${winnerId}`);
    const next = await createProviderAttemptLifecycle({
      mode: 'observe',
      policy,
      identity: identityForOperation(
        '00000000-0000-4000-8000-000000000980',
        '00000000-0000-4000-8000-000000000080',
      ),
      deadlineAt: new Date(Date.now() + 60_000),
      db: testDb(),
    }).acquire();

    await expect(next.reserveProviderStart()).resolves.toBeUndefined();
    expect(next.admission).toBe('acquired');
    expect(
      (
        await testDb()
          .select()
          .from(provider_attempt)
          .where(eq(provider_attempt.attempt_id, loserId))
      )[0]?.provider_start_reserved_at,
    ).toBeNull();
  });

  it('extends a started attempt lease to its immutable deadline', async () => {
    const deadlineAt = new Date(Date.now() + 120_000);
    const handle = await createProviderAttemptLifecycle({
      mode: 'enforce',
      policy: { maxConcurrentAttempts: 1, maxAttemptStartsPerMinute: 10 },
      identity: identity('00000000-0000-4000-8000-000000000925'),
      deadlineAt,
      db: testDb(),
    }).acquire();

    await handle.reserveProviderStart();

    const row = (await testDb().select().from(provider_attempt_admission))[0];
    expect(row?.lease_expires_at?.getTime()).toBe(deadlineAt.getTime());
  });

  it('marks mixed live policy would-deny in observe and policy-mismatch in enforce', async () => {
    const deadlineAt = new Date(Date.now() + 60_000);
    const first = await createProviderAttemptLifecycle({
      mode: 'enforce',
      policy: { maxConcurrentAttempts: 3, maxAttemptStartsPerMinute: 10 },
      identity: identity('00000000-0000-4000-8000-000000000926'),
      deadlineAt,
      db: testDb(),
    }).acquire();
    const observed = await createProviderAttemptLifecycle({
      mode: 'observe',
      policy: { maxConcurrentAttempts: 4, maxAttemptStartsPerMinute: 10 },
      identity: identity('00000000-0000-4000-8000-000000000927'),
      deadlineAt,
      db: testDb(),
    }).acquire();

    expect(observed.admission).toBe('would_deny');
    await expect(
      createProviderAttemptLifecycle({
        mode: 'enforce',
        policy: { maxConcurrentAttempts: 4, maxAttemptStartsPerMinute: 10 },
        identity: identity('00000000-0000-4000-8000-000000000928'),
        deadlineAt,
        db: testDb(),
      }).acquire(),
    ).rejects.toMatchObject({ reason: 'policy_mismatch' });
    await first.finish(unknownEvidence);
    await observed.finish(unknownEvidence);
  });

  it('keeps start fencing outside lane policy while fencing attempt identity drift', async () => {
    const policy = { maxConcurrentAttempts: 3, maxAttemptStartsPerMinute: 10 };
    const deadlineAt = new Date(Date.now() + 60_000);
    const fencedAttemptId = '00000000-0000-4000-8000-000000000955';
    await createProviderAttemptLifecycle({
      mode: 'enforce',
      policy,
      identity: identity(fencedAttemptId),
      deadlineAt,
      providerStartFence: 'operation_kind',
      db: testDb(),
    }).acquire();

    await expect(
      createProviderAttemptLifecycle({
        mode: 'enforce',
        policy,
        identity: identity('00000000-0000-4000-8000-000000000956'),
        deadlineAt,
        db: testDb(),
      }).acquire(),
    ).resolves.toMatchObject({ admission: 'acquired' });
    await expect(
      createProviderAttemptLifecycle({
        mode: 'enforce',
        policy,
        identity: identity(fencedAttemptId),
        deadlineAt,
        db: openIndependentDb().db,
      }).acquire(),
    ).rejects.toMatchObject({ reason: 'identity_collision' });
  });

  it('fails enforce closed and returns observe untracked on control-plane failure', async () => {
    // Given independent DB handles whose underlying clients are closed.
    const enforceDb = openIndependentDb();
    const observeDb = openIndependentDb();
    await enforceDb.close();
    await observeDb.close();
    opened.splice(0);

    // When both modes acquire against the unavailable control plane.
    const enforce = createProviderAttemptLifecycle({
      mode: 'enforce',
      identity: identity('00000000-0000-4000-8000-000000000866'),
      deadlineAt: new Date(Date.now() + 60_000),
      db: enforceDb.db,
    });
    const observe = createProviderAttemptLifecycle({
      mode: 'observe',
      identity: identity('00000000-0000-4000-8000-000000000867'),
      deadlineAt: new Date(Date.now() + 60_000),
      db: observeDb.db,
    });

    // Then enforce is closed while observe exposes an explicit untracked handle.
    await expect(enforce.acquire()).rejects.toMatchObject({ reason: 'control_plane_unavailable' });
    await expect(observe.acquire()).resolves.toMatchObject({ admission: 'untracked' });
  });

  it('re-evaluates a new delivery after a durable capacity denial', async () => {
    const policy = { maxConcurrentAttempts: 1, maxAttemptStartsPerMinute: 10 };
    const blocker = await createProviderAttemptLifecycle({
      mode: 'enforce',
      policy,
      identity: identity('00000000-0000-4000-8000-000000000940'),
      deadlineAt: new Date(Date.now() + 60_000),
      db: testDb(),
    }).acquire();
    const deniedAttemptId = '00000000-0000-4000-8000-000000000941';
    await expect(
      createProviderAttemptLifecycle({
        mode: 'enforce',
        policy,
        identity: identity(deniedAttemptId),
        deadlineAt: new Date(Date.now() + 60_000),
        db: testDb(),
      }).acquire(),
    ).rejects.toMatchObject({ reason: 'capacity_exhausted' });
    await blocker.finish(unknownEvidence);

    const retry = await createProviderAttemptLifecycle({
      mode: 'enforce',
      policy,
      identity: identity('00000000-0000-4000-8000-000000000942'),
      deadlineAt: new Date(Date.now() + 60_000),
      db: testDb(),
    }).acquire();

    await expect(retry.reserveProviderStart()).resolves.toBeUndefined();
    expect(
      (
        await testDb()
          .select()
          .from(provider_attempt_admission)
          .where(eq(provider_attempt_admission.attempt_id, deniedAttemptId))
      )[0],
    ).toMatchObject({ status: 'denied', terminal_reason: 'capacity_exhausted' });
  });

  it('re-evaluates a new delivery after durable rate and policy denials', async () => {
    const ratePolicy = { maxConcurrentAttempts: 10, maxAttemptStartsPerMinute: 1 };
    const rateSeedId = '00000000-0000-4000-8000-000000000943';
    const rateSeed = await createProviderAttemptLifecycle({
      mode: 'enforce',
      policy: ratePolicy,
      identity: identity(rateSeedId),
      deadlineAt: new Date(Date.now() + 60_000),
      db: testDb(),
    }).acquire();
    await rateSeed.reserveProviderStart();
    await rateSeed.finish(unknownEvidence);
    const rateDeniedId = '00000000-0000-4000-8000-000000000944';
    const rateDenied = await createProviderAttemptLifecycle({
      mode: 'enforce',
      policy: ratePolicy,
      identity: identity(rateDeniedId),
      deadlineAt: new Date(Date.now() + 60_000),
      db: testDb(),
    }).acquire();
    await expect(rateDenied.reserveProviderStart()).rejects.toMatchObject({
      reason: 'rate_exhausted',
    });
    await testDb().execute(sql`UPDATE provider_attempt
      SET started_at = clock_timestamp() - interval '3 minutes',
        provider_start_reserved_at = clock_timestamp() - interval '2 minutes'
      WHERE attempt_id = ${rateSeedId}`);
    await expect(
      (
        await createProviderAttemptLifecycle({
          mode: 'enforce',
          policy: ratePolicy,
          identity: identity('00000000-0000-4000-8000-000000000945'),
          deadlineAt: new Date(Date.now() + 60_000),
          db: testDb(),
        }).acquire()
      ).reserveProviderStart(),
    ).resolves.toBeUndefined();
    expect(
      (
        await testDb()
          .select()
          .from(provider_attempt_admission)
          .where(eq(provider_attempt_admission.attempt_id, rateDeniedId))
      )[0],
    ).toMatchObject({ status: 'denied', terminal_reason: 'rate_exhausted' });

    await resetDb();
    const policySeed = await createProviderAttemptLifecycle({
      mode: 'enforce',
      policy: { maxConcurrentAttempts: 3, maxAttemptStartsPerMinute: 10 },
      identity: identity('00000000-0000-4000-8000-000000000946'),
      deadlineAt: new Date(Date.now() + 60_000),
      db: testDb(),
    }).acquire();
    const policyDeniedId = '00000000-0000-4000-8000-000000000947';
    const nextPolicy = { maxConcurrentAttempts: 4, maxAttemptStartsPerMinute: 10 };
    await expect(
      createProviderAttemptLifecycle({
        mode: 'enforce',
        policy: nextPolicy,
        identity: identity(policyDeniedId),
        deadlineAt: new Date(Date.now() + 60_000),
        db: testDb(),
      }).acquire(),
    ).rejects.toMatchObject({ reason: 'policy_mismatch' });
    await policySeed.finish(unknownEvidence);
    await expect(
      (
        await createProviderAttemptLifecycle({
          mode: 'enforce',
          policy: nextPolicy,
          identity: identity('00000000-0000-4000-8000-000000000948'),
          deadlineAt: new Date(Date.now() + 60_000),
          db: testDb(),
        }).acquire()
      ).reserveProviderStart(),
    ).resolves.toBeUndefined();
    const durableDenials = await testDb()
      .select()
      .from(provider_attempt_admission)
      .where(eq(provider_attempt_admission.attempt_id, policyDeniedId));
    expect(durableDenials[0]).toMatchObject({
      status: 'denied',
      terminal_reason: 'policy_mismatch',
    });
  });

  it('atomically fences operation-kind starts and expires stale active owners', async () => {
    const firstAttemptId = '00000000-0000-4000-8000-000000000949';
    const liveCompetitorId = '00000000-0000-4000-8000-000000000950';
    const staleCompetitorId = '00000000-0000-4000-8000-000000000951';
    const first = await createProviderAttemptLifecycle({
      mode: 'observe',
      identity: identity(firstAttemptId),
      deadlineAt: new Date(Date.now() + 60_000),
      providerStartFence: 'operation_kind',
      db: testDb(),
    }).acquire();
    await first.reserveProviderStart();
    const firstOwner = (
      await testDb()
        .select()
        .from(provider_attempt_admission)
        .where(eq(provider_attempt_admission.attempt_id, firstAttemptId))
    )[0]?.lease_owner;
    expect(firstOwner).toEqual(expect.any(String));
    const liveCompetitor = await createProviderAttemptLifecycle({
      mode: 'observe',
      identity: identity(liveCompetitorId),
      deadlineAt: new Date(Date.now() + 60_000),
      providerStartFence: 'operation_kind',
      db: testDb(),
    }).acquire();
    const liveCompetitorOwner = (
      await testDb()
        .select()
        .from(provider_attempt_admission)
        .where(eq(provider_attempt_admission.attempt_id, liveCompetitorId))
    )[0]?.lease_owner;
    expect(liveCompetitorOwner).toEqual(expect.any(String));
    await expect(liveCompetitor.reserveProviderStart()).rejects.toMatchObject({
      reason: 'active_duplicate',
    });
    expect(
      (
        await testDb()
          .select()
          .from(provider_attempt_admission)
          .where(eq(provider_attempt_admission.attempt_id, liveCompetitorId))
      )[0],
    ).toMatchObject({
      status: 'released',
      lease_owner: liveCompetitorOwner,
      terminal_reason: 'provider_start_active_duplicate',
    });
    expect(
      (
        await testDb()
          .select()
          .from(provider_attempt)
          .where(eq(provider_attempt.attempt_id, liveCompetitorId))
      )[0]?.provider_start_reserved_at,
    ).toBeNull();
    expect(
      (
        await testDb()
          .select()
          .from(provider_attempt_admission)
          .where(eq(provider_attempt_admission.attempt_id, firstAttemptId))
      )[0],
    ).toMatchObject({ status: 'acquired' });
    await testDb().execute(sql`UPDATE provider_attempt_admission
      SET lease_expires_at = clock_timestamp() - interval '1 second'
      WHERE attempt_id = ${firstAttemptId}`);
    const staleCompetitor = await createProviderAttemptLifecycle({
      mode: 'observe',
      identity: identity(staleCompetitorId),
      deadlineAt: new Date(Date.now() + 60_000),
      providerStartFence: 'operation_kind',
      db: testDb(),
    }).acquire();
    const staleCompetitorOwner = (
      await testDb()
        .select()
        .from(provider_attempt_admission)
        .where(eq(provider_attempt_admission.attempt_id, staleCompetitorId))
    )[0]?.lease_owner;
    expect(staleCompetitorOwner).toEqual(expect.any(String));

    await expect(staleCompetitor.reserveProviderStart()).rejects.toMatchObject({
      reason: 'recovery_required',
    });
    const expiredOwner = (
      await testDb()
        .select()
        .from(provider_attempt_admission)
        .where(eq(provider_attempt_admission.attempt_id, firstAttemptId))
    )[0];
    expect(expiredOwner).toMatchObject({
      status: 'lease_expired',
      lease_owner: firstOwner,
      terminal_reason: 'lease_expired',
    });
    expect(expiredOwner?.terminal_at?.getTime()).toBeGreaterThanOrEqual(
      expiredOwner?.lease_expires_at?.getTime() ?? Number.POSITIVE_INFINITY,
    );
    expect(
      (
        await testDb()
          .select()
          .from(provider_attempt_admission)
          .where(eq(provider_attempt_admission.attempt_id, staleCompetitorId))
      )[0],
    ).toMatchObject({
      status: 'released',
      lease_owner: staleCompetitorOwner,
      terminal_reason: 'provider_start_recovery_required',
    });
    expect(
      (
        await testDb()
          .select()
          .from(provider_attempt)
          .where(eq(provider_attempt.attempt_id, staleCompetitorId))
      )[0]?.provider_start_reserved_at,
    ).toBeNull();
    await expect(first.recordExternalRequestId('too-late')).rejects.toMatchObject({
      reason: 'lease_lost',
    });
    await expect(first.finish(unknownEvidence)).rejects.toMatchObject({ reason: 'lease_lost' });
  });

  it('releases a deadline-elapsed started blocker while preserving both owners', async () => {
    const ownerAttemptId = '00000000-0000-4000-8000-000000000960';
    const contenderAttemptId = '00000000-0000-4000-8000-000000000961';
    const owner = await createProviderAttemptLifecycle({
      mode: 'observe',
      identity: identity(ownerAttemptId),
      deadlineAt: new Date(Date.now() + 60_000),
      providerStartFence: 'operation_kind',
      db: testDb(),
    }).acquire();
    await owner.reserveProviderStart();
    await testDb().execute(sql`UPDATE provider_attempt_admission
      SET status = 'would_deny', deadline_at = clock_timestamp() - interval '1 second',
        lease_expires_at = clock_timestamp() + interval '30 seconds'
      WHERE attempt_id = ${ownerAttemptId}`);
    const ownerBefore = (
      await testDb()
        .select()
        .from(provider_attempt_admission)
        .where(eq(provider_attempt_admission.attempt_id, ownerAttemptId))
    )[0];
    const contender = await createProviderAttemptLifecycle({
      mode: 'observe',
      identity: identity(contenderAttemptId),
      deadlineAt: new Date(Date.now() + 60_000),
      providerStartFence: 'operation_kind',
      db: testDb(),
    }).acquire();
    const contenderOwner = (
      await testDb()
        .select()
        .from(provider_attempt_admission)
        .where(eq(provider_attempt_admission.attempt_id, contenderAttemptId))
    )[0]?.lease_owner;
    expect(contenderOwner).toEqual(expect.any(String));

    await expect(contender.reserveProviderStart()).rejects.toMatchObject({
      reason: 'recovery_required',
    });
    expect(
      (
        await testDb()
          .select()
          .from(provider_attempt_admission)
          .where(eq(provider_attempt_admission.attempt_id, ownerAttemptId))
      )[0],
    ).toMatchObject({
      status: 'released',
      lease_owner: ownerBefore?.lease_owner,
      terminal_reason: 'deadline_elapsed',
    });
    expect(
      (
        await testDb()
          .select()
          .from(provider_attempt_admission)
          .where(eq(provider_attempt_admission.attempt_id, contenderAttemptId))
      )[0],
    ).toMatchObject({
      status: 'released',
      lease_owner: contenderOwner,
      terminal_reason: 'provider_start_recovery_required',
    });
  });

  it('serializes concurrent fenced reserves without preholding attempt locks', async () => {
    const firstAttemptId = '00000000-0000-4000-8000-000000000962';
    const secondAttemptId = '00000000-0000-4000-8000-000000000963';
    const deadlineAt = new Date(Date.now() + 60_000);
    const firstIdentity = identity(firstAttemptId);
    const first = await createProviderAttemptLifecycle({
      mode: 'observe',
      identity: firstIdentity,
      deadlineAt,
      providerStartFence: 'operation_kind',
      db: openIndependentDb().db,
    }).acquire();
    const second = await createProviderAttemptLifecycle({
      mode: 'observe',
      identity: identity(secondAttemptId),
      deadlineAt,
      providerStartFence: 'operation_kind',
      db: openIndependentDb().db,
    }).acquire();
    const operationFenceKey = `provider-attempt-operation-kind:${firstIdentity.operationId}:${firstIdentity.provider}:${firstIdentity.lane}:${firstIdentity.operationKind}`;
    const reservations: Array<Promise<void>> = [];
    const lockWaiters = await openIndependentDb().db.transaction(async (barrierTx) => {
      const holderRows = await barrierTx.execute<{ pid: number }>(
        sql`SELECT pg_backend_pid() AS pid`,
      );
      const holderPid = holderRows[0]?.pid;
      if (holderPid === undefined) throw new Error('operation fence barrier has no backend pid');
      await barrierTx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${operationFenceKey}, 0))`,
      );
      reservations.push(first.reserveProviderStart(), second.reserveProviderStart());

      let waitingRows: Array<{ granted_advisory: number; pid: number }> = [];
      for (let probe = 0; probe < 100 && waitingRows.length < 2; probe += 1) {
        waitingRows = await barrierTx.execute<{ granted_advisory: number; pid: number }>(sql`
          SELECT waiting.pid,
            (SELECT count(*)::int
              FROM pg_locks granted
              WHERE granted.pid = waiting.pid
                AND granted.locktype = 'advisory'
                AND granted.granted) AS granted_advisory
          FROM pg_locks held
          JOIN pg_locks waiting
            ON waiting.locktype = held.locktype
            AND waiting.database IS NOT DISTINCT FROM held.database
            AND waiting.classid IS NOT DISTINCT FROM held.classid
            AND waiting.objid IS NOT DISTINCT FROM held.objid
            AND waiting.objsubid IS NOT DISTINCT FROM held.objsubid
          WHERE held.pid = ${holderPid}
            AND held.locktype = 'advisory'
            AND held.granted
            AND waiting.pid <> held.pid
            AND NOT waiting.granted
          ORDER BY waiting.pid
        `);
      }
      return waitingRows;
    });

    const results = await Promise.allSettled(reservations);

    expect(lockWaiters).toHaveLength(2);
    expect(lockWaiters).toEqual([
      expect.objectContaining({ granted_advisory: 0 }),
      expect.objectContaining({ granted_advisory: 0 }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ reason: 'active_duplicate' }) }),
    ]);
    const attempts = await testDb().select().from(provider_attempt);
    expect(attempts.filter((attempt) => attempt.provider_start_reserved_at !== null)).toHaveLength(
      1,
    );
    const admissions = await testDb().select().from(provider_attempt_admission);
    expect(admissions.filter((admission) => admission.status === 'released')).toEqual([
      expect.objectContaining({ terminal_reason: 'provider_start_active_duplicate' }),
    ]);
  });

  it('keeps the operation-kind duplicate-start fence active in persisted off mode', async () => {
    const first = await createProviderAttemptLifecycle({
      mode: 'off',
      persistAttemptWhenOff: true,
      identity: identity('00000000-0000-4000-8000-000000000968'),
      deadlineAt: new Date(Date.now() + 60_000),
      providerStartFence: 'operation_kind',
      db: testDb(),
    }).acquire();
    await first.reserveProviderStart();
    const competitor = await createProviderAttemptLifecycle({
      mode: 'off',
      persistAttemptWhenOff: true,
      identity: identity('00000000-0000-4000-8000-000000000969'),
      deadlineAt: new Date(Date.now() + 60_000),
      providerStartFence: 'operation_kind',
      db: testDb(),
    }).acquire();

    await expect(competitor.reserveProviderStart()).rejects.toMatchObject({
      reason: 'active_duplicate',
    });
    expect(
      (
        await testDb()
          .select()
          .from(provider_attempt_admission)
          .where(eq(provider_attempt_admission.attempt_id, '00000000-0000-4000-8000-000000000969'))
      )[0],
    ).toMatchObject({
      mode: 'off',
      status: 'released',
      terminal_reason: 'provider_start_active_duplicate',
    });
  });

  it('fences a concurrent same-generation attempt identity before a second start', async () => {
    const attemptId = '00000000-0000-4000-8000-000000000954';
    const deadlineAt = new Date(Date.now() + 60_000);
    const owner = await createProviderAttemptLifecycle({
      mode: 'observe',
      identity: identity(attemptId),
      deadlineAt,
      providerStartFence: 'operation_kind',
      db: testDb(),
    }).acquire();
    await owner.reserveProviderStart();

    await expect(
      createProviderAttemptLifecycle({
        mode: 'observe',
        identity: identity(attemptId),
        deadlineAt,
        providerStartFence: 'operation_kind',
        db: openIndependentDb().db,
      }).acquire(),
    ).rejects.toMatchObject({ reason: 'active_duplicate' });
  });

  it('allows a different delivery deadline after an expired unreserved attempt', async () => {
    await createProviderAttemptLifecycle({
      mode: 'observe',
      identity: identity('00000000-0000-4000-8000-000000000952'),
      deadlineAt: new Date(Date.now() - 1_000),
      providerStartFence: 'operation_kind',
      db: testDb(),
    }).acquire();
    const retry = await createProviderAttemptLifecycle({
      mode: 'observe',
      identity: identity('00000000-0000-4000-8000-000000000953'),
      deadlineAt: new Date(Date.now() + 60_000),
      providerStartFence: 'operation_kind',
      db: testDb(),
    }).acquire();

    await expect(retry.reserveProviderStart()).resolves.toBeUndefined();
  });
});
