// YUK-226 S2-5b (验证轮 A) — 单一权威 kind 词表规范化层 unit test (no DB).
//
// 覆盖 normalizeToCanonicalKind / answerClassCompatible / questionKindToSkillKind /
// skillKindToQuestionKind 的双向映射 + 校验 + cross-vocabulary 命中。
// YUK-386：kindsMatch（归一后字符串相等）已退役为 answerClassCompatible
// （归一后比较 answer-class）——pin/过滤的语义是「同一判分类」而非「同一标签」。

import { describe, expect, it } from 'vitest';

import { KNOWN_QUESTION_KIND_IDS, QuestionKind } from '@/core/schema/business';
import { SubjectQuestionKindSchema } from './profile-schema';
import {
  answerClassCompatible,
  canonicalKindToPersistedForms,
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

describe('answerClassCompatible (YUK-386 — folded label → shared answer class)', () => {
  it('matches labels that fold to the same canonical kind', () => {
    // reading_comprehension request vs reading output.
    expect(answerClassCompatible('reading', 'reading_comprehension')).toBe(true);
    expect(answerClassCompatible('reading_comprehension', 'reading')).toBe(true);
    // computation vs calculation.
    expect(answerClassCompatible('computation', 'calculation')).toBe(true);
    // single_choice / multiple_choice both fold to choice.
    expect(answerClassCompatible('choice', 'single_choice')).toBe(true);
    expect(answerClassCompatible('single_choice', 'multiple_choice')).toBe(true);
  });

  it('widens beyond label identity: same answer class is compatible', () => {
    // The YUK-386 semantics — a pin on 'reading' accepts ANY open-answer label
    // (semantic class), including free-form labels unknown to either vocabulary.
    expect(answerClassCompatible('reading', 'computation')).toBe(true);
    expect(answerClassCompatible('translation', 'calculation')).toBe(true);
    expect(answerClassCompatible('reading', 'nonsense')).toBe(true);
    expect(answerClassCompatible('nonsense', 'reading')).toBe(true);
    // 'short_answer' pin ≡ 'essay' supply: both classify semantic.
    expect(answerClassCompatible('short_answer', 'essay')).toBe(true);
  });

  it('still rejects across answer classes', () => {
    // exact-class vs semantic-class.
    expect(answerClassCompatible('choice', 'reading')).toBe(false);
    expect(answerClassCompatible('choice', 'short_answer')).toBe(false);
    expect(answerClassCompatible('single_choice', 'essay')).toBe(false);
    // steps (derivation/proof) vs prose (semantic).
    expect(answerClassCompatible('derivation', 'reading')).toBe(false);
    expect(answerClassCompatible('proof', 'short_answer')).toBe(false);
    // exact vs steps.
    expect(answerClassCompatible('choice', 'derivation')).toBe(false);
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

// YUK-390 residual groundwork — lock the single-mapper convergence state over
// the FULL vocabularies (not just spot values): the profile→canonical mapping
// is total + consistent, every canonical family normalizes back to itself, the
// two vocabularies partition with no orphan values, and representative
// selection is stable. If a future kind is added to either vocabulary without
// updating the single mapping, these go red — the compile-time Record
// exhaustiveness catches missing keys; these catch semantic drift.
describe('vocabulary convergence invariants (full-vocab)', () => {
  it('every SubjectQuestionKind maps total + consistently into canonical', () => {
    for (const skillKind of SubjectQuestionKindSchema.options) {
      // QuestionKind is now z.string().min(1) (free-form label) — the parse
      // asserts the mapper emits a non-empty label, and normalize folds it back
      // to itself (mapper output is always a KNOWN canonical id).
      const mapped = skillKindToQuestionKind(skillKind);
      expect(QuestionKind.safeParse(mapped).success, skillKind).toBe(true);
      expect(KNOWN_QUESTION_KIND_IDS).toContain(mapped);
      expect(normalizeToCanonicalKind(skillKind), skillKind).toBe(mapped);
    }
  });

  it('every known canonical label expands to a family that normalizes back to it', () => {
    for (const canonical of KNOWN_QUESTION_KIND_IDS) {
      expect(new Set(canonicalKindToPersistedForms(canonical)).has(canonical), canonical).toBe(
        true,
      );
      for (const form of canonicalKindToPersistedForms(canonical)) {
        expect(normalizeToCanonicalKind(form), `${canonical} ← ${form}`).toBe(canonical);
      }
    }
  });

  it('no orphan values: every persisted form is a member of one of the two vocabularies', () => {
    const known = new Set<string>([
      ...KNOWN_QUESTION_KIND_IDS,
      ...SubjectQuestionKindSchema.options,
    ]);
    for (const canonical of KNOWN_QUESTION_KIND_IDS) {
      for (const form of canonicalKindToPersistedForms(canonical)) {
        expect(known.has(form), form).toBe(true);
      }
    }
  });

  it('representative selection is stable and family-preserving for every profile kind', () => {
    for (const skillKind of SubjectQuestionKindSchema.options) {
      const canonical = skillKindToQuestionKind(skillKind);
      const representative = questionKindToSkillKind(canonical);
      // stays in the same canonical family (lossy fold picks one member)...
      expect(skillKindToQuestionKind(representative), skillKind).toBe(canonical);
      // ...and is stable: applying the round-trip again changes nothing.
      expect(questionKindToSkillKind(skillKindToQuestionKind(representative)), skillKind).toBe(
        representative,
      );
    }
  });
});
