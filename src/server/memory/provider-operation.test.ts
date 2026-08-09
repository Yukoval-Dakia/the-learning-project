import type {
  ProviderAttemptHandle,
  ProviderAttemptLifecycle,
} from '@/server/ai/provider-attempt-lifecycle';
import {
  createMem0OpaqueOperationContext,
  executeMem0OpaqueOperation,
} from '@/server/ai/provider-attempt-runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => vi.restoreAllMocks());

describe('Mem0 opaque provider operation', () => {
  it('keeps one caller-owned operation identity while each SDK call gets a fresh attempt', async () => {
    // Given one product invocation and an observable lifecycle factory.
    const identities: ProviderAttemptLifecycle['identity'][] = [];
    const createLifecycle = vi.fn((input: { identity: ProviderAttemptLifecycle['identity'] }) => {
      identities.push(input.identity);
      return {
        identity: input.identity,
        acquire: async () => ({
          admission: 'acquired' as const,
          reserveProviderStart: async () => {},
          recordExternalRequestId: async () => {},
          finish: async () => 'settled' as const,
        }),
      } satisfies ProviderAttemptLifecycle;
    });
    const context = createMem0OpaqueOperationContext({
      caller: 'worker',
      deadlineAt: new Date('2026-08-09T03:01:00.000Z'),
      operationAnchor: 'memory-ingest-job-852',
      createLifecycle,
    });

    // When two real SDK calls belong to that invocation.
    await executeMem0OpaqueOperation(context, 'add_inferred', async () => 'first');
    await executeMem0OpaqueOperation(context, 'add_verbatim', async () => 'second');

    // Then the operation stays stable, attempts stay fresh, and identity is opaque Mem0 truth.
    expect(identities).toHaveLength(2);
    expect(identities[0]?.operationId).toBe(identities[1]?.operationId);
    expect(identities[0]?.attemptId).not.toBe(identities[1]?.attemptId);
    expect(identities).toEqual([
      expect.objectContaining({
        attemptKind: 'opaque_operation',
        provider: 'mem0',
        model: null,
        lane: 'mem0.event-memory',
        protocol: 'mem0-oss-sdk',
        endpointClass: 'memory.add',
        caller: 'worker',
        operationKind: 'add_inferred',
      }),
      expect.objectContaining({
        attemptKind: 'opaque_operation',
        provider: 'mem0',
        model: null,
        lane: 'mem0.event-memory',
        protocol: 'mem0-oss-sdk',
        endpointClass: 'memory.add',
        caller: 'worker',
        operationKind: 'add_verbatim',
      }),
    ]);
  });

  it('serializes terminal truth with opaque wire and unknown usage and cost', async () => {
    // Given a lifecycle whose terminal evidence is observable.
    const finish = vi.fn<ProviderAttemptHandle['finish']>(async () => 'settled');
    const createLifecycle = vi.fn((input: { identity: ProviderAttemptLifecycle['identity'] }) => ({
      identity: input.identity,
      acquire: async () => ({
        admission: 'acquired' as const,
        reserveProviderStart: async () => {},
        recordExternalRequestId: async () => {},
        finish,
      }),
    }));
    const context = createMem0OpaqueOperationContext({
      caller: 'api',
      deadlineAt: new Date('2026-08-09T03:01:00.000Z'),
      operationAnchor: 'api-memory-search-852',
      createLifecycle,
    });

    // When the opaque SDK call succeeds.
    const result = await executeMem0OpaqueOperation(context, 'search', async () => ({
      results: [{ id: 'mem_852', memory: 'prefers concise feedback' }],
    }));

    // Then the original output survives and no fake wire, token, or monetary zero is serialized.
    expect(result).toEqual({
      results: [{ id: 'mem_852', memory: 'prefers concise feedback' }],
    });
    expect(createLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'observe', deadlineAt: context.deadlineAt }),
    );
    expect(finish).toHaveBeenCalledWith({
      terminal: 'succeeded',
      reason: 'provider_response_accepted',
      wireCount: null,
      usage: {
        basis: 'unknown',
        unit: null,
        input: null,
        output: null,
        total: null,
        source: 'mem0_sdk_usage_unavailable',
      },
      cost: {
        basis: 'unknown',
        amount: null,
        currency: null,
        source: 'mem0_sdk_cost_unavailable',
      },
    });
  });

  it('returns provider success when terminal settlement fails after the SDK returned', async () => {
    // Given adversarial provider and settlement values that must never enter telemetry logs.
    const settlementSecret = 'SECRET_PROVIDER_PAYLOAD=do-not-log';
    const providerResultSecret = 'SECRET_PROVIDER_RESULT=do-not-log';
    const querySecret = 'SECRET_QUERY=do-not-log';
    const payloadSecret = 'SECRET_EVENT_PAYLOAD=do-not-log';
    const settlementError = new Error(settlementSecret);
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const createLifecycle = (input: { identity: ProviderAttemptLifecycle['identity'] }) => ({
      identity: input.identity,
      acquire: async () => ({
        admission: 'acquired' as const,
        reserveProviderStart: async () => {},
        recordExternalRequestId: async () => {},
        finish: async () => {
          throw settlementError;
        },
      }),
    });
    const context = createMem0OpaqueOperationContext({
      caller: 'api',
      deadlineAt: new Date('2026-08-09T03:01:00.000Z'),
      operationAnchor: 'api-success-settlement-failure-852',
      createLifecycle,
    });

    // When the operation settles after receiving the SDK value.
    const result = await executeMem0OpaqueOperation(context, 'search', async () => ({
      result: providerResultSecret,
      ignoredQuery: querySecret,
      ignoredPayload: payloadSecret,
    }));

    // Then observe telemetry fails open and records only fixed, non-sensitive diagnostics.
    expect(result).toEqual({
      result: providerResultSecret,
      ignoredQuery: querySecret,
      ignoredPayload: payloadSecret,
    });
    expect(errorLog).toHaveBeenCalledWith(
      '[mem0-provider-operation] terminal settlement failed; preserving provider outcome',
      {
        attemptId: expect.any(String),
        operationId: context.operationId,
        operationKind: 'search',
        caller: 'api',
        settlementReason: 'finish_threw',
        settlementMessage: 'terminal evidence settlement threw',
      },
    );
    const serializedLog = JSON.stringify(errorLog.mock.calls);
    expect(serializedLog).not.toContain(settlementSecret);
    expect(serializedLog).not.toContain(providerResultSecret);
    expect(serializedLog).not.toContain(querySecret);
    expect(serializedLog).not.toContain(payloadSecret);
  });

  it('rethrows the original SDK error even when failed settlement also fails', async () => {
    // Given distinct SDK and settlement failures.
    const sdkError = new Error('Mem0 search rejected');
    const settlementError = new Error('provider attempt settlement unavailable');
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const finish = vi.fn(async () => {
      throw settlementError;
    });
    const createLifecycle = (input: { identity: ProviderAttemptLifecycle['identity'] }) => ({
      identity: input.identity,
      acquire: async () => ({
        admission: 'acquired' as const,
        reserveProviderStart: async () => {},
        recordExternalRequestId: async () => {},
        finish,
      }),
    });
    const context = createMem0OpaqueOperationContext({
      caller: 'worker',
      deadlineAt: new Date('2026-08-09T03:01:00.000Z'),
      operationAnchor: 'worker-sdk-settlement-failure-852',
      createLifecycle,
    });

    // When the SDK rejects and failure settlement also rejects.
    const outcome = executeMem0OpaqueOperation(context, 'add_inferred', async () => {
      throw sdkError;
    });

    // Then the exact original SDK error wins and terminal evidence still reports provider failure.
    await expect(outcome).rejects.toBe(sdkError);
    expect(finish).toHaveBeenCalledWith(
      expect.objectContaining({ terminal: 'failed', reason: 'provider_attempt_failed' }),
    );
    expect(errorLog).toHaveBeenCalledWith(
      '[mem0-provider-operation] terminal settlement failed; preserving provider outcome',
      {
        attemptId: expect.any(String),
        operationId: context.operationId,
        operationKind: 'add_inferred',
        caller: 'worker',
        settlementReason: 'finish_threw',
        settlementMessage: 'terminal evidence settlement threw',
      },
    );
  });
});
