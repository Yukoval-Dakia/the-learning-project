import { describe, expect, it } from 'vitest';

import { causeOptionsForSelectedKnowledge } from './cause-options';

const nodes = [
  { id: 'k_yuwen', name: '虚词', effective_domain: 'yuwen' },
  { id: 'k_math', name: '单位换算', effective_domain: 'math' },
];

describe('causeOptionsForSelectedKnowledge', () => {
  it('uses the selected knowledge effective domain to expose math cause options', () => {
    const options = causeOptionsForSelectedKnowledge(nodes, ['k_math']);
    const ids = options.map((option) => option.id);

    expect(ids).toContain('unit_error');
    expect(ids).toContain('time_pressure');
  });

  it('falls back to the default subject cause options when no knowledge is selected', () => {
    const options = causeOptionsForSelectedKnowledge(nodes, []);
    const ids = options.map((option) => option.id);

    expect(ids).toContain('concept');
    expect(ids).toContain('carelessness');
    expect(ids).not.toContain('unit_error');
  });
});

// YUK-598（review-757 P2-2 可测半）— subjectRows 参数：custom 分类法行驱动 + 回退。
describe('causeOptionsForSelectedKnowledge subjectRows 语义', () => {
  const customNodes = [{ id: 'k_chem', name: '配平', effective_domain: 'subj_chem1' }];
  const rows = [{ id: 'subj_chem1', causeCategories: [{ id: 'chem_balance', label: '配平错误' }] }];

  it('custom 科目：分类法只有行认识 → 行驱动', () => {
    expect(causeOptionsForSelectedKnowledge(customNodes, ['k_chem'], rows)).toEqual([
      { id: 'chem_balance', label: '配平错误' },
    ]);
  });

  it('行 miss / 省略 rows → 编译期 registry 行为逐位不变', () => {
    const withRows = causeOptionsForSelectedKnowledge(nodes, ['k_yuwen'], rows);
    const withRowsMiss = causeOptionsForSelectedKnowledge(nodes, ['k_math'], rows);
    const without = causeOptionsForSelectedKnowledge(nodes, ['k_math']);
    expect(withRowsMiss).toEqual(without);
    // yuwen 在 rows 里但无 causeCategories 键？——rows 形状要求带 causeCategories，
    // 本 rows 无 yuwen 行 → 落编译期 yuwen 分类法（非空）。
    expect(withRows.length).toBeGreaterThan(0);
  });
});
