// YUK-1092 — evaluateSubmission model_executor 装配点单测（无 DB）。
//
// resolveModelExecutor 是组合点上的 descriptor → ModelUnitExecutorPort
// 解析器。断言三件事：
//   1. 端口/undefined 直通 —— 注入 seam 语义零变化；
//   2. {kind:'jev'} + Tx 句柄 ⇒ fail-loud（模型 run/cost 台账是独立证据，
//      绝不能落在会随评估事务回滚的句柄上）；
//   3. {kind:'jev'} + 池化 Db ⇒ 装配出真正服务的 Jev 端口（缺凭证时返回
//      Jev 专属的 infra_failure 文案，证明装配产物是 Jev executor 而非
//      通用占位）。
// import 链安全：jev-model-executor → typed-primitive-runner → run-lifecycle
// 对 @/db/client 均为 type-only；@/db/schema 是纯 zod/table 定义，不连接。

import { describe, expect, it } from 'vitest';
import type { ModelExecutorRequest, ModelUnitOutcomeT } from '@/core/schema/assessment';
import type { Db, Tx } from '@/db/client';
import { type JevModelExecutorSpec, resolveModelExecutor } from './evaluate-submission';

const fakeDb = { $client: {} } as unknown as Db;
const fakeTx = {} as unknown as Tx;

describe('resolveModelExecutor — model_executor assembly (YUK-1092)', () => {
  it('passes through an injected port / undefined unchanged', () => {
    const port = async (): Promise<ModelUnitOutcomeT> => ({
      kind: 'pending',
      pending: { reason: 'unjudgeable', detail: 'fixture pending' },
      run_refs: [],
    });
    expect(resolveModelExecutor(fakeDb, port)).toBe(port);
    expect(resolveModelExecutor(fakeDb, undefined)).toBeUndefined();
    expect(resolveModelExecutor(fakeTx, port)).toBe(port); // ports are handle-free
  });

  it('jev spec over a Tx handle ⇒ fail-loud invalid_executor_spec (ledger rows must not roll back)', () => {
    const spec: JevModelExecutorSpec = { kind: 'jev', deadline_at: Date.now() + 60_000 };
    expect(() => resolveModelExecutor(fakeTx, spec)).toThrowError(/invalid_executor_spec/);
    expect(() => resolveModelExecutor(fakeTx, spec)).toThrowError(/requires the pool Db handle/);
  });

  it('jev spec over a Db handle assembles a serving Jev port (credential gate detail proves the lane)', async () => {
    const spec: JevModelExecutorSpec = {
      kind: 'jev',
      deadline_at: Date.now() + 60_000,
      rule_threshold: 0.8,
    };
    const port = resolveModelExecutor(fakeDb, spec);
    expect(typeof port).toBe('function');
    expect(port).not.toBeUndefined();

    const savedKey = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      const request: ModelExecutorRequest = {
        submission_id: 'sub_u',
        evaluation_group_id: 'grp_u',
        revision_id: 'rev_u',
        attempt: 1,
        scoring_unit_id: 'u1',
        executor: {
          kind: 'model_executor',
          task_kind: 'JevScoringDecisionTask',
          admitted_slice_id: 'slice_unit_test',
        },
        unit: {
          scoring_unit_id: 'u1',
          slot_refs: ['s1'],
          material_refs: [],
          evidence_slot_refs: [],
          requires_group_evidence: false,
          criterion: {
            kind: 'rule_reference',
            rule_id: 'r1',
            statement_md: 'award when correct',
            source: 'official',
          },
          points: 4,
        },
        slot_responses: [{ slot_id: 's1', kind: 'text', text_md: 'answer' }],
        group_evidence: [],
        materials: [],
        spent_cost_usd_micros: 0,
      };
      if (port === undefined) throw new Error('expected an assembled Jev port');
      const out = await port(request);
      // 凭证闸门 detail 是 Jev executor 专属文案 —— 装配产物确实就位，
      // 且全程没有触碰 db（无 run 行写出）。
      expect(out).toMatchObject({
        kind: 'pending',
        pending: {
          reason: 'infra_failure',
          retryable: false,
          detail: expect.stringContaining('no credentialed Jev lane'),
        },
      });
    } finally {
      if (savedKey !== undefined) process.env.OPENROUTER_API_KEY = savedKey;
    }
  });
});
