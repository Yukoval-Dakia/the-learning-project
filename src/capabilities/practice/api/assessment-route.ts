// issueAssessment / saveSubmission / 自动保存的 route handler。
// 薄层：只做 HTTP 整形 + zod 解析 + 域状态 → ApiError 映射；业务全在
// practice/server/assessment/{issue,submit}.ts。

import type { ZodType } from 'zod';
import { db } from '@/db/client';
import { ApiError, errorResponse, resourceResponse } from '@/kernel/http';
import { issueAssessment } from '../server/assessment/issue';
import { projectIssuanceResult } from '../server/assessment/issue-response';
import { revealFrozenStudyReference } from '../server/assessment/study-context';
import { getIssuanceState, saveResponseDraft, saveSubmission } from '../server/assessment/submit';
import {
  CreateSubmissionBodySchema,
  IssueAssessmentBodySchema,
  SaveResponseDraftBodySchema,
} from './assessment-contracts';

export async function revealStudyReference(
  _req: Request,
  params: Record<string, string>,
): Promise<Response> {
  try {
    return Response.json(await revealFrozenStudyReference(db, params.id));
  } catch (error) {
    return errorResponse(error);
  }
}

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

// ---------- POST /api/issuances ----------

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
    const response = projectIssuanceResult(body, out);
    return resourceResponse(response, {
      outcome: response.status === 'issued' ? 'created' : 'existing',
      location: `/api/issuances/${encodeURIComponent(response.issuance.issuance_id)}`,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

// ---------- GET /api/issuances/[id] ----------

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

// ---------- POST /api/issuances/[id]/responses ----------

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
      case 'already_submitted':
        throw new ApiError(
          'already_submitted',
          out.conflict_reason ?? 'draft for an already-submitted attempt cannot be recreated',
          409,
        );
      default:
        throw new ApiError('internal_error', 'unexpected saveResponseDraft status', 500);
    }
  } catch (err) {
    return errorResponse(err);
  }
}

// ---------- POST /api/submissions ----------

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
      case 'coordinate_conflict':
        throw new ApiError(
          'coordinate_conflict',
          out.conflict_reason ?? 'concurrent submission coordinate conflict — safe to retry',
          409,
        );
      default:
        throw new ApiError('internal_error', 'unexpected saveSubmission status', 500);
    }
  } catch (err) {
    return errorResponse(err);
  }
}
