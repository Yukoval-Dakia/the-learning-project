import { getDefaultRegistry } from '@/core/capability/judges';
import { validateProfile } from '@/core/capability/validate-profile';
import { subjectProfiles } from '@/subjects/profile';
import { describe, expect, it } from 'vitest';

describe('Profile ↔ Registry integration', () => {
  const registry = getDefaultRegistry();

  for (const [id, profile] of Object.entries(subjectProfiles)) {
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
