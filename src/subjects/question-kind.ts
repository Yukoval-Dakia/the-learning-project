// Single normalization layer for the three question-kind vocabularies: the
// persisted free-form `question.kind`, the profile/skill SubjectQuestionKind enum,
// and the on-disk quiz-gen directory names (derived from the enum). Persisted
// kind is no longer a behavior authority; branches read answer class or structure.
// Consumers use this module instead of hand-rolling computation/calculation cases.

import type { z } from 'zod';
import { kindLabelsShareAnswerClass } from '@/core/schema/answer-class';
import { KNOWN_QUESTION_KIND_IDS, type QuestionKind } from '@/core/schema/business';
import { type SubjectQuestionKind, SubjectQuestionKindSchema } from '@/subjects/profile-schema';

// Local alias instead of coupling to the judge-routing type.
type QuestionKindT = z.infer<typeof QuestionKind>;

// Recognition set for folding, not a gate: unknown labels remain valid kinds.
const CANONICAL_KIND_IDS: ReadonlySet<string> = new Set(KNOWN_QUESTION_KIND_IDS);

// Fold profile keys onto their persisted label. Lossy (several keys share one
// label), which is fine because pin/filter compatibility compares answer class.
const SKILL_TO_CANONICAL: Record<SubjectQuestionKind, QuestionKindT> = {
  single_choice: 'choice',
  multiple_choice: 'choice',
  short_answer: 'short_answer',
  translation: 'translation',
  reading_comprehension: 'reading',
  proof: 'derivation',
  calculation: 'computation',
  word_problem: 'computation',
};

// Reverse direction picks a representative key. Kinds with no profile equivalent
// pass through so skill resolution still reaches its no-pack fallback.
const CANONICAL_TO_SKILL: Partial<Record<QuestionKindT, SubjectQuestionKind>> = {
  choice: 'single_choice',
  short_answer: 'short_answer',
  translation: 'translation',
  reading: 'reading_comprehension',
  computation: 'calculation',
  derivation: 'proof',
};

/**
 * Fold any known vocabulary value to a canonical persisted label; null when
 * neither vocabulary knows it. Null is not invalidity — free-form kinds remain
 * valid, so callers choose to reject, skip, or pass through.
 */
export function normalizeToCanonicalKind(value: string): QuestionKindT | null {
  if (CANONICAL_KIND_IDS.has(value)) return value;
  if (SubjectQuestionKindSchema.safeParse(value).success) {
    return SKILL_TO_CANONICAL[value as SubjectQuestionKind];
  }
  return null;
}

/**
 * True when both labels land in the same answer class after folding. Labels
 * outside the vocabularies compare by their own class, so unknown open-answer
 * kinds still match a semantic pin while a choice pin stays exact-only.
 */
export function answerClassCompatible(a: string, b: string): boolean {
  const ca = normalizeToCanonicalKind(a) ?? a;
  const cb = normalizeToCanonicalKind(b) ?? b;
  return kindLabelsShareAnswerClass(ca, cb);
}

/**
 * Persisted label → representative skill key, normalizing first so callers may
 * pass either vocabulary. Unknown labels pass through untouched.
 */
export function questionKindToSkillKind(persistedKind: string): string {
  const canonical = normalizeToCanonicalKind(persistedKind);
  if (canonical === null) return persistedKind;
  return CANONICAL_TO_SKILL[canonical] ?? canonical;
}

/**
 * Inverse: skill key → the persisted label to query, so few-shot filters hit real
 * rows. Unknown values pass through.
 */
export function skillKindToQuestionKind(skillKind: string): string {
  const parsed = SubjectQuestionKindSchema.safeParse(skillKind);
  return parsed.success ? SKILL_TO_CANONICAL[parsed.data] : skillKind;
}

/**
 * Every persisted form that folds to this canonical label. Historical writers used
 * both vocabularies, so a read filtering on `kind = 'choice'` would miss
 * `single_choice` rows; expanding to IN (...) keeps those rows visible. Unknown
 * input returns itself as a single element, keeping the filter exact.
 */
export function canonicalKindToPersistedForms(kind: string): string[] {
  const canonical = normalizeToCanonicalKind(kind);
  if (canonical === null) return [kind];
  const forms = new Set<string>([canonical]);
  for (const [skillKind, mapped] of Object.entries(SKILL_TO_CANONICAL) as Array<
    [SubjectQuestionKind, QuestionKindT]
  >) {
    if (mapped === canonical) forms.add(skillKind);
  }
  return [...forms];
}
