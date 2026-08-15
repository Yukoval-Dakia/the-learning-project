import { SubjectRegistry, subjectProfiles } from '@/subjects/profile';
import { describe, expect, it } from 'vitest';
import { resolveSubjectRenderNotation } from './subject-resolution';

describe('resolveSubjectRenderNotation', () => {
  it('uses the resolvable registry for a retired custom subject', () => {
    const registry = new SubjectRegistry();
    const base = subjectProfiles.general;
    if (!base) throw new Error('general subject profile missing');
    registry.upsert(
      {
        ...base,
        id: 'subj_retired_math',
        displayName: '已停用数学专题',
        renderConfig: { ...base.renderConfig, notation: 'katex' },
      },
      [],
      {
        meta: { isBuiltin: false, isSelectable: true, retiredAt: new Date() },
      },
    );

    expect(registry.getSelectableSubjectIds()).not.toContain('subj_retired_math');
    expect(registry.getResolvableSubjectIds()).toContain('subj_retired_math');
    expect(resolveSubjectRenderNotation('subj_retired_math', registry)).toBe('katex');
  });

  it('keeps the neutral fallback non-math for missing or unknown subjects', () => {
    const registry = new SubjectRegistry();
    expect(resolveSubjectRenderNotation(null, registry)).toBeNull();
    expect(resolveSubjectRenderNotation('unknown-domain', registry)).toBeNull();
  });
});
