// YUK-523 — 校准诊断视图纯逻辑的 no-DB unit 覆盖。守住 tier 派生（含 evidence=0 盲区优先于 cold_start）、
// theta_se=null 回落冷启先验、排序比较器 + 点表头翻向、θ̂ SE → 分布带/填充条定位、同 SE lane 堆叠。
// ⑥红线相关：tier 只表相对次序、SE 是置信量。纯函数、零 DB → unit 车道。

import type { CalibrationMaturityRow } from '@/capabilities/onboarding/ui/recompute/calibration-maturity-api';
import { describe, expect, it } from 'vitest';
import {
  COLD_START_SE,
  type CalSort,
  SE_LO,
  calCounts,
  calDots,
  calSorted,
  calTier,
  nextSort,
  seFillPct,
  seToX,
  sortCaret,
  toCalRows,
} from './calibration-view';

function row(over: Partial<CalibrationMaturityRow> = {}): CalibrationMaturityRow {
  return {
    knowledge_id: over.knowledge_id ?? 'k1',
    name: over.name ?? 'KC',
    evidence_count: over.evidence_count ?? 6,
    theta_se: 'theta_se' in over ? (over.theta_se ?? null) : 0.4,
    confidence: 'confidence' in over ? (over.confidence ?? null) : 0.8,
    track: 'track' in over ? (over.track ?? null) : null,
    cold_start: over.cold_start ?? false,
  };
}

describe('calTier', () => {
  it('evidence=0 → blind（盲区优先，即使 cold_start 也是 blind）', () => {
    expect(calTier(row({ evidence_count: 0, cold_start: true }))).toBe('blind');
    expect(calTier(row({ evidence_count: 0, cold_start: false }))).toBe('blind');
  });
  it('有证据 + cold_start → warming', () => {
    expect(calTier(row({ evidence_count: 3, cold_start: true }))).toBe('warming');
  });
  it('有证据 + 非 cold_start → firm', () => {
    expect(calTier(row({ evidence_count: 9, cold_start: false }))).toBe('firm');
  });
});

describe('toCalRows', () => {
  it('theta_se=null（无 mastery_state 行 / 冷启）回落冷启先验 SE，不当精确分', () => {
    const [r] = toCalRows([row({ evidence_count: 0, theta_se: null })]);
    expect(r.display_se).toBe(COLD_START_SE);
    expect(r.tier).toBe('blind');
  });
  it('有 theta_se 时 display_se = theta_se', () => {
    const [r] = toCalRows([row({ theta_se: 0.33 })]);
    expect(r.display_se).toBe(0.33);
  });
});

describe('calCounts', () => {
  it('按 tier 分桶计数', () => {
    const rows = toCalRows([
      row({ knowledge_id: 'a', evidence_count: 9, cold_start: false }), // firm
      row({ knowledge_id: 'b', evidence_count: 3, cold_start: true }), // warming
      row({ knowledge_id: 'c', evidence_count: 0, theta_se: null }), // blind
      row({ knowledge_id: 'd', evidence_count: 0, theta_se: null }), // blind
    ]);
    expect(calCounts(rows)).toEqual({ firm: 1, warming: 1, blind: 2 });
  });
});

describe('calSorted', () => {
  const rows = toCalRows([
    row({ knowledge_id: 'a', name: 'B', evidence_count: 2, theta_se: 0.9, cold_start: true }),
    row({ knowledge_id: 'b', name: 'A', evidence_count: 8, theta_se: 0.3, cold_start: false }),
  ]);

  it('按 se 升序 → 最可信（SE 小）在前', () => {
    const out = calSorted(rows, { key: 'se', dir: 1 });
    expect(out.map((r) => r.knowledge_id)).toEqual(['b', 'a']);
  });
  it('dir=-1 翻向', () => {
    const out = calSorted(rows, { key: 'se', dir: -1 });
    expect(out.map((r) => r.knowledge_id)).toEqual(['a', 'b']);
  });
  it('按 evidence 升序', () => {
    expect(calSorted(rows, { key: 'evidence', dir: 1 }).map((r) => r.evidence_count)).toEqual([
      2, 8,
    ]);
  });
  it('按 tier：firm 先于 warming（rank），同 tier 内 SE 兜底', () => {
    const out = calSorted(rows, { key: 'tier', dir: 1 });
    expect(out.map((r) => r.tier)).toEqual(['firm', 'warming']);
  });
  it('不原地修改入参', () => {
    const before = rows.map((r) => r.knowledge_id);
    calSorted(rows, { key: 'name', dir: 1 });
    expect(rows.map((r) => r.knowledge_id)).toEqual(before);
  });
});

describe('nextSort', () => {
  it('同列翻向', () => {
    expect(nextSort({ key: 'se', dir: 1 }, 'se')).toEqual<CalSort>({ key: 'se', dir: -1 });
    expect(nextSort({ key: 'se', dir: -1 }, 'se')).toEqual<CalSort>({ key: 'se', dir: 1 });
  });
  it('异列默认升序，evidence 异列默认降序（证据多的在上）', () => {
    expect(nextSort({ key: 'se', dir: 1 }, 'name')).toEqual<CalSort>({ key: 'name', dir: 1 });
    expect(nextSort({ key: 'se', dir: 1 }, 'evidence')).toEqual<CalSort>({
      key: 'evidence',
      dir: -1,
    });
  });
});

describe('sortCaret', () => {
  it('非活动列空串；活动列按方向出 ↑/↓', () => {
    expect(sortCaret({ key: 'se', dir: 1 }, 'name')).toBe('');
    expect(sortCaret({ key: 'se', dir: 1 }, 'se')).toBe(' ↑');
    expect(sortCaret({ key: 'se', dir: -1 }, 'se')).toBe(' ↓');
  });
});

describe('seToX / seFillPct', () => {
  it('se=COLD_START_SE → 最左/0%（最不可信）', () => {
    expect(seToX(COLD_START_SE)).toBe(2); // clamp 下界
    expect(seFillPct(COLD_START_SE)).toBe(0);
  });
  it('se=SE_LO → 接近最右/100%（最可信）', () => {
    expect(seToX(SE_LO)).toBe(98); // clamp 上界
    expect(seFillPct(SE_LO)).toBe(100);
  });
  it('越界 SE 被 clamp 进 [2,98] / [0,100]', () => {
    expect(seToX(1.5)).toBe(2);
    expect(seToX(0.05)).toBe(98);
    expect(seFillPct(1.5)).toBe(0);
    expect(seFillPct(0.05)).toBe(100);
  });
});

describe('calDots', () => {
  it('同 SE（2 位小数）的点 lane 递增堆叠，避免重叠', () => {
    const rows = toCalRows([
      row({ knowledge_id: 'a', evidence_count: 0, theta_se: null }), // se 1.00
      row({ knowledge_id: 'b', evidence_count: 0, theta_se: null }), // se 1.00 同桶
      row({ knowledge_id: 'c', theta_se: 0.3 }), // 不同桶
    ]);
    const dots = calDots(rows);
    const byId = Object.fromEntries(dots.map((d) => [d.knowledge_id, d]));
    expect(byId.a.lane).toBe(0);
    expect(byId.b.lane).toBe(1);
    expect(byId.c.lane).toBe(0);
    expect(byId.a.x).toBe(byId.b.x); // 同 SE 同 x
    expect(byId.c.x).not.toBe(byId.a.x);
  });
});
