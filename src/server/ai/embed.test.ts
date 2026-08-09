import {
  ProviderRequestIdentity,
  type ProviderRequestIdentity as ProviderRequestIdentityT,
} from '@/core/schema/provider-attempt';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type DirectProviderLifecycleFactory,
  type DirectProviderOperationContext,
  type DirectProviderOperationOptions,
  executeDirectProviderAttempt,
  isDirectProviderAttemptInvariantError,
  providerOperationIdForInvocation,
} from './direct-provider-attempt';
import { ProviderAttemptLifecycleError } from './provider-attempt-lifecycle';

function operationContext(): {
  context: DirectProviderOperationContext;
  createLifecycle: ReturnType<typeof vi.fn<DirectProviderLifecycleFactory>>;
} {
  const createLifecycle = vi.fn<DirectProviderLifecycleFactory>();
  return {
    createLifecycle,
    context: {
      caller: 'api',
      deadlineAt: new Date('2030-01-01T00:00:00.000Z'),
      mode: 'observe',
      operationId: '00000000-0000-4000-8000-000000000001',
      createLifecycle,
    },
  };
}

type AttemptRecord = { identity: ProviderRequestIdentityT; evidence?: unknown };

function trackingContext(records: AttemptRecord[]): DirectProviderOperationOptions {
  const createLifecycle: DirectProviderLifecycleFactory = (input) => ({
    identity: input.identity,
    acquire: async () => ({
      admission: 'acquired',
      reserveProviderStart: async () => undefined,
      recordExternalRequestId: async () => undefined,
      finish: async (evidence) => {
        records.push({ identity: input.identity, evidence });
        return 'settled';
      },
    }),
  });
  return {
    caller: 'worker',
    deadlineAt: new Date('2030-01-01T00:00:00.000Z'),
    mode: 'observe',
    operationAnchor: '00000000-0000-4000-8000-000000000010',
    createLifecycle,
  };
}

function fixedIdentity(attemptId: string, operationId: string) {
  return ProviderRequestIdentity.parse({
    attemptId,
    operationId,
    attemptKind: 'wire',
    provider: 'test-provider',
    model: 'test-model',
    lane: 'test-lane',
    protocol: 'test-protocol',
    endpointClass: 'test-endpoint',
    caller: 'api',
    operationKind: 'test-operation',
  });
}

