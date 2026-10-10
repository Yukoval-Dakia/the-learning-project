import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderAttemptLifecycle } from '@/server/ai/provider-attempt-lifecycle';
import {
  createMem0OpaqueOperationContext,
  executeMem0OpaqueOperation,
} from '@/server/ai/provider-attempt-runtime';

afterEach(() => vi.restoreAllMocks());

describe('Mem0 opaque provider operation', () => {
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
      mode: 'observe',
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
});
