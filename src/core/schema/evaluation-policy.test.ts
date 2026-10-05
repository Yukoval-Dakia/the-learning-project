// YUK-739 — subject-owned rating/cause semantics policy: schema contract tests.
//
// The policy moved INTO SubjectProfile:
//   - CauseCategoryDeclaration gained `meta_cause_prior` (cold-start prior that
//     replaced the cross-subject DEFAULT_META_CAUSE_BY_CATEGORY mirror),
//     `rating_lean` (replaced rating-advisor's hard-coded subject id lists) and
//     `variant_strategy` (replaced variant-gen's VARIANT_CAUSE_STRATEGIES).
//   - SubjectProfileSchema gained `ratingPolicy.outcomeToRating` (the coarse
//     judge outcome → FSRS rating map that was duplicated in the practice
//     judge-rating copy + the core fsrs scheduler copy).
//
// This file pins: schema validation (incl. fail-closed on invalid values),
// genuinely-universal defaults, ≥2 subjects with meaningfully different
// semantics, and historical/replay compatibility (old shapes still parse and
// inherit the same behavior they had before the fields existed).

import { describe, expect, it } from 'vitest';
import { generalProfile } from '@/subjects/general/profile';
import { mathProfile } from '@/subjects/math/profile';
import { physicsProfile } from '@/subjects/physics/profile';
import { SubjectProfileSchema } from '@/subjects/profile-schema';
import { assembleSubjectProfile, decomposeProfileToTraitPayloads } from '@/subjects/trait-compose';
import { CauseTaxonomyTraitSchema, JudgePolicyTraitSchema } from '@/subjects/trait-schemas';
import { yuwenProfile } from '@/subjects/yuwen/profile';
import { CauseSchema } from './cause';
import { CauseCategoryDeclaration, UNIVERSAL_RATING_FROM_OUTCOME } from './profile-decl';

