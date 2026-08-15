import { getAllowedCauseIds } from '@/core/schema/cause';
import type { Db } from '@/db/client';
import { ApiError } from '@/kernel/http';
import {
  type SubjectProfile,
  resolveKnownSubjectId,
  resolveSubjectProfile,
} from '@/subjects/profile';
import { getEffectiveDomain } from './knowledge-tree';

/**
 * Resolve the authoritative profile without the read-side orphan fallback.
 * Release-critical writers use this variant so a transient DB/domain failure
 * cannot silently change the task prompt to the generic subject profile.
 */
export async function resolveSubjectProfileForKnowledgeIdsStrict(
  db: Db,
  knowledgeIds: string[],
): Promise<SubjectProfile> {
  const firstKnowledgeId = knowledgeIds[0];
  if (!firstKnowledgeId) {
    throw new Error('resolveSubjectProfileForKnowledgeIdsStrict requires a knowledge id');
  }
  const domain = await getEffectiveDomain(db, firstKnowledgeId);
  const subjectId = resolveKnownSubjectId(domain);
  if (!subjectId) {
    throw new Error(
      `knowledge domain '${domain}' has no hydrated subject profile; strict resolution cannot use the general fallback`,
    );
  }
  return resolveSubjectProfile(subjectId);
}

export async function resolveSubjectProfileForKnowledgeIds(
  db: Db,
  knowledgeIds: string[],
): Promise<SubjectProfile> {
  const firstKnowledgeId = knowledgeIds[0];
  if (!firstKnowledgeId) return resolveSubjectProfile(null);
  try {
    return await resolveSubjectProfileForKnowledgeIdsStrict(db, knowledgeIds);
  } catch (err) {
    // YUK-56 (2026-05-24): tolerate missing / orphaned knowledge ids — fall
    // back to default profile rather than 500ing the caller. Reasons:
    //   - knowledge ids on a question may be stale (parent deleted, etc.)
    //     and judging shouldn't hard-block on the read-side housekeeping
    //   - this helper has no business surfacing knowledge-graph integrity
    //     issues — that's an audit-drift / DB-foreign-key concern
    //   - exact / keyword judges don't need profile-specific routing; they
    //     work with the default profile. Semantic / steps would also work,
    //     using the default subject hint
    // Audit-drift owns flagging real "orphan k id" data — this returns a
    // safe fallback at runtime.
    console.warn(
      `resolveSubjectProfileForKnowledgeIds: falling back to default profile for unresolvable knowledge id '${firstKnowledgeId}': ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return resolveSubjectProfile(null);
  }
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
