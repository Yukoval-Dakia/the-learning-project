import {
  CauseCategoryDeclaration,
  RenderConfig,
  SchedulingHints,
} from '@/core/schema/profile-decl';
import {
  resolveSubjectProfile,
  subjectProfiles,
} from '@/subjects/profile';
import { describe, expect, it } from 'vitest';

describe('SubjectProfile extensions', () => {
  it('wenyan profile has version field', () => {
    const profile = subjectProfiles.wenyan;
    expect(profile.version).toBeDefined();
    expect(typeof profile.version).toBe('string');
    expect(profile.version.length).toBeGreaterThan(0);
  });

  it('wenyan profile has causeCategories array', () => {
    const profile = subjectProfiles.wenyan;
    expect(Array.isArray(profile.causeCategories)).toBe(true);
    expect(profile.causeCategories.length).toBeGreaterThan(0);
    for (const category of profile.causeCategories) {
      expect(CauseCategoryDeclaration.safeParse(category).success).toBe(true);
    }
  });

  it('wenyan causeCategories have unique ids', () => {
    const profile = subjectProfiles.wenyan;
    const ids = profile.causeCategories.map((category) => category.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('wenyan profile has renderConfig', () => {
    const profile = subjectProfiles.wenyan;
    expect(RenderConfig.safeParse(profile.renderConfig).success).toBe(true);
    expect(profile.renderConfig.font_family).toBe('serif-cjk');
    expect(profile.renderConfig.notation).toBeNull();
  });

  it('wenyan profile has schedulingHints', () => {
    const profile = subjectProfiles.wenyan;
    expect(SchedulingHints.safeParse(profile.schedulingHints).success).toBe(
      true,
    );
    expect(profile.schedulingHints.default_policy).toBe('fsrs');
  });

  it('wenyan profile has judgeCapabilities array', () => {
    const profile = subjectProfiles.wenyan;
    expect(Array.isArray(profile.judgeCapabilities)).toBe(true);
    expect(profile.judgeCapabilities).toContain('exact');
    expect(profile.judgeCapabilities).toContain('keyword');
  });

  it('math profile has renderConfig with katex notation', () => {
    const profile = subjectProfiles.math;
    expect(profile.renderConfig.notation).toBe('katex');
    expect(profile.renderConfig.font_family).toBe('system');
  });

  it('math profile has causeCategories with unique ids', () => {
    const profile = subjectProfiles.math;
    expect(profile.causeCategories.length).toBeGreaterThan(0);
    const ids = profile.causeCategories.map((category) => category.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('all profiles still have existing fields intact', () => {
    for (const profile of Object.values(subjectProfiles)) {
      expect(profile.displayName).toBeDefined();
      expect(profile.languageStyle).toBeDefined();
      expect(profile.questionKinds.length).toBeGreaterThan(0);
      expect(profile.judgePolicy).toBeDefined();
      expect(profile.noteTemplate).toBeDefined();
      expect(profile.grounding).toBeDefined();
      expect(profile.promptFragments).toBeDefined();
    }
  });

  it('resolveSubjectProfile defaults to wenyan for unknown domains', () => {
    expect(resolveSubjectProfile('unknown').id).toBe('wenyan');
    expect(resolveSubjectProfile(null).id).toBe('wenyan');
  });
});
