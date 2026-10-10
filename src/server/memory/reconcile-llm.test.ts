import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermanentError, RetryableError } from '@/core/schema/structured_question';
import type {
  DirectProviderLifecycleFactory,
  DirectProviderOperationContext,
} from '@/server/ai/direct-provider-attempt';
import { type CandidateEntry, type NewMemoryEntry, judgeReconciliation } from './reconcile-llm';

// Minimal env for createMem0Config inside judgeReconciliation
const MOCK_ENV = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  ZHIPU_API_KEY: 'test-key',
  DASHSCOPE_API_KEY: 'test-dashscope',
};

function attemptContext(
  records: unknown[],
  externalRequestIds: string[] = [],
  delays: { acquireMs?: number; reserveMs?: number } = {},
): DirectProviderOperationContext {
  const createLifecycle: DirectProviderLifecycleFactory = (input) => ({
    identity: input.identity,
    acquire: async () => {
      if (delays.acquireMs) await new Promise((resolve) => setTimeout(resolve, delays.acquireMs));
      return {
        admission: 'acquired',
        reserveProviderStart: async () => {
          if (delays.reserveMs)
            await new Promise((resolve) => setTimeout(resolve, delays.reserveMs));
        },
        recordExternalRequestId: async (id) => {
          externalRequestIds.push(id);
        },
        finish: async (evidence) => {
          records.push({
            identity: input.identity,
            providerStartFence: input.providerStartFence,
            evidence,
          });
          return 'settled';
        },
      };
    },
  });
  return {
    caller: 'worker',
    deadlineAt: new Date('2030-01-01T00:00:00.000Z'),
    mode: 'observe',
    operationId: '00000000-0000-4000-8000-000000000020',
    createLifecycle,
  };
}

function mockNewMems(): NewMemoryEntry[] {
  return [
    {
      index: 0,
      kind: 'preference',
      text: 'User prefers dark mode',
      memory_id: 'mem-new-1',
      created_ms: 2000,
    },
    {
      index: 1,
      kind: 'event',
      text: 'User answered question q1',
      memory_id: 'mem-new-2',
      created_ms: 2000,
    },
  ];
}

function mockCandidates(): Map<number, CandidateEntry[]> {
  return new Map([
    [
      0,
      [
        // YUK-557: candidates now carry mem0's fused `score` — must not leak into
        // the prompt (indices only) nor break parsing.
        {
          index: 0,
          text: 'User prefers light mode',
          memory_id: 'mem-old-1',
          created_ms: 1000,
          score: 0.77,
        },
        {
          index: 1,
          text: 'User likes terse feedback',
          memory_id: 'mem-old-2',
          created_ms: 2000,
          score: 0.34,
        },
      ],
    ],
    [1, []],
  ]);
}

const MIMO_ENV = {
  ...MOCK_ENV,
  AI_PROVIDER_OVERRIDE: 'opencode-go',
  AI_PROVIDER_MODEL: 'mimo-v2.6-pro',
  OPENCODE_API_KEY: 'synthetic-mimo-key',
};

function abortError() {
  return new DOMException('Synthetic transport aborted', 'AbortError');
}

describe('judgeReconciliation transport deadline', () => {
  afterEach(() => vi.useRealTimers());

  function expectAbortEvidence(attempts: unknown[], wireCount = 1) {
    expect(attempts).toEqual([
      expect.objectContaining({
        providerStartFence: 'operation_kind',
        identity: expect.objectContaining({ provider: 'opencode-go', model: 'mimo-v2.6-pro' }),
        evidence: expect.objectContaining({
          terminal: 'aborted',
          reason: 'provider_request_aborted',
          wireCount,
          usage: expect.objectContaining({
            basis: 'unknown',
            input: null,
            output: null,
            total: null,
          }),
          cost: expect.objectContaining({ basis: 'unknown', amount: null, currency: 'USD' }),
        }),
      }),
    ]);
  }

  it('aborts a request stalled before response headers without inventing usage or cost', async () => {
    vi.useFakeTimers();
    const attempts: unknown[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      const signal = init?.signal;
      if (!signal) throw new Error('Expected the transport abort signal');
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(abortError()), { once: true });
      });
    });
    const outcome = judgeReconciliation(mockNewMems(), mockCandidates(), {
      env: MIMO_ENV,
      timeoutMs: 25,
      fetchImpl,
      providerAttempt: attemptContext(attempts),
    }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(25);
    expect(await outcome).toBeInstanceOf(RetryableError);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expectAbortEvidence(attempts);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps a genuine invalid JSON body permanent with unknown usage and cost', async () => {
    const attempts: unknown[] = [];
    const ids: string[] = [];
    await expect(
      judgeReconciliation(mockNewMems(), mockCandidates(), {
        env: MIMO_ENV,
        fetchImpl: async () =>
          new Response('{"incomplete":', { headers: { 'x-request-id': 'malformed-id' } }),
        providerAttempt: attemptContext(attempts, ids),
      }),
    ).rejects.toBeInstanceOf(PermanentError);
    expect(ids).toEqual(['malformed-id']);
    expect(attempts).toEqual([
      expect.objectContaining({
        evidence: expect.objectContaining({
          terminal: 'failed',
          reason: 'provider_response_malformed',
          wireCount: 1,
          usage: expect.objectContaining({ basis: 'unknown', input: null, output: null }),
          cost: expect.objectContaining({ basis: 'unknown', amount: null }),
        }),
      }),
    ]);
  });
});
