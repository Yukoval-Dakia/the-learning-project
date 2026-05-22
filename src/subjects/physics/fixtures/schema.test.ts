import { describe, expect, it } from 'vitest';
import fixtureData from './data.json' with { type: 'json' };
import {
  ExpectedSignal,
  PhysicsFixtureFileSchema,
  loadPhysicsFixtures,
} from './index';

describe('physics fixtures', () => {
  it('data.json conforms to PhysicsFixtureFileSchema', () => {
    expect(() => PhysicsFixtureFileSchema.parse(fixtureData)).not.toThrow();
  });

  it('loadPhysicsFixtures returns exactly 10 items', () => {
    const items = loadPhysicsFixtures();
    expect(items.length).toBe(10);
  });

  it('每条 fixture 至少 1 个 expected_signals test_case', () => {
    const items = loadPhysicsFixtures();
    for (const item of items) {
      expect(item.expected_signals.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('expected_signals coverage：5 类信号每类至少 1 道 fixture 命中', () => {
    const items = loadPhysicsFixtures();
    const allSignals = new Set<string>();
    for (const item of items) {
      for (const tc of item.expected_signals) {
        allSignals.add(tc.expected_signal);
      }
    }
    for (const signal of ExpectedSignal.options) {
      expect(allSignals).toContain(signal);
    }
  });

  it('fixture 数量分类符合 spec §3 P-1 #3：5 单位换算 + 3 量纲分析 + 2 公式应用', () => {
    const items = loadPhysicsFixtures();
    const unitCount = items.filter((i) => i.ref.startsWith('physics-unit-')).length;
    const dimCount = items.filter((i) => i.ref.startsWith('physics-dim-')).length;
    const formulaCount = items.filter((i) => i.ref.startsWith('physics-formula-')).length;
    expect(unitCount).toBe(5);
    expect(dimCount).toBe(3);
    expect(formulaCount).toBe(2);
  });

  it('refs 全局唯一', () => {
    const items = loadPhysicsFixtures();
    const refs = items.map((i) => i.ref);
    expect(new Set(refs).size).toBe(refs.length);
  });
});
