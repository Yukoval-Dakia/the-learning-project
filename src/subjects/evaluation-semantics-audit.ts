// YUK-739 — evaluation-semantics audit check, shared by the two audit:profile
// modes (compile-time `scripts/audit-profile.ts` and DB-assembly
// `src/server/subjects/audit-profile-db.ts`).
//
// Rating/cause semantics declarations are REQUIRED on builtin subjects (fail
// closed): every cause category must declare its `meta_cause_prior` (explicit
// null allowed — undeclared is not), and `ratingPolicy.outcomeToRating` must be
// the complete verdict→rating map over legal FsrsRating values. Custom
// (non-builtin) subjects may omit them and inherit the neutral fallbacks
// (universal rating map / null prior), same as pre-YUK-739 trait payloads —
// their ids are simply not in the builtin floor the audit guards.

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
