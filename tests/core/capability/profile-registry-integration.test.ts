import { getDefaultRegistry } from '@/core/capability/judges';
import { validateProfile } from '@/core/capability/validate-profile';
import { subjectProfiles } from '@/subjects/profile';
import { describe, expect, it } from 'vitest';

describe('Profile ↔ Registry integration', () => {
  const registry = getDefaultRegistry();
  const profiles = Object.entries(subjectProfiles);

  it('covers every built-in subject profile', () => {
    expect(profiles.length).toBeGreaterThanOrEqual(2);
  });

  it('registers every implemented judge route used by built-in subject profiles', () => {
    expect(registry.resolveJudge('semantic')).toBeTruthy();

    for (const [id, profile] of profiles) {
      for (const route of profile.judgePolicy.preferredRoutes) {
        if (registry.resolveJudge(route)) {
          expect(profile.judgeCapabilities, `${id} should declare ${route}`).toContain(route);
        }
      }
    }
  });

  for (const [id, profile] of profiles) {
    describe(`${id} profile`, () => {
      it('passes validation against the default registry', () => {
        const result = validateProfile(profile, registry);
        if (!result.valid) {
          console.error(`${id} validation errors:`, result.errors);
        }
        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
      });

      it('has no deprecation warnings', () => {
        const result = validateProfile(profile, registry);
        expect(result.warnings).toHaveLength(0);
      });
    });
  }
});
