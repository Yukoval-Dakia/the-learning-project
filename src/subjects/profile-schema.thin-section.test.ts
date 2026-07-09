import { describe, expect, it } from 'vitest';
import { mathProfile } from './math/profile';
import { physicsProfile } from './physics/profile';
import { SubjectProfileSchema } from './profile-schema';
import { yuwenProfile } from './yuwen/profile';

// YUK-225 (S2 slice 4) — thin profile section: sourceWhitelist + sourcingRoutePreference.

describe('SubjectProfileSchema thin section (YUK-225)', () => {
  it('defaults sourceWhitelist to [] when omitted', () => {
    const base = SubjectProfileSchema.parse(yuwenProfile);
    // yuwen declares a whitelist, so re-parse a clone with it stripped.
    const { sourceWhitelist: _omit, ...withoutWhitelist } = base;
    const parsed = SubjectProfileSchema.parse(withoutWhitelist);
    expect(parsed.sourceWhitelist).toEqual([]);
  });

  it('accepts a populated sourceWhitelist', () => {
    const parsed = SubjectProfileSchema.parse(yuwenProfile);
    expect(parsed.sourceWhitelist).toContain('gzywtk.com');
    expect(parsed.sourceWhitelist).toContain('gaokao.eol.cn');
  });

  it('accepts sourcingRoutePreference keyed by question kind', () => {
    const parsed = SubjectProfileSchema.parse(yuwenProfile);
    expect(parsed.sourcingRoutePreference?.reading_comprehension).toEqual([
      'material',
      'sourced',
      'closed_book',
    ]);
  });

  it('rejects an invalid route value in sourcingRoutePreference', () => {
    const bad = {
      ...yuwenProfile,
      sourcingRoutePreference: { translation: ['nonsense_route'] },
    };
    expect(SubjectProfileSchema.safeParse(bad).success).toBe(false);
  });

  it('the three shipped profiles all parse with the new section', () => {
    for (const profile of [yuwenProfile, mathProfile, physicsProfile]) {
      const parsed = SubjectProfileSchema.safeParse(profile);
      expect(parsed.success).toBe(true);
    }
  });
});
