// YUK-354 (A7) — no-DB unit coverage for the effectiveness 趋势面纯视图逻辑.
// Guards the safety-relevant bits: 合成根识别（毛刺 ①）、⑥低置信降级映射、科目分桶、
// 规模 rollup-first 选择。纯函数、零 DB → 跑 unit 车道。

import { describe, expect, it } from 'vitest';
import type {
  EffectivenessTrendPoint,
  EffectivenessTrendSeries,
  TrendConfidence,
  TrendDirection,
} from './effectiveness-trend-api';
import {
  confidenceClass,
  countSettled,
  directionMeta,
  isSeedRoot,
  isTender,
  partitionSubjectSeries,
  pointsToValues,
  selectMovedKcs,
  seriesForDomain,
  summarizeOverview,
  trajGeometry,
} from './effectiveness-trend-view';

function pt(p_learned: number | null, theta_hat: number | null = 0): EffectivenessTrendPoint {
  return { at: '2026-06-28T00:00:00.000Z', p_learned, theta_hat, theta_delta: null };
}

function kc(
  id: string,
  direction: TrendDirection,
  confidence: TrendConfidence,
  opts: Partial<EffectivenessTrendSeries> = {},
): EffectivenessTrendSeries {
  return {
    knowledge_id: id,
    name: opts.name ?? id,
    // 用 `in` 而非 ?? —— effective_domain 可以显式是 null（未归类桶），?? 会把它误吞成默认值。
    effective_domain: 'effective_domain' in opts ? (opts.effective_domain ?? null) : 'wenyan',
    points: opts.points ?? [pt(0.3), pt(0.5)],
    trend: {
      direction,
      confidence,
      span_evidence: opts.trend?.span_evidence ?? 4,
      has_mastery_signal: opts.trend?.has_mastery_signal ?? direction !== 'insufficient',
    },
    activity_count: opts.activity_count ?? 4,
  };
}

describe('isSeedRoot (合成根毛刺 ①)', () => {
  it('matches seed:<subject>:root', () => {
    expect(isSeedRoot('seed:wenyan:root')).toBe(true);
    expect(isSeedRoot('seed:math:root')).toBe(true);
  });
  it('does not match real KC ids or partial shapes', () => {
    expect(isSeedRoot('k_pmp')).toBe(false);
    expect(isSeedRoot('seed:wenyan:binyu')).toBe(false);
    expect(isSeedRoot('seed::root')).toBe(false); // empty subject segment
    expect(isSeedRoot('seed:wenyan:root:extra')).toBe(false);
  });
});

describe('confidenceClass (⑥ 低置信降级映射)', () => {
  it('insufficient direction always collapses to is-insf regardless of confidence', () => {
    expect(confidenceClass('insufficient', 'high')).toBe('is-insf');
    expect(confidenceClass('insufficient', 'low')).toBe('is-insf');
  });
  it('maps read-model confidence (low/medium/high) to firm/mid/low classes', () => {
    expect(confidenceClass('rising', 'high')).toBe('is-firm');
    expect(confidenceClass('rising', 'medium')).toBe('is-mid');
    expect(confidenceClass('rising', 'low')).toBe('is-low');
    expect(confidenceClass('holding', 'low')).toBe('is-low');
  });
});

describe('isTender (⑥ 一眼看出别当真)', () => {
  it('low confidence OR insufficient direction is tender', () => {
    expect(isTender('rising', 'low')).toBe(true);
    expect(isTender('insufficient', 'high')).toBe(true);
  });
  it('firm/mid non-insufficient trends are not tender', () => {
    expect(isTender('rising', 'high')).toBe(false);
    expect(isTender('falling', 'medium')).toBe(false);
  });
});

describe('directionMeta', () => {
  it('falling is honestly rendered with its own tone/glyph (no softening)', () => {
    expect(directionMeta('falling')).toEqual({ label: '在退', glyph: '↓', tone: 'down' });
    expect(directionMeta('insufficient').tone).toBe('insf');
  });
});

