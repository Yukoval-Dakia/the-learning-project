import { describe, expect, it } from 'vitest';
import { BudgetHaltError, D18_BUDGET_CAPS, EvalBudgetGate } from './d18-budget';

// D18 预算 gate（纯规则，unit partition）： ceilings、per-call caps、
// unknown-cost 保守预留、halt latch、settle 入账完整性。

const call = (over: Partial<Parameters<EvalBudgetGate['admit']>[0]> = {}) => ({
  kind: 'verification' as const,
  inputTokens: 512,
  outputTokens: 256,
  estimatedCostUsd: 0.001,
  ...over,
});

describe('EvalBudgetGate', () => {
  it('admit 预付计数；settle 入账实际成本', () => {
    const gate = new EvalBudgetGate();
    gate.admit(call());
    gate.settle({
      kind: 'verification',
      inputTokens: 400,
      outputTokens: 100,
      actualCostUsd: 0.002,
    });
    const ledger = gate.ledger();
    expect(ledger.requests).toBe(1);
    expect(ledger.verificationCalls).toBe(1);
    expect(ledger.spentUsd).toBeCloseTo(0.002);
    expect(ledger.halted).toBe(false);
  });

  it('非 verification kind 计入 requests 但不计 verificationCalls', () => {
    const gate = new EvalBudgetGate();
    gate.admit(call({ kind: 'auxiliary' }));
    expect(gate.ledger().requests).toBe(1);
    expect(gate.ledger().verificationCalls).toBe(0);
  });

  it('per-call input/output cap 触顶即 halt 并 latch', () => {
    const gate = new EvalBudgetGate();
    expect(() => gate.admit(call({ inputTokens: 40_000 }))).toThrowError(BudgetHaltError);
    expect(gate.ledger().haltReason).toBe('per_call_input_exceeded');
    // latch：之后任何 admit（即使合法）都拒。
    expect(() => gate.admit(call())).toThrowError(BudgetHaltError);
    expect(gate.ledger().haltReason).toBe('per_call_input_exceeded');
  });

  it('output cap 独立触发', () => {
    const gate = new EvalBudgetGate();
    expect(() => gate.admit(call({ outputTokens: 20_000 }))).toThrowError(BudgetHaltError);
    expect(gate.ledger().haltReason).toBe('per_call_output_exceeded');
  });

  it('verification ceiling：第 201 次 verification 调用被拒', () => {
    const gate = new EvalBudgetGate({
      ...D18_BUDGET_CAPS,
      maxVerificationCalls: 3,
    });
    for (let i = 0; i < 3; i++) gate.admit(call());
    expect(() => gate.admit(call())).toThrowError(BudgetHaltError);
    expect(gate.ledger().haltReason).toBe('verification_ceiling');
    expect(gate.ledger().verificationCalls).toBe(3);
  });

  it('request ceiling 覆盖全部 kind', () => {
    const gate = new EvalBudgetGate({ ...D18_BUDGET_CAPS, maxRequests: 2 });
    gate.admit(call({ kind: 'auxiliary' }));
    gate.admit(call({ kind: 'auxiliary' }));
    expect(() => gate.admit(call())).toThrowError(BudgetHaltError);
    expect(gate.ledger().haltReason).toBe('request_ceiling');
  });

  it('cost ceiling：spent + est + reserve 超顶即拒（不超支一次调用）', () => {
    const gate = new EvalBudgetGate({
      ...D18_BUDGET_CAPS,
      totalCostUsd: 0.1,
      reserveUsd: 0.02,
    });
    // admit#1: 0 + 0.03 + 0.02 = 0.05 ≤ 0.1 → pass
    gate.admit(call({ estimatedCostUsd: 0.03 }));
    gate.settle({
      kind: 'verification',
      inputTokens: 1,
      outputTokens: 1,
      actualCostUsd: 0.05,
    });
    // admit#2: 0.05 + 0.03 + 0.02 = 0.10 不超 → pass（严格大于才拒）
    gate.admit(call({ estimatedCostUsd: 0.03 }));
    gate.settle({
      kind: 'verification',
      inputTokens: 1,
      outputTokens: 1,
      actualCostUsd: 0.05,
    });
    // admit#3: 0.10 + 0.03 + 0.02 = 0.15 > 0.1 → halt
    expect(() => gate.admit(call({ estimatedCostUsd: 0.03 }))).toThrowError(BudgetHaltError);
    expect(gate.ledger().haltReason).toBe('cost_ceiling');
    expect(gate.ledger().requests).toBe(2); // 被拒的调用不计预付
  });

  it('未知成本：admit 按 reserve 预留；settle 无 reported → 保守值入账（绝不记 0）', () => {
    const gate = new EvalBudgetGate({
      ...D18_BUDGET_CAPS,
      totalCostUsd: 0.06,
      reserveUsd: 0.02,
    });
    // 未知 estimate → 预留 reserve；0 + 0.02 + 0.02 = 0.04 ≤ 0.06 → pass
    gate.admit(call({ estimatedCostUsd: null }));
    gate.settle({
      kind: 'verification',
      inputTokens: 1,
      outputTokens: 1,
      actualCostUsd: null,
      estimatedCostUsd: null,
    });
    // 入账 reserve（保守）—— spent = 0.02
    expect(gate.ledger().spentUsd).toBeCloseTo(0.02);
    // 第二次未知调用：0.02 + 0.02 + 0.02 = 0.06 不超 → pass
    gate.admit(call({ estimatedCostUsd: null }));
    // 第三次：0.02 + 0.02 + 0.02 = 0.06？spent 还是 0.02（未 settle）
    // → 0.02 + 0.02 + 0.02 = 0.06 ≤ 0.06 → pass 仍在界内
    gate.admit(call({ estimatedCostUsd: null }));
    expect(gate.ledger().requests).toBe(3);
  });

  it('D18 常量上限值固定（文档钉住 ≤$5 / ≤200 / ≤800）', () => {
    expect(D18_BUDGET_CAPS.totalCostUsd).toBe(5.0);
    expect(D18_BUDGET_CAPS.maxVerificationCalls).toBe(200);
    expect(D18_BUDGET_CAPS.maxRequests).toBe(800);
    expect(D18_BUDGET_CAPS.reserveUsd).toBeGreaterThan(0);
  });
});
