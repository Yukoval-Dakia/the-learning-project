import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runEvalHarness } from '@/core/eval/d18-harness';
import { ai_task_runs } from '@/db/schema';
import { runTypedPrimitiveTask } from '@/server/ai/typed-primitive-runner';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { jevOpenRouterInvoker } from './d18-jev-invoker';
import { aiTaskRunEvidenceSink } from './d18-seal';

const request = {
  state: { submission: { text: '若 x + 3 = 7，则 x = 4。这里先移项，再验算。' } },
  questions: {
    q1: {
      type: 'noul',
      instructions: '检查推导与最终答案。',
      criteria: { true: '推导正确，结果为 4。', false: '推导或结果错误。' },
    },
  },
};

beforeEach(async () => {
  await resetDb();
});

describe('D18 harness durable cost and attempt accounting', () => {
  it('seals an unknown-cost success once without violating the database constraint', async () => {
    const report = await runEvalHarness({
      runId: 'd18-unknown-cost',
      corpus: [{ id: 'unknown', split: 'holdout', request }],
      invoker: {
        lane: 'jev-openrouter',
        estimate: () => ({
          kind: 'verification',
          inputTokens: 512,
          outputTokens: 32,
          estimatedCostUsd: 0.005,
        }),
        invoke: async () => ({
          output: { answers: { q1: { type: 'noul', noul: 0.95 } } },
          usage: { inputTokens: 512, outputTokens: 32 },
          reportedCostUsd: null,
        }),
      },
      sink: aiTaskRunEvidenceSink(testDb(), { provider: 'openrouter', model: 'typesafe/jev-1.13' }),
    });
    expect(report.failures).toEqual([]);
    expect(report.ledger.spentUsd).toBe(0.005);
    const rows = await testDb().select().from(ai_task_runs);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      task_kind: 'D18EvalHarness',
      status: 'success',
      cost_basis: 'estimated',
      cost_usd: 0.005,
    });
  });

  it('accounts for every 429 wire at the harness gate and preserves failed reserves', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'test-only-key');
    try {
      const fetchImpl: typeof fetch = vi.fn(
        async () => new Response('rate limited', { status: 429 }),
      );
      const invoker = jevOpenRouterInvoker({
        db: testDb(),
        run: (kind, input, ctx) => runTypedPrimitiveTask(kind, input, { ...ctx, fetchImpl }),
      });
      const report = await runEvalHarness({
        runId: 'd18-retry-cap',
        corpus: [{ id: 'retry', split: 'holdout', request }],
        invoker,
        sink: aiTaskRunEvidenceSink(testDb(), {
          provider: 'openrouter',
          model: 'typesafe/jev-1.13',
        }),
        maxAttemptsPerItem: 3,
        caps: {
          totalCostUsd: 5,
          maxVerificationCalls: 2,
          maxRequests: 2,
          perCallInputTokens: 32000,
          perCallOutputTokens: 8192,
          reserveUsd: 0.02,
        },
      });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(report).toMatchObject({
        invocations: 2,
        retries: 1,
        halt_reason: 'verification_ceiling',
      });
      expect(report.ledger).toMatchObject({ requests: 2, verificationCalls: 2, spentUsd: 0.01 });
      const rows = await testDb().select().from(ai_task_runs);
      expect(rows.filter((row) => row.task_kind === 'JevScoringDecisionTask')).toHaveLength(2);
      const seals = rows.filter((row) => row.task_kind === 'D18EvalHarness');
      expect(seals).toHaveLength(3);
      expect(
        seals.filter((row) => row.cost_basis === 'estimated').map((row) => row.cost_usd),
      ).toEqual([0.005, 0.005]);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
