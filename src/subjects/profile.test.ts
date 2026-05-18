import { describe, expect, it } from 'vitest';
import { defaultSubjectProfile, resolveSubjectProfile } from './profile';

describe('SubjectProfile resolution', () => {
  it('defaults missing or unknown domains to wenyan', () => {
    expect(defaultSubjectProfile.id).toBe('wenyan');
    expect(resolveSubjectProfile().id).toBe('wenyan');
    expect(resolveSubjectProfile(null).id).toBe('wenyan');
    expect(resolveSubjectProfile('unknown-domain').id).toBe('wenyan');
  });

  it('resolves the math pressure-test profile without wenyan prompt fragments', () => {
    const profile = resolveSubjectProfile('math');

    expect(profile.id).toBe('math');
    expect(profile.displayName).toBe('数学');
    expect(profile.questionKinds).toContain('proof');
    expect(profile.judgePolicy.preferredRoutes).toContain('symbolic_math');
    expect(profile.promptFragments.noteExamplePolicy).toContain('推导');
    expect(profile.promptFragments.noteExamplePolicy).toContain('单位');
    expect(profile.promptFragments.noteExamplePolicy).not.toContain('《师说》');
    expect(profile.promptFragments.teachingStyle).not.toContain('文言文');
  });
});
