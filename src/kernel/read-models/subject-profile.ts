import { getAllowedCauseIds } from '@/core/schema/cause';
import type { Db, Tx } from '@/db/client';
import { ApiError } from '@/kernel/http';
import { hydrateSubjectRegistryFromDb } from '@/kernel/read-models/subject-hydration';
import {
  type SubjectProfile,
  SubjectRegistry,
  normalizeSubjectKey,
  resolveKnownSubjectId,
  resolveSubjectProfile,
} from '@/subjects/profile';
import { SUBJECT_TRAIT_KINDS } from '@/subjects/trait-schemas';
import { getEffectiveDomain } from './knowledge-tree';

/**
 * Resolve the authoritative profile without the read-side orphan fallback.
 * Release-critical writers use this variant so a transient DB/domain failure
 * cannot silently change the task prompt to the generic subject profile.
 */
export async function resolveSubjectProfileForKnowledgeIdsStrict(
  db: Db | Tx,
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

/**
 * Strictly-live subject resolution for paid inputs. Hydrates a private registry in
 * the caller's context and returns the profile only when it is DB-live this round:
 * the subject is hydrated and every bound trait resolution passed schema. A non-empty
 * domain that resolves to no known subject throws instead of silently using `general`.
 * Every failure throws before any plan/void/enqueue/provider step.
 */
export async function resolveSubjectProfileStrictLive(
  db: Db | Tx,
  domain: string | null,
): Promise<SubjectProfile> {
  const registry = new SubjectRegistry();
  const report = await hydrateSubjectRegistryFromDb(db, registry);
  const raw = domain?.trim() ?? '';
  const key = raw ? normalizeSubjectKey(raw) : '';
  let targetId: string;
  if (key) {
    const resolved = registry.resolveKnownSubjectId(key);
    if (resolved === null) {
      const skipped = report.skipped.find((s) => normalizeSubjectKey(s.subjectId) === key);
      throw new Error(
        skipped
          ? `domain '${raw}' subject '${skipped.subjectId}' failed hydration: ${skipped.reason}`
          : `domain '${raw}' resolves to no known subject — refusing a fallback profile`,
      );
    }
    targetId = resolved;
  } else {
    targetId = 'general';
  }
  if (!report.hydrated.includes(targetId)) {
    const reason = report.builtinFloor.includes(targetId)
      ? 'degraded to builtin code floor'
      : (report.skipped.find((s) => normalizeSubjectKey(s.subjectId) === targetId)?.reason ??
        'no hydrated DB subject row');
    throw new Error(`subject '${targetId}' is not authoritatively hydrated: ${reason}`);
  }
  const resolutions = report.resolutions.get(targetId);
  if (!resolutions || resolutions.length !== SUBJECT_TRAIT_KINDS.length) {
    throw new Error(`subject '${targetId}' lacks complete live trait provenance`);
  }
  const degraded = resolutions.filter((r) => r.degraded !== null);
  if (degraded.length > 0) {
    throw new Error(
      `subject '${targetId}' has non-live trait payloads: ${degraded
        .map((r) => `${r.kind}=${r.degraded}`)
        .join(', ')}`,
    );
  }
  const profile = registry.get(targetId);
  if (!profile) {
    throw new Error(`subject '${targetId}' missing from registry after successful hydration`);
  }
  return profile;
}

export async function resolveSubjectProfileForKnowledgeIds(
  db: Db | Tx,
  knowledgeIds: string[],
): Promise<SubjectProfile> {
  const firstKnowledgeId = knowledgeIds[0];
  if (!firstKnowledgeId) return resolveSubjectProfile(null);
  try {
    return await resolveSubjectProfileForKnowledgeIdsStrict(db, knowledgeIds);
  } catch (err) {
    // Tolerate missing or orphaned knowledge ids: fall back to the default profile
    // rather than 500. Audit drift owns flagging real orphan data.
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
