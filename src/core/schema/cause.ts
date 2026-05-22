import { z } from 'zod';

const CAUSE_ID_PATTERN = /^[a-z][a-z0-9_]*$/;

export const CauseCategoryId = z.string().regex(CAUSE_ID_PATTERN, {
  message: 'cause id must be lowercase alphanumeric + underscores, starting with a letter',
});

// Backward-compatible export name used throughout the app.
export const CauseCategory = CauseCategoryId;
export type CauseCategoryT = z.infer<typeof CauseCategory>;

export const CauseSchema = z.object({
  primary_category: CauseCategoryId,
  secondary_categories: z.array(CauseCategoryId).default([]),
  analysis_md: z.string(),
  confidence: z.number().min(0).max(1),
});
export type CauseSchemaT = z.infer<typeof CauseSchema>;

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
