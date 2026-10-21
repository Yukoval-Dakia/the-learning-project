// Seed source of truth. Payloads are decomposed from the code profiles at load
// time, but a content change only reaches deployed rows when the matching
// seedVersion is bumped: reconcileBuiltinTraits treats a semver mismatch as its
// only upgrade signal and hard-skips equal rows (reruns stay side-effect free).
//
// Versions are per (subject, kind); a charter bump must not churn other kinds.

import { subjectProfiles } from './profile';
import { decomposeProfileToTraitPayloads } from './trait-compose';
import {
  SUBJECT_TRAIT_KINDS,
  type SubjectTraitKind,
  TRAIT_PAYLOAD_SCHEMA_VERSIONS,
} from './trait-schemas';

export const BUILTIN_SUBJECT_IDS = ['general', 'yuwen', 'math', 'physics'] as const;
export type BuiltinSubjectId = (typeof BUILTIN_SUBJECT_IDS)[number];

// Bump the matching cell whenever that seed's content changes, or deployed rows
// keep the old payload.
export const BUILTIN_TRAIT_SEED_VERSIONS: Record<
  BuiltinSubjectId,
  Record<SubjectTraitKind, string>
> = {
  general: {
    charter: '1.0.0',
    // Rating/cause semantics moved onto the profile; bumped so existing rows
    // reconcile to the new payload.
    judge_policy: '1.1.0',
    cause_taxonomy: '1.1.0',
    source_policy: '1.0.0',
    render_theme: '1.0.0',
    scheduling: '1.0.0',
  },
  yuwen: {
    charter: '1.0.0',
    judge_policy: '1.1.0',
    cause_taxonomy: '1.1.0',
    source_policy: '1.0.0',
    render_theme: '1.0.0',
    scheduling: '1.0.0',
  },
  math: {
    charter: '1.0.0',
    judge_policy: '1.1.0',
    cause_taxonomy: '1.1.0',
    // 1.2.0 dropped the retired jyeooSupply field so deployed rows upgrade.
    source_policy: '1.2.0',
    render_theme: '1.0.0',
    scheduling: '1.0.0',
  },
  physics: {
    charter: '1.0.0',
    judge_policy: '1.1.0',
    cause_taxonomy: '1.1.0',
    source_policy: '1.0.0',
    render_theme: '1.0.0',
    scheduling: '1.0.0',
  },
};

export interface BuiltinTraitSeed {
  payload: unknown;
  seedVersion: string;
  payloadSchemaVersion: number;
}

export function seedTraitId(subjectId: BuiltinSubjectId, kind: SubjectTraitKind): string {
  return `trt_seed_${subjectId}_${kind}`;
}

function buildSeeds(): Record<BuiltinSubjectId, Record<SubjectTraitKind, BuiltinTraitSeed>> {
  const out = {} as Record<BuiltinSubjectId, Record<SubjectTraitKind, BuiltinTraitSeed>>;
  for (const subjectId of BUILTIN_SUBJECT_IDS) {
    const profile = subjectProfiles[subjectId];
    if (!profile) {
      // Missing builtin is a broken build, not a runtime condition.
      throw new Error(`BUILTIN_TRAIT_SEEDS: builtin profile '${subjectId}' is not registered`);
    }
    const payloads = decomposeProfileToTraitPayloads(profile);
    out[subjectId] = {} as Record<SubjectTraitKind, BuiltinTraitSeed>;
    for (const kind of SUBJECT_TRAIT_KINDS) {
      out[subjectId][kind] = {
        payload: payloads[kind],
        seedVersion: BUILTIN_TRAIT_SEED_VERSIONS[subjectId][kind],
        payloadSchemaVersion: TRAIT_PAYLOAD_SCHEMA_VERSIONS[kind],
      };
    }
  }
  return out;
}

export const BUILTIN_TRAIT_SEEDS = buildSeeds();