describe('partitionSubjectSeries (毛刺 ① — seed-root = 科目整体)', () => {
  it('splits the seed-root row out as `whole`, leaving real KCs', () => {
    const rows = [
      kc('seed:wenyan:root', 'rising', 'low'),
      kc('k_zhi', 'rising', 'high'),
      kc('k_binyu', 'insufficient', 'low'),
    ];
    const { whole, kcs } = partitionSubjectSeries(rows);
    expect(whole?.knowledge_id).toBe('seed:wenyan:root');
    expect(kcs.map((k) => k.knowledge_id)).toEqual(['k_zhi', 'k_binyu']);
  });
  it('no seed-root → whole is null, all rows are KCs', () => {
    const rows = [kc('k_zhi', 'rising', 'high')];
    const { whole, kcs } = partitionSubjectSeries(rows);
    expect(whole).toBeNull();
    expect(kcs).toHaveLength(1);
  });
});

describe('seriesForDomain (含 null = 未归类桶, 毛刺 ③)', () => {
  it('filters by effective_domain, null matching the uncategorized bucket', () => {
    const series = [
      kc('a', 'rising', 'high', { effective_domain: 'wenyan' }),
      kc('b', 'holding', 'high', { effective_domain: 'math' }),
      kc('u', 'rising', 'low', { effective_domain: null }),
    ];
    expect(seriesForDomain(series, 'wenyan').map((k) => k.knowledge_id)).toEqual(['a']);
    expect(seriesForDomain(series, null).map((k) => k.knowledge_id)).toEqual(['u']);
  });
});

describe('selectMovedKcs + countSettled (规模 rollup-first)', () => {
  const kcs = [
    kc('rise', 'rising', 'high'),
    kc('fall', 'falling', 'medium'),
    kc('hold', 'holding', 'high'),
    kc('insf', 'insufficient', 'low'),
  ];
  it('moved = rising|falling only', () => {
    expect(selectMovedKcs(kcs).map((k) => k.knowledge_id)).toEqual(['rise', 'fall']);
  });
  it('settled counts holding + insufficient (collapsed by default)', () => {
    expect(countSettled(kcs)).toEqual({ holding: 1, insufficient: 1 });
  });
});

describe('summarizeOverview (⑥ 多数低置信诚实信号)', () => {
  it('counts directions and splits firm vs tender (low-conf counts as tender)', () => {
    const series = [
      kc('a', 'rising', 'high'),
      kc('b', 'rising', 'low'),
      kc('c', 'insufficient', 'low'),
    ];
    const o = summarizeOverview(series);
    expect(o.counts).toEqual({ rising: 2, holding: 0, falling: 0, insufficient: 1 });
    expect(o.total).toBe(3);
    expect(o.firm).toBe(1); // only the high-confidence rising one
    expect(o.tender).toBe(2);
  });
});

describe('pointsToValues', () => {
  it('drops null / non-finite p_learned points', () => {
    expect(pointsToValues([pt(0.3), pt(null), pt(0.6)])).toEqual([0.3, 0.6]);
    expect(pointsToValues([pt(null), pt(null)])).toEqual([]);
  });
});

describe('trajGeometry', () => {
  it('single point is centered, no band path (errbar handled by view)', () => {
    const g = trajGeometry([0.4], 'low', 100, 40, 8, 8);
    expect(g.n).toBe(1);
    expect(g.pts[0].x).toBe(50);
    expect(g.bandPath).toBe('');
    expect(g.linePath).toMatch(/^M/);
  });
  it('two+ points produce a closed band path', () => {
    const g = trajGeometry([0.3, 0.5, 0.7], 'firm', 120, 50, 8, 8);
    expect(g.n).toBe(3);
    expect(g.pts).toHaveLength(3);
    expect(g.bandPath).toMatch(/Z$/);
  });
  it('empty values → no points, empty paths (degenerate, no fake line)', () => {
    const g = trajGeometry([], 'low', 100, 40, 8, 8);
    expect(g.n).toBe(0);
    expect(g.linePath).toBe('');
    expect(g.bandPath).toBe('');
  });
});
