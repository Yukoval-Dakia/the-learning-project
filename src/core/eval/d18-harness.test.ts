import { describe, expect, it } from 'vitest';
import { D18_BUDGET_CAPS } from './d18-budget';
import {
  type EvalCorpusItem,
  type EvalEvidenceEntry,
  type EvalInvoker,
  runEvalHarness,
  stubInvoker,
} from './d18-harness';

// D18 eval harness（unit partition）：预算触顶即停 + gate_rejected 证据行、
// invoke_failed 不记 cost、retries 计入上限、证据 entry 形状（digest 不
// 含原文）、stub invoker 确定性。

const corpus = (n: number, split: 'dev' | 'holdout' = 'dev'): EvalCorpusItem[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `item-${i}`,
    split,
    request: { prompt: `q${i}` },
  }));

class MemSink {
  entries: EvalEvidenceEntry[] = [];
  closed = false;
  async record(e: EvalEvidenceEntry) {
    this.entries.push(e);
  }
  async close() {
    this.closed = true;
  }
}

describe('runEvalHarness', () => {
  it('happy path：全 item settle，账本/证据/关闭齐全', async () => {
    const sink = new MemSink();
    const report = await runEvalHarness({
      runId: 'r1',
      corpus: corpus(3),
      invoker: stubInvoker({ costUsd: 0.001 }),
      sink,
    });
    expect(report.items_attempted).toBe(3);
    expect(report.invocations).toBe(3);
    expect(report.halted).toBe(false);
    expect(report.ledger.spentUsd).toBeCloseTo(0.003);
    expect(sink.entries).toHaveLength(3);
    expect(sink.entries.every((e) => e.outcome === 'settled')).toBe(true);
    expect(sink.entries[0]).toMatchObject({ run_id: 'r1', item_id: 'item-0', attempt: 1 });
    expect(sink.entries[0]?.input_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(sink.entries[0]?.output_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(sink.closed).toBe(true);
  });

  it('触顶即停：halt 后不继续下一 item，gate_rejected 证据落盘', async () => {
    const sink = new MemSink();
    const report = await runEvalHarness({
      runId: 'r2',
      corpus: corpus(10),
      invoker: stubInvoker({ costUsd: 0.001 }),
      sink,
      caps: { ...D18_BUDGET_CAPS, maxRequests: 4 },
    });
    expect(report.halted).toBe(true);
    expect(report.halt_reason).toBe('request_ceiling');
    expect(report.invocations).toBe(4);
    // 4 次 settled + 1 次 gate_rejected（触顶调用本身也封存）。
    expect(sink.entries).toHaveLength(5);
    expect(sink.entries.at(-1)?.outcome).toBe('gate_rejected');
    expect(sink.entries.at(-1)?.output_digest).toBe('');
  });

  it('invoke_failed 不记 cost、继续下一 item；failures 入报告', async () => {
    const sink = new MemSink();
    const flaky: EvalInvoker = {
      lane: 'flaky',
      estimate: () => ({
        kind: 'verification',
        inputTokens: 10,
        outputTokens: 10,
        estimatedCostUsd: 0.001,
      }),
      async invoke(req) {
        if (req.item.id === 'item-1') throw new Error('upstream 503');
        return {
          output: { ok: true },
          usage: { inputTokens: 10, outputTokens: 10 },
          reportedCostUsd: 0.001,
        };
      },
    };
    const report = await runEvalHarness({
      runId: 'r3',
      corpus: corpus(3),
      invoker: flaky,
      sink,
    });
    expect(report.items_attempted).toBe(3);
    expect(report.failures).toEqual([{ item_id: 'item-1', attempt: 1, error: 'upstream 503' }]);
    expect(report.ledger.spentUsd).toBeCloseTo(0.002); // 失败调用无 reported cost
    expect(sink.entries.map((e) => e.outcome)).toEqual(['settled', 'invoke_failed', 'settled']);
  });

  it('retries：maxAttemptsPerItem>1 时失败重试且计入 invocation 上限', async () => {
    const sink = new MemSink();
    let calls = 0;
    const twiceFlaky: EvalInvoker = {
      lane: 'twice',
      estimate: () => ({
        kind: 'verification',
        inputTokens: 10,
        outputTokens: 10,
        estimatedCostUsd: 0.001,
      }),
      async invoke(req) {
        calls += 1;
        if (req.item.id === 'item-0' && req.attempt === 1) throw new Error('transient');
        return {
          output: { ok: true },
          usage: { inputTokens: 10, outputTokens: 10 },
          reportedCostUsd: 0.001,
        };
      },
    };
    const report = await runEvalHarness({
      runId: 'r4',
      corpus: corpus(2),
      invoker: twiceFlaky,
      sink,
      maxAttemptsPerItem: 2,
    });
    expect(calls).toBe(3); // item0: fail+success, item1: success
    expect(report.retries).toBe(1);
    expect(report.invocations).toBe(3);
    expect(sink.entries.map((e) => `${e.item_id}:${e.attempt}:${e.outcome}`)).toEqual([
      'item-0:1:invoke_failed',
      'item-0:2:settled',
      'item-1:1:settled',
    ]);
  });

  it('stub invoker 零 egress：输出是输入 digest 的确定性 echo', async () => {
    const invoker = stubInvoker();
    const req = {
      item: { id: 'x', split: 'dev' as const, request: { a: 1 } },
      attempt: 1,
    };
    const a = await invoker.invoke(req);
    const b = await invoker.invoke(req);
    expect(a.output).toEqual(b.output); // 确定性
    expect((a.output as { stub: boolean }).stub).toBe(true);
  });
});