describe('CauseCategoryDeclaration evaluation-semantics fields (YUK-739)', () => {
  it('accepts a fully declared category', () => {
    const parsed = CauseCategoryDeclaration.safeParse({
      id: 'concept',
      label: '概念理解',
      meta_cause_prior: 'flawed_model',
      rating_lean: 'conceptual',
      variant_strategy: '同概念不同语境 / 反向考查（验证概念边界）',
    });
    expect(parsed.success).toBe(true);
  });

  it('keeps the new fields optional (historical declarations without them still parse)', () => {
    const parsed = CauseCategoryDeclaration.safeParse({ id: 'other', label: '其它' });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.meta_cause_prior).toBeUndefined();
      expect(parsed.data.rating_lean).toBeUndefined();
      expect(parsed.data.variant_strategy).toBeUndefined();
    }
  });

  it('rejects an invalid meta_cause_prior (fail closed)', () => {
    const parsed = CauseCategoryDeclaration.safeParse({
      id: 'concept',
      label: '概念理解',
      meta_cause_prior: 'bogus_meta_cause',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects an invalid rating_lean (fail closed)', () => {
    const parsed = CauseCategoryDeclaration.safeParse({
      id: 'careless',
      label: '粗心',
      rating_lean: 'sleepy',
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts an explicit null meta_cause_prior (deliberately non-diagnostic)', () => {
    const parsed = CauseCategoryDeclaration.safeParse({
      id: 'other',
      label: '其它',
      meta_cause_prior: null,
    });
    expect(parsed.success).toBe(true);
  });
});

describe('ratingPolicy section (YUK-739)', () => {
  it('the universal map equals the legacy inline mapping exactly (replay compatibility)', () => {
    // The values every production site used before the policy existed:
    // judge-rating.ts / core schedulers/fsrs.ts both mapped
    // correct→good, partial→hard, incorrect→again, unsupported→null.
    expect(UNIVERSAL_RATING_FROM_OUTCOME).toEqual({
      correct: 'good',
      partial: 'hard',
      incorrect: 'again',
      unsupported: null,
    });
  });

  it('SubjectProfileSchema defaults ratingPolicy to the universal map when omitted', () => {
    const { ratingPolicy: _omit, ...withoutPolicy } = mathProfile;
    const parsed = SubjectProfileSchema.parse(withoutPolicy);
    expect(parsed.ratingPolicy.outcomeToRating).toEqual(UNIVERSAL_RATING_FROM_OUTCOME);
  });

  it('rejects an invalid rating value (fail closed)', () => {
    const bad = {
      ...mathProfile,
      ratingPolicy: { outcomeToRating: { ...UNIVERSAL_RATING_FROM_OUTCOME, correct: 'easy' } },
    };
    expect(SubjectProfileSchema.safeParse(bad).success).toBe(false);
  });

  it('accepts a per-subject override (differing semantics are representable)', () => {
    const overridden = {
      ...mathProfile,
      ratingPolicy: { outcomeToRating: { ...UNIVERSAL_RATING_FROM_OUTCOME, partial: 'again' } },
    };
    const parsed = SubjectProfileSchema.parse(overridden);
    expect(parsed.ratingPolicy.outcomeToRating.partial).toBe('again');
  });
});

describe('built-in subjects declare meaningfully different cause semantics (YUK-739)', () => {
  const builtins = [generalProfile, yuwenProfile, mathProfile, physicsProfile];

  it('every built-in category declares an explicit meta_cause_prior', () => {
    for (const profile of builtins) {
      for (const category of profile.causeCategories) {
        expect(
          category.meta_cause_prior,
          `${profile.id}:${category.id} must declare meta_cause_prior (explicit null allowed)`,
        ).toBeDefined();
      }
    }
  });

  it('declared priors equal the legacy cross-subject map values (no silent reinterpretation)', () => {
    // Legacy DEFAULT_META_CAUSE_BY_CATEGORY rows, pinned inline so any drift
    // from the pre-YUK-739 semantics fails this test.
    const legacy: Record<string, string | null> = {
      concept: 'flawed_model',
      knowledge_gap: 'knowledge_gap',
      calculation: 'execution_slip',
      computation: 'execution_slip',
      method: 'rule_misapplication',
      reading: 'representation_failure',
      memory: 'retrieval_failure',
      expression: 'representation_failure',
      unit_error: 'execution_slip',
      unit: 'representation_failure',
      dimension: 'representation_failure',
      formula: 'retrieval_failure',
      grammar: 'rule_misapplication',
      word_meaning: 'rule_misapplication',
      carelessness: 'execution_slip',
      careless: 'execution_slip',
      time_pressure: 'execution_slip',
      other: null,
    };
    for (const profile of builtins) {
      for (const category of profile.causeCategories) {
        expect(`${profile.id}:${category.id}: ${category.meta_cause_prior}`).toBe(
          `${profile.id}:${category.id}: ${legacy[category.id]}`,
        );
      }
    }
  });

  it('math and physics use different ids for the same underlying semantics (vocab ownership)', () => {
    const mathIds = new Set(mathProfile.causeCategories.map((c) => c.id));
    const physicsIds = new Set(physicsProfile.causeCategories.map((c) => c.id));
    // math-only vocabulary
    expect(mathIds.has('calculation')).toBe(true);
    expect(physicsIds.has('calculation')).toBe(false);
    // physics-only vocabulary
    expect(physicsIds.has('computation')).toBe(true);
    expect(mathIds.has('computation')).toBe(false);
    expect(physicsIds.has('dimension')).toBe(true);
    expect(mathIds.has('dimension')).toBe(false);
    // both map onto execution_slip / representation_failure respectively
    expect(mathProfile.causeCategories.find((c) => c.id === 'calculation')?.meta_cause_prior).toBe(
      'execution_slip',
    );
    expect(
      physicsProfile.causeCategories.find((c) => c.id === 'computation')?.meta_cause_prior,
    ).toBe('execution_slip');
    expect(physicsProfile.causeCategories.find((c) => c.id === 'unit')?.meta_cause_prior).toBe(
      'representation_failure',
    );
    // yuwen-only vocabulary carries a different prior than the math namesakes
    expect(yuwenProfile.causeCategories.find((c) => c.id === 'grammar')?.meta_cause_prior).toBe(
      'rule_misapplication',
    );
  });

  it('rating leans are declared on the careless/conceptual categories of each subject', () => {
    const mathCarelessness = mathProfile.causeCategories.find((c) => c.id === 'carelessness');
    const physicsCareless = physicsProfile.causeCategories.find((c) => c.id === 'careless');
    expect(mathCarelessness?.rating_lean).toBe('carelessness');
    expect(physicsCareless?.rating_lean).toBe('carelessness');
    expect(mathProfile.causeCategories.find((c) => c.id === 'concept')?.rating_lean).toBe(
      'conceptual',
    );
    expect(physicsProfile.causeCategories.find((c) => c.id === 'concept')?.rating_lean).toBe(
      'conceptual',
    );
    // Non-leaning categories must NOT declare a lean (0-lean fallback preserved).
    expect(mathProfile.causeCategories.find((c) => c.id === 'unit_error')?.rating_lean).toBe(
      undefined,
    );
  });

  it('every built-in declares the universal rating policy explicitly', () => {
    for (const profile of builtins) {
      expect(profile.ratingPolicy.outcomeToRating).toEqual(UNIVERSAL_RATING_FROM_OUTCOME);
    }
  });
});

describe('historical + trait round-trip compatibility (YUK-739)', () => {
  it('historical judge cause payloads (no meta fields) still parse', () => {
    const parsed = CauseSchema.parse({
      primary_category: 'unit_error',
      secondary_categories: [],
      analysis_md: '单位换算错误。',
      confidence: 0.8,
    });
    expect(parsed.meta_cause).toBeUndefined();
  });

  it('a pre-YUK-739 judge_policy trait payload hydrates to the universal rating policy', () => {
    const { ratingPolicy, ...modern } = decomposeProfileToTraitPayloads(mathProfile).judge_policy;
    expect(ratingPolicy).toBeDefined();
    const legacyPayload = modern as unknown as Record<string, unknown>;
    const parsed = JudgePolicyTraitSchema.parse(legacyPayload);
    expect(parsed.ratingPolicy.outcomeToRating).toEqual(UNIVERSAL_RATING_FROM_OUTCOME);
  });

  it('a pre-YUK-739 cause_taxonomy trait payload (no semantics fields) still parses', () => {
    const legacyCategories = mathProfile.causeCategories.map(({ id, label, review_priority }) => ({
      id,
      label,
      review_priority,
    }));
    const parsed = CauseTaxonomyTraitSchema.safeParse({ causeCategories: legacyCategories });
    expect(parsed.success).toBe(true);
  });

  it('assemble(decompose(profile)) preserves the rating policy and cause semantics', () => {
    for (const profile of [generalProfile, yuwenProfile, mathProfile, physicsProfile]) {
      const payloads = decomposeProfileToTraitPayloads(profile);
      const assembled = assembleSubjectProfile({
        id: profile.id,
        displayName: profile.displayName,
        version: profile.version,
        payloads,
      });
      expect(assembled.ratingPolicy).toEqual(profile.ratingPolicy);
      expect(assembled.causeCategories).toEqual(profile.causeCategories);
    }
  });
});
