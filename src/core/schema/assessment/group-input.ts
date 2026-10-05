import { stableStringify } from '../../migration/canonical';
import type { GroupEvidenceT, SubmissionRecordT } from './judgment';
import type { EvidenceAttachmentT } from './materials';
import { type ResponseSetT, validateResponseSet } from './response';
import type { PublishedQuestionRevisionT } from './revision';

/** Original submissions stay separate; this is a view of a declared joint input. */
export interface EvaluationInputMember {
  submission: SubmissionRecordT;
  issued_part_ids: readonly string[];
}

export class GroupInputContractError extends Error {
  override name = 'GroupInputContractError';
  constructor(
    public readonly code: 'invalid_group_input' | 'invalid_issuance_scope',
    detail: string,
  ) {
    super(`assessment group input: ${detail}`);
  }
}

export function combineEvaluationMembers(
  anchor: SubmissionRecordT,
  revision: Pick<PublishedQuestionRevisionT, 'revision_id' | 'structure' | 'response_spec'>,
  members: readonly EvaluationInputMember[],
) {
  const fail = (detail: string): never => {
    throw new GroupInputContractError('invalid_group_input', detail);
  };
  const ids = new Set<string>();
  const partIds = new Set<string>();
  const knownParts = new Set(revision.structure.parts.map((part) => part.part_id));
  const entries: ResponseSetT['entries'] = [];
  const groupEvidence: GroupEvidenceT[] = [];
  const evidenceById = new Map<string, string>();
  const seenGroupEvidence = new Set<string>();
  let occurrenceMs = Number.NEGATIVE_INFINITY;
  let foundAnchor = false;
  const acceptEvidence = (evidence: EvidenceAttachmentT) => {
    const bytes = stableStringify(evidence);
    const previous = evidenceById.get(evidence.evidence_id);
    if (previous !== undefined && previous !== bytes) fail('ambiguous evidence identity');
    evidenceById.set(evidence.evidence_id, bytes);
  };
  const ordered = [...members].sort((a, b) =>
    a.submission.submission_id < b.submission.submission_id
      ? -1
      : a.submission.submission_id > b.submission.submission_id
        ? 1
        : 0,
  );
  for (const member of ordered) {
    const sub = member.submission;
    if (ids.has(sub.submission_id)) fail('duplicate member');
    ids.add(sub.submission_id);
    if (
      sub.evaluation_group_id !== anchor.evaluation_group_id ||
      sub.revision_id !== revision.revision_id
    ) {
      fail('joint members must share the declared group and published revision');
    }
    if (sub.submission_id === anchor.submission_id) {
      if (stableStringify(sub) !== stableStringify(anchor)) fail('anchor payload mismatch');
      foundAnchor = true;
    }
    if (
      member.issued_part_ids.length === 0 ||
      new Set(member.issued_part_ids).size !== member.issued_part_ids.length ||
      member.issued_part_ids.some((part) => !knownParts.has(part))
    ) {
      throw new GroupInputContractError(
        'invalid_issuance_scope',
        'issued parts must be a nonempty unique subset of the frozen revision',
      );
    }
    for (const part of member.issued_part_ids) {
      if (partIds.has(part)) fail('overlapping issued parts');
      partIds.add(part);
    }
    const ownParts = new Set(member.issued_part_ids);
    const issues = validateResponseSet(
      { slots: revision.response_spec.slots.filter((slot) => ownParts.has(slot.part_id)) },
      sub.response_set,
    );
    if (issues.length > 0)
      fail(`member responses outside its issuance: ${issues.map((i) => i.detail).join('; ')}`);
    entries.push(...sub.response_set.entries);
    for (const entry of sub.response_set.entries) {
      if (entry.kind === 'open') for (const evidence of entry.evidence) acceptEvidence(evidence);
    }
    for (const evidence of sub.group_evidence) {
      acceptEvidence(evidence.evidence);
      const key = stableStringify(evidence);
      if (!seenGroupEvidence.has(key)) groupEvidence.push(evidence);
      seenGroupEvidence.add(key);
    }
    const time = Date.parse(sub.submitted_at);
    if (!Number.isFinite(time)) fail('invalid member occurrence');
    occurrenceMs = Math.max(occurrenceMs, time);
  }
  if (!foundAnchor) fail('anchor is not a declared member');
  return {
    member_submission_ids: [...ids].sort(),
    issued_part_ids: [...partIds].sort(),
    response_set: { entries },
    group_evidence: groupEvidence,
    occurrence_at: new Date(occurrenceMs).toISOString(),
  };
}
