import { z } from 'zod';
import {
  CauseCategoryDeclaration,
  RatingPolicySchema,
  RenderConfig,
  SchedulingHints,
  UNIVERSAL_RATING_POLICY,
} from '@/core/schema/profile-decl';

export type SubjectId = string;

// Compile-time literal only; the runtime set is the registry (plus hydrated
// custom subjects). `general` is deliberately excluded because it is the
// fallback identity, never a selectable subject.
export const BUILTIN_IDS = ['yuwen', 'math', 'physics'] as const;
export type BuiltinId = (typeof BUILTIN_IDS)[number];

/** @deprecated Use BUILTIN_IDS or the runtime registry APIs. */
export const KNOWN_SUBJECT_IDS = BUILTIN_IDS;
/** @deprecated Subject ids are strings now; use BuiltinId where enumeration matters. */
export type KnownSubjectId = string;

export const SubjectQuestionKindSchema = z.enum([
  'single_choice',
  'multiple_choice',
  'short_answer',
  'translation',
  'reading_comprehension',
  'proof',
  'calculation',
  'word_problem',
]);
export type SubjectQuestionKind = z.infer<typeof SubjectQuestionKindSchema>;

// Preferred routes may name strategies without a runner yet; the allowlist lives
// with the judge contract. judgeCapabilities lists registry-backed runners only.
export const JudgeRouteKindSchema = z.enum([
  'exact',
  'keyword',
  'semantic',
  'rubric',
  'steps',
  'unit_dimension',
  'multimodal_direct',
  'ai_flexible',
]);
export type JudgeRouteKind = z.infer<typeof JudgeRouteKindSchema>;

export const SubjectProfileSchema = z.object({
  id: z.string().trim().min(1),
  version: z.string().trim().min(1),
  displayName: z.string().trim().min(1),
  languageStyle: z.string().trim().min(1),
  questionKinds: z.array(SubjectQuestionKindSchema).min(1),
  judgePolicy: z.object({
    preferredRoutes: z.array(JudgeRouteKindSchema).min(1),
    notes: z.array(z.string()),
  }),
  exampleSources: z.array(z.string().trim().min(1)),
  noteTemplate: z.object({
    definition: z.string().trim().min(1),
    mechanism: z.string().trim().min(1),
    example: z.string().trim().min(1),
    pitfall: z.string().trim().min(1),
    check: z.string().trim().min(1),
  }),
  grounding: z.object({
    requirement: z.string().trim().min(1),
    allowedSources: z.array(z.string().trim().min(1)),
    uncertaintyPolicy: z.string().trim().min(1),
  }),
  promptFragments: z.object({
    roleNoun: z.string().trim().min(1),
    noteExamplePolicy: z.string().trim().min(1),
    variantExamplePolicy: z.string().trim().min(1),
    teachingStyle: z.string().trim().min(1),
    checkQuestionPolicy: z.string().trim().min(1),
    learningIntentPolicy: z.string().trim().min(1),
    // Empty string is legal (it is the seed); .min(1) here would reject every
    // assembled profile. methodology feeds teaching prompts, rubricGuidance only
    // the authored rubric anchors.
    methodology: z.string().default(''),
    rubricGuidance: z.string().default(''),
  }),
  causeCategories: z.array(CauseCategoryDeclaration).min(1),
  // Maps judge outcomes to FSRS ratings; consumers resolve the policy through
  // the profile, never a local copy. Omitting it inherits the universal map.
  ratingPolicy: RatingPolicySchema.default(UNIVERSAL_RATING_POLICY),
  renderConfig: RenderConfig,
  schedulingHints: SchedulingHints,
  judgeCapabilities: z.array(z.string().trim().min(1)),
  // Skill packs are discovered on disk under src/subjects/<id>/skills, not
  // registered. Sources outside sourceWhitelist still enter (whitelist_match
  // false) and are only sorted lower; an empty list means none are trusted.
  sourceWhitelist: z.array(z.string().trim().min(1)).default([]),
  // Per-kind preference for where to find missing questions; unlisted kinds use
  // the default sourced → material → closed_book order.
  sourcingRoutePreference: z
    .partialRecord(
      SubjectQuestionKindSchema,
      z.array(z.enum(['sourced', 'material', 'closed_book', 'variant'])).min(1),
    )
    .optional(),
});
export type SubjectProfile = z.infer<typeof SubjectProfileSchema>;
export type SlimSubjectProfile = Pick<SubjectProfile, 'id' | 'displayName' | 'renderConfig'>;
