// Owns the issue and draft-save requests for both doors (Hono route and Start server
// function): body validation, the domain-status -> ApiError contract and the writer call.
// Each door keeps only its own transport (body read, Response or JSON shaping).

import type { ZodType } from 'zod';
import type { Db } from '@/db/client';
import { ApiError } from '@/kernel/http';
import {
  type IssueAssessmentRequest,
  type IssueAssessmentResult,
  issueAssessment,
} from '@/kernel/records/assessment-issuance';
import {
  IssueAssessmentBodySchema,
  SaveResponseDraftBodySchema,
} from '../../../api/assessment-contracts';
import { type SaveResponseDraftResult, saveResponseDraft } from './submit';

/** A missing or malformed body reaches the schema as null, so both doors report the same 400. */
export async function parseAssessmentBody<T>(
  readBody: () => Promise<unknown>,
  schema: ZodType<T>,
): Promise<T> {
  const parsed = schema.safeParse(await readBody().catch(() => null));
  if (!parsed.success) {
    const message = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new ApiError('validation_error', message, 400);
  }
  return parsed.data;
}

/** POST /api/issuances: the writer owns locking, frozen bindings, claims and replay. */
export async function requestAssessmentIssuance(db: Db, readBody: () => Promise<unknown>) {
  const body = await parseAssessmentBody(readBody, IssueAssessmentBodySchema);
  const out = await issueAssessment(db, {
    issuance_id: body.issuance_id,
    group_id: body.group_id,
    revision_id: body.revision_id,
    part_ids: body.part_ids,
    option_order_overrides: body.option_order_overrides,
    mode: body.mode,
    container_occurrence_ref: body.container_occurrence_ref ?? null,
    claim: body.claim,
    actorRef: 'api:issue',
  });
  return projectIssuanceResult(body, out);
}

/**
 * POST /api/issuances/[id]/responses: only a committed save returns; every other status is the
 * caller-visible refusal (stale epoch and already-submitted stay 409 so a client never
 * overwrites a newer draft or a submitted attempt).
 */
export async function requestResponseDraftSave(
  db: Db,
  issuanceId: string,
  readBody: () => Promise<unknown>,
): Promise<Extract<SaveResponseDraftResult, { status: 'saved' }>> {
  const body = await parseAssessmentBody(readBody, SaveResponseDraftBodySchema);
  const out = await saveResponseDraft(db, {
    issuance_id: issuanceId,
    evaluation_group_ref: body.evaluation_group_ref ?? null,
    response_set: body.response_set,
    group_evidence: body.group_evidence,
    expected_save_epoch: body.expected_save_epoch,
  });
  switch (out.status) {
    case 'saved':
      return out;
    case 'issuance_not_found':
      throw new ApiError('not_found', `issuance '${issuanceId}' not found`, 404);
    case 'invalid_response':
      throw new ApiError(
        'invalid_response',
        `response_set invalid for issued scope: ${(out.issues ?? []).join('; ')}`,
        422,
      );
    case 'stale_draft':
      throw new ApiError(
        'stale_draft',
        `draft epoch ${out.current_save_epoch} is newer than expected_save_epoch — refresh before overwriting`,
        409,
      );
    case 'already_submitted':
      throw new ApiError(
        'already_submitted',
        out.conflict_reason ?? 'draft for an already-submitted attempt cannot be recreated',
        409,
      );
    default:
      throw new ApiError('internal_error', 'unexpected saveResponseDraft status', 500);
  }
}

function projectIssuanceResult(
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
