/** Frozen assessment input calculation shared by writer, activation and readers. */
import { canonicalHash, stableStringify } from './migration/canonical';
import {
  type EvaluationInputMember,
  GroupInputContractError,
  combineEvaluationMembers,
} from './schema/assessment/group-input';
import {
  AcceptedLearnerProcess,
  type AcceptedLearnerProcessT,
  EvaluationInputSnapshot,
  type EvaluationInputSnapshotT,
  SubmissionRecord,
  type SubmissionRecordT,
} from './schema/assessment/judgment';
import type { IssuanceBindingT, PublishedQuestionRevisionT } from './schema/assessment/revision';

export { acceptedProcessEventId } from './schema/assessment/judgment';

export interface FrozenEvaluationMember extends EvaluationInputMember {
  binding: IssuanceBindingT;
  issued_at: string;
}

type SubmissionRow = Omit<SubmissionRecordT, 'submitted_at'> & { submitted_at: Date };
type IssuanceRow = IssuanceBindingT & { issuance_id: string; issued_at: Date };

export function acceptLearnerProcess(
  submission: SubmissionRecordT,
  issuedPartIds: readonly string[],
  reasoningTrace?: string | null,
): AcceptedLearnerProcessT | undefined {
  if (!reasoningTrace?.trim()) return undefined;
  const original = SubmissionRecord.parse(submission);
  return AcceptedLearnerProcess.parse({
    version: 1,
    submission_id: original.submission_id,
    issuance_id: original.issuance_id,
    revision_id: original.revision_id,
    evaluation_group_id: original.evaluation_group_id,
    submission_digest: `sha256:${canonicalHash(original)}`,
    issued_part_ids: [...issuedPartIds].sort(),
    reasoning_trace: reasoningTrace,
  });
}

export function evaluationMemberFromRows(
  sub: SubmissionRow,
  issuance: IssuanceRow,
  learnerProcess?: AcceptedLearnerProcessT | null,
): FrozenEvaluationMember {
  if (sub.issuance_id !== issuance.issuance_id || sub.revision_id !== issuance.revision_id) {
    throw new GroupInputContractError(
      'invalid_group_input',
      'submission/issuance coordinates differ',
    );
  }
  const submission = SubmissionRecord.parse({
    ...sub,
    submitted_at: sub.submitted_at.toISOString(),
  });
  if (
    learnerProcess === null ||
    (learnerProcess !== undefined &&
      stableStringify(AcceptedLearnerProcess.parse(learnerProcess)) !==
        stableStringify(
          acceptLearnerProcess(submission, issuance.part_ids, learnerProcess.reasoning_trace),
        ))
  ) {
    throw new GroupInputContractError('invalid_group_input', 'accepted process binding differs');
  }
  return {
    submission,
    ...(learnerProcess ? { learner_process: learnerProcess } : {}),
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
  version: 1 | 2 = members.some((member) => member.learner_process !== undefined) ? 2 : 1,
): EvaluationInputSnapshotT {
  const scope = combineEvaluationMembers(anchor, revision, members);
  if (version === 2 && !members.some((member) => member.learner_process !== undefined)) {
    throw new GroupInputContractError('invalid_group_input', 'version 2 requires accepted process');
  }
  return EvaluationInputSnapshot.parse({
    version,
    revision_id: revision.revision_id,
    member_submission_ids: scope.member_submission_ids,
    issued_part_ids: scope.issued_part_ids,
    occurrence_at: scope.occurrence_at,
    digest: `sha256:${canonicalHash({
      anchor_submission_id: anchor.submission_id,
      revision_id: revision.revision_id,
      revision_digest: revision.integrity_digest,
      members: members
        .map(({ learner_process, ...member }) =>
          version === 2 && learner_process ? { ...member, learner_process } : member,
        )
        .sort((a, b) =>
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
