import { ApiError } from '@/kernel/http';
import type { IssueAssessmentRequest, IssueAssessmentResult } from './issue';

// Both transports expose the same issued/replayed result and domain-error contract.
export function projectIssuanceResult(
  body: Pick<IssueAssessmentRequest, 'group_id' | 'issuance_id'>,
  out: IssueAssessmentResult,
) {
  switch (out.status) {
    case 'issued':
    case 'replayed':
      return out;
    case 'not_found':
      throw new ApiError('not_found', `question group '${body.group_id}' not found`, 404);
    case 'unpublished':
      throw new ApiError(
        'unpublished',
        `question group '${body.group_id}' has no published revision — nothing to issue`,
        422,
      );
    case 'revision_mismatch':
      throw new ApiError(
        'revision_mismatch',
        'requested revision has been superseded or is not current',
        409,
      );
    case 'suspended':
      throw new ApiError(
        'suspended',
        `question group '${body.group_id}' is suspended (verify/retraction hold) — new issuance blocked`,
        422,
      );
    case 'withdrawn':
      throw new ApiError('withdrawn', `question group '${body.group_id}' is withdrawn`, 422);
    case 'not_admitted':
      throw new ApiError(
        'not_admitted',
        `question group '${body.group_id}' is not scoring-admitted for auto_score issuance`,
        422,
        undefined,
        // typed gate reason（公共枚举）进 details；issues 文本仍是诊断。
        out.serving_reason != null ? { serving_reason: out.serving_reason } : undefined,
      );
    case 'container_ref_required':
      throw new ApiError(
        'container_ref_required',
        `question group '${body.group_id}' is container_only — container_occurrence_ref required`,
        422,
      );
    case 'claim_unavailable':
      throw new ApiError(
        'claim_unavailable',
        `question group '${body.group_id}' already has an unreleased claimed issuance`,
        409,
      );
    case 'issuance_id_conflict':
      throw new ApiError(
        'issuance_id_conflict',
        `issuance '${body.issuance_id}' already exists with a different binding`,
        409,
      );
    case 'binding_invalid':
      throw new ApiError(
        'binding_invalid',
        `issuance binding invalid: ${(out.issues ?? []).join('; ')}`,
        422,
      );
    default:
      throw new ApiError('internal_error', 'unexpected issueAssessment status', 500);
  }
}
