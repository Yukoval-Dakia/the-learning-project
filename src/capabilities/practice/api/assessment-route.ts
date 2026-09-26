// YUK-1052 — issueAssessment / saveSubmission / 自动保存的 route handler。
// 薄层：只做 HTTP 整形 + zod 解析 + 域状态 → ApiError 映射；业务全在
// src/server/assessment/{issue,submit}.ts。

import type { ZodType } from 'zod';
import { db } from '@/db/client';
import { ApiError, errorResponse, resourceResponse } from '@/kernel/http';
import { issueAssessment } from '@/server/assessment/issue';
import { getIssuanceState, saveResponseDraft, saveSubmission } from '@/server/assessment/submit';
import {
  CreateSubmissionBodySchema,
  IssueAssessmentBodySchema,
  SaveResponseDraftBodySchema,
} from './assessment-contracts';

async function parseBody<T>(req: Request, schema: ZodType<T>): Promise<T> {
  const raw = await req.json().catch(() => null);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const message = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new ApiError('validation_error', message, 400);
  }
  return parsed.data;
}

// ---------- POST /api/issuances — issueAssessment ----------

export async function createIssuance(req: Request): Promise<Response> {
  try {
    const body = await parseBody(req, IssueAssessmentBodySchema);
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
    switch (out.status) {
      case 'issued':
      case 'replayed':
        return resourceResponse(out, {
          outcome: out.status === 'issued' ? 'created' : 'existing',
          location: `/api/issuances/${encodeURIComponent(out.issuance.issuance_id)}`,
        });
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
          'requested revision does not belong to the group',
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
  } catch (err) {
    return errorResponse(err);
  }
}

// ---------- GET /api/issuances/[id] — pending 恢复读面 ----------

export async function getIssuance(
  _req: Request,
  params: Record<string, string>,
): Promise<Response> {
  try {
    const state = await getIssuanceState(db, params.id);
    if (state.issuance == null) {
      throw new ApiError('not_found', `issuance '${params.id}' not found`, 404);
    }
    return Response.json(state);
  } catch (err) {
    return errorResponse(err);
  }
}

// ---------- POST /api/issuances/[id]/responses — saveResponseDraft ----------

export async function saveDraft(req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const body = await parseBody(req, SaveResponseDraftBodySchema);
    const out = await saveResponseDraft(db, {
      issuance_id: params.id,
      evaluation_group_ref: body.evaluation_group_ref ?? null,
      response_set: body.response_set,
      group_evidence: body.group_evidence,
      expected_save_epoch: body.expected_save_epoch,
    });
    switch (out.status) {
      case 'saved':
        return Response.json(out);
      case 'issuance_not_found':
        throw new ApiError('not_found', `issuance '${params.id}' not found`, 404);
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
      default:
        throw new ApiError('internal_error', 'unexpected saveResponseDraft status', 500);
    }
  } catch (err) {
    return errorResponse(err);
  }
}

// ---------- POST /api/submissions — saveSubmission ----------

export async function createSubmission(req: Request): Promise<Response> {
  try {
    const body = await parseBody(req, CreateSubmissionBodySchema);
    const out = await saveSubmission(db, {
      issuance_id: body.issuance_id,
      evaluation_group_id: body.evaluation_group_id,
      idempotency_key: body.idempotency_key,
      response_set: body.response_set,
      group_evidence: body.group_evidence,
      submission_id: body.submission_id,
      actorRef: 'api:submit',
    });
    switch (out.status) {
      case 'saved':
      case 'replayed':
        return resourceResponse(out, {
          outcome: out.status === 'saved' ? 'created' : 'existing',
          location: `/api/submissions/${encodeURIComponent(out.submission.submission_id)}`,
        });
      case 'issuance_not_found':
        throw new ApiError('not_found', `issuance '${body.issuance_id}' not found`, 404);
      case 'revision_not_found':
        throw new ApiError('revision_not_found', 'pinned revision missing for issuance', 409);
      case 'invalid_response':
        throw new ApiError(
          'invalid_response',
          `response_set invalid for issued scope: ${(out.issues ?? []).join('; ')}`,
          422,
        );
      case 'group_conflict':
        throw new ApiError(
          'group_conflict',
          out.conflict_reason ?? 'submission group mismatch',
          409,
        );
      case 'idempotency_conflict':
        throw new ApiError(
          'idempotency_conflict',
          out.conflict_reason ?? 'same idempotency key, different payload',
          409,
        );
      default:
        throw new ApiError('internal_error', 'unexpected saveSubmission status', 500);
    }
  } catch (err) {
    return errorResponse(err);
  }
}
