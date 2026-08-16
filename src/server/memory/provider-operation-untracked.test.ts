import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createMem0OpaqueOperationContext,
  executeMem0OpaqueOperation,
} from '@/server/ai/provider-attempt-runtime';

afterEach(() => vi.restoreAllMocks());

describe('Mem0 opaque untracked settlement', () => {
  it('continues the SDK call when observe admission is untracked', async () => {
    // Given observe mode cannot write control-plane truth but returns an untracked handle.
    const execute = vi.fn(async () => 'untracked-provider-value');
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const context = createMem0OpaqueOperationContext({
      caller: 'worker',
      deadlineAt: new Date('2026-08-09T03:01:00.000Z'),
      operationAnchor: 'worker-untracked-852',
      mode: 'observe',
      createLifecycle: (input) => ({
        identity: input.identity,
        acquire: async () => ({
          admission: 'untracked' as const,
          reserveProviderStart: async () => {},
          recordExternalRequestId: async () => {},
          finish: async () => 'untracked' as const,
        }),
      }),
    });

    // When the opaque operation executes through that handle.
    const result = await executeMem0OpaqueOperation(context, 'add_inferred', execute);

    // Then observe telemetry remains fail-open before the SDK call.
    expect(result).toBe('untracked-provider-value');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(errorLog).toHaveBeenCalledOnce();
    expect(errorLog).toHaveBeenCalledWith(
      '[mem0-provider-operation] terminal settlement failed; preserving provider outcome',
      {
        attemptId: expect.any(String),
        operationId: context.operationId,
        operationKind: 'add_inferred',
        caller: 'worker',
        settlementReason: 'finish_untracked',
        settlementMessage: 'terminal evidence was not durably recorded',
      },
    );
  });

  it('rethrows the SDK error when failed settlement is untracked', async () => {
    // Given an SDK rejection whose observe terminal settlement cannot be tracked.
    const sdkError = new Error('opaque SDK rejection');
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const context = createMem0OpaqueOperationContext({
      caller: 'api',
      deadlineAt: new Date('2026-08-09T03:01:00.000Z'),
      operationAnchor: 'api-failed-untracked-852',
      mode: 'observe',
      createLifecycle: (input) => ({
        identity: input.identity,
        acquire: async () => ({
          admission: 'untracked' as const,
          reserveProviderStart: async () => {},
          recordExternalRequestId: async () => {},
          finish: async () => 'untracked' as const,
        }),
      }),
    });

    // When the SDK and terminal tracking both fail.
    const outcome = executeMem0OpaqueOperation(context, 'search', async () => {
      throw sdkError;
    });

    // Then the SDK error wins and one redacted operator event records settlement loss.
    await expect(outcome).rejects.toBe(sdkError);
    expect(errorLog).toHaveBeenCalledOnce();
    expect(errorLog).toHaveBeenCalledWith(
      '[mem0-provider-operation] terminal settlement failed; preserving provider outcome',
      {
        attemptId: expect.any(String),
        operationId: context.operationId,
        operationKind: 'search',
        caller: 'api',
        settlementReason: 'finish_untracked',
        settlementMessage: 'terminal evidence was not durably recorded',
      },
    );
  });
});
