import { z } from 'zod';

const CAUSE_ID_PATTERN = /^[a-z][a-z0-9_]*$/;

export const CauseCategoryId = z.string().regex(CAUSE_ID_PATTERN, {
  message: 'cause id must be lowercase alphanumeric + underscores, starting with a letter',
});

// Backward-compatible export name used throughout the app.
export const CauseCategory = CauseCategoryId;
export type CauseCategoryT = z.infer<typeof CauseCategory>;

export const MetaCause = z.enum([
  'execution_slip',
  'knowledge_gap',
  'retrieval_failure',
  'rule_misapplication',
  'flawed_model',
  'representation_failure',
]);
export type MetaCauseT = z.infer<typeof MetaCause>;

export const MetacogFlag = z.enum([
  'blind_spot',
  'false_fluency',
  'regulation_gap',
  'overconfident',
  'poor_resolution',
  'calibrated',
]);
export type MetacogFlagT = z.infer<typeof MetacogFlag>;

export const BloomLevel = z.enum([
  'remember',
  'understand',
  'apply',
  'analyze',
  'evaluate',
  'create',
]);
export type BloomLevelT = z.infer<typeof BloomLevel>;

export const MetaCauseFields = z.object({
  meta_cause: MetaCause.nullable(),
  meta_cause_secondary: MetaCause.nullable(),
  metacog_flag: MetacogFlag.nullable(),
  bloom_level: BloomLevel.nullable(),
  self_corrected_on_hint: z.boolean().nullable(),
  recurred_cross_item: z.boolean().nullable(),
});
export type MetaCauseFieldsT = z.infer<typeof MetaCauseFields>;

export const CauseSchema = z.object({
  primary_category: CauseCategoryId,
  secondary_categories: z.array(CauseCategoryId).default([]),
  analysis_md: z.string(),
  confidence: z.number().min(0).max(1),
  // YUK-672: optional at the event boundary so every historical judge remains
  // parseable. The live attribution writer completes all six fields (nullable)
  // before writing a new judge event.
  meta_cause: MetaCause.nullish(),
  meta_cause_secondary: MetaCause.nullish(),
  metacog_flag: MetacogFlag.nullish(),
  bloom_level: BloomLevel.nullish(),
  self_corrected_on_hint: z.boolean().nullish(),
  recurred_cross_item: z.boolean().nullish(),
});
export type CauseSchemaT = z.infer<typeof CauseSchema>;

/**
 * Cold-start priors only. Instance-level attribution may override these from
 * behavioral evidence; an explicit `null` means the category is deliberately
 * non-diagnostic (for example `other`).
 */
export const DEFAULT_META_CAUSE_BY_CATEGORY: Readonly<Record<string, MetaCauseT | null>> = {
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

export function getDefaultMetaCause(categoryId: string): MetaCauseT | null | undefined {
  return DEFAULT_META_CAUSE_BY_CATEGORY[categoryId];
}

export type CauseProfileLike = {
  causeCategories?: Array<{
    id: string;
    label?: string;
    description?: string;
    review_priority?: 1 | 2 | 3 | 4 | 5;
    variant_targetable?: boolean;
  }>;
};

export function getAllowedCauseIds(profile?: CauseProfileLike | null): Set<string> {
  return new Set((profile?.causeCategories ?? []).map((category) => category.id));
}

export function validateCauseAgainstProfile<T extends CauseSchemaT>(
  cause: T,
  profile?: CauseProfileLike | null,
): T {
  const allowed = getAllowedCauseIds(profile);
  const fallback = allowed.has('other') ? 'other' : (profile?.causeCategories?.[0]?.id ?? 'other');
  const primary = allowed.has(cause.primary_category) ? cause.primary_category : fallback;
  const secondary = cause.secondary_categories.filter(
    (category) => allowed.has(category) && category !== primary,
  );
  return {
    ...cause,
    primary_category: primary,
    secondary_categories: secondary,
  };
}

export function getCauseLabel(causeId: string, profile?: CauseProfileLike | null): string {
  const profileCategory = profile?.causeCategories?.find((category) => category.id === causeId);
  if (profileCategory?.label) return profileCategory.label;
  const fallbackCategory = profile?.causeCategories?.find((category) => category.id === 'other');
  return fallbackCategory?.label ?? '其它';
}

export function getCausePriority(
  causeId: string | null | undefined,
  profile?: CauseProfileLike | null,
): 1 | 2 | 3 | 4 | 5 {
  if (!causeId) return 3;
  const profileCategory = profile?.causeCategories?.find((category) => category.id === causeId);
  if (profileCategory?.review_priority) return profileCategory.review_priority;
  const fallbackCategory = profile?.causeCategories?.find((category) => category.id === 'other');
  return fallbackCategory?.review_priority ?? 3;
}
