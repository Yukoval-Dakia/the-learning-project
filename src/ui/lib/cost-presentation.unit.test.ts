import { describe, expect, it } from 'vitest';
import type { ApiOperationJsonResponse } from './api';
import { describeCosts } from './cost-presentation';

type Bucket = ApiOperationJsonResponse<'getTodayCost'>['today']['by_currency'][number];
const zero: Bucket = {
  currency: 'USD',
  cost: 0,
  reported_cost: 0,
  estimated_cost: 0,
  legacy_cost: 0,
  unknown_attempts: 0,
  legacy_rows: 0,
};

describe('cost presentation truth', () => {
  it('does not turn unpriced calls into free calls, even with an unknown currency', () => {
    for (const currency of ['USD', 'XXX']) {
      const result = describeCosts([{ ...zero, currency, unknown_attempts: 2 }]);
      expect(result.amount).toContain('费用未知');
      expect(result.amount).not.toContain('0.00');
      expect(result.note).toContain('2 次费用未知');
    }
  });
  it('aggregates each currency with its reported, estimated, legacy and unknown components', () => {
    const result = describeCosts(
      [
        { ...zero, cost: 0.1, reported_cost: 0.1 },
        { ...zero, cost: 0.2, estimated_cost: 0.2, unknown_attempts: 1 },
        { ...zero, currency: 'CNY', cost: 0.4, legacy_cost: 0.4, legacy_rows: 3 },
      ],
      4,
    );
    expect(result.amount).toBe('$0.3000 + 未知 · ¥0.4000');
    expect(result.note).toContain('已报告 $0.1000');
    expect(result.note).toContain('估算 $0.2000');
    expect(result.note).toContain('历史口径 ¥0.4000（3 条）');
    expect(result.note).toContain('1 次费用未知');
    expect(result.note).toContain('不含未知费用');
  });
  it('keeps a genuinely known zero distinct from no records', () => {
    expect(describeCosts([zero]).amount).toBe('$0.00');
    expect(describeCosts([zero]).note).toContain('已知金额为零');
    expect(describeCosts([]).amount).toBe('暂无费用记录');
  });
  it.each([2, 4] as const)(
    'never rounds a positive known amount to zero at precision %i',
    (precision) => {
      const result = describeCosts(
        [{ ...zero, cost: 0.0000003, estimated_cost: 0.0000003 }],
        precision,
      );
      expect(result.amount).toBe(precision === 2 ? '<$0.01' : '<$0.0001');
      expect(result.note).toContain(`估算 ${result.amount}`);
    },
  );
});
