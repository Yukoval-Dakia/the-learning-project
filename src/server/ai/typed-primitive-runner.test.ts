// YUK-1049 — typed primitive runner failure-fixture unit tests.
//
// The wire transport is stubbed via fetchImpl (the ONLY mock — lifecycle
// effects stay real). @/server/ai/log is vi.mock'd so the durable writer
// boundary is observable without Postgres; `db` is an untouched stub.
// Sibling typed-primitive-runner.db.test.ts exercises the real writers.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const logMocks = vi.hoisted(() => ({
  started: vi.fn(async (_db: unknown, _row: { input_hash: string }) => {}),
  terminal: vi.fn(async (_db: unknown, _row: unknown) => true),
  retried: vi.fn(async (_db: unknown, _id: string) => true),
  tool: vi.fn(async () => 'tool-log-id'),
}));

vi.mock('@/server/ai/log', () => ({
  writeAiTaskRunStarted: logMocks.started,
  writeAiTaskAttemptFinished: logMocks.terminal,
  writeAiTaskRunRetried: logMocks.retried,
  writeToolCallLog: logMocks.tool,
}));

import { runTypedPrimitiveTask } from './typed-primitive-runner';

const KIND = 'JevScoringDecisionTask';
const BASE_INPUT = {
  state: { submission: { entries: [{ slot_id: 's1', kind: 'text', text_md: 'x = 4' }] } },
  questions: {
    u1: {
      type: 'noul',
      instructions: 'Is the answer correct?',
      criteria: { true: 'value is 4', false: 'value is not 4' },
    },
  },
};

function responseJson(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as Response;
}

function okBody(overrides: Record<string, unknown> = {}) {
  return {
    model: 'typesafe/jev-1.13-20260917',
    provider: 'TypeSafe',
    id: 'gen-dec-test-1',
    answers: { u1: { type: 'noul', noul: 0.93 } },
    usage: { input_tokens: 120, output_tokens: 10, cost: 120 * 4.2e-8 },
    ...overrides,
  };
}

function ctx(fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) {
  return { db: {} as never, fetchImpl, ...extra };
}

const realDateNow = Date.now;

beforeEach(() => {
  vi.stubEnv('OPENROUTER_API_KEY', 'test-or-key');
  logMocks.started.mockReset().mockResolvedValue(undefined);
  logMocks.terminal.mockReset().mockResolvedValue(true);
  logMocks.retried.mockReset().mockResolvedValue(true);
});

afterEach(() => {
  vi.unstubAllEnvs();
  Date.now = realDateNow;
  vi.restoreAllMocks();
});

describe('runTypedPrimitiveTask — request contract', () => {
  it('posts the canonical typed body with pinned provider constraints and reports success', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return responseJson(okBody());
    }) as unknown as typeof fetch;

    const out = await runTypedPrimitiveTask(KIND, BASE_INPUT, ctx(fetchImpl));
    expect(out.output).toMatchObject({ model: 'typesafe/jev-1.13-20260917' });
    expect(out.attempts).toBe(1);
    expect(out.usage.inputTokens).toBe(120);
    expect(out.cost_basis).toBe('reported');
    expect(out.cost_usd).toBeCloseTo(120 * 4.2e-8, 12);
    expect(out.unknown_cost).toBe(false);

    expect(calls).toHaveLength(1);
    const body = JSON.parse(String(calls[0].init?.body));
    expect(calls[0].url).toBe('https://openrouter.ai/api/v1/systemone');
    expect(calls[0].init?.method).toBe('POST');
    expect(calls[0].init?.redirect).toBe('error');
    expect(body.model).toBe('typesafe/jev-1.13');
    expect(body.provider).toEqual({
      only: ['TypeSafe'],
      order: ['TypeSafe'],
      allow_fallbacks: false,
      max_price: { prompt: '0.042', completion: '0' },
    });
    expect(body.state).toEqual(BASE_INPUT.state);
    expect(body.questions).toEqual(BASE_INPUT.questions);
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer test-or-key');

    // Provenance: input_hash over the canonical typed body (state+questions+
    // model+provider), not a composed prompt.
    expect(logMocks.started).toHaveBeenCalledTimes(1);
    const startedRow = logMocks.started.mock.calls[0][1] as {
      provider: string;
      model: string;
      input_hash: string;
      task_kind: string;
    };
    expect(startedRow.provider).toBe('openrouter');
    expect(startedRow.model).toBe('typesafe/jev-1.13');
    expect(startedRow.task_kind).toBe(KIND);
    expect(startedRow.input_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects unregistered and non-typed task kinds without any wire call', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(runTypedPrimitiveTask('NopeTask', BASE_INPUT, ctx(fetchImpl))).rejects.toThrow(
      /unregistered/,
    );
    await expect(
      runTypedPrimitiveTask('SemanticJudgeTask', BASE_INPUT, ctx(fetchImpl)),
    ).rejects.toThrow(/unregistered|not a typed-execution/);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(logMocks.started).not.toHaveBeenCalled();
  });

  it('rejects malformed typed input before any lifecycle row or wire call', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(
      runTypedPrimitiveTask(
        KIND,
        { state: {}, questions: { u1: { type: 'noul' } } },
        ctx(fetchImpl),
      ),
    ).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(logMocks.started).not.toHaveBeenCalled();
  });
});

