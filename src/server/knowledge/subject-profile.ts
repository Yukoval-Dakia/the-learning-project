import { getAllowedCauseIds } from '@/core/schema/cause';
import type { Db } from '@/db/client';
import { ApiError } from '@/server/http/errors';
import { type SubjectProfile, resolveSubjectProfile } from '@/subjects/profile';
import { getEffectiveDomain } from './domain';

export async function resolveSubjectProfileForKnowledgeIds(
  db: Db,
  knowledgeIds: string[],
): Promise<SubjectProfile> {
  const firstKnowledgeId = knowledgeIds[0];
  if (!firstKnowledgeId) return resolveSubjectProfile(null);
  const domain = await getEffectiveDomain(db, firstKnowledgeId);
  return resolveSubjectProfile(domain);
}

export function assertCauseAllowedForSubjectProfile(
  cause: { primary_category: string } | null,
  profile: SubjectProfile,
): void {
  if (cause === null) return;
  const allowed = getAllowedCauseIds(profile);
  if (allowed.has(cause.primary_category)) return;
  throw new ApiError(
    'validation_error',
    `cause '${cause.primary_category}' is not allowed for subject '${profile.id}'`,
    400,
  );
}
