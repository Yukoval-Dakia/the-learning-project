// YUK-523 — Coach 复盘中枢 tab 配置的 no-DB unit 覆盖。守住三视图标识/顺序、默认视图（成效趋势）、
// eyebrow query 键齐全、isCoachView 守卫。纯数据/纯函数 → unit 车道。

import { describe, expect, it } from 'vitest';
import {
  COACH_VIEWS,
  type CoachView,
  DEFAULT_COACH_VIEW,
  VIEW_QUERY,
  isCoachView,
} from './coach-hub-view';

describe('COACH_VIEWS', () => {
  it('是恰好三个视图，顺序 = 活动量 / 校准诊断 / 成效趋势', () => {
    expect(COACH_VIEWS.map((v) => v.id)).toEqual(['activity', 'calibration', 'efficacy']);
  });

  it('每个视图带 label / icon；校准 ⟂ 成效是正交对，活动量非正交', () => {
    const byId = Object.fromEntries(COACH_VIEWS.map((v) => [v.id, v]));
    expect(byId.activity.label).toBe('活动量');
    expect(byId.calibration.label).toBe('校准诊断');
    expect(byId.efficacy.label).toBe('成效趋势');
    expect(byId.activity.ortho).toBe(false);
    expect(byId.calibration.ortho).toBe(true);
    expect(byId.efficacy.ortho).toBe(true);
    for (const v of COACH_VIEWS) expect(v.icon.length).toBeGreaterThan(0);
  });
});

describe('DEFAULT_COACH_VIEW', () => {
  it('默认视图 = 成效趋势（设计 useState("efficacy")）', () => {
    expect(DEFAULT_COACH_VIEW).toBe('efficacy');
  });
});

describe('VIEW_QUERY', () => {
  it('每个视图都有 eyebrow query 串', () => {
    for (const v of COACH_VIEWS) {
      expect(VIEW_QUERY[v.id].length).toBeGreaterThan(0);
    }
  });

  it('efficacy 串指向真实纵向读模型端点（非设计 mock 串）', () => {
    expect(VIEW_QUERY.efficacy).toContain('/api/observability/effectiveness-trend');
    expect(VIEW_QUERY.calibration).toContain('/api/observability/calibration-maturity');
    expect(VIEW_QUERY.activity).toContain('/api/review/weekly');
  });
});

describe('isCoachView', () => {
  it('只对三个合法视图标识返回 true', () => {
    const valid: CoachView[] = ['activity', 'calibration', 'efficacy'];
    for (const v of valid) expect(isCoachView(v)).toBe(true);
  });

  it('对未知 / null / undefined 返回 false', () => {
    expect(isCoachView('effectiveness')).toBe(false); // 旧 2-视图标识，已不存在
    expect(isCoachView('weekly')).toBe(false);
    expect(isCoachView(null)).toBe(false);
    expect(isCoachView(undefined)).toBe(false);
    expect(isCoachView('')).toBe(false);
  });
});
