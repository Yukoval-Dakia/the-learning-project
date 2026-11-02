// Mock import-lane revisions for the rehearsal. Live publishes do not use this file.
// q-solo has no frozen snapshot, so its only legal binding is question_asserted.
// A snapshot_verified digest is canonicalHash of the frozen snapshot. Do not hand-write it.

import type { RevisionRegistry, RevisionRegistryEntry } from '@/core/migration/apply';
import { canonicalHash } from '@/core/migration/canonical';
import type { Db } from '@/db/client';
import {
  question_admission_verification,
  question_group_lifecycle,
  question_revision,
} from '@/db/schema';
import { DURABLE_SNAPSHOT, MAIN_SNAPSHOT, SOLO_SNAPSHOT } from './corpus';

const T0 = new Date('2026-09-20T08:00:00.000Z');

interface RevisionSeed {
  revisionId: string;
  groupId: string;
  promptMd: string;
  referenceMd: string;
}

function revisionRow(seed: RevisionSeed): typeof question_revision.$inferInsert {
  const { revisionId, groupId, promptMd } = seed;
  return {
    revision_id: revisionId,
    group_id: groupId,
    revision_ordinal: 1,
    integrity_digest: canonicalHash({ revision: revisionId, group: groupId }),
    structure: {
      group_id: groupId,
      materials: [],
      parts: [{ part_id: 'p1', prompt_md: promptMd, material_ids: [] }],
    },
    response_spec: {
      slots: [
        {
          slot_id: 's1',
          part_id: 'p1',
          kind: 'open_response',
          accepted_evidence: [],
          evidence_required: false,
        },
      ],
    },
    scoring_basis: {
      units: [
        {
          scoring_unit_id: 'u1',
          slot_refs: ['s1'],
          material_refs: [],
          evidence_slot_refs: [],
          requires_group_evidence: false,
          criterion: {
            kind: 'rule_reference',
            rule_id: 'legacy-import',
            statement_md: 'historical import',
            source: 'manual',
          },
          points: 1,
        },
      ],
      aggregation: { kind: 'sum' },
      blank_scores_zero: false,
    },
    execution_plan: {
      plan_version: 1,
      assignments: [{ scoring_unit_ids: ['u1'], executor: { kind: 'human_review' } }],
      escalation: { on_unadmitted_model: 'withhold', on_low_confidence: 'human_review' },
    },
    supersedes_revision_id: null,
    availability: 'general_pool' as const,
    published_by: { by: 'system' as const, task_kind: 'migration-corpus-import' },
    published_at: T0,
  };
}

/** Seed revisions, an admitted lifecycle, and the admission verification. */
export async function seedContractCorpus(db: Db): Promise<void> {
  const rows: RevisionSeed[] = [
    {
      revisionId: 'rev-q-main',
      groupId: 'grp-q-main',
      promptMd: MAIN_SNAPSHOT.question.prompt_md,
      referenceMd: MAIN_SNAPSHOT.question.reference_md ?? '',
    },
    {
      revisionId: 'rev-q-durable',
      groupId: 'grp-q-durable',
      promptMd: DURABLE_SNAPSHOT.prompt_md,
      referenceMd: DURABLE_SNAPSHOT.reference_md ?? '',
    },
    {
      revisionId: 'rev-q-solo',
      groupId: 'grp-q-solo',
      promptMd: SOLO_SNAPSHOT.question.prompt_md,
      referenceMd: SOLO_SNAPSHOT.question.reference_md ?? '',
    },
  ];
  await db.insert(question_revision).values(rows.map(revisionRow));
  await db.insert(question_group_lifecycle).values(
    rows.map((r) => ({
      group_id: r.groupId,
      current_revision_id: r.revisionId,
      availability: 'general_pool' as const,
      // admitted lets issueAssessment auto-score.
      scoring_admission_state: 'admitted' as const,
      // AdmissionEvidence from publish.ts. system_verified plus a passed
      // independent check matches an imported admitted row.
      scoring_admission_evidence: {
        marking_provenance: 'system_verified' as const,
        verification: {
          structural_check_passed: true,
          independent_verification: {
            passed: true,
            verifier: 'independent_model' as const,
            verified_at: T0.toISOString(),
          },
          note: 'rehearsal corpus admission evidence',
        },
        model_slice: null,
      },
      scoring_admission_decided_at: T0,
      scoring_admission_generation: 1,
      claim_policy: 'unbounded' as const,
      suspended: false,
      withdrawn: false,
      created_at: T0,
      updated_at: T0,
    })),
  );
  await db.insert(question_admission_verification).values(
    rows.map((r) => ({
      id: `qav-${r.revisionId}`,
      revision_id: r.revisionId,
      revision_digest: canonicalHash({ revision: r.revisionId, group: r.groupId }),
      policy_id: 'admission-policy@rehearsal',
      generation: 0,
      outcome: 'passed' as const,
      recorded_at: T0,
    })),
  );
}

/** Two snapshot_verified bindings and one question_asserted. q-solo can only be the latter. */
export function buildRehearsalRegistry(now = T0): RevisionRegistry {
  const entry = (
    questionId: string,
    revisionId: string,
    kind: RevisionRegistryEntry['binding_kind'],
    snapshotDigest: string | null,
    assertionReason: string | null,
  ): RevisionRegistryEntry => ({
    question_id: questionId,
    revision_id: revisionId,
    part_ids: ['p1'],
    slot_id: 's1',
    scoring_unit_id: 'u1',
    binding_kind: kind,
    snapshot_digest: snapshotDigest,
    assertion_reason: assertionReason,
    published_at: now.toISOString(),
  });
  return {
    registry_version: 2,
    generated_by: 'yuk1057-rehearsal',
    entries: [
      entry('q-main', 'rev-q-main', 'snapshot_verified', canonicalHash(MAIN_SNAPSHOT), null),
      entry(
        'q-durable',
        'rev-q-durable',
        'snapshot_verified',
        canonicalHash(DURABLE_SNAPSHOT),
        null,
      ),
      entry(
        'q-solo',
        'rev-q-solo',
        'question_asserted',
        null,
        'owner-verified mapping of the legacy solo derivation into its contract revision',
      ),
    ],
  };
}
