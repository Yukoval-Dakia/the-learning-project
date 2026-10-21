// Shared by both audit:profile modes (compile-time and DB assembly). Builtin
// subjects fail closed: each cause category must declare meta_cause_prior
// (explicit null allowed) and ratingPolicy must carry the complete verdict map.
// Custom subjects may omit both and inherit the neutral fallbacks.

import { FsrsRating } from '@/core/schema/business';
import { BUILTIN_SUBJECT_IDS } from './builtin-trait-seeds';
import type { SubjectProfile } from './profile-schema';

export function auditEvaluationSemantics(profile: SubjectProfile): string[] {
  if (!(BUILTIN_SUBJECT_IDS as readonly string[]).includes(profile.id)) return [];
  const errors: string[] = [];
  for (const category of profile.causeCategories) {
    if (category.meta_cause_prior === undefined) {
      errors.push(
        `SubjectProfile.causeCategories[${category.id}]: builtin subject '${profile.id}' must declare meta_cause_prior (explicit null allowed) — rating/cause semantics are subject-owned (YUK-739)`,
      );
    }
  }
  const map = profile.ratingPolicy?.outcomeToRating;
  const legal = new Set<string>(FsrsRating.options);
  const valuesOk =
    map !== undefined &&
    (['correct', 'partial', 'incorrect'] as const).every(
      (outcome) => typeof map[outcome] === 'string' && legal.has(map[outcome]),
    ) &&
    (map.unsupported === null ||
      (typeof map.unsupported === 'string' && legal.has(map.unsupported)));
  if (!valuesOk) {
    errors.push(
      `SubjectProfile.ratingPolicy.outcomeToRating: builtin subject '${profile.id}' must declare the complete verdict→rating map over FsrsRating values (YUK-739)`,
    );
  }
  return errors;
}
