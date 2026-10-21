// Per-kind strict write-gate schemas and the single source of trait kinds
// (db/schema imports them so the enums cannot drift). Browser-safe.
//
// Field split: charter (languageStyle + flat prompt fragments + note template),
// judge_policy (kinds/routes/capabilities), cause_taxonomy, source_policy,
// render_theme, scheduling. id/displayName live on the subject control row;
// assembly version is computed, never stored.
//
// Charter is deliberately a flat named-section object, not nested promptFragments,
// so a strict top-level gate rejects unknown sections. methodology/rubricGuidance
// default to '' because empty is the legal initial state; .min(1) would break
// thin-create and every assembled profile.

import { z } from 'zod';
import {
  CauseCategoryDeclaration,
  RatingPolicySchema,
  RenderConfig,
  SchedulingHints,
  UNIVERSAL_RATING_POLICY,
} from '@/core/schema/profile-decl';
import { JudgeRouteKindSchema, SubjectQuestionKindSchema } from './profile-schema';

export const SUBJECT_TRAIT_KINDS = [
  'charter',
  'judge_policy',
  'cause_taxonomy',
  'source_policy',
  'render_theme',
  'scheduling',
] as const;
export type SubjectTraitKind = (typeof SUBJECT_TRAIT_KINDS)[number];

// Payload schema generation carried by journal snapshots; bump when a shape changes.
export const TRAIT_PAYLOAD_SCHEMA_VERSIONS: Record<SubjectTraitKind, number> = {
  charter: 1,
  judge_policy: 1,
  cause_taxonomy: 1,
  source_policy: 1,
  render_theme: 1,
  scheduling: 1,
};

export const CharterTraitSchema = z
  .object({
    languageStyle: z.string().trim().min(1),
    // Flat prompt-fragment slots, same min(1) semantics as profile-schema.
    roleNoun: z.string().trim().min(1),
    noteExamplePolicy: z.string().trim().min(1),
    variantExamplePolicy: z.string().trim().min(1),
    teachingStyle: z.string().trim().min(1),
    checkQuestionPolicy: z.string().trim().min(1),
    learningIntentPolicy: z.string().trim().min(1),
    noteTemplate: z
      .object({
        definition: z.string().trim().min(1),
        mechanism: z.string().trim().min(1),
        example: z.string().trim().min(1),
        pitfall: z.string().trim().min(1),
        check: z.string().trim().min(1),
      })
      .strict(),
    // Empty string is legal here (see module header); seeds start empty.
    methodology: z.string().default(''),
    rubricGuidance: z.string().default(''),
  })
  .strict();
export type CharterTrait = z.infer<typeof CharterTraitSchema>;

export const JudgePolicyTraitSchema = z
  .object({
    questionKinds: z.array(SubjectQuestionKindSchema).min(1),
    judgePolicy: z
      .object({
        preferredRoutes: z.array(JudgeRouteKindSchema).min(1),
        notes: z.array(z.string()),
      })
      .strict(),
    judgeCapabilities: z.array(z.string().trim().min(1)),
    // Defaulted so rows predating this section hydrate to the same universal map.
    ratingPolicy: RatingPolicySchema.default(UNIVERSAL_RATING_POLICY),
  })
  .strict();
export type JudgePolicyTrait = z.infer<typeof JudgePolicyTraitSchema>;

export const CauseTaxonomyTraitSchema = z
  .object({
    causeCategories: z.array(CauseCategoryDeclaration).min(1),
  })
  .strict();
export type CauseTaxonomyTrait = z.infer<typeof CauseTaxonomyTraitSchema>;

export const SourcePolicyTraitSchema = z
  .object({
    grounding: z
      .object({
        requirement: z.string().trim().min(1),
        allowedSources: z.array(z.string().trim().min(1)),
        uncertaintyPolicy: z.string().trim().min(1),
      })
      .strict(),
    sourceWhitelist: z.array(z.string().trim().min(1)).default([]),
    sourcingRoutePreference: z
      .partialRecord(
        SubjectQuestionKindSchema,
        z.array(z.enum(['sourced', 'material', 'closed_book', 'variant'])).min(1),
      )
      .optional(),
    exampleSources: z.array(z.string().trim().min(1)),
  })
  .strict();
export type SourcePolicyTrait = z.infer<typeof SourcePolicyTraitSchema>;

export const RenderThemeTraitSchema = z
  .object({
    renderConfig: RenderConfig,
  })
  .strict();
export type RenderThemeTrait = z.infer<typeof RenderThemeTraitSchema>;

export const SchedulingTraitSchema = z
  .object({
    schedulingHints: SchedulingHints,
  })
  .strict();
export type SchedulingTrait = z.infer<typeof SchedulingTraitSchema>;

// One lookup for write gates and hydration so the two can never disagree.
export const TRAIT_PAYLOAD_SCHEMAS = {
  charter: CharterTraitSchema,
  judge_policy: JudgePolicyTraitSchema,
  cause_taxonomy: CauseTaxonomyTraitSchema,
  source_policy: SourcePolicyTraitSchema,
  render_theme: RenderThemeTraitSchema,
  scheduling: SchedulingTraitSchema,
} as const satisfies Record<SubjectTraitKind, z.ZodTypeAny>;

export type SubjectTraitPayloads = {
  charter: CharterTrait;
  judge_policy: JudgePolicyTrait;
  cause_taxonomy: CauseTaxonomyTrait;
  source_policy: SourcePolicyTrait;
  render_theme: RenderThemeTrait;
  scheduling: SchedulingTrait;
};

const SubjectTraitPayloadsSchema = z.object(TRAIT_PAYLOAD_SCHEMAS);

/** Validate the complete persisted/overridden assembly; error paths include the trait kind. */
export function parseTraitPayloads(
  raw: Partial<Record<SubjectTraitKind, unknown>>,
): SubjectTraitPayloads {
  return SubjectTraitPayloadsSchema.parse(raw);
}
