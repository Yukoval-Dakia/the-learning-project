import { describe, expect, it } from 'vitest';

import { AUTO_LINK_SYSTEM_LABEL, type AutoLinkRelation, autoLinkChip } from './auto-link-chip';

// YUK-95 P5 Lane-D — pure chip-label mapping unit (no DB / no React). Verifies
// the ADR-0020 §9 chip text per relation + the auto-flag gate.

describe('autoLinkChip — relation → chip mapping (ADR-0020 §9)', () => {
  const cases: Array<[AutoLinkRelation, string]> = [
    ['subtopic', 'via 子主题'],
    ['prerequisite', 'via prerequisite'],
    ['derived_from', 'via 派生'],
    ['contrasts_with', 'via 对比'],
  ];

  for (const [relation, label] of cases) {
    it(`maps auto:true relation='${relation}' → "${label}" + tone class`, () => {
      const chip = autoLinkChip({ auto: true, relation });
      expect(chip.isAuto).toBe(true);
      expect(chip.relationLabel).toBe(label);
      expect(chip.relationToneClass).not.toBeNull();
    });
  }

  it('contrasts_with uses the (placeholder) --contrasts tone class until T-KG lands', () => {
    // Deferred: switches to a dedicated --contrasts token once the T-KG branch
    // merges; the class name is stable, only its CSS tone changes.
    const chip = autoLinkChip({ auto: true, relation: 'contrasts_with' });
    expect(chip.relationToneClass).toBe('auto-link-chip--contrasts');
  });

  it('user-inserted cross_link (no auto flag) renders no chip and no system marker', () => {
    const chip = autoLinkChip({ artifact_id: 'a1', title: '某笔记' });
    expect(chip.isAuto).toBe(false);
    expect(chip.relationLabel).toBeNull();
    expect(chip.relationToneClass).toBeNull();
  });

  it('auto:false is treated as a user link', () => {
    const chip = autoLinkChip({ auto: false, relation: 'subtopic' });
    expect(chip.isAuto).toBe(false);
    expect(chip.relationLabel).toBeNull();
  });

  it('auto:true with an unknown/missing relation → system marker but no relation chip', () => {
    const missing = autoLinkChip({ auto: true });
    expect(missing.isAuto).toBe(true);
    expect(missing.relationLabel).toBeNull();
    expect(missing.relationToneClass).toBeNull();

    const unknown = autoLinkChip({ auto: true, relation: 'related_to' });
    expect(unknown.isAuto).toBe(true);
    expect(unknown.relationLabel).toBeNull();
  });

  it('tolerates null / undefined attrs', () => {
    expect(autoLinkChip(null).isAuto).toBe(false);
    expect(autoLinkChip(undefined).isAuto).toBe(false);
  });

  it('exposes a stable system-maintained marker label', () => {
    expect(AUTO_LINK_SYSTEM_LABEL).toBe('系统维护');
  });
});
