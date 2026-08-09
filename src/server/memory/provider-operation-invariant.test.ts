import {
  createMem0OpaqueOperationContext,
  executeMem0OpaqueOperation,
} from '@/server/ai/provider-attempt-runtime';
import { describe, expect, it, vi } from 'vitest';

describe('Mem0 opaque provider start invariants', () => {
  it.each(['acquire', 'reserve'] as const)(
    'propagates the %s lifecycle invariant before provider start',
    async (failurePoint) => {
      // Given a lifecycle invariant fails before the external provider starts.
      const invariantError = new Error(`${failurePoint} invariant failed`);
      const execute = vi.fn(async () => 'must-not-run');
      const context = createMem0OpaqueOperationContext({
        caller: 'api',
        deadlineAt: new Date('2026-08-09T03:01:00.000Z'),
        operationAnchor: `api-${failurePoint}-invariant-852`,
        mode: 'observe',
        createLifecycle: (input) => ({
          identity: input.identity,
          acquire: async () => {
            if (failurePoint === 'acquire') throw invariantError;
            return {
              admission: 'acquired' as const,
              reserveProviderStart: async () => {
                throw invariantError;
              },
              recordExternalRequestId: async () => {},
              finish: async () => 'settled' as const,
            };
          },
        }),
      });

      // When the operation reaches the failing pre-provider invariant.
      const outcome = executeMem0OpaqueOperation(context, 'search', execute);

      // Then the invariant error propagates and no SDK request is made.
      await expect(outcome).rejects.toBe(invariantError);
      expect(execute).not.toHaveBeenCalled();
    },
  );
});