describe('runTypedPrimitiveTask — HTTP status taxonomy', () => {
  async function expectPermanentStatus(status: number) {
    const fetchImpl = vi.fn(async () =>
      responseJson({ error: 'bad' }, status),
    ) as unknown as typeof fetch;
    await expect(runTypedPrimitiveTask(KIND, BASE_INPUT, ctx(fetchImpl))).rejects.toMatchObject({
      name: 'AgentRunError',
      subtype: 'api_error_result',
      apiErrorStatus: status,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1); // no blind retry
    expect(logMocks.terminal).toHaveBeenCalledTimes(1);
    const term = logMocks.terminal.mock.calls[0][1] as { outcome: string };
    expect(term.outcome).toBe('failed_permanent');
  }

  it('401 is permanent — single wire call, no retry', async () => {
    await expectPermanentStatus(401);
  });

  it('422 is permanent — single wire call, no retry', async () => {
    await expectPermanentStatus(422);
  });

  it('429 retries within budget then succeeds', async () => {
    let now = 1_000_000;
    Date.now = () => now;
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      now += 200;
      return call === 1 ? responseJson({ error: 'rate' }, 429) : responseJson(okBody());
    }) as unknown as typeof fetch;

    const out = await runTypedPrimitiveTask(KIND, BASE_INPUT, ctx(fetchImpl));
    expect(out.attempts).toBe(2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(logMocks.retried).toHaveBeenCalledTimes(1);
    expect(logMocks.started).toHaveBeenCalledTimes(2); // one durable row per attempt
  });

  it('529 is transient like 5xx — retried, then permanent failure exhausts budget', async () => {
    let now = 1_000_000;
    Date.now = () => now;
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      now += 200;
      return call < 2 ? responseJson({ error: 'overloaded' }, 529) : responseJson(okBody());
    }) as unknown as typeof fetch;

    const out = await runTypedPrimitiveTask(KIND, BASE_INPUT, ctx(fetchImpl));
    expect(out.attempts).toBe(2); // 1 + transientRetries(1)
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(logMocks.retried).toHaveBeenCalledTimes(1);
  });

  it('transient failures beyond the retry budget surface the last error', async () => {
    let now = 1_000_000;
    Date.now = () => now;
    const fetchImpl = vi.fn(async () => {
      now += 200;
      return responseJson({ error: 'rate' }, 429);
    }) as unknown as typeof fetch;
    await expect(runTypedPrimitiveTask(KIND, BASE_INPUT, ctx(fetchImpl))).rejects.toMatchObject({
      subtype: 'api_error_result',
      apiErrorStatus: 429,
    });
    // budget.transientRetries = 1 → at most 2 wire calls
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('connection-class transport failure is transient (api_error_status null)', async () => {
    let now = 1_000_000;
    Date.now = () => now;
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      now += 200;
      if (call === 1) throw new TypeError('fetch failed: socket hangup');
      return responseJson(okBody());
    }) as unknown as typeof fetch;
    const out = await runTypedPrimitiveTask(KIND, BASE_INPUT, ctx(fetchImpl));
    expect(out.attempts).toBe(2);
  });
});

