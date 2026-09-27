// YUK-1058 — computeD18Metrics 单测（纯函数，dev/holdout/all 三 split 聚合）。

import { describe, expect, it } from 'vitest';

import type { EvalEvidenceEntry } from './d18-harness';
import { SEVERE_ERROR_FRAC, computeD18Metrics } from './d18-metrics';

function entry(over: Partial<EvalEvidenceEntry> & { item_id: string }): EvalEvidenceEntry {
  return {
    run_id: 'r1',
    split: 'dev',
    attempt: 1,
    lane: 'stub',
    kind: 'verification',
    input_digest: 'in',
    output_digest: 'out',
    usage: { inputTokens: 10, outputTokens: 5 },
    cost_usd: null,
    cost_basis: null,
    cost_ref: null,
    outcome: 'settled',
    error: null,
    latency_ms: null,
    score: null,
    escalated: null,
    recorded_at: '2026-09-27T00:00:00.000Z',
    ...over,
  };
}

describe('computeD18Metrics', () => {
  it('empty run → all-null metrics, zero counts', () => {
    const m = computeD18Metrics('r0', [], new Map());
    expect(m.run_id).toBe('r0');
    expect(m.severe_error_threshold_frac).toBe(SEVERE_ERROR_FRAC);
    for (const s of ['dev', 'holdout', 'all'] as const) {
      const split = m.splits[s];
      expect(split.items_evaluated).toBe(0);
      expect(split.error_rate).toBeNull();
      expect(split.point_error).toBeNull();
      expect(split.upgrade_coverage).toBeNull();
      expect(split.latency_ms.p50).toBeNull();
      expect(split.cost_usd_total).toBe(0);
    }
  });

  it('judge deviation metrics on gold items (error_rate / point_error / severe)', () => {
    // 4 dev items: deltas 0,1,4,8（b 的 norm=0.1 < 0.2 阈值 → mismatch 但非 severe）。
    const entries = [
      entry({ item_id: 'a', score: { points_awarded: 10, max_points: 10 } }),
      entry({ item_id: 'b', score: { points_awarded: 9, max_points: 10 } }),
      entry({ item_id: 'c', score: { points_awarded: 6, max_points: 10 } }),
      entry({ item_id: 'd', score: { points_awarded: 2, max_points: 10 } }),
    ];
    const gold = new Map([
      ['a', { max_points: 10, gold_points: 10 }],
      ['b', { max_points: 10, gold_points: 10 }], // |9−10|=1 → mismatch, not severe
      ['c', { max_points: 10, gold_points: 10 }], // |6−10|=4 → severe (≥0.2)
      ['d', { max_points: 10, gold_points: 10 }], // |2−10|=8 → severe
    ]);
    const m = computeD18Metrics('r1', entries, gold).splits.all;
    expect(m.items_evaluated).toBe(4);
    expect(m.items_with_gold).toBe(4);
    expect(m.point_error).toBeCloseTo((0 + 1 + 4 + 8) / 4, 6); // 3.25
    expect(m.normalized_point_error).toBeCloseTo((0 + 0.1 + 0.4 + 0.8) / 4, 6); // 0.325
    expect(m.error_rate).toBeCloseTo(3 / 4, 6); // b,c,d mismatch
    expect(m.severe_error_rate).toBeCloseTo(2 / 4, 6); // c,d ≥20%
  });

  it('retry: last settled attempt is the final score; retries counted', () => {
    const entries = [
      entry({ item_id: 'x', attempt: 1, outcome: 'invoke_failed', error: 'boom' }),
      entry({ item_id: 'x', attempt: 2, score: { points_awarded: 5, max_points: 10 } }),
    ];
    const gold = new Map([['x', { max_points: 10, gold_points: 10 }]]);
    const m = computeD18Metrics('r1', entries, gold).splits.all;
    expect(m.invocations).toBe(2);
    expect(m.retries).toBe(1);
    expect(m.failed_invocations).toBe(1);
    expect(m.settled_invocations).toBe(1);
    expect(m.point_error).toBeCloseTo(5, 6); // attempt=2 wins
  });

  it('escalation coverage = escalated settled / settled; null when no settled', () => {
    const entries = [
      entry({ item_id: 'x', escalated: true }),
      entry({ item_id: 'y', escalated: false }),
      entry({ item_id: 'z', escalated: null }),
      entry({ item_id: 'w', outcome: 'invoke_failed', error: 'x' }),
    ];
    const m = computeD18Metrics('r1', entries, new Map()).splits.all;
    expect(m.escalated_invocations).toBe(1);
    expect(m.upgrade_coverage).toBeCloseTo(1 / 3, 6);
  });

  it('cost: reported vs total; latency percentiles over settled only', () => {
    const entries = [
      entry({ item_id: 'a', latency_ms: 100, cost_usd: 0.01, cost_basis: 'reported' }),
      entry({ item_id: 'b', latency_ms: 300, cost_usd: 0.02, cost_basis: 'estimated' }),
      entry({ item_id: 'c', latency_ms: 200, cost_usd: null, cost_basis: 'unknown' }),
      entry({ item_id: 'd', outcome: 'gate_rejected', latency_ms: null }),
    ];
    const m = computeD18Metrics('r1', entries, new Map()).splits.all;
    expect(m.cost_usd_total).toBeCloseTo(0.03, 6);
    expect(m.cost_usd_reported).toBeCloseTo(0.01, 6);
    expect(m.latency_ms.p50).toBe(200);
    expect(m.latency_ms.mean).toBeCloseTo(200, 6);
    expect(m.gate_rejected_invocations).toBe(1);
  });

  it('split separation: dev and holdout metrics computed independently', () => {
    const entries = [
      entry({ item_id: 'd1', split: 'dev', score: { points_awarded: 10, max_points: 10 } }),
      entry({ item_id: 'h1', split: 'holdout', score: { points_awarded: 0, max_points: 10 } }),
    ];
    const gold = new Map([
      ['d1', { max_points: 10, gold_points: 10 }],
      ['h1', { max_points: 10, gold_points: 10 }],
    ]);
    const m = computeD18Metrics('r1', entries, gold);
    expect(m.splits.dev.error_rate).toBe(0);
    expect(m.splits.holdout.error_rate).toBe(1);
    expect(m.splits.all.items_with_gold).toBe(2);
  });

  it('items without gold excluded from judge metrics but counted in evaluated/coverage', () => {
    const entries = [
      entry({ item_id: 'nogold', escalated: true }),
      entry({ item_id: 'g', score: { points_awarded: 10, max_points: 10 } }),
    ];
    const gold = new Map([['g', { max_points: 10, gold_points: 10 }]]);
    const m = computeD18Metrics('r1', entries, gold).splits.all;
    expect(m.items_evaluated).toBe(2);
    expect(m.items_with_gold).toBe(1);
    expect(m.error_rate).toBe(0);
    expect(m.upgrade_coverage).toBeCloseTo(0.5, 6);
  });
});