describe('executeDirectProviderAttempt', () => {
  it.each([
    ['absent config', {}, 'off', null],
    [
      'global off',
      {
        AI_PROVIDER_ATTEMPT_ADMISSION_MODE: 'off',
        AI_PROVIDER_ATTEMPT_ADMISSION_POLICIES_JSON: JSON.stringify({
          'glm.memory-reconcile': { maxConcurrentAttempts: 2, maxAttemptStartsPerMinute: 5 },
        }),
      },
      'off',
      null,
    ],
    [
      'unlisted lane policy',
      {
        AI_PROVIDER_ATTEMPT_ADMISSION_MODE: 'observe',
        AI_PROVIDER_ATTEMPT_ADMISSION_POLICIES_JSON: JSON.stringify({
          'dashscope.embedding': { maxConcurrentAttempts: 3, maxAttemptStartsPerMinute: 7 },
        }),
      },
      'off',
      null,
    ],
    [
      'listed observe policy',
      {
        AI_PROVIDER_ATTEMPT_ADMISSION_MODE: 'observe',
        AI_PROVIDER_ATTEMPT_ADMISSION_POLICIES_JSON: JSON.stringify({
          'glm.memory-reconcile': { maxConcurrentAttempts: 2, maxAttemptStartsPerMinute: 5 },
        }),
      },
      'observe',
      { maxConcurrentAttempts: 2, maxAttemptStartsPerMinute: 5 },
    ],
    [
      'listed enforce policy',
      {
        AI_PROVIDER_ATTEMPT_ADMISSION_MODE: 'enforce',
        AI_PROVIDER_ATTEMPT_ADMISSION_POLICIES_JSON: JSON.stringify({
          'glm.memory-reconcile': { maxConcurrentAttempts: 2, maxAttemptStartsPerMinute: 5 },
        }),
      },
      'enforce',
      { maxConcurrentAttempts: 2, maxAttemptStartsPerMinute: 5 },
    ],
  ] as const)(
    'passes resolver result through the direct production seam for %s',
    async (_scenario, env, expectedMode, expectedPolicy) => {
      const execute = vi.fn().mockResolvedValue('provider-result');
      const createLifecycle = vi.fn<DirectProviderLifecycleFactory>((input) => ({
        identity: input.identity,
        acquire: async () => ({
          admission: input.mode === 'off' ? 'off' : 'acquired',
          reserveProviderStart: async () => undefined,
          recordExternalRequestId: async () => undefined,
          finish: async () => (input.mode === 'off' ? 'untracked' : 'settled'),
        }),
      }));
      const context: DirectProviderOperationContext = {
        caller: 'worker',
        deadlineAt: new Date('2030-01-01T00:00:00.000Z'),
        env,
        operationId: '00000000-0000-4000-8000-000000000071',
        createLifecycle,
      };

      await expect(
        executeDirectProviderAttempt(
          context,
          {
            provider: 'glm',
            model: 'glm-5.2',
            lane: 'glm.memory-reconcile',
            protocol: 'http',
            endpointClass: 'openai-compatible.chat-completions',
            operationKind: 'memory_reconcile',
            unknownCostCurrency: 'CNY',
          },
          execute,
        ),
      ).resolves.toMatchObject({ value: 'provider-result' });
      expect(createLifecycle).toHaveBeenCalledWith(
        expect.objectContaining({ mode: expectedMode, policy: expectedPolicy }),
      );
      expect(execute).toHaveBeenCalledOnce();
    },
  );

  it('allows the provider callback after an observe would-deny', async () => {
    const execute = vi.fn().mockResolvedValue('observed');
    const { context, createLifecycle } = operationContext();
    createLifecycle.mockReturnValue({
      identity: fixedIdentity('00000000-0000-4000-8000-000000000046', context.operationId),
      acquire: async () => ({
        admission: 'would_deny',
        reserveProviderStart: async () => undefined,
        recordExternalRequestId: async () => undefined,
        finish: async () => 'settled',
      }),
    });

    await expect(
      executeDirectProviderAttempt(
        context,
        {
          provider: 'glm',
          model: 'glm-5.2',
          lane: 'glm.memory-reconcile',
          protocol: 'http',
          endpointClass: 'openai-compatible.chat-completions',
          operationKind: 'memory_reconcile',
          unknownCostCurrency: 'CNY',
        },
        execute,
      ),
    ).resolves.toMatchObject({ value: 'observed' });
    expect(execute).toHaveBeenCalledOnce();
  });

  it('does not invoke the provider callback after an enforce denial', async () => {
    const execute = vi.fn().mockResolvedValue('unreachable');
    const { context, createLifecycle } = operationContext();
    createLifecycle.mockReturnValue({
      identity: fixedIdentity('00000000-0000-4000-8000-000000000047', context.operationId),
      acquire: async () => {
        throw new ProviderAttemptLifecycleError(
          'capacity_exhausted',
          '00000000-0000-4000-8000-000000000047',
        );
      },
    });

    await expect(
      executeDirectProviderAttempt(
        context,
        {
          provider: 'glm',
          model: 'glm-5.2',
          lane: 'glm.memory-reconcile',
          protocol: 'http',
          endpointClass: 'openai-compatible.chat-completions',
          operationKind: 'memory_reconcile',
          unknownCostCurrency: 'CNY',
        },
        execute,
      ),
    ).rejects.toMatchObject({ reason: 'capacity_exhausted' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('classifies lifecycle invariants without treating ordinary control-plane unavailability as invariant', () => {
    expect(
      isDirectProviderAttemptInvariantError(
        new ProviderAttemptLifecycleError('terminal_reuse', '00000000-0000-4000-8000-000000000044'),
      ),
    ).toBe(true);
    expect(
      isDirectProviderAttemptInvariantError(
        new ProviderAttemptLifecycleError(
          'control_plane_unavailable',
          '00000000-0000-4000-8000-000000000045',
        ),
      ),
    ).toBe(false);
    expect(isDirectProviderAttemptInvariantError(new Error('provider failed'))).toBe(false);
  });

  it('reserves immediately before the wire call and settles reported truth once', async () => {
    const calls: string[] = [];
    const finish = vi.fn().mockResolvedValue('settled');
    const { context, createLifecycle } = operationContext();
    createLifecycle.mockReturnValue({
      identity: fixedIdentity('00000000-0000-4000-8000-000000000002', context.operationId),
      acquire: async () => ({
        admission: 'acquired',
        reserveProviderStart: async () => {
          calls.push('reserve');
        },
        recordExternalRequestId: async () => {
          calls.push('external-id');
        },
        finish,
      }),
    });

    const result = await executeDirectProviderAttempt(
      context,
      {
        provider: 'glm',
        model: 'glm-5.2',
        lane: 'memory_reconcile',
        protocol: 'openai-compatible',
        endpointClass: 'chat_completions',
        operationKind: 'memory_reconcile',
        unknownCostCurrency: 'CNY',
      },
      async (attempt) => {
        calls.push('fetch');
        await attempt.recordExternalRequestId('provider-request-1');
        attempt.reportUsage({ input: 11, output: 7, total: 18 });
        attempt.estimateCost({ amount: 0.000032, currency: 'CNY', source: 'glm-pricebook' });
        return 'ok';
      },
    );

    expect(result).toEqual({
      value: 'ok',
      attemptId: '00000000-0000-4000-8000-000000000002',
    });
    expect(calls).toEqual(['reserve', 'fetch', 'external-id']);
    expect(finish).toHaveBeenCalledTimes(1);
    expect(finish).toHaveBeenCalledWith({
      terminal: 'succeeded',
      reason: 'provider_response_accepted',
      wireCount: 1,
      usage: {
        basis: 'reported',
        unit: 'tokens',
        input: 11,
        output: 7,
        total: 18,
        source: 'provider_response',
      },
      cost: {
        basis: 'estimated',
        amount: 0.000032,
        currency: 'CNY',
        source: 'glm-pricebook',
      },
    });
  });

  it('preserves an aborted terminal and rethrows the original error', async () => {
    const abort = new DOMException('aborted', 'AbortError');
    const finish = vi.fn().mockResolvedValue('settled');
    const { context, createLifecycle } = operationContext();
    createLifecycle.mockReturnValue({
      identity: fixedIdentity('00000000-0000-4000-8000-000000000003', context.operationId),
      acquire: async () => ({
        admission: 'acquired',
        reserveProviderStart: async () => undefined,
        recordExternalRequestId: async () => undefined,
        finish,
      }),
    });

    await expect(
      executeDirectProviderAttempt(
        context,
        {
          provider: 'dashscope',
          model: 'text-embedding-v4',
          lane: 'embedding',
          protocol: 'openai-compatible',
          endpointClass: 'embeddings',
          operationKind: 'embed_texts',
          unknownCostCurrency: null,
        },
        async (attempt) => {
          attempt.markTerminal('aborted', 'provider_request_aborted');
          throw abort;
        },
      ),
    ).rejects.toBe(abort);
    expect(finish).toHaveBeenCalledTimes(1);
    expect(finish).toHaveBeenCalledWith(
      expect.objectContaining({ terminal: 'aborted', reason: 'provider_request_aborted' }),
    );
  });

  it('surfaces settlement failure instead of the provider error after a wire burn', async () => {
    const providerError = new TypeError('network failed');
    const settlementError = new ProviderAttemptLifecycleError(
      'control_plane_unavailable',
      '00000000-0000-4000-8000-000000000004',
    );
    const { context, createLifecycle } = operationContext();
    createLifecycle.mockReturnValue({
      identity: fixedIdentity('00000000-0000-4000-8000-000000000004', context.operationId),
      acquire: async () => ({
        admission: 'acquired',
        reserveProviderStart: async () => undefined,
        recordExternalRequestId: async () => undefined,
        finish: async () => {
          throw settlementError;
        },
      }),
    });

    await expect(
      executeDirectProviderAttempt(
        context,
        {
          provider: 'glm',
          model: 'glm-5.2',
          lane: 'glm.memory-reconcile',
          protocol: 'http',
          endpointClass: 'openai-compatible.chat-completions',
          operationKind: 'memory_reconcile',
          unknownCostCurrency: 'CNY',
        },
        async (attempt) => {
          attempt.markTerminal('failed', 'provider_network_error');
          throw providerError;
        },
      ),
    ).rejects.toBe(settlementError);
  });

  it('keeps explicit durable anchors stable and omitted anchors invocation-scoped', () => {
    const durable = '00000000-0000-4000-8000-000000000005';
    expect(providerOperationIdForInvocation(durable)).toBe(durable);
    const first = providerOperationIdForInvocation('question-block-cuid');
    const second = providerOperationIdForInvocation('question-block-cuid');
    const distinct = providerOperationIdForInvocation('different-question-block-cuid');
    expect(first).toBe(second);
    expect(first).not.toBe(distinct);
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(providerOperationIdForInvocation()).not.toBe(providerOperationIdForInvocation());
    expect(() => providerOperationIdForInvocation('   ')).toThrow(
      'durable operation anchor must be nonblank',
    );
  });
});

beforeEach(() => {
  vi.unstubAllGlobals();
  process.env.DASHSCOPE_API_KEY = 'test-key';
});

describe('embedMany', () => {
  it('posts to compat /embeddings and returns 1024-dim vectors', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: Array(1024).fill(0.01) }] }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const { embedMany } = await import('./embed');
    const out = await embedMany(['hello'], trackingContext([]));
    expect(out).toHaveLength(1);
    expect(out[0]).toHaveLength(1024);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/embeddings$/);
    expect(JSON.parse(init.body).model).toBe('text-embedding-v4');
    expect(JSON.parse(init.body).dimensions).toBe(1024);
  });

  it('throws on non-ok response', async () => {
    const records: AttemptRecord[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 503, text: async () => 'down' }),
    );
    const { embedMany } = await import('./embed');
    await expect(embedMany(['x'], trackingContext(records))).rejects.toThrow(/503/);
    expect(records[0]?.evidence).toEqual(
      expect.objectContaining({ terminal: 'failed', reason: 'provider_http_503', wireCount: 1 }),
    );
  });

  it('chunks inputs at the DashScope batch cap (10) and stitches in order', async () => {
    // 25 inputs -> 3 requests (10 + 10 + 5). Each request must carry <= 10 inputs;
    // each chunk responds with index-tagged items returned out of order, and the
    // final stitched output must follow the original input order.
    const fetchMock = vi.fn().mockImplementation(async (_url, init) => {
      const inputs = JSON.parse(init.body).input as string[];
      expect(inputs.length).toBeLessThanOrEqual(10);
      // Encode the input's own value into the embedding so we can verify ordering.
      const data = inputs.map((text, i) => ({
        index: i,
        embedding: Array(1024).fill(Number(text)),
      }));
      // Return out of order to exercise index-based reassembly.
      data.reverse();
      return { ok: true, json: async () => ({ data }) };
    });
    vi.stubGlobal('fetch', fetchMock);
    const { embedMany } = await import('./embed');
    const texts = Array.from({ length: 25 }, (_, i) => String(i));
    const records: AttemptRecord[] = [];
    const out = await embedMany(texts, trackingContext(records));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(records).toHaveLength(3);
    expect(new Set(records.map((record) => record.identity.attemptId)).size).toBe(3);
    expect(new Set(records.map((record) => record.identity.operationId))).toEqual(
      new Set(['00000000-0000-4000-8000-000000000010']),
    );
    expect(records.every((record) => record.identity.lane === 'dashscope.embedding')).toBe(true);
    expect(records.every((record) => record.identity.protocol === 'http')).toBe(true);
    expect(
      records.every((record) => record.identity.endpointClass === 'openai-compatible.embeddings'),
    ).toBe(true);
    expect(records.map((record) => record.evidence)).toEqual([
      expect.objectContaining({ terminal: 'succeeded', wireCount: 1 }),
      expect.objectContaining({ terminal: 'succeeded', wireCount: 1 }),
      expect.objectContaining({ terminal: 'succeeded', wireCount: 1 }),
    ]);
    expect(out).toHaveLength(25);
    // out[i] should encode input i (i.e. vector filled with Number(texts[i]) = i).
    out.forEach((v, i) => expect(v[0]).toBe(i));
  });

  it('returns empty without acquiring a provider attempt', async () => {
    const records: AttemptRecord[] = [];
    const { embedMany } = await import('./embed');
    await expect(embedMany([], trackingContext(records))).resolves.toEqual([]);
    expect(records).toEqual([]);
  });

  it('uses a fresh attempt id when the same operation repeats a wire call', async () => {
    const records: AttemptRecord[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ embedding: Array(1024).fill(0.01) }] }),
      }),
    );
    const { embedMany } = await import('./embed');
    const context = trackingContext(records);
    await embedMany(['first'], context);
    await embedMany(['second'], context);
    expect(records).toHaveLength(2);
    expect(records[0]?.identity.operationId).toBe(records[1]?.identity.operationId);
    expect(records[0]?.identity.attemptId).not.toBe(records[1]?.identity.attemptId);
  });

  it('settles network and abort failures with their original thrown errors', async () => {
    const networkRecords: AttemptRecord[] = [];
    const networkError = new TypeError('socket closed');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(networkError));
    const { embedMany } = await import('./embed');
    await expect(embedMany(['network'], trackingContext(networkRecords))).rejects.toBe(
      networkError,
    );
    expect(networkRecords[0]?.evidence).toEqual(
      expect.objectContaining({ terminal: 'failed', reason: 'provider_network_error' }),
    );

    const abortRecords: AttemptRecord[] = [];
    const abortError = new DOMException('aborted', 'AbortError');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abortError));
    await expect(embedMany(['abort'], trackingContext(abortRecords))).rejects.toBe(abortError);
    expect(abortRecords[0]?.evidence).toEqual(
      expect.objectContaining({ terminal: 'aborted', reason: 'provider_request_aborted' }),
    );
  });

  it('throws when a chunk returns the wrong number of vectors', async () => {
    const records: AttemptRecord[] = [];
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ index: 0, embedding: Array(1024).fill(0.01) }] }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const { embedMany } = await import('./embed');
    await expect(embedMany(['a', 'b'], trackingContext(records))).rejects.toThrow(
      /returned 1 vectors for 2 inputs/,
    );
    expect(records[0]?.evidence).toEqual(
      expect.objectContaining({ terminal: 'failed', reason: 'provider_response_malformed' }),
    );
  });
});
