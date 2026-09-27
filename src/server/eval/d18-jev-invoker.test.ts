// YUK-1058 live-lane — d18-jev-invoker unit tests (no DB, no wire).
// `run` seam replaces runTypedPrimitiveTask; `db` is an untouched stub —
// the fake never consults it. Register in vitest.shared.ts fastTestInclude
// (src/server/** has no unit glob).

import { describe, expect, it } from 'vitest';
import type { EvalInvocationRequest } from '@/core/eval/d18-harness';
import type { JevSystemOneResponseT } from '@/core/schema/jev-systemone';
import type { Db } from '@/db/client';
import type { TypedPrimitiveOutcome } from '@/server/ai/typed-primitive-runner';

import { jevAnswerToScore, jevOpenRouterInvoker } from './d18-jev-invoker';

const db = {} as Db;

function item(
  request: unknown,
  expect?: { max_points: number; gold_points: number },
): EvalInvocationRequest {
  return {
    item: { id: 'it-1', split: 'dev', request, expect },
    attempt: 1,
  };
}

const VALID_INPUT = {
  state: { text: '2+2=4' },
  questions: {
    q1: {
      type: 'noul' as const,
      instructions: 'Is the statement correct?',
      criteria: { true: 'Correct.', false: 'Incorrect.' },
    },
  },
};

function fakeOutcome(overrides: Partial<TypedPrimitiveOutcome<JevSystemOneResponseT>> = {}) {
  const output: JevSystemOneResponseT = {
    model: 'typesafe/jev-1.13-20260917',
    provider: 'TypeSafe',
    answers: { q1: { type: 'noul', noul: 0.9, confidence: 0.8 } },
    usage: { input_tokens: 10, output_tokens: 5, cost: 0.000012 },
  };
  return {
    task_run_id: 'run-1',
    output,
    attempts: 1,
    usage: { inputTokens: 10, outputTokens: 5 },
    cost_usd: 0.000012,
    cost_basis: 'reported' as const,
    cost_ref: 'openrouter:usage.cost',
    model: 'typesafe/jev-1.13',
    unknown_cost: false,
    ...overrides,
  };
}

describe('jevAnswerToScore', () => {
  const noulQ = VALID_INPUT.questions.q1;
  const scoreQ = { type: 'score' as const, instructions: 'x', criteria: ['l0', 'l1', 'l2'] };

  it('noul → P × max_points', () => {
    expect(jevAnswerToScore(noulQ, { type: 'noul', noul: 0.5 }, 4)).toEqual({
      points_awarded: 2,
      max_points: 4,
    });
  });

  it('score → expectation over declared level order × max', () => {
    expect(jevAnswerToScore(scoreQ, { type: 'score', score: 2 }, 4)).toEqual({
      points_awarded: 4,
      max_points: 4,
    });
    // 越界钳位：score=9 超过 levels-1 → 满分
    expect(jevAnswerToScore(scoreQ, { type: 'score', score: 9 }, 4)).toEqual({
      points_awarded: 4,
      max_points: 4,
    });
  });

  it('mismatched/choice/缺失 → null（不编造判分）', () => {
    expect(jevAnswerToScore(scoreQ, { type: 'noul', noul: 1 }, 4)).toBeNull();
    expect(jevAnswerToScore(noulQ, { type: 'choice', choice: 'a' }, 4)).toBeNull();
    expect(jevAnswerToScore(noulQ, undefined, 4)).toBeNull();
    expect(jevAnswerToScore(undefined, { type: 'noul', noul: 1 }, 4)).toBeNull();
  });
});

describe('jevOpenRouterInvoker', () => {
  it('lane=jev-openrouter;estimate is the conservative reserve', () => {
    const inv = jevOpenRouterInvoker({ db, run: async () => fakeOutcome() });
    expect(inv.lane).toBe('jev-openrouter');
    const est = inv.estimate(item(VALID_INPUT));
    expect(est.kind).toBe('verification');
    expect(est.estimatedCostUsd).toBeGreaterThan(0);
  });

  it('settled call: output/usage/cost/score/escalated mirrored', async () => {
    const calls: unknown[] = [];
    const inv = jevOpenRouterInvoker({
      db,
      run: async (_kind, input, _ctx) => {
        calls.push(input);
        return fakeOutcome();
      },
    });
    const result = await inv.invoke(item(VALID_INPUT, { max_points: 4, gold_points: 4 }));
    expect(result.reportedCostUsd).toBeCloseTo(0.000012);
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(result.score).toEqual({ points_awarded: 3.6, max_points: 4 });
    expect(result.escalated).toBe(false);
    expect(calls).toHaveLength(1);
    // canonical typed input passed through verbatim
    expect(calls[0]).toEqual(VALID_INPUT);
  });

  it('no expect → no score (cost/latency only, no fabricated judgment)', async () => {
    const inv = jevOpenRouterInvoker({ db, run: async () => fakeOutcome() });
    const result = await inv.invoke(item(VALID_INPUT));
    expect(result.score).toBeUndefined();
  });

  it('unknown_cost → reportedCostUsd null (gate falls back to reserve)', async () => {
    const inv = jevOpenRouterInvoker({
      db,
      run: async () => fakeOutcome({ cost_usd: 0.005, cost_basis: 'unknown', unknown_cost: true }),
    });
    const result = await inv.invoke(item(VALID_INPUT));
    expect(result.reportedCostUsd).toBeNull();
  });

  it('schema-invalid request → invoke throws (harness records invoke_failed)', async () => {
    const inv = jevOpenRouterInvoker({ db, run: async () => fakeOutcome() });
    await expect(inv.invoke(item({ not: 'jev' }))).rejects.toThrow();
  });
});
