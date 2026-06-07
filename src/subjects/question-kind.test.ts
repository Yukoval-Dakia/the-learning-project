// YUK-226 S2-5b (验证轮 A) — 单一权威 kind 词表规范化层 unit test (no DB).
//
// 覆盖 normalizeToCanonicalKind / kindsMatch / questionKindToSkillKind /
// skillKindToQuestionKind 的双向映射 + 校验 + cross-vocabulary 命中。

import { describe, expect, it } from 'vitest';

import {
  canonicalKindToPersistedForms,
  kindsMatch,
  normalizeToCanonicalKind,
  questionKindToSkillKind,
  skillKindToQuestionKind,
} from './question-kind';

describe('normalizeToCanonicalKind', () => {
  it('passes a persisted QuestionKind through unchanged (canonical)', () => {
    expect(normalizeToCanonicalKind('choice')).toBe('choice');
    expect(normalizeToCanonicalKind('computation')).toBe('computation');
    expect(normalizeToCanonicalKind('reading')).toBe('reading');
    expect(normalizeToCanonicalKind('translation')).toBe('translation');
    expect(normalizeToCanonicalKind('derivation')).toBe('derivation');
  });

  it('folds profile/skill SubjectQuestionKind to canonical', () => {
    expect(normalizeToCanonicalKind('single_choice')).toBe('choice');
    expect(normalizeToCanonicalKind('multiple_choice')).toBe('choice');
    expect(normalizeToCanonicalKind('reading_comprehension')).toBe('reading');
    expect(normalizeToCanonicalKind('calculation')).toBe('computation');
    expect(normalizeToCanonicalKind('word_problem')).toBe('computation');
    expect(normalizeToCanonicalKind('proof')).toBe('derivation');
  });

  it('returns null for an unknown value (drives the route 400)', () => {
    expect(normalizeToCanonicalKind('nonsense')).toBeNull();
    expect(normalizeToCanonicalKind('')).toBeNull();
    expect(normalizeToCanonicalKind('calc')).toBeNull();
  });
});

describe('kindsMatch (canonical-space compare)', () => {
  it('matches the same canonical kind across vocabularies', () => {
    // reading_comprehension request vs reading output.
    expect(kindsMatch('reading', 'reading_comprehension')).toBe(true);
    expect(kindsMatch('reading_comprehension', 'reading')).toBe(true);
    // computation vs calculation.
    expect(kindsMatch('computation', 'calculation')).toBe(true);
    // single_choice / multiple_choice both fold to choice.
    expect(kindsMatch('choice', 'single_choice')).toBe(true);
    expect(kindsMatch('single_choice', 'multiple_choice')).toBe(true);
    // proof vs derivation.
    expect(kindsMatch('derivation', 'proof')).toBe(true);
  });

  it('rejects different kinds', () => {
    expect(kindsMatch('reading', 'computation')).toBe(false);
    expect(kindsMatch('translation', 'calculation')).toBe(false);
  });

  it('rejects when either side is unknown', () => {
    expect(kindsMatch('reading', 'nonsense')).toBe(false);
    expect(kindsMatch('nonsense', 'reading')).toBe(false);
  });
});

describe('questionKindToSkillKind (canonical → representative skill key)', () => {
  it('maps canonical kinds to their representative SubjectQuestionKind', () => {
    expect(questionKindToSkillKind('computation')).toBe('calculation');
    expect(questionKindToSkillKind('reading')).toBe('reading_comprehension');
    expect(questionKindToSkillKind('choice')).toBe('single_choice');
    expect(questionKindToSkillKind('derivation')).toBe('proof');
  });

  it('accepts a profile key too (normalizes first)', () => {
    expect(questionKindToSkillKind('calculation')).toBe('calculation');
    expect(questionKindToSkillKind('reading_comprehension')).toBe('reading_comprehension');
  });

  it('passes through kinds with no profile equivalent', () => {
    expect(questionKindToSkillKind('true_false')).toBe('true_false');
    expect(questionKindToSkillKind('fill_blank')).toBe('fill_blank');
    expect(questionKindToSkillKind('essay')).toBe('essay');
  });
});

describe('canonicalKindToPersistedForms (YUK-288 题型 filter expansion)', () => {
  it('expands a canonical kind to canonical + every profile vocab folding to it', () => {
    // choice ← single_choice, multiple_choice (seed/fixture rows store single_choice).
    expect(new Set(canonicalKindToPersistedForms('choice'))).toEqual(
      new Set(['choice', 'single_choice', 'multiple_choice']),
    );
    // computation ← calculation, word_problem.
    expect(new Set(canonicalKindToPersistedForms('computation'))).toEqual(
      new Set(['computation', 'calculation', 'word_problem']),
    );
    // reading ← reading_comprehension.
    expect(new Set(canonicalKindToPersistedForms('reading'))).toEqual(
      new Set(['reading', 'reading_comprehension']),
    );
    // derivation ← proof.
    expect(new Set(canonicalKindToPersistedForms('derivation'))).toEqual(
      new Set(['derivation', 'proof']),
    );
  });

  it('returns only the canonical itself for kinds with no profile vocab', () => {
    // true_false / fill_blank / essay / translation / short_answer have no extra
    // folding profile key (translation/short_answer map 1:1; the rest are
    // canonical-only). The set always includes the canonical value at minimum.
    expect(canonicalKindToPersistedForms('true_false')).toEqual(['true_false']);
    expect(canonicalKindToPersistedForms('fill_blank')).toEqual(['fill_blank']);
    expect(canonicalKindToPersistedForms('essay')).toEqual(['essay']);
    expect(new Set(canonicalKindToPersistedForms('translation'))).toEqual(new Set(['translation']));
    expect(new Set(canonicalKindToPersistedForms('short_answer'))).toEqual(
      new Set(['short_answer']),
    );
  });

  it('accepts a profile key (normalizes first) and still expands the canonical family', () => {
    // A caller passing single_choice gets the full choice family, not just itself.
    expect(new Set(canonicalKindToPersistedForms('single_choice'))).toEqual(
      new Set(['choice', 'single_choice', 'multiple_choice']),
    );
  });

  it('degenerates to an exact single-element set for an unknown kind', () => {
    // Unknown → no normalisation → exact match on the raw value (no over-broadening).
    expect(canonicalKindToPersistedForms('nonsense')).toEqual(['nonsense']);
  });
});

describe('skillKindToQuestionKind (profile key → persisted canonical)', () => {
  it('maps profile keys to the persisted kind rows are stored under', () => {
    expect(skillKindToQuestionKind('calculation')).toBe('computation');
    expect(skillKindToQuestionKind('reading_comprehension')).toBe('reading');
    expect(skillKindToQuestionKind('single_choice')).toBe('choice');
    expect(skillKindToQuestionKind('proof')).toBe('derivation');
    expect(skillKindToQuestionKind('translation')).toBe('translation');
  });

  it('round-trips computation/calculation and reading/reading_comprehension', () => {
    expect(skillKindToQuestionKind(questionKindToSkillKind('computation'))).toBe('computation');
    expect(questionKindToSkillKind(skillKindToQuestionKind('calculation'))).toBe('calculation');
    expect(skillKindToQuestionKind(questionKindToSkillKind('reading'))).toBe('reading');
  });
});
