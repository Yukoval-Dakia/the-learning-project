import {
  CauseCategoryDeclaration,
  RenderConfig,
  SchedulingHints,
} from '@/core/schema/profile-decl';
import {
  KNOWN_SUBJECT_IDS,
  type SubjectProfile,
  SubjectRegistry,
  resolveSubjectProfile,
  subjectProfiles,
} from '@/subjects/profile';
import { describe, expect, it } from 'vitest';

function makeCustomProfile(overrides: Partial<SubjectProfile> = {}): SubjectProfile {
  const base = subjectProfiles.math;
  return {
    ...base,
    id: 'test_subject',
    version: '1.0.0',
    displayName: '测试学科',
    judgePolicy: {
      preferredRoutes: [...base.judgePolicy.preferredRoutes],
      notes: [...base.judgePolicy.notes],
    },
    noteTemplate: { ...base.noteTemplate },
    grounding: {
      ...base.grounding,
      allowedSources: [...base.grounding.allowedSources],
    },
    promptFragments: { ...base.promptFragments },
    causeCategories: base.causeCategories.map((category) => ({ ...category })),
    renderConfig: { ...base.renderConfig },
    schedulingHints: { ...base.schedulingHints },
    judgeCapabilities: [...base.judgeCapabilities],
    ...overrides,
  };
}

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

  it('wenyan profile declares subject-specific actionable cause categories', () => {
    const profile = subjectProfiles.wenyan;
    const categories = new Map(profile.causeCategories.map((category) => [category.id, category]));

    expect(profile.causeCategories).toHaveLength(11);
    expect(categories.get('grammar')?.label).toBe('语法判断');
    expect(categories.get('word_meaning')?.label).toBe('词义混淆');
    expect(categories.get('method')?.variant_targetable).toBe(true);
    expect(categories.get('time_pressure')?.review_priority).toBe(2);
    expect(categories.get('concept')?.description).not.toMatch(/词义|语法功能/);
  });

  it('wenyan profile has renderConfig', () => {
    const profile = subjectProfiles.wenyan;
    expect(RenderConfig.safeParse(profile.renderConfig).success).toBe(true);
    expect(profile.renderConfig.font_family).toBe('serif-cjk');
    expect(profile.renderConfig.notation).toBeNull();
  });

  it('wenyan profile has schedulingHints', () => {
    const profile = subjectProfiles.wenyan;
    expect(SchedulingHints.safeParse(profile.schedulingHints).success).toBe(true);
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

describe('SubjectRegistry', () => {
  it('resolves known subject by id', () => {
    const registry = new SubjectRegistry();
    const wenyan = registry.resolve('wenyan');
    expect(wenyan).toBeDefined();
    expect(wenyan.displayName).toBe('文言文');
  });

  it('resolves subject by alias', () => {
    const registry = new SubjectRegistry();
    const result = registry.resolve('classical_chinese');
    expect(result).toBeDefined();
    expect(result.id).toBe('wenyan');
  });

  it('resolves math by alias "mathematics"', () => {
    const registry = new SubjectRegistry();
    const result = registry.resolve('mathematics');
    expect(result).toBeDefined();
    expect(result.id).toBe('math');
  });

  it('returns default profile for unknown subject', () => {
    const registry = new SubjectRegistry();
    const result = registry.resolve('unknown_subject');
    expect(result).toBeDefined();
    expect(result.id).toBe('wenyan');
  });

  it('returns default profile for null/undefined', () => {
    const registry = new SubjectRegistry();
    expect(registry.resolve(null).id).toBe('wenyan');
    expect(registry.resolve(undefined).id).toBe('wenyan');
  });

  it('is case-insensitive', () => {
    const registry = new SubjectRegistry();
    expect(registry.resolve('WENYAN').id).toBe('wenyan');
    expect(registry.resolve('Math').id).toBe('math');
  });

  it('lists all registered profile ids', () => {
    const registry = new SubjectRegistry();
    const ids = registry.listIds();
    expect(ids).toContain('wenyan');
    expect(ids).toContain('math');
  });

  it('registers a custom profile', () => {
    const registry = new SubjectRegistry();
    // Use a synthetic id (not a real subject) so this test doesn't collide
    // with profiles added to the default registry over time.
    const testSubject = makeCustomProfile();
    registry.register(testSubject, ['test_alias', 'test_subject_101']);

    expect(registry.resolve('test_subject').displayName).toBe('测试学科');
    expect(registry.resolve('test_alias').id).toBe('test_subject');
    expect(registry.listIds()).toContain('test_subject');
  });

  it('throws instead of silently overwriting duplicate profile ids', () => {
    const registry = new SubjectRegistry();
    const firstSubject = makeCustomProfile();
    const secondSubject = { ...firstSubject, displayName: '覆盖测试学科' };

    registry.register(firstSubject);

    expect(() => registry.register(secondSubject)).toThrow(/already registered/i);
    expect(registry.resolve('test_subject').displayName).toBe('测试学科');
  });

  it('rejects invalid custom profiles during registration', () => {
    const registry = new SubjectRegistry();
    const invalidSubject = makeCustomProfile({
      id: 'invalid_subject',
      judgeCapabilities: [...subjectProfiles.math.judgeCapabilities, 'ghost_judge'],
    });

    expect(() => registry.register(invalidSubject)).toThrow(
      /Subject profile 'invalid_subject' failed validation:[\s\S]*ghost_judge/,
    );
    expect(registry.get('invalid_subject')).toBeUndefined();
  });

  it('rejects duplicate cause ids during registration', () => {
    const registry = new SubjectRegistry();
    const duplicate = {
      ...subjectProfiles.math.causeCategories[0],
      label: 'Duplicate cause',
    };
    const invalidSubject = makeCustomProfile({
      id: 'duplicate_cause_subject',
      causeCategories: [subjectProfiles.math.causeCategories[0], duplicate],
    });

    expect(() => registry.register(invalidSubject)).toThrow(/duplicate id/);
    expect(registry.get('duplicate_cause_subject')).toBeUndefined();
  });

  it('rejects missing prompt fragments during registration', () => {
    const registry = new SubjectRegistry();
    const { promptFragments: _promptFragments, ...invalidSubject } = makeCustomProfile({
      id: 'missing_prompt_subject',
    });

    expect(() => registry.register(invalidSubject as SubjectProfile)).toThrow(/promptFragments/);
    expect(registry.get('missing_prompt_subject')).toBeUndefined();
  });

  it('can report invalid registration without throwing for audit callers', () => {
    const registry = new SubjectRegistry();
    const invalidSubject = makeCustomProfile({
      id: 'audit_invalid_subject',
      judgeCapabilities: [...subjectProfiles.math.judgeCapabilities, 'ghost_judge'],
    });

    const result = registry.register(invalidSubject, [], { throwOnInvalid: false });

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes('ghost_judge'))).toBe(true);
    expect(registry.get('audit_invalid_subject')).toBeUndefined();
  });
});

