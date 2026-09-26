// YUK-1092 — typed primitive runner cumulative-cost unit tests (no DB).
//
// The success-path cost must be the CUMULATIVE invocation spend — every
// retried wire attempt's settled/reserved cost plus the terminal attempt's
// truth — not the last attempt alone (PR #1477 P1: undercounting lets
// plan-level max_total_cost bounds be blown after retries).
//
// Two transient failures + one success needs transientRetries=2, which the
// pinned JevScoringDecisionTask budget (transientRetries=1) cannot express.
// The registry is therefore mocked with a retry-2 clone of the SAME task
// definition — the mock alters ONLY the retry budget number; lifecycle, wire
// stubbing (fetchImpl), taxonomy and cost accounting all stay real.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const logMocks = vi.hoisted(() => ({
  started: vi.fn(async (_db: unknown, _row: unknown) => {}),
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

vi.mock('@/ai/registry', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/ai/registry')>();
  return {
    ...original,
    tasks: {
      ...original.tasks,
      JevScoringDecisionTask: {
        ...original.tasks.JevScoringDecisionTask,
        budget: {
          ...original.tasks.JevScoringDecisionTask.budget,
          transientRetries: 2,
        },
      },
    },
  };
});

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

const SUCCEED_COST_USD = 120 * 4.2e-8;
const RESERVE_USD = 0.005;

function responseJson(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as Response;
}

const okBody = {
  model: 'typesafe/jev-1.13-20260917',
  provider: 'TypeSafe',
  id: 'gen-dec-cum-1',
  answers: { u1: { type: 'noul', noul: 0.93 } },
  usage: { input_tokens: 120, output_tokens: 10, cost: SUCCEED_COST_USD },
};

beforeEach(() => {
  vi.stubEnv('OPENROUTER_API_KEY', 'test-or-key');
  logMocks.started.mockReset().mockResolvedValue(undefined);
  logMocks.terminal.mockReset().mockResolvedValue(true);
  logMocks.retried.mockReset().mockResolvedValue(true);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('runTypedPrimitiveTask — cumulative invocation cost (YUK-1092)', () => {
  it('transient + transient + success ⇒ cost_usd = reserve + reserve + settled truth', async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      return call < 3 ? responseJson({ error: 'rate' }, 429) : responseJson(okBody);
    }) as unknown as typeof fetch;

    const out = await runTypedPrimitiveTask(KIND, BASE_INPUT, {
      db: {} as never,
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(out.attempts).toBe(3);
    // The two failed attempts contributed their reserve ($0.005 each — wire
    // attempted, cost truth unknown); the success contributes its reported
    // $0.00000504. Cumulative, not the last attempt's cost_usd alone.
    expect(out.cost_usd).toBeCloseTo(2 * RESERVE_USD + SUCCEED_COST_USD, 12);
    expect(out.unknown_cost).toBe(true); // a settled attempt had unknown cost
    expect(logMocks.retried).toHaveBeenCalledTimes(2);
    expect(logMocks.started).toHaveBeenCalledTimes(3); // one durable row per attempt
  });

  it('transient + success ⇒ cumulative = reserve + settled (single retry sanity)', async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      return call === 1 ? responseJson({ error: 'rate' }, 429) : responseJson(okBody);
    }) as unknown as typeof fetch;

    const out = await runTypedPrimitiveTask(KIND, BASE_INPUT, {
      db: {} as never,
      fetchImpl,
    });
    expect(out.attempts).toBe(2);
    expect(out.cost_usd).toBeCloseTo(RESERVE_USD + SUCCEED_COST_USD, 12);
    expect(out.cost_basis).toBe('reported');
    expect(out.unknown_cost).toBe(true);
  });
});
