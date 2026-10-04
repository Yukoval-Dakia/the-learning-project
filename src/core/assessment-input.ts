/** Frozen assessment input calculation shared by writer, activation and readers. */
import { canonicalHash, stableStringify } from './migration/canonical';
import {
  type EvaluationInputMember,
  GroupInputContractError,
  combineEvaluationMembers,
} from './schema/assessment/group-input';
import {
  EvaluationInputSnapshot,
  type EvaluationInputSnapshotT,
  SubmissionRecord,
  type SubmissionRecordT,
} from './schema/assessment/judgment';
import type { IssuanceBindingT, PublishedQuestionRevisionT } from './schema/assessment/revision';

export interface FrozenEvaluationMember extends EvaluationInputMember {
  binding: IssuanceBindingT;
  issued_at: string;
}

type SubmissionRow = Omit<SubmissionRecordT, 'submitted_at'> & { submitted_at: Date };
type IssuanceRow = IssuanceBindingT & { issuance_id: string; issued_at: Date };
export function evaluationMemberFromRows(
  sub: SubmissionRow,
  issuance: IssuanceRow,
): FrozenEvaluationMember {
  if (sub.issuance_id !== issuance.issuance_id || sub.revision_id !== issuance.revision_id) {
    throw new GroupInputContractError(
      'invalid_group_input',
      'submission/issuance coordinates differ',
    );
  }
  return {
    submission: SubmissionRecord.parse({ ...sub, submitted_at: sub.submitted_at.toISOString() }),
    issued_part_ids: issuance.part_ids,
    binding: {
      revision_id: issuance.revision_id,
      part_ids: issuance.part_ids,
      material_bindings: issuance.material_bindings,
      option_order: issuance.option_order,
    },
    issued_at: issuance.issued_at.toISOString(),
  };
}

export function sameMemberSet(a: readonly string[], b: readonly string[]): boolean {
  return (
    a.length > 0 &&
    new Set(a).size === a.length &&
    new Set(b).size === b.length &&
    stableStringify([...a].sort()) === stableStringify([...b].sort())
  );
}

export function freezeEvaluationInput(
  anchor: SubmissionRecordT,
  revision: Pick<
    PublishedQuestionRevisionT,
    'revision_id' | 'integrity_digest' | 'structure' | 'response_spec'
  >,
  members: readonly FrozenEvaluationMember[],
): EvaluationInputSnapshotT {
  const scope = combineEvaluationMembers(anchor, revision, members);
  return EvaluationInputSnapshot.parse({
    version: 1,
    revision_id: revision.revision_id,
    member_submission_ids: scope.member_submission_ids,
    issued_part_ids: scope.issued_part_ids,
    occurrence_at: scope.occurrence_at,
    digest: `sha256:${canonicalHash({
      anchor_submission_id: anchor.submission_id,
      revision_id: revision.revision_id,
      revision_digest: revision.integrity_digest,
      members: [...members].sort((a, b) =>
        a.submission.submission_id < b.submission.submission_id
          ? -1
          : a.submission.submission_id > b.submission.submission_id
            ? 1
            : 0,
      ),
    })}`,
  });
}

export function matchesEvaluationInput(
  snapshot: unknown,
  actual: EvaluationInputSnapshotT,
): boolean {
  const parsed = EvaluationInputSnapshot.safeParse(snapshot);
  return parsed.success && stableStringify(parsed.data) === stableStringify(actual);
}
