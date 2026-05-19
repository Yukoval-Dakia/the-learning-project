import { z } from 'zod';

const CAUSE_ID_PATTERN = /^[a-z][a-z0-9_]*$/;

export const UNIVERSAL_CAUSE_IDS = [
  'concept',
  'knowledge_gap',
  'calculation',
  'reading',
  'memory',
  'expression',
  'method',
  'carelessness',
  'time_pressure',
  'other',
] as const;

export type UniversalCauseId = (typeof UNIVERSAL_CAUSE_IDS)[number];

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

export const UNIVERSAL_CAUSE_LABELS: Record<UniversalCauseId, string> = {
  concept: '概念',
  knowledge_gap: '知识缺',
  calculation: '运算',
  reading: '审题',
  memory: '记忆',
  expression: '表达',
  method: '方法',
  carelessness: '手滑',
  time_pressure: '时间',
  other: '其它',
};

export const UNIVERSAL_CAUSE_PRIORITY: Record<UniversalCauseId, 1 | 2 | 3 | 4 | 5> = {
  concept: 5,
  knowledge_gap: 4,
  method: 4,
  calculation: 3,
  reading: 3,
  memory: 3,
  expression: 3,
  carelessness: 2,
  time_pressure: 2,
  other: 2,
};

export type CauseProfileLike = {
  causeCategories?: Array<{
    id: string;
    label?: string;
    description?: string;
  }>;
};

export function getAllowedCauseIds(profile?: CauseProfileLike | null): Set<string> {
  return new Set([
    ...UNIVERSAL_CAUSE_IDS,
    ...(profile?.causeCategories ?? []).map((category) => category.id),
  ]);
}

export function validateCauseAgainstProfile<T extends CauseSchemaT>(
  cause: T,
  profile?: CauseProfileLike | null,
): T {
  const allowed = getAllowedCauseIds(profile);
  const primary = allowed.has(cause.primary_category) ? cause.primary_category : 'other';
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
  if (causeId in UNIVERSAL_CAUSE_LABELS) {
    return UNIVERSAL_CAUSE_LABELS[causeId as UniversalCauseId];
  }
  const profileCategory = profile?.causeCategories?.find((category) => category.id === causeId);
  return profileCategory?.label ?? UNIVERSAL_CAUSE_LABELS.other;
}

export function getCausePriority(
  causeId: string | null | undefined,
  profile?: CauseProfileLike | null,
): 1 | 2 | 3 | 4 | 5 {
  if (!causeId) return 3;
  if (causeId in UNIVERSAL_CAUSE_PRIORITY) {
    return UNIVERSAL_CAUSE_PRIORITY[causeId as UniversalCauseId];
  }
  if (profile?.causeCategories?.some((category) => category.id === causeId)) {
    return UNIVERSAL_CAUSE_PRIORITY.other;
  }
  return UNIVERSAL_CAUSE_PRIORITY.other;
}