describe('KNOWN_SUBJECT_IDS', () => {
  it('contains wenyan and math', () => {
    expect(KNOWN_SUBJECT_IDS).toContain('wenyan');
    expect(KNOWN_SUBJECT_IDS).toContain('math');
  });
});

describe('M2.1: mathProfile + steps@1', () => {
  it('mathProfile passes validateProfile against default registry', async () => {
    const { createDefaultRegistry } = await import('@/core/capability/judges');
    const { validateProfile } = await import('@/core/capability/validate-profile');
    const { mathProfile } = await import('@/subjects/math/profile');
    const registry = createDefaultRegistry();
    const result = validateProfile(mathProfile, registry);
    expect(result.errors, JSON.stringify(result.errors)).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('mathProfile.judgeCapabilities includes steps', async () => {
    const { mathProfile } = await import('@/subjects/math/profile');
    expect(mathProfile.judgeCapabilities).toContain('steps');
  });

  it('default registry exposes steps@1 with experimental stability', async () => {
    const { createDefaultRegistry } = await import('@/core/capability/judges');
    const registry = createDefaultRegistry();
    const runner = registry.resolveJudge('steps');
    expect(runner).toBeDefined();
    expect(runner?.manifest.version).toBe('1.0.0');
    expect(runner?.manifest.stability).toBe('experimental');
  });
});

describe('P0: physics SubjectProfile', () => {
  it('is registered in the default registry', () => {
    const profile = resolveSubjectProfile('physics');
    expect(profile.id).toBe('physics');
    expect(profile.displayName).toBe('物理');
  });

  it('resolves via the physical alias', () => {
    const profile = resolveSubjectProfile('physical');
    expect(profile.id).toBe('physics');
  });

  it('declares katex renderConfig', async () => {
    const { physicsProfile } = await import('@/subjects/physics/profile');
    expect(physicsProfile.renderConfig.notation).toBe('katex');
  });

  it('declares cause categories including unit and dimension', async () => {
    const { physicsProfile } = await import('@/subjects/physics/profile');
    const causeIds = physicsProfile.causeCategories.map((c) => c.id);
    expect(causeIds).toContain('unit');
    expect(causeIds).toContain('dimension');
  });

  it('judgeCapabilities at P1: exact + semantic + unit_dimension', async () => {
    const { physicsProfile } = await import('@/subjects/physics/profile');
    expect(physicsProfile.judgeCapabilities).toEqual(['exact', 'semantic', 'unit_dimension']);
  });

  it('prefers unit_dimension for P1 physics numeric answers', async () => {
    const { physicsProfile } = await import('@/subjects/physics/profile');
    expect(physicsProfile.judgePolicy.preferredRoutes).toEqual([
      'exact',
      'semantic',
      'unit_dimension',
    ]);
  });

  it('appears in registry.listIds()', async () => {
    const { getDefaultSubjectRegistry } = await import('@/subjects/profile');
    const registry = getDefaultSubjectRegistry();
    expect(registry.listIds()).toContain('physics');
  });

  it('KNOWN_SUBJECT_IDS contains physics', () => {
    expect(KNOWN_SUBJECT_IDS).toContain('physics');
  });

  it('physicsProfile passes validateProfile against default registry', async () => {
    const { createDefaultRegistry } = await import('@/core/capability/judges');
    const { validateProfile } = await import('@/core/capability/validate-profile');
    const { physicsProfile } = await import('@/subjects/physics/profile');
    const registry = createDefaultRegistry();
    const result = validateProfile(physicsProfile, registry);
    expect(result.errors, JSON.stringify(result.errors)).toEqual([]);
    expect(result.valid).toBe(true);
  });
});