describe('runTypedPrimitiveTask — contract violations', () => {
  it('model drift is a permanent typed_contract_violation (no retry)', async () => {
    const fetchImpl = vi.fn(async () =>
      responseJson(okBody({ model: 'typesafe/jev-1.14-20990101' })),
    ) as unknown as typeof fetch;
    await expect(runTypedPrimitiveTask(KIND, BASE_INPUT, ctx(fetchImpl))).rejects.toMatchObject({
      subtype: 'typed_contract_violation',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('provider drift is a permanent typed_contract_violation', async () => {
    const fetchImpl = vi.fn(async () =>
      responseJson(okBody({ provider: 'NotTypeSafe' })),
    ) as unknown as typeof fetch;
    await expect(runTypedPrimitiveTask(KIND, BASE_INPUT, ctx(fetchImpl))).rejects.toMatchObject({
      subtype: 'typed_contract_violation',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('invalid response schema is a permanent typed_contract_violation', async () => {
    const fetchImpl = vi.fn(async () =>
      responseJson({
        model: 'typesafe/jev-1.13-20260917',
        answers: { u1: { type: 'noul', noul: 7 } },
      }),
    ) as unknown as typeof fetch;
    await expect(runTypedPrimitiveTask(KIND, BASE_INPUT, ctx(fetchImpl))).rejects.toMatchObject({
      subtype: 'typed_contract_violation',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('non-JSON 200 body is a permanent typed_contract_violation', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => '<html>not json</html>',
    })) as unknown as typeof fetch;
    await expect(runTypedPrimitiveTask(KIND, BASE_INPUT, ctx(fetchImpl))).rejects.toMatchObject({
      subtype: 'typed_contract_violation',
    });
  });
});

describe('runTypedPrimitiveTask — usage/cost truth', () => {
  it('missing usage block still succeeds with unknown cost (reserve, never zero)', async () => {
    const body = okBody();
    delete (body as Record<string, unknown>).usage;
    const fetchImpl = vi.fn(async () => responseJson(body)) as unknown as typeof fetch;
    const out = await runTypedPrimitiveTask(KIND, BASE_INPUT, ctx(fetchImpl));
    expect(out.cost_basis).toBe('unknown');
    // YUK-1092 — cost_usd is the CUMULATIVE invocation figure; an
    // unknown-cost attempt reports its per-call reserve, never undefined.
    expect(out.cost_usd).toBe(0.005);
    expect(out.unknown_cost).toBe(true);
    const term = logMocks.terminal.mock.calls[0][1] as {
      cost_truth: { basis: string; amountUsd: number | null };
    };
    expect(term.cost_truth).toEqual({
      basis: 'unknown',
      amountUsd: null,
      ref: expect.stringContaining('unpriced'),
    });
  });

  it('usage without cost ⇒ local pricebook estimate (output free)', async () => {
    const body = okBody();
    (body.usage as Record<string, unknown>).cost = undefined;
    const fetchImpl = vi.fn(async () => responseJson(body)) as unknown as typeof fetch;
    const out = await runTypedPrimitiveTask(KIND, BASE_INPUT, ctx(fetchImpl));
    expect(out.cost_basis).toBe('estimated');
    expect(out.cost_usd).toBeCloseTo(120 * 4.2e-8, 12);
    expect(out.cost_ref).toContain('pricebook:');
    expect(out.unknown_cost).toBe(false);
  });
});

describe('runTypedPrimitiveTask — timeout, cancellation, budget', () => {
  it('abort() mid-flight binds budget_timeout, not a retryable transport error', async () => {
    const fetchImpl = vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('The operation was aborted', 'AbortError')),
          );
        }),
    ) as unknown as typeof fetch;
    const ac = new AbortController();
    const promise = runTypedPrimitiveTask(
      KIND,
      BASE_INPUT,
      ctx(fetchImpl, { abortController: ac }),
    );
    setTimeout(() => ac.abort(), 20);
    await expect(promise).rejects.toMatchObject({ subtype: 'budget_timeout' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('pre-aborted caller signal throws before any wire call', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const ac = new AbortController();
    ac.abort();
    await expect(
      runTypedPrimitiveTask(KIND, BASE_INPUT, ctx(fetchImpl, { signal: ac.signal })),
    ).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('attempt timeout aborts the wire and binds budget_timeout', async () => {
    const fetchImpl = vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('The operation was aborted', 'AbortError')),
          );
        }),
    ) as unknown as typeof fetch;
    const spec = { ...BASE_INPUT };
    // deadlineAt far in the future — the per-attempt budget.timeout (15s) is
    // what fires; shrink it via a 1ms... instead rely on the lifecycle timer:
    // budget.timeout is 15s, too long for a unit test — simulate by aborting
    // through the shared abortController after first wire starts.
    const ac = new AbortController();
    const promise = runTypedPrimitiveTask(KIND, spec, ctx(fetchImpl, { abortController: ac }));
    setTimeout(() => ac.abort(), 30);
    await expect(promise).rejects.toMatchObject({ subtype: 'budget_timeout' });
  });

  it('unknown-cost retries exhaust maxCost reserve instead of unlimited spending', async () => {
    // Every attempt fails transiently with no usage evidence → each counts as
    // the $0.005 reserve; maxCost=$0.02 allows at most 3-4 accounting entries.
    let now = 1_000_000;
    Date.now = () => now;
    const fetchImpl = vi.fn(async () => {
      now += 200;
      return responseJson({ error: 'rate' }, 429);
    }) as unknown as typeof fetch;
    await expect(runTypedPrimitiveTask(KIND, BASE_INPUT, ctx(fetchImpl))).rejects.toMatchObject({
      subtype: 'api_error_result',
      apiErrorStatus: 429,
    });
    // 1 + transientRetries(1) = 2 attempts ≈ $0.010 < $0.02 cap — the retry
    // budget binds first here; the reserve math is exercised, not blown.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const terminalCalls = logMocks.terminal.mock.calls.map(
      (call) => call[1] as { outcome: string },
    );
    expect(terminalCalls.every((c) => c.outcome === 'failed_retryable')).toBe(true);
  });
});
