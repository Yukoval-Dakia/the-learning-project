import { describe, expect, it } from 'vitest';
import type { SupplyPlanV1T } from '@/core/schema/supply_plan';
import {
  checkSupplyPlanKnowledgeIds,
  checkSupplyPlanStructure,
  parseSupplyPlanOutput,
} from './supply-plan-gate';

const VALID_PLAN: SupplyPlanV1T = {
  version: 1,
  items: [
    {
      knowledge_id: 'kc-frontier-1',
      kind: 'choice',
      difficulty_band: 'near',
      count: 3,
      route_preference: ['sourcing_web', 'quiz_gen'],
      rationale: 'frontier 节点零覆盖',
    },
  ],
  budget: { jyeoo_questions: 5 },
};

describe('parseSupplyPlanOutput', () => {
  it('accepts a strict JSON plan', () => {
    const result = parseSupplyPlanOutput(JSON.stringify(VALID_PLAN));
    expect(result).toEqual({ ok: true, plan: VALID_PLAN });
  });

  it('extracts JSON embedded in prose', () => {
    const result = parseSupplyPlanOutput(`规划如下：\n${JSON.stringify(VALID_PLAN)}\n以上。`);
    expect(result).toEqual({ ok: true, plan: VALID_PLAN });
  });

  it('accepts an empty-items plan (valid zero-demand night)', () => {
    const result = parseSupplyPlanOutput(
      JSON.stringify({ ...VALID_PLAN, items: [], budget: { jyeoo_questions: 0 } }),
    );
    expect(result.ok).toBe(true);
  });

  it('rejects blank output', () => {
    const result = parseSupplyPlanOutput('   ');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons[0]).toMatch(/empty/);
  });

  it('rejects non-JSON output', () => {
    const result = parseSupplyPlanOutput('not a plan at all');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons[0]).toMatch(/invalid JSON/);
  });

  it('rejects schema violations with readable reasons', () => {
    const bad = {
      ...VALID_PLAN,
      items: [{ ...VALID_PLAN.items[0], kind: 'not_a_kind' }],
    };
    const result = parseSupplyPlanOutput(JSON.stringify(bad));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons[0]).toContain('items.0.kind');
  });

  it('rejects unknown routes via schema enum', () => {
    const bad = {
      ...VALID_PLAN,
      items: [{ ...VALID_PLAN.items[0], route_preference: ['carrier_pigeon'] }],
    };
    const result = parseSupplyPlanOutput(JSON.stringify(bad));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons[0]).toContain('route_preference');
  });

  it('rejects wrong version literal', () => {
    const result = parseSupplyPlanOutput(JSON.stringify({ ...VALID_PLAN, version: 2 }));
    expect(result.ok).toBe(false);
  });

  it('rejects count above the per-item cap', () => {
    const bad = { ...VALID_PLAN, items: [{ ...VALID_PLAN.items[0], count: 11 }] };
    expect(parseSupplyPlanOutput(JSON.stringify(bad)).ok).toBe(false);
  });

  it('rejects more than 25 items', () => {
    const items = Array.from({ length: 26 }, (_, i) => ({
      ...VALID_PLAN.items[0],
      knowledge_id: `kc-${i}`,
    }));
    expect(parseSupplyPlanOutput(JSON.stringify({ ...VALID_PLAN, items })).ok).toBe(false);
  });

  it('rejects rationale above 500 chars', () => {
    const bad = {
      ...VALID_PLAN,
      items: [{ ...VALID_PLAN.items[0], rationale: 'x'.repeat(501) }],
    };
    expect(parseSupplyPlanOutput(JSON.stringify(bad)).ok).toBe(false);
  });
});

describe('checkSupplyPlanStructure', () => {
  it('passes a well-formed plan', () => {
    expect(checkSupplyPlanStructure(VALID_PLAN, { jyeooBudgetRemaining: 40 })).toEqual([]);
  });

  it('rejects duplicate cells and points at both indexes', () => {
    const plan: SupplyPlanV1T = {
      ...VALID_PLAN,
      items: [VALID_PLAN.items[0], VALID_PLAN.items[0]],
    };
    const reasons = checkSupplyPlanStructure(plan, { jyeooBudgetRemaining: 40 });
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain('duplicates');
    expect(reasons[0]).toContain('items[1]');
    expect(reasons[0]).toContain('items[0]');
  });

  it('allows same KC at different kind/band', () => {
    const plan: SupplyPlanV1T = {
      ...VALID_PLAN,
      items: [
        VALID_PLAN.items[0],
        { ...VALID_PLAN.items[0], kind: 'computation' },
        { ...VALID_PLAN.items[0], difficulty_band: 'stretch' },
      ],
    };
    expect(checkSupplyPlanStructure(plan, { jyeooBudgetRemaining: 40 })).toEqual([]);
  });

  it('rejects declared budget above remaining', () => {
    const reasons = checkSupplyPlanStructure(VALID_PLAN, { jyeooBudgetRemaining: 4 });
    expect(reasons[0]).toContain('exceeds remaining daily budget 4');
  });

  it('rejects jyeoo-only demand exceeding the declared budget', () => {
    const plan: SupplyPlanV1T = {
      ...VALID_PLAN,
      items: [
        { ...VALID_PLAN.items[0], count: 6, route_preference: ['jyeoo_fetch'] },
        {
          ...VALID_PLAN.items[0],
          knowledge_id: 'kc-2',
          count: 5,
          route_preference: ['jyeoo_fetch'],
        },
      ],
      budget: { jyeoo_questions: 8 },
    };
    const reasons = checkSupplyPlanStructure(plan, { jyeooBudgetRemaining: 40 });
    expect(reasons[0]).toContain('jyeoo-only items request 11');
  });

  it('does not count mixed-route items toward the jyeoo-only sum', () => {
    const plan: SupplyPlanV1T = {
      ...VALID_PLAN,
      items: [
        {
          ...VALID_PLAN.items[0],
          count: 10,
          route_preference: ['jyeoo_fetch', 'sourcing_web'],
        },
      ],
      budget: { jyeoo_questions: 0 },
    };
    expect(checkSupplyPlanStructure(plan, { jyeooBudgetRemaining: 40 })).toEqual([]);
  });
});

describe('checkSupplyPlanKnowledgeIds', () => {
  const live = new Set(['kc-frontier-1', 'kc-2']);

  it('passes when every referenced id is live', () => {
    expect(checkSupplyPlanKnowledgeIds(VALID_PLAN, live)).toEqual([]);
  });

  it('rejects unknown ids once per id', () => {
    const plan: SupplyPlanV1T = {
      ...VALID_PLAN,
      items: [
        VALID_PLAN.items[0],
        { ...VALID_PLAN.items[0], kind: 'computation' },
        { ...VALID_PLAN.items[0], knowledge_id: 'kc-ghost' },
      ],
    };
    const reasons = checkSupplyPlanKnowledgeIds(plan, live);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain("items[2].knowledge_id 'kc-ghost'");
  });
});
