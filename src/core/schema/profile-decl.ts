import { z } from 'zod';
import { FsrsRating } from './business';
import { CoarseOutcome } from './capability';
import { MetaCause } from './cause';

const CAUSE_ID_PATTERN = /^[a-z][a-z0-9_]*$/;

// YUK-739 — subject-owned rating/cause semantics. The three fields below move
// semantics that used to live in cross-subject mirrors (the universal
// DEFAULT_META_CAUSE_BY_CATEGORY table, rating-advisor's hard-coded id lists,
// variant-gen's VARIANT_CAUSE_STRATEGIES) onto the per-subject cause category
// declaration itself. All three are OPTIONAL at the schema level so historical
// trait payloads and custom subjects without declarations keep parsing; the
// builtin profiles must declare them (audit:profile fails closed) and
// undeclared categories inherit the neutral fallback the legacy code used for
// unknown ids.

/**
 * How a cause category leans the rating advisory on a partial-credit verdict.
 * Replaces rating-advisor's hard-coded id lists ('careless'/'carelessness' →
 * carelessness-leaning, 'concept'/'conceptual*' → conceptual-leaning): each
 * subject declares the lean on its OWN vocabulary.
 */
export const CauseRatingLean = z.enum(['carelessness', 'conceptual']);
export type CauseRatingLeanT = z.infer<typeof CauseRatingLean>;

export const CauseCategoryDeclaration = z.object({
  id: z.string().min(1).regex(CAUSE_ID_PATTERN, {
    message: 'cause id must be lowercase alphanumeric + underscores, starting with a letter',
  }),
  label: z.string().min(1),
  description: z.string().optional(),
  review_priority: z
    .union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)])
    .optional(),
  variant_targetable: z.boolean().optional(),
  source_pack: z
    .object({
      id: z.string().min(1),
      version: z.string().min(1),
    })
    .optional(),
  /**
   * Cold-start meta-cause prior for this category (YUK-739). Replaced the
   * cross-subject DEFAULT_META_CAUSE_BY_CATEGORY mirror: the prior is a fact
   * about the subject's OWN category vocabulary, not a global id table.
   * `null` = deliberately non-diagnostic (e.g. `other`). Undefined (custom /
   * historical declarations) = no prior — attribution normalization falls
   * back to null, matching the legacy unknown-id behavior.
   */
  meta_cause_prior: MetaCause.nullable().optional(),
  /** Rating-advisory lean (see CauseRatingLean). Undefined = neutral. */
  rating_lean: CauseRatingLean.nullable().optional(),
  /**
   * Targeted-variant authoring strategy copy for this category (YUK-739).
   * Replaced variant-gen's cross-subject VARIANT_CAUSE_STRATEGIES table.
   * Undefined = the generic per-category fallback line.
   */
  variant_strategy: z.string().trim().min(1).optional(),
});
export type CauseCategoryDeclarationT = z.infer<typeof CauseCategoryDeclaration>;

export const RenderConfig = z.object({
  font_family: z.string().min(1),
  notation: z.string().nullable(),
  code_highlight: z.string().nullable(),
});
export type RenderConfigT = z.infer<typeof RenderConfig>;

export const SchedulingHints = z.object({
  default_policy: z.string().min(1),
});
export type SchedulingHintsT = z.infer<typeof SchedulingHints>;

// ── YUK-739 — rating policy (judge verdict → FSRS rating surface) ────────────
//
// The coarse_outcome → FsrsRating map was previously duplicated as inline
// copies in src/capabilities/practice/server/judge-rating.ts and
// src/core/capability/schedulers/fsrs.ts. It now lives as a typed,
// schema-validated SubjectProfile section so a subject that needs different
// verdict semantics can declare them instead of every consumer silently
// inheriting one subject's (or task shape's) mapping.

/**
 * Verdict → rating map. `unsupported` may map to null (= verdict not ratable;
 * skips FSRS scheduling). The three ratable outcomes must map onto a concrete
 * FsrsRating — the FSRS kernel takes exactly one of again|hard|good.
 */
export const RatingFromOutcomePolicy = z.object({
  correct: FsrsRating,
  partial: FsrsRating,
  incorrect: FsrsRating,
  unsupported: FsrsRating.nullable(),
});
export type RatingFromOutcomePolicyT = z.infer<typeof RatingFromOutcomePolicy>;

/**
 * The genuinely-universal default every subject inherits unless it declares
 * otherwise. Byte-identical to the pre-YUK-739 inline mappings (replay
 * compatibility: historical FSRS states were scheduled under exactly these
 * values). Consumers WITHOUT a profile in scope (e.g. the core fsrs scheduler
 * capability, which by design receives no SubjectProfile) read this constant
 * directly — the one tracked universal, not an untracked mirror.
 */
export const UNIVERSAL_RATING_FROM_OUTCOME: RatingFromOutcomePolicyT = {
  correct: 'good',
  partial: 'hard',
  incorrect: 'again',
  unsupported: null,
};

export const RatingPolicySchema = z.object({
  outcomeToRating: RatingFromOutcomePolicy,
});
export type RatingPolicyT = z.infer<typeof RatingPolicySchema>;

/** Default `ratingPolicy` section value (the universal map). */
export const UNIVERSAL_RATING_POLICY: RatingPolicyT = {
  outcomeToRating: UNIVERSAL_RATING_FROM_OUTCOME,
};

export type RatingPolicyProfileLike = {
  ratingPolicy?: RatingPolicyT | undefined;
};

/**
 * Resolve the verdict → rating mapping for a profile. Absent/`null` profile or
 * a pre-YUK-739 profile object without the section inherits the universal map.
 */
export function ratingFromOutcomeFor(
  profile?: RatingPolicyProfileLike | null,
): RatingFromOutcomePolicyT {
  return profile?.ratingPolicy?.outcomeToRating ?? UNIVERSAL_RATING_FROM_OUTCOME;
}
